'use strict';

/*
 * tbl_aip_store data layer.
 * 
 * Two readers + one writer touch this table:
 * 
 *   Reader 1 — Stage 6 (ingester/stages/aip_store.js). Calls
 *     get_by_uuid() at the start of each run to detect a prior
 *     successful copy (idempotent re-fire shouldn't re-upload).
 * 
 *   Reader 2 — dashboard AIPs view. Calls list() with filters +
 *     pagination to render the staff table, and get() for the
 *     download/retry actions.
 * 
 *   Writer — Stage 6 calls upsert_by_uuid() on success/failure;
 *     dashboard's "retry" action calls reset_for_retry() to clear
 *     the backoff + attempts before re-enqueuing.
 * 
 * Status conventions on `is_migrated` (kept compatible with the
 * legacy migration's value set):
 * 
 *   0 — initial / unset
 *   2 — legacy: NOT_FOUND (source AIP missing in DuraCloud)
 *   3 — legacy: REQUEST_FAILED
 *   5 — legacy: migrated OK
 *   6 — v2 ingest: copied OK
 *   7 — v2 ingest: copy failed
 * 
 * is_terminal_success(row) and is_failure(row) helpers below hide
 * the numeric codes from the controller/view layer.
 */

const validator = require('validator');

const { db } = require('../config/db');
const tables = require('../config/db_tables');
const { NotFoundError, ValidationError } = require('../libs/errors');

const AIP_STORE = tables.aip_store;

/*
 * Dashboard list sort keys. Anything else falls back to 'recent'
 * (the pre-sort default ordering).
 */
const ALLOWED_SORTS = new Set(['recent', 'title', 'size', 'downloads']);

/*
 * Status codes used by v2 Stage 6 + dashboard helpers. Legacy values
 * (2/3/5) are documented above but not surfaced as named exports —
 * nothing in v2 code writes them.
 */
const STATUS = {
    INITIAL: 0,
    LEGACY_NOT_FOUND: 2,
    LEGACY_REQUEST_FAILED: 3,
    LEGACY_MIGRATED_OK: 5,
    INGEST_COPIED_OK: 6,
    INGEST_COPY_FAILED: 7,
    /*
     * 8 = AM_NOT_FOUND: orphan rows where Archivematica Storage
     * Service returns 404 for the package UUID. These objects exist
     * in tbl_objects (so they have a repository record) but AM has
     * no metadata for the UUID — no retry can succeed. Marked
     * terminal + excluded from backfill eligibility so we don't
     * keep re-attempting the same dead end. Distinct from
     * INGEST_COPY_FAILED (7) because that one IS retry-eligible
     * (transient curation / Wasabi / AM-5xx errors).
     */
    AM_NOT_FOUND: 8,
};

/*
 * Provenance labels written to the `source` column. NULL/missing on
 * pre-migration rows is treated as 'legacy_migration' by the
 * dashboard for display purposes.
 */
const SOURCE = {
    LEGACY_MIGRATION: 'legacy_migration',
    INGEST_V2: 'ingest_v2',
};

function require_pid(pid) {
    if (!pid || typeof pid !== 'string') throw new ValidationError('uuid (pid) is required');
    if (!validator.isUUID(pid)) throw new ValidationError('uuid must be a UUID');
}

function require_id(id) {
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('id must be a positive integer');
}

/*
 * Terminal success: row has been copied to Wasabi (legacy OR v2 path).
 * The dashboard's "show me copied" filter uses this.
 */
function is_terminal_success(row) {
    if (!row) return false;
    return (
        row.is_migrated === STATUS.LEGACY_MIGRATED_OK ||
        row.is_migrated === STATUS.INGEST_COPIED_OK
    );
}

/*
 * Failure: any of the retry-eligible failure codes. Dashboard uses
 * this for the red status badge + Retry kabob affordance. AM_NOT_FOUND
 * is deliberately NOT included here — those rows are terminal orphans
 * that the operator can't recover by retrying. is_orphan() picks them
 * out separately so the dashboard can render an "AIP not found"
 * pill rather than a misleading "Failed" + Retry button.
 */
function is_failure(row) {
    if (!row) return false;
    return (
        row.is_migrated === STATUS.LEGACY_NOT_FOUND ||
        row.is_migrated === STATUS.LEGACY_REQUEST_FAILED ||
        row.is_migrated === STATUS.INGEST_COPY_FAILED
    );
}

/*
 * Orphan: AM Storage Service returned 404 for the package UUID.
 * Terminal — no retry can fix this — and excluded from future
 * backfill eligibility so we don't keep re-attempting these rows
 * every time the operator clicks Start backfill.
 */
function is_orphan(row) {
    if (!row) return false;
    return row.is_migrated === STATUS.AM_NOT_FOUND;
}

/*
 * Single-row lookup by repo PID. Returns null when no row exists
 * (NOT throw) — the common case is "no row yet, this PID hasn't
 * been through Stage 6". Throwing would force every caller to
 * wrap in try/catch. NotFoundError stays for the get(id) path
 * where the caller IS asking for a specific row by primary key.
 */
async function get_by_uuid(pid) {
    require_pid(pid);
    const row = await db()(AIP_STORE).where({ uuid: pid }).first();
    return row || null;
}

/*
 * Single-row lookup by primary key. Used by the dashboard download
 * + retry actions where the URL carries the id.
 */
async function get(id) {
    require_id(id);
    const row = await db()(AIP_STORE).where({ id }).first();
    if (!row) throw new NotFoundError(`AIP store row ${id} not found`);
    return row;
}

/*
 * Paged + filtered list for the dashboard table. Mirrors the
 * signature of repository/model.list — same `page` / `page_size`
 * envelope so the views layer can reuse pagination helpers.
 * 
 * Filters:
 *   q          — case-insensitive LIKE across uuid + aip + wasabi_key.
 *   source     — exact match ('ingest_v2' or 'legacy_migration').
 *                 'legacy_migration' also matches NULL (pre-migration
 *                 rows). 'all' / undefined = no filter.
 *   status     — 'copied'  → is_terminal_success
 *                'failed'  → is_failure
 *                'pending' → otherwise (0 / 4 / 8 / etc.)
 *                undefined → no filter
 *   since/until — copied_at range (legacy rows excluded when this is
 *                  set, because legacy rows have NULL copied_at).
 * 
 * Returns { page, page_size, total, items }. Items include a
 * derived `display_status` field so the view doesn't have to know
 * the numeric codes.
 */
const LIST_COLUMNS = [
    'id',
    'uuid',
    'aip',
    'aip_uuid',
    'wasabi_bucket',
    'wasabi_key',
    'bytes',
    'copied_at',
    'source',
    'attempts',
    'next_attempt_at',
    'error',
    'message',
    'is_migrated',
    'downloaded',
];

async function list(filter = {}) {
    const page = Math.max(1, Number.parseInt(filter.page, 10) || 1);
    const page_size = Math.min(200, Math.max(1, Number.parseInt(filter.page_size, 10) || 25));

    const q = db()(AIP_STORE).select(LIST_COLUMNS);

    if (filter.q && typeof filter.q === 'string' && filter.q.trim()) {
        const needle = `%${filter.q.trim()}%`;
        /*
         * extra_uuids widens the text match: pids the CALLER resolved
         * from another table (the AIPs dashboard passes objects whose
         * display_record matched q, so ASpace identifiers hit). Kept
         * as plain data so this model stays scoped to its own table.
         */
        const extra_uuids = Array.isArray(filter.extra_uuids)
            ? filter.extra_uuids.filter((u) => typeof u === 'string' && u.length > 0)
            : [];
        q.andWhere(function () {
            this.where('uuid', 'like', needle)
                .orWhere('aip', 'like', needle)
                .orWhere('wasabi_key', 'like', needle);
            if (extra_uuids.length > 0) this.orWhereIn('uuid', extra_uuids);
        });
    }

    if (filter.source === SOURCE.INGEST_V2) {
        q.where({ source: SOURCE.INGEST_V2 });
    } else if (filter.source === SOURCE.LEGACY_MIGRATION) {
        /*
         * Legacy rows include both explicitly-tagged rows AND the
         * ~20k pre-source-column rows where the column is NULL.
         */
        q.andWhere(function () {
            this.where({ source: SOURCE.LEGACY_MIGRATION }).orWhereNull('source');
        });
    }

    if (filter.status === 'copied') {
        q.whereIn('is_migrated', [STATUS.LEGACY_MIGRATED_OK, STATUS.INGEST_COPIED_OK]);
    } else if (filter.status === 'failed') {
        /*
         * Retry-eligible failures only — orphans (8) are surfaced via
         * the dedicated 'orphan' filter so staff can triage them
         * separately (they need a different action: investigation,
         * not a retry).
         */
        q.whereIn('is_migrated', [
            STATUS.LEGACY_NOT_FOUND,
            STATUS.LEGACY_REQUEST_FAILED,
            STATUS.INGEST_COPY_FAILED,
        ]);
    } else if (filter.status === 'orphan') {
        q.where('is_migrated', STATUS.AM_NOT_FOUND);
    } else if (filter.status === 'pending') {
        /*
         * "pending" here means "not yet terminal" — could be a fresh
         * row Stage 6 just created with is_migrated=0, or any value
         * outside the terminal sets. The dashboard surfaces this
         * as "in progress" rows. Orphans (8) are terminal too even
         * though they're not retryable — exclude them from pending.
         */
        q.whereNotIn('is_migrated', [
            STATUS.LEGACY_MIGRATED_OK,
            STATUS.INGEST_COPIED_OK,
            STATUS.LEGACY_NOT_FOUND,
            STATUS.LEGACY_REQUEST_FAILED,
            STATUS.INGEST_COPY_FAILED,
            STATUS.AM_NOT_FOUND,
        ]);
    }

    if (filter.since) q.where('copied_at', '>=', filter.since);
    if (filter.until) q.where('copied_at', '<=', filter.until);

    const count_q = q.clone().clearSelect().clearOrder().count({ total: '*' }).first();

    /*
     * Sort (dashboard "Sort by" select — mirrors the Manage
     * Collections options):
     *   recent    — default: most-recent-copy first; rows without a
     *               copied_at (legacy bulk) fall to the bottom. The
     *               id DESC tiebreaker gives a stable order for
     *               legacy rows (~20k of which share NULL).
     *   title     — object title A–Z; see the branch below.
     *   size      — bytes, largest first (NULL sizes last in DESC).
     *   downloads — download count, highest first.
     */
    const sort = ALLOWED_SORTS.has(filter.sort) ? filter.sort : 'recent';

    if (sort === 'title' && typeof filter.title_of === 'function') {
        /*
         * Title order can't be computed in SQL at acceptable cost:
         * MariaDB's json_extract over the ~21k 3KB display_records
         * measured ~59s per query (correlated subquery AND join
         * variants both). Instead the CALLER supplies a
         * title_of(uuid) lookup — the AIPs controller keeps a
         * short-TTL cached pid→title map (~0.7s to build) — and we
         * sort the filtered id/uuid pairs in memory (tiny rows),
         * page from the sorted list, then fetch just the page.
         * Titles arrive as data so this model stays scoped to its
         * own table, same reasoning as extra_uuids above. Rows
         * without a resolvable title sort last; id DESC ties.
         */
        const pairs = await q.clone().clearSelect().select('id', 'uuid');
        pairs.sort((a, b) => {
            const ta = filter.title_of(a.uuid) || null;
            const tb = filter.title_of(b.uuid) || null;
            if (ta && tb) {
                const cmp = ta.localeCompare(tb);
                if (cmp !== 0) return cmp;
            } else if (ta) {
                return -1;
            } else if (tb) {
                return 1;
            }
            return b.id - a.id;
        });
        const total = pairs.length;
        const page_ids = pairs
            .slice((page - 1) * page_size, page * page_size)
            .map((p) => p.id);
        let rows = [];
        if (page_ids.length > 0) {
            const fetched = await db()(AIP_STORE)
                .select(LIST_COLUMNS)
                .whereIn('id', page_ids);
            const by_id = new Map(fetched.map((r) => [r.id, r]));
            rows = page_ids.map((id) => by_id.get(id)).filter(Boolean);
        }
        return {
            page,
            page_size,
            total,
            items: rows.map((r) => ({
                ...r,
                display_status: derive_display_status(r),
            })),
        };
    }

    if (sort === 'size') {
        q.orderBy([
            { column: 'bytes', order: 'desc' },
            { column: 'id', order: 'desc' },
        ]);
    } else if (sort === 'downloads') {
        q.orderBy([
            { column: 'downloaded', order: 'desc' },
            { column: 'id', order: 'desc' },
        ]);
    } else {
        q.orderBy([
            { column: 'copied_at', order: 'desc' },
            { column: 'id', order: 'desc' },
        ]);
    }
    q.limit(page_size).offset((page - 1) * page_size);

    const [rows, count] = await Promise.all([q, count_q]);
    return {
        page,
        page_size,
        total: Number(count.total || 0),
        items: rows.map((r) => ({
            ...r,
            display_status: derive_display_status(r),
        })),
    };
}

/*
 * Resolve a downloadable Wasabi key from a tbl_aip_store row, walking
 * a fallback chain: wasabi_key → aip → basename(aip_legacy).
 * 
 * Background: the original DuraCloud → Wasabi migration had a 2-step
 * shape: a `get_aip_locations()` pass that populated `aip_legacy`
 * (full DC path), then an `update_aips()` pass that extracted the
 * basename into `aip`. For ~332 legacy rows the second pass never
 * ran — they have `aip_legacy` set but `aip` empty. The file IS in
 * Wasabi at the basename of aip_legacy; we just need to extract it
 * at request time.
 * 
 * The basename strip mirrors the legacy migration:
 *   tmp = record.aip_legacy.split('/')
 *   aip = tmp[tmp.length - 1].replace('_transfer', '')
 * 
 * Returns null when none of the three columns yield a non-empty
 * value (e.g., true orphans). Callers should treat null as "no
 * downloadable key" and refuse the request with a clear message.
 */
function derive_wasabi_key(row) {
    if (!row) return null;
    if (row.wasabi_key) return row.wasabi_key;
    if (row.aip) return row.aip;
    if (row.aip_legacy && typeof row.aip_legacy === 'string') {
        const parts = row.aip_legacy.split('/').filter(Boolean);
        const basename = parts[parts.length - 1];
        if (basename) {
            /*
             * String.prototype.replace with a non-regex literal
             * replaces only the FIRST occurrence — matches the
             * legacy migration's behavior exactly.
             */
            return basename.replace('_transfer', '');
        }
    }
    return null;
}

/*
 * Map the numeric is_migrated code (+ context) to a stable string the
 * view layer renders directly. Keeps the EJS template free of
 * numeric branches.
 * 
 * Values:
 *   'copied'      — terminal success (legacy or v2)
 *   'failed'      — terminal-but-retryable failure (legacy NOT_FOUND,
 *                    legacy REQUEST_FAILED, v2 INGEST_COPY_FAILED).
 *                    The Retry kabob is offered for these.
 *   'orphan'      — AM Storage Service returned 404 (is_migrated=8).
 *                    Terminal AND non-retryable; the dashboard renders
 *                    a distinct pill and hides the Retry action.
 *   'in_progress' — anything else (initial state, awaiting Stage 6)
 */
function derive_display_status(row) {
    if (is_terminal_success(row)) return 'copied';
    if (is_orphan(row)) return 'orphan';
    if (is_failure(row)) return 'failed';
    return 'in_progress';
}

/*
 * Insert-or-update by repository PID. Stage 6's primary writer.
 * Returns the row id (new or existing).
 * 
 * Why upsert rather than separate insert/update: Stage 6 is
 * idempotent — a retry should overwrite whatever was there from a
 * prior failed attempt. The natural key is (uuid). We don't use
 * ON DUPLICATE KEY UPDATE because the existing prod schema lacks a
 * UNIQUE on uuid (legacy rows allow duplicates from re-runs of the
 * one-time migration). A check-then-write is fine: Stage 6 is the
 * only v2-side writer and runs single-threaded against any given
 * uuid (the queue row gates it).
 */
async function upsert_by_uuid(pid, patch) {
    require_pid(pid);
    if (!patch || typeof patch !== 'object') {
        throw new ValidationError('patch must be an object');
    }
    const existing = await db()(AIP_STORE).where({ uuid: pid }).first();
    if (existing) {
        await db()(AIP_STORE).where({ id: existing.id }).update(patch);
        return { id: existing.id, created: false };
    }
    const insert = { uuid: pid, ...patch };
    /*
     * Backstop the legacy NOT NULL columns: callers don't have to
     * remember to pass 'aip' / 'aip_legacy' when those don't apply
     * to a v2 ingest row.
     */
    if (insert.aip === undefined) insert.aip = '';
    if (insert.aip_legacy === undefined) insert.aip_legacy = '';
    const [id] = await db()(AIP_STORE).insert(insert);
    return { id, created: true };
}

// Plain update by id — used by the dashboard retry flow.
async function update(id, patch) {
    require_id(id);
    if (!patch || typeof patch !== 'object') {
        throw new ValidationError('patch must be an object');
    }
    const affected = await db()(AIP_STORE).where({ id }).update(patch);
    if (affected === 0) throw new NotFoundError(`AIP store row ${id} not found`);
    return get(id);
}

/*
 * Increment the download counter atomically. Used by the dashboard
 * download action so the counter doesn't race with concurrent
 * downloads of the same row.
 */
async function increment_downloaded(id) {
    require_id(id);
    const affected = await db()(AIP_STORE).where({ id }).increment('downloaded', 1);
    if (affected === 0) throw new NotFoundError(`AIP store row ${id} not found`);
}

/*
 * Reset a failed row for manual retry from the dashboard. Clears
 * attempts + next_attempt_at + error so Stage 6 picks it up again on the
 * next worker tick, and resets is_migrated to INITIAL.
 * 
 * Why reset is_migrated (it didn't used to): a retry-eligible failure
 * (INGEST_COPY_FAILED) gets overwritten by Stage 6 on its next run
 * anyway — but an ORPHAN row (AM_NOT_FOUND) is short-circuited on Stage 6
 * entry and re-dead-lettered before curation is ever called, so leaving
 * the tag made a retry a silent no-op. Resetting to INITIAL clears that
 * short-circuit so a deliberate operator retry actually re-attempts the
 * copy — the recovery path for an AIP that was mis-orphaned because AM
 * was still registering it in the Storage Service when Stage 6 first
 * looked.
 * 
 * Returns the updated row so the controller can re-render the table
 * row with the new state.
 */
async function reset_for_retry(id) {
    require_id(id);
    const affected = await db()(AIP_STORE).where({ id }).update({
        attempts: 0,
        next_attempt_at: null,
        error: null,
        message: null,
        is_migrated: STATUS.INITIAL,
    });
    if (affected === 0) throw new NotFoundError(`AIP store row ${id} not found`);
    return get(id);
}

module.exports = {
    STATUS,
    SOURCE,
    is_terminal_success,
    is_failure,
    is_orphan,
    get,
    get_by_uuid,
    list,
    upsert_by_uuid,
    update,
    increment_downloaded,
    reset_for_retry,
    derive_display_status,
    derive_wasabi_key,
};
