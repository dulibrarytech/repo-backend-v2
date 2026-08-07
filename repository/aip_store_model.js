'use strict';

/*
 * tbl_aip_store data layer.
 *
 * Callers:
 *   Stage 6 (ingester/stages/aip_store.js) — get_by_uuid() to detect a
 *     prior successful copy, upsert_by_uuid() on success/failure.
 *   Dashboard AIPs view — list() with filters + pagination, get() for
 *     the download/retry actions, reset_for_retry() to clear backoff
 *     and attempts before re-enqueuing.
 *
 * Status conventions on `is_migrated`, compatible with the legacy
 * migration's value set:
 *
 *   0 — initial / unset
 *   2 — legacy: NOT_FOUND (source AIP missing in DuraCloud)
 *   3 — legacy: REQUEST_FAILED
 *   5 — legacy: migrated OK
 *   6 — v2 ingest: copied OK
 *   7 — v2 ingest: copy failed
 *
 * is_terminal_success(row) and is_failure(row) hide the numeric codes
 * from the controller/view layer.
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
     * Orphans: AM Storage Service 404s for the package UUID though the
     * object has a repository record. Terminal and excluded from
     * backfill eligibility, unlike the retry-eligible
     * INGEST_COPY_FAILED (7).
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
 * Paged + filtered list for the dashboard table, using the same
 * `page` / `page_size` envelope as repository/model.list.
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
     * Sort keys:
     *   recent    — default: most-recent copy first; NULL copied_at
     *               (legacy rows) last, id DESC as a stable tiebreaker.
     *   title     — object title A–Z; see the branch below.
     *   size      — bytes, largest first (NULL sizes last).
     *   downloads — download count, highest first.
     */
    const sort = ALLOWED_SORTS.has(filter.sort) ? filter.sort : 'recent';

    if (sort === 'title' && typeof filter.title_of === 'function') {
        /*
         * Title order is computed in memory, not SQL: the caller
         * supplies a title_of(uuid) lookup, the filtered id/uuid pairs
         * are sorted here, and only the resulting page is fetched.
         * Rows without a resolvable title sort last, id DESC on ties.
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
        /*
         * Default sort: rows needing attention first, then
         * newest-copied. "Needing attention" is scoped by status —
         * failures + in-flight — NOT by copied_at IS NULL: the ~20k
         * legacy migrated-OK rows also have NULL copied_at (the
         * one-time migration recorded no per-row timestamp), so a
         * NULL-first key buries recent copies behind the entire
         * legacy backlog. Legacy-OK and orphan rows sink to the
         * bottom (copied_at DESC puts NULLs last in both MariaDB
         * and sqlite), with id DESC as the stable tiebreaker.
         */
        q.orderByRaw(
            '(is_migrated NOT IN (?, ?, ?)) DESC, copied_at DESC, id DESC',
            [
                STATUS.LEGACY_MIGRATED_OK,
                STATUS.INGEST_COPIED_OK,
                STATUS.AM_NOT_FOUND,
            ]
        );
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
 * Which of the given AM AIP UUIDs are currently in retry backoff
 * (next_attempt_at in the future)? Returns a Set of aip_uuid strings.
 *
 * Used by the ingest worker's Stage 6 claim so a row waiting out its
 * backoff doesn't occupy the (serial) copy slot every tick and stall
 * every AIP behind it — the worker skips backoff rows and claims the
 * next runnable one instead. The stage's own backoff guard stays as
 * the authoritative per-row gate; this is claim-time scheduling only.
 *
 * The date comparison happens in JS, not SQL, because sqlite (tests)
 * and MariaDB (prod) disagree on Date binding semantics; the row set
 * is small (only rows with a live next_attempt_at can match).
 */
async function list_uuids_in_backoff(aip_uuids) {
    if (!Array.isArray(aip_uuids) || aip_uuids.length === 0) return new Set();
    const uuids = aip_uuids.filter((u) => typeof u === 'string' && u.length > 0);
    if (uuids.length === 0) return new Set();
    const rows = await db()(AIP_STORE)
        .whereIn('aip_uuid', uuids)
        .whereNotNull('next_attempt_at')
        .select('aip_uuid', 'next_attempt_at');
    const now = new Date();
    return new Set(
        rows
            .filter((r) => new Date(r.next_attempt_at) > now)
            .map((r) => r.aip_uuid)
    );
}

/*
 * Resolve a downloadable Wasabi key from a tbl_aip_store row, walking
 * the fallback chain wasabi_key → aip → basename(aip_legacy), where
 * the basename strip is `split('/').pop().replace('_transfer', '')`.
 *
 * Returns null when no column yields a non-empty value; callers should
 * treat that as "no downloadable key" and refuse the request.
 */
function derive_wasabi_key(row) {
    if (!row) return null;
    if (row.wasabi_key) return row.wasabi_key;
    if (row.aip) return row.aip;
    if (row.aip_legacy && typeof row.aip_legacy === 'string') {
        const parts = row.aip_legacy.split('/').filter(Boolean);
        const basename = parts[parts.length - 1];
        if (basename) {
            /* Non-regex replace: first occurrence only, by design. */
            return basename.replace('_transfer', '');
        }
    }
    return null;
}

/*
 * Map the numeric is_migrated code to a stable string the view layer
 * renders directly:
 *   'copied'      — terminal success (legacy or v2)
 *   'failed'      — retryable failure; the Retry action is offered
 *   'orphan'      — is_migrated=8, terminal and non-retryable; the
 *                   dashboard hides the Retry action
 *   'in_progress' — anything else (initial state, awaiting Stage 6)
 */
function derive_display_status(row) {
    if (is_terminal_success(row)) return 'copied';
    if (is_orphan(row)) return 'orphan';
    if (is_failure(row)) return 'failed';
    return 'in_progress';
}

/*
 * Insert-or-update by repository PID, keyed on (uuid). Stage 6's
 * primary writer. Returns { id, created }.
 *
 * Check-then-write rather than ON DUPLICATE KEY UPDATE, because the
 * prod schema has no UNIQUE on uuid; safe because Stage 6 is the only
 * v2-side writer and the queue row serializes it per uuid.
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
    /* Backstop the legacy NOT NULL columns. */
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

/* Atomically increment the download counter. */
async function increment_downloaded(id) {
    require_id(id);
    const affected = await db()(AIP_STORE).where({ id }).increment('downloaded', 1);
    if (affected === 0) throw new NotFoundError(`AIP store row ${id} not found`);
}

/*
 * Reset a failed row for manual retry from the dashboard: clears
 * attempts, next_attempt_at and error, and resets is_migrated to
 * INITIAL so Stage 6 picks it up on the next tick.
 *
 * Resetting is_migrated matters for orphans (AM_NOT_FOUND), which
 * Stage 6 short-circuits on entry — without the reset an operator
 * retry would be a silent no-op.
 *
 * Returns the updated row.
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
    list_uuids_in_backoff,
    upsert_by_uuid,
    update,
    increment_downloaded,
    reset_for_retry,
    derive_display_status,
    derive_wasabi_key,
};
