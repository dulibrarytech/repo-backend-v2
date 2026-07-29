'use strict';

/*
 * CRUD against tbl_objects.
 * 
 * Public surface is intentionally narrow for Phase 3:
 *   list(filter)          paginated listing
 *   get(pid)              fetch one by pid (the UUID, not the autoinc id)
 *   publish(pid)          is_published = 1
 *   suppress(pid)         is_published = 0
 *   soft_delete(pid)      is_active = 0, delete_id stamped
 * 
 * Thumbnail / image / viewer / transcript routes from the legacy code
 * depend on external services (TN_SERVICE, ARCHIVESSPACE, DURACLOUD)
 * that haven't been ported yet. Those endpoints land later.
 */

const { randomUUID } = require('node:crypto');
const validator = require('validator');

const { db } = require('../config/db');
const tables = require('../config/db_tables');
const archivematica = require('../libs/archivematica');
const log = require('../libs/log');
const { ConflictError, NotFoundError, ValidationError } = require('../libs/errors');

const PUBLIC_FIELDS = [
    'id',
    'pid',
    'handle',
    'uri',
    'is_member_of_collection',
    'object_type',
    'mime_type',
    'file_name',
    'thumbnail',
    'is_published',
    'is_restricted',
    'is_active',
    'is_compound',
    'is_indexed',
    'sip_uuid',
    'created',
    /*
     * display_record is a longtext JSON snapshot the legacy indexer
     * populates with title/abstract/handle/subjects. The dashboard
     * enriches each row via libs/object_projection at render time so
     * the table can show titles, not just PIDs.
     */
    'display_record',
];

const ALLOWED_OBJECT_TYPES = new Set(['object', 'collection', 'compound']);

function require_pid(pid) {
    if (!pid || typeof pid !== 'string') {
        throw new ValidationError('pid is required');
    }
    if (!validator.isUUID(pid)) {
        throw new ValidationError('pid must be a UUID');
    }
}

// list({ collection, object_type, is_published, is_active, created_since, page, page_size })
async function list(filter = {}) {
    const page = Math.max(1, Number.parseInt(filter.page, 10) || 1);
    const page_size = Math.min(200, Math.max(1, Number.parseInt(filter.page_size, 10) || 25));

    const q = db()(tables.objects).select(PUBLIC_FIELDS);
    if (filter.collection) q.where({ is_member_of_collection: filter.collection });
    if (filter.object_type) {
        if (!ALLOWED_OBJECT_TYPES.has(filter.object_type)) {
            throw new ValidationError(
                `object_type must be one of ${[...ALLOWED_OBJECT_TYPES].join(', ')}`
            );
        }
        q.where({ object_type: filter.object_type });
    }
    if (filter.is_published !== undefined) q.where({ is_published: filter.is_published ? 1 : 0 });
    if (filter.is_active !== undefined) q.where({ is_active: filter.is_active ? 1 : 0 });
    /*
     * Objects created within a recent window — backs the "Recent Ingests"
     * view. Caller passes a 'YYYY-MM-DD HH:MM:SS' (UTC) cutoff; `created` is
     * a TIMESTAMP stored in that same format by both MariaDB now() and
     * sqlite CURRENT_TIMESTAMP, so the string compares chronologically
     * (fixed-width + zero-padded → lexicographic == chronological).
     */
    if (filter.created_since) q.where('created', '>=', filter.created_since);
    /*
     * Exclude collection rows — used by the collection-detail member list so a
     * nested sub-collection doesn't appear among the parent's member objects
     * (sub-collections render in their own section).
     */
    if (filter.exclude_collections) q.whereNot({ object_type: 'collection' });

    /*
     * Total before pagination (one extra count query — cheap with the
     * indexes we shipped in db/schema.js).
     */
    const count_q = q.clone().clearSelect().clearOrder().count({ total: '*' }).first();

    q.orderBy('id', 'desc')
        .limit(page_size)
        .offset((page - 1) * page_size);

    const [rows, count] = await Promise.all([q, count_q]);
    return {
        page,
        page_size,
        total: Number(count.total || 0),
        items: rows,
    };
}

async function get(pid) {
    require_pid(pid);
    const row = await db()(tables.objects).select(PUBLIC_FIELDS).where({ pid }).first();
    if (!row) throw new NotFoundError(`Object ${pid} not found`);
    return row;
}

/*
 * Batch-read by an explicit pid list. Returns the rows that exist
 * in any order (caller indexes by pid). Empty input → empty output;
 * missing pids are silently omitted (callers that need a hard error
 * should `get()` per-pid). Used by the AIPs dashboard to attach
 * object titles to tbl_aip_store rows without an N+1 query.
 */
async function list_by_pids(pids) {
    if (!Array.isArray(pids) || pids.length === 0) return [];
    return db()(tables.objects).select(PUBLIC_FIELDS).whereIn('pid', pids);
}

/*
 * Cached pid → lowercased-title map over ALL objects, for callers that
 * need to ORDER BY title across a whole result set (the AIPs dashboard
 * title sort). Titles live only inside display_record JSON and MariaDB
 * json_extract at this scale measured ~59s/query, so extraction happens
 * here in JS (~0.7s for the full corpus) behind a short TTL. Staleness
 * is bounded at the TTL — acceptable for a sort key; a just-refreshed
 * title sorts by its old value for at most a minute.
 *
 * Chunked by id so peak memory holds one 5k-row slice of 3KB blobs,
 * not the whole table.
 */
const TITLE_MAP_TTL_MS = 60_000;
let _title_map_cache = { at: 0, map: null };

async function cached_title_map() {
    const now = Date.now();
    if (_title_map_cache.map && now - _title_map_cache.at < TITLE_MAP_TTL_MS) {
        return _title_map_cache.map;
    }
    const map = new Map();
    let last_id = 0;
    for (;;) {
        const rows = await db()(tables.objects)
            .select('id', 'pid', 'display_record')
            .where('id', '>', last_id)
            .orderBy('id')
            .limit(5000);
        if (rows.length === 0) break;
        for (const r of rows) {
            last_id = r.id;
            if (!r.display_record) continue;
            try {
                const dr =
                    typeof r.display_record === 'string'
                        ? JSON.parse(r.display_record)
                        : r.display_record;
                const t =
                    (dr && dr.title) ||
                    (dr && dr.display_record && dr.display_record.title) ||
                    null;
                if (t) map.set(r.pid, String(t).toLowerCase());
            } catch {
                // Corrupt display_record — no title.
            }
        }
        if (rows.length < 5000) break;
    }
    _title_map_cache = { at: now, map };
    return map;
}

/* Test hook — lets suites invalidate the cache between seeds. */
function _reset_title_map_cache() {
    _title_map_cache = { at: 0, map: null };
}

/*
 * Pids whose display_record text contains `q` — the same LIKE-over-JSON
 * approach the staff search (search/model.js) uses, but projected down
 * to bare pids. Used by the AIPs dashboard so a search by ASpace
 * identifier (e.g. D009.22.0007.0041.00001, which lives only inside
 * display_record) can resolve to tbl_aip_store rows via uuid=pid.
 * Capped so a broad term can't balloon the caller's whereIn.
 */
async function list_pids_by_display_record_match(q, limit = 500) {
    /*
     * Min length 3 (mirrors search/model quick_lookup): the LIKE is a
     * full longtext scan (~1s warm on the current corpus), and one- or
     * two-char fragments match almost every row anyway — not worth a
     * scan per keystroke of a live-search box.
     */
    if (typeof q !== 'string' || q.trim().length < 3) return [];
    /* LIKE-escape user-supplied wildcards (mirrors search/model.js). */
    const needle = '%' + q.trim().replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
    const rows = await db()(tables.objects)
        .select('pid')
        .where('display_record', 'like', needle)
        .limit(limit);
    return rows.map((r) => r.pid);
}

/*
 * Publish and suppress BOTH dirty the row so the indexer reflects the
 * new state in ES on its next tick. This keeps the staff workflow
 * single-click: publish → public; suppress → not public. Without
 * is_updated=1, staff would have to chain "publish + refresh
 * metadata" to make a record actually appear in public search.
 * 
 * The worker's eligibility check (is_published=1 AND is_active=1)
 * decides INDEX vs DELETE per row at claim time:
 *   - publish → eligible → INDEX with current display_record content
 *   - suppress → ineligible → DELETE from ES
 */
async function set_publish_state(pid, value) {
    require_pid(pid);
    const affected = await db()(tables.objects)
        .where({ pid })
        .update({ is_published: value ? 1 : 0, is_updated: 1 });
    if (affected === 0) throw new NotFoundError(`Object ${pid} not found`);
    return get(pid);
}

async function publish(pid) {
    return set_publish_state(pid, true);
}

async function suppress(pid) {
    return set_publish_state(pid, false);
}

/*
 * Soft-delete a single object.
 * 
 * Three-step flow matching v1's contract:
 *   1. Read the row. Refuse if it's published — staff must suppress
 *      first. No --force override; this is intentional.
 *   2. Submit an AIP deletion request to Archivematica (best-effort —
 *      AM hiccups must not block the user-visible soft-delete).
 *   3. Flip is_active=0 with is_updated=1 so the indexer picks it up
 *      and removes the row from Elasticsearch on its next tick.
 * 
 * `delete_reason` is required and gets forwarded to AM as the
 * event_reason on the deletion request, so the AM admin reviewing
 * the request in the Storage Service UI sees why.
 * 
 * `actor` is the JWT principal (du_id / email). Prepended to the
 * AM reason text so the audit record names a human, and logged
 * for cross-reference with this service's log stream.
 * 
 * Returns { ok: true, delete_id, am }. `delete_id` is AM's deletion-
 * request id when the AM call succeeded; otherwise a fresh UUID
 * (so the row still has a unique audit token). Inspect `am.ok` to
 * distinguish.
 */
async function soft_delete(pid, { delete_reason, actor } = {}) {
    require_pid(pid);
    _validate_delete_reason(delete_reason);

    /*
     * Read first so the published guard runs BEFORE we touch AM. v1
     * had this backwards — it submitted the AM deletion request even
     * when it then refused to soft-delete the published row, leaving
     * orphaned AM requests behind. We fix that here.
     */
    const row = await db()(tables.objects)
        .where({ pid, is_active: 1 })
        .select('pid', 'sip_uuid', 'is_published')
        .first();
    if (!row) throw new NotFoundError(`Active object ${pid} not found`);

    if (row.is_published) {
        throw new ConflictError(
            `Cannot delete published object ${pid}. Suppress it first, then delete.`
        );
    }

    // Best-effort AM AIP deletion request.
    const am = await _request_aip_delete_safely(row, delete_reason, actor);

    /*
     * is_updated=1: the row was active (possibly indexed); after this
     * it's no longer eligible (is_active=0), so the indexer needs to
     * claim and DELETE from ES. Same rationale as suppress.
     */
    const affected = await db()(tables.objects)
        .where({ pid, is_active: 1 })
        .update({ is_active: 0, delete_id: am.delete_id, is_updated: 1 });
    if (affected === 0) {
        /*
         * Race: a concurrent delete won between our SELECT and UPDATE.
         * Surface as NotFound so the caller sees an idempotent result.
         */
        throw new NotFoundError(`Active object ${pid} not found`);
    }
    return { ok: true, delete_id: am.delete_id, am };
}

/*
 * Submit an AM deletion request for one row. NEVER throws — returns
 * a structured outcome the caller folds into the delete result.
 * 
 * Shape:
 *   { ok: true,  delete_id, status, skipped? }
 *   { ok: false, delete_id, error, status? }
 * 
 * `delete_id` is always populated so the caller can stamp the
 * audit column unconditionally — AM's request id when the call
 * succeeded, otherwise a fresh UUID.
 */
async function _request_aip_delete_safely(row, delete_reason, actor) {
    /*
     * Legacy / hand-imported rows that never went through Stage 3
     * have no AM SIP to delete. Skip the call but still produce a
     * delete_id so the row gets the same audit treatment.
     */
    if (!row.sip_uuid || row.sip_uuid === 'PENDING') {
        return {
            ok: true,
            delete_id: randomUUID(),
            skipped: 'no_sip_uuid',
        };
    }
    if (!archivematica.is_storage_configured()) {
        log.warn({
            event: 'am_delete_aip_skipped_not_configured',
            pid: row.pid,
        });
        return {
            ok: false,
            delete_id: randomUUID(),
            error: 'AM storage API not configured',
        };
    }

    const reason = _format_delete_reason(delete_reason, actor);
    try {
        const r = await archivematica.delete_aip_request({
            uuid: row.sip_uuid,
            delete_reason: reason,
        });
        if (r.status >= 200 && r.status < 300) {
            /*
             * AM's 202 carries the deletion-request id in data.id
             * (sometimes data.uuid). Either works as our delete_id;
             * if neither is present, fall back to a fresh UUID so
             * the column is always populated.
             */
            const id =
                (r.data && (r.data.id || r.data.uuid)) || randomUUID();
            return { ok: true, delete_id: String(id), status: r.status };
        }
        log.warn({
            event: 'am_delete_aip_bad_status',
            pid: row.pid,
            status: r.status,
        });
        return {
            ok: false,
            delete_id: randomUUID(),
            status: r.status,
            error: `AM returned HTTP ${r.status}`,
        };
    } catch (err) {
        log.warn({
            event: 'am_delete_aip_failed',
            pid: row.pid,
            err: err.message,
        });
        return {
            ok: false,
            delete_id: randomUUID(),
            error: err.message,
        };
    }
}

/*
 * Compose the event_reason text AM stores against the deletion
 * request. Prepends the actor so the AM admin reviewing the queue
 * can identify who initiated it without cross-referencing logs.
 */
function _format_delete_reason(reason, actor) {
    const actor_text = actor ? `Deleted by ${actor}` : 'Deletion requested';
    const date = new Date().toISOString().slice(0, 10);
    const cleaned = String(reason).trim().replace(/\s+/g, ' ');
    return `${actor_text} on ${date}. Reason: ${cleaned}`.slice(0, 1000);
}

function _validate_delete_reason(reason) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new ValidationError('delete_reason is required');
    }
    if (reason.length > 1000) {
        throw new ValidationError('delete_reason must be 1000 characters or fewer');
    }
}

/*
 * ----- Bulk operations ----------------------------------------------------
 * 
 * Each bulk function takes an array of pids, validates them all up front,
 * and applies the change in a single SQL UPDATE for atomicity + speed.
 * All three:
 *   - Cap at MAX_BULK_PIDS (100). Above that the controller chunks.
 *   - De-duplicate the input — repeats in the array would otherwise inflate
 *     the affected count.
 *   - Return `{ affected, pids }` where pids is the validated/deduped list
 *     so the controller can re-render exactly the rows the user selected.
 *   - Skip is_active=0 rows for publish/suppress so a stale UI checking a
 *     soft-deleted row doesn't accidentally bring it back to life.
 * 
 * We don't throw NotFoundError on partial misses here — bulk is a
 * best-effort fan-out, and the affected count tells the caller what
 * actually happened.
 */

const MAX_BULK_PIDS = 100;

function require_pid_array(pids) {
    if (!Array.isArray(pids) || pids.length === 0) {
        throw new ValidationError('pids must be a non-empty array');
    }
    if (pids.length > MAX_BULK_PIDS) {
        throw new ValidationError(`Bulk requests are capped at ${MAX_BULK_PIDS} pids`);
    }
    // De-dupe while preserving order, then validate each.
    const unique = [...new Set(pids.map(String))];
    for (const pid of unique) {
        if (!validator.isUUID(pid)) {
            throw new ValidationError(`Invalid pid in bulk request: ${pid}`);
        }
    }
    return unique;
}

async function set_publish_state_bulk(pids, value) {
    const unique = require_pid_array(pids);
    /*
     * Both publish and suppress dirty: keep the staff workflow
     * single-click. See set_publish_state above for the rationale.
     */
    const affected = await db()(tables.objects)
        .whereIn('pid', unique)
        .andWhere('is_active', 1)
        .update({ is_published: value ? 1 : 0, is_updated: 1 });
    return { affected, pids: unique };
}

async function bulk_publish(pids) {
    return set_publish_state_bulk(pids, true);
}

async function bulk_suppress(pids) {
    return set_publish_state_bulk(pids, false);
}

/*
 * Bulk soft-delete. Three-phase, mirroring the single-row path:
 * 
 *   1. Validate input + look up every row up front. If ANY row is
 *      published, reject the WHOLE batch — same strictness as the
 *      single delete. Staff suppress + retry.
 *   2. Fire one AM deletion request per row, serially (AM may not
 *      love a fan-out of 100 concurrent delete_aip calls).
 *      Best-effort: failures are recorded but don't abort the
 *      transaction.
 *   3. Soft-delete each row inside one transaction, using AM's
 *      returned request id as the delete_id when available.
 * 
 * Returns { affected, pids, am_failed, am_outcomes }. The
 * am_outcomes array carries the per-row AM result so the caller
 * can surface which rows had AM-side problems.
 */
async function bulk_soft_delete(pids, { delete_reason, actor } = {}) {
    const unique = require_pid_array(pids);
    _validate_delete_reason(delete_reason);

    const rows = await db()(tables.objects)
        .whereIn('pid', unique)
        .andWhere({ is_active: 1 })
        .select('pid', 'sip_uuid', 'is_published');
    const published = rows.filter((r) => r.is_published);
    if (published.length > 0) {
        const sample = published
            .slice(0, 5)
            .map((r) => r.pid)
            .join(', ');
        const more =
            published.length > 5 ? ` (and ${published.length - 5} more)` : '';
        throw new ConflictError(
            `Cannot delete ${published.length} published object${
                published.length === 1 ? '' : 's'
            }: ${sample}${more}. Suppress them first, then delete.`
        );
    }

    /*
     * Per-row AM delete requests. Serial so AM doesn't see a thundering
     * herd. Total time bounded by MAX_BULK_PIDS × per-call timeout.
     */
    const am_outcomes = [];
    for (const row of rows) {
        const outcome = await _request_aip_delete_safely(row, delete_reason, actor);
        am_outcomes.push({ pid: row.pid, ...outcome });
    }

    // Soft-delete each row inside one transaction.
    let affected = 0;
    await db().transaction(async (trx) => {
        for (const outcome of am_outcomes) {
            const n = await trx(tables.objects)
                .where({ pid: outcome.pid, is_active: 1 })
                .update({
                    is_active: 0,
                    delete_id: outcome.delete_id,
                    is_updated: 1,
                });
            affected += n;
        }
    });

    const am_failed = am_outcomes.filter((o) => !o.ok).length;
    return { affected, pids: unique, am_failed, am_outcomes };
}

/*
 * Update an object's metadata payload from a fresh ArchivesSpace
 * fetch. Writes the four columns the metadata worker cares about in
 * one statement so the indexer can pick the row up via `is_updated=1`
 * on its next cycle. Returns the affected count.
 * 
 * The shape of `payload` mirrors what v1's worker wrote:
 *   mods             — full ASpace JSON, stringified
 *   display_record   — denormalized envelope, stringified
 *   compound_parts   — '[]' for simple objects, parts array stringified
 *                      for compound objects
 *   is_compound      — 0 | 1
 * 
 * We do NOT touch is_indexed here. That flag belongs to the indexer
 * (which runs separately in v2 today); flipping it here would lie to
 * the indexer about the row's state.
 */
async function update_metadata_payload(pid, payload) {
    require_pid(pid);
    const allowed = ['mods', 'display_record', 'compound_parts', 'is_compound'];
    const update = {};
    for (const key of allowed) {
        if (payload[key] !== undefined) update[key] = payload[key];
    }
    if (Object.keys(update).length === 0) {
        throw new ValidationError('No metadata fields supplied');
    }
    update.is_updated = 1;
    const affected = await db()(tables.objects).where({ pid }).update(update);
    if (affected === 0) throw new NotFoundError(`Object ${pid} not found`);
    return { affected };
}

/*
 * Update an object's thumbnail URL. Writes the column AND mirrors the
 * URL into the JSON `display_record` blob so the two stay in sync — the
 * indexer reads from display_record, the dashboard reads either, and
 * drift between them is a long-standing source of bug reports against
 * v1. Done in a single transaction so a crash between the two writes
 * can't leave them divergent.
 * 
 * Returns the refreshed row (post-update) for the caller to render.
 */
async function set_thumbnail(pid, url) {
    require_pid(pid);
    if (typeof url !== 'string' || url.length === 0) {
        throw new ValidationError('thumbnail url is required');
    }
    /*
     * Defense in depth: only allow http(s) URLs to land in the DB. The
     * caller already builds these from PUBLIC_BASE_URL + a constant
     * suffix; this guards against future callers passing user input.
     */
    if (!/^https?:\/\//i.test(url)) {
        throw new ValidationError('thumbnail url must be http(s)');
    }

    return db().transaction(async (trx) => {
        const row = await trx(tables.objects)
            .select(PUBLIC_FIELDS)
            .where({ pid })
            .first()
            .forUpdate()
            /*
             * sqlite (our test driver) doesn't support FOR UPDATE; knex
             * throws if we ask for it there. Skip the lock when it's
             * unsupported — the transaction itself still serializes us
             * against other writers via sqlite's BEGIN IMMEDIATE.
             */
            .catch(async (err) => {
                if (/forUpdate|FOR UPDATE/i.test(String(err && err.message))) {
                    return trx(tables.objects).select(PUBLIC_FIELDS).where({ pid }).first();
                }
                throw err;
            });
        if (!row) throw new NotFoundError(`Object ${pid} not found`);

        /*
         * Parse + patch display_record. Use the same defensive parser
         * libs/object_projection uses so a malformed blob doesn't
         * upgrade to a 500 here.
         */
        let parsed = {};
        if (row.display_record) {
            try {
                const candidate = JSON.parse(row.display_record);
                if (candidate && typeof candidate === 'object') parsed = candidate;
            } catch {
                /*
                 * Leave parsed = {} — we'll overwrite the blob with a
                 * minimal {thumbnail} object. Better than losing the
                 * edit because a corrupt JSON value is sitting in there.
                 */
            }
        }
        parsed.thumbnail = url;

        /*
         * Dirty the row so the indexer re-pushes the doc with the
         * new thumbnail value (the thumbnail is part of the indexed
         * projection). Same single-click principle as publish: a
         * visible change to a published record should reach public
         * search without requiring a follow-up metadata refresh.
         */
        await trx(tables.objects)
            .where({ pid })
            .update({
                thumbnail: url,
                display_record: JSON.stringify(parsed),
                is_updated: 1,
            });

        return trx(tables.objects).select(PUBLIC_FIELDS).where({ pid }).first();
    });
}

/*
 * Look up a collection row by its ArchivesSpace URI. Used by the
 * submit-to-ingest pre-flight gate to decide whether to auto-create
 * the local collection mirror. Returns the full row (or undefined),
 * constrained to object_type='collection' so a stray archival_object
 * row with a matching URI can never satisfy the lookup.
 */
async function find_collection_by_uri(uri) {
    if (!uri || typeof uri !== 'string') return undefined;
    return db()(tables.objects)
        .select(PUBLIC_FIELDS)
        .where({ uri, object_type: 'collection' })
        .first();
}

/*
 * Auto-create a collection row from an ArchivesSpace resource record.
 * Called by the ingest pre-flight gate when no local mirror exists
 * for the resource URI.
 * 
 * Required input:
 *   {
 *     uri:    '/repositories/2/resources/1204'
 *     mods:   the raw AS record JSON (object — we stringify here)
 *     pid:    optional — caller-supplied UUID. The handle-minting
 *             flow generates the PID up front (so it can mint
 *             against the same UUID that ends up in the row),
 *             then passes it here. When absent we generate one.
 *     display_record: optional pre-built envelope; if absent we wrap
 *                     `mods` in the canonical envelope shape so the
 *                     dashboard projection finds title/abstract/etc.
 *     handle: optional persistent identifier URL (best-effort —
 *             pass '' if the handle service is unreachable)
 *   }
 * 
 * Sets is_active=1, is_published=0 (staff publishes via the
 * dashboard), is_member_of_collection = parent_collection_pid || ''
 * ('' = top-level root; a PID = a sub-collection nested under that
 * parent). is_updated=1 so the indexer worker picks the new collection
 * up on its next tick.
 */
async function create_collection({
    uri,
    mods,
    pid: caller_pid,
    display_record,
    handle,
    parent_collection_pid,
}) {
    if (!uri || typeof uri !== 'string') {
        throw new ValidationError('uri is required to create a collection');
    }
    if (!mods || typeof mods !== 'object') {
        throw new ValidationError('mods (AS record) is required to create a collection');
    }
    /*
     * Sub-collection: the new collection is a member of an existing parent
     * collection (vs '' = top-level root). Validate the parent is a live
     * collection so we never create an orphan-nested row pointing at a
     * missing / soft-deleted / non-collection PID. Ingest passes no parent,
     * so this is skipped on that path — behavior there is unchanged.
     */
    if (parent_collection_pid) {
        const parent = await db()(tables.objects)
            .where({ pid: parent_collection_pid, object_type: 'collection', is_active: 1 })
            .first();
        if (!parent) {
            throw new ValidationError(
                'parent_collection_pid must reference an active collection'
            );
        }
    }
    const pid = caller_pid || randomUUID();
    const mods_json = JSON.stringify(mods);
    /*
     * If the caller didn't pre-build display_record, wrap the bare
     * metadata in the same envelope shape the metadata-refresh
     * worker writes — `{ display_record: <metadata> }`. The dashboard
     * projection (libs/object_projection.js) reads from the outer
     * envelope's top-level keys (title, abstract, ...), so we hoist
     * those when present so the row renders correctly without a
     * separate metadata refresh.
     */
    const envelope = display_record || {
        display_record: mods,
        title: mods.title || null,
        abstract: typeof mods.abstract === 'string' ? mods.abstract : null,
        f_subjects: Array.isArray(mods.f_subjects) ? mods.f_subjects : [],
    };
    const row = {
        pid,
        object_type: 'collection',
        uri,
        mods: mods_json,
        display_record: JSON.stringify(envelope),
        handle: handle || '',
        is_member_of_collection: parent_collection_pid || '',
        is_active: 1,
        is_published: 0,
        is_compound: 0,
        is_indexed: 0,
        is_restricted: 0,
        is_updated: 1,
    };
    try {
        await db()(tables.objects).insert(row);
    } catch (err) {
        /*
         * Race: a concurrent submit already inserted the same URI.
         * Re-fetch the now-existing row and return it instead of
         * surfacing the constraint error. The unique-on-(uri,
         * object_type) index is the DB-level guard; this branch is
         * the application-level recovery. Match by error-message
         * substring because the wire format differs across drivers
         * (MariaDB: "Duplicate entry"; sqlite: "UNIQUE constraint").
         */
        if (/duplicate|unique/i.test(err.message)) {
            const existing = await find_collection_by_uri(uri);
            if (existing) return existing;
        }
        throw err;
    }
    return get(pid);
}

/*
 * Test/bootstrap helper. Not exposed via routes — production ingest
 * path lands in Phase 8 (ingester merge). Keeps the model self-contained
 * so integration tests can seed without reaching into knex directly.
 */
async function _insert(row) {
    if (!row.pid || !validator.isUUID(row.pid)) {
        throw new ValidationError('pid must be a UUID');
    }
    const [id] = await db()(tables.objects).insert(row);
    return get(row.pid).catch(async () => {
        /*
         * sqlite returns the autoinc id; mysql does too. Fall back to
         * by-id lookup if pid lookup somehow misses (e.g. test races).
         */
        const fallback = await db()(tables.objects).select(PUBLIC_FIELDS).where({ id }).first();
        return fallback;
    });
}

module.exports = {
    PUBLIC_FIELDS,
    ALLOWED_OBJECT_TYPES,
    MAX_BULK_PIDS,
    list,
    list_by_pids,
    list_pids_by_display_record_match,
    cached_title_map,
    _reset_title_map_cache,
    get,
    publish,
    suppress,
    soft_delete,
    bulk_publish,
    bulk_suppress,
    bulk_soft_delete,
    set_thumbnail,
    update_metadata_payload,
    find_collection_by_uri,
    create_collection,
    _insert,
};
