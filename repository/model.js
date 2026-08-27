'use strict';

/*
 * CRUD against tbl_objects.
 *
 *   list / get / list_by_pids          reads; `pid` is the UUID, not the
 *                                      autoinc id
 *   cached_title_map                   pid → lowercased title, TTL-cached
 *   list_pids_by_display_record_match  LIKE over the display_record JSON
 *   publish / suppress                 is_published 1 | 0
 *   soft_delete                        is_active = 0, delete_id stamped
 *   bulk_publish / bulk_suppress / bulk_soft_delete
 *   set_thumbnail / update_metadata_payload
 *   find_collection_by_uri / create_collection
 *
 * Every write that changes what public search should show also sets
 * is_updated=1, which is what makes the indexer claim the row on its next tick.
 */

const { randomUUID } = require('node:crypto');
const validator = require('validator');

const { db } = require('../config/db');
const tables = require('../config/db_tables');
const archivematica = require('../libs/archivematica');
const log = require('../libs/log');
const projection = require('../libs/object_projection');
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
     * Longtext JSON snapshot carrying title/abstract/handle/subjects. The
     * dashboard enriches each row through libs/object_projection at render
     * time so tables can show titles rather than PIDs.
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
     * A 'YYYY-MM-DD HH:MM:SS' UTC cutoff. `created` is a TIMESTAMP stored in
     * that same fixed-width format, so a string compare is chronological.
     */
    if (filter.created_since) q.where('created', '>=', filter.created_since);
    // Keeps nested sub-collections out of a parent's member-object list.
    if (filter.exclude_collections) q.whereNot({ object_type: 'collection' });

    // Total before pagination.
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
 * Batch-read by pid list. Returns the rows that exist, in any order, so the
 * caller indexes by pid. Empty input gives empty output and missing pids are
 * omitted silently — callers needing a hard error should `get()` per pid.
 */
async function list_by_pids(pids) {
    if (!Array.isArray(pids) || pids.length === 0) return [];
    return db()(tables.objects).select(PUBLIC_FIELDS).whereIn('pid', pids);
}

/*
 * Cached pid → lowercased-title map over ALL objects, for callers that need to
 * ORDER BY title across a whole result set. Titles live only inside the
 * display_record JSON, so they are extracted here in JS rather than by SQL, and
 * held behind a 60s TTL — a just-refreshed title sorts by its old value for at
 * most that long.
 *
 * Chunked by id, so peak memory holds one 5k-row slice rather than the table.
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
 * Pids whose display_record text contains `q` — the LIKE-over-JSON approach
 * search/model.js uses, projected down to bare pids and capped at `limit` so a
 * broad term cannot balloon the caller's whereIn.
 */
async function list_pids_by_display_record_match(q, limit = 500) {
    // Under 3 chars returns nothing, mirroring search/model quick_lookup.
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
 * Publish gate: a row must not go public while its parent collection is
 * unpublished — public search would list it with a collection link that
 * 404s (three such orphans were live when this gate was added). Applies
 * to objects AND nested sub-collections alike: anything whose parent is
 * a real collection pid. Two parents pass unchecked — 'codu:root'
 * (top-level collections have no gated parent) and a parent pid with no
 * row (legacy rows with dangling references must stay publishable).
 *
 * Takes the target rows' parent pids; returns Map<parent_pid, title>
 * of the parents that block publishing (empty Map = allowed).
 */
async function _unpublished_parents(parent_pids) {
    const real = [...new Set(parent_pids.filter((p) => p && validator.isUUID(String(p))))];
    if (real.length === 0) return new Map();
    const rows = await db()(tables.objects)
        .select('pid', 'display_record')
        .whereIn('pid', real)
        .where({ object_type: 'collection', is_published: 0 });
    const blocked = new Map();
    for (const r of rows) {
        const title = projection.parse_display_record(r.display_record).title;
        blocked.set(r.pid, title || r.pid);
    }
    return blocked;
}

/*
 * Publish and suppress BOTH set is_updated=1, so the indexer claims the row on
 * its next tick. Its eligibility check (is_published=1 AND is_active=1) then
 * decides what to do:
 *   - publish  → eligible   → INDEX with the current display_record
 *   - suppress → ineligible → DELETE from ES
 *
 * Publishing is gated on the parent collection being published (see
 * _unpublished_parents); suppress has no gate.
 */
async function set_publish_state(pid, value) {
    require_pid(pid);
    if (value) {
        const row = await db()(tables.objects)
            .select('pid', 'is_member_of_collection')
            .where({ pid })
            .first();
        if (!row) throw new NotFoundError(`Object ${pid} not found`);
        const blocked = await _unpublished_parents([row.is_member_of_collection]);
        if (blocked.size > 0) {
            const [title] = blocked.values();
            throw new ValidationError(
                `Cannot publish: this item's collection ("${title}") is unpublished. ` +
                    'Publish the collection first, then its items.'
            );
        }
    }
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
 * Soft-delete a single object, in three steps:
 *   1. Read the row and refuse if it is published — staff suppress first.
 *      There is no force override.
 *   2. Submit an AIP deletion request to Archivematica. Best-effort: an AM
 *      hiccup does not block the user-visible soft-delete.
 *   3. Set is_active=0 with is_updated=1, so the indexer removes the row from
 *      Elasticsearch on its next tick.
 *
 * `delete_reason` is required and is forwarded to AM as the deletion request's
 * event_reason. `actor` (the JWT principal) is prepended to that text so the
 * audit record names a human.
 *
 * Returns { ok: true, delete_id, am }, where delete_id is AM's request id on
 * success and a fresh UUID otherwise. Inspect `am.ok` to tell them apart.
 */
async function soft_delete(pid, { delete_reason, actor } = {}) {
    require_pid(pid);
    _validate_delete_reason(delete_reason);

    // Read first, so the published guard runs BEFORE any AM call.
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

    // is_updated=1 so the indexer claims the now-ineligible row and DELETEs it.
    const affected = await db()(tables.objects)
        .where({ pid, is_active: 1 })
        .update({ is_active: 0, delete_id: am.delete_id, is_updated: 1 });
    if (affected === 0) {
        // A concurrent delete won between the SELECT and the UPDATE.
        throw new NotFoundError(`Active object ${pid} not found`);
    }
    return { ok: true, delete_id: am.delete_id, am };
}

/*
 * Submit an AM deletion request for one row. NEVER throws — returns a
 * structured outcome the caller folds into the delete result:
 *
 *   { ok: true,  delete_id, status, skipped? }
 *   { ok: false, delete_id, error, status? }
 *
 * `delete_id` is always populated, so the caller can stamp the audit column
 * unconditionally: AM's request id on success, a fresh UUID otherwise.
 */
async function _request_aip_delete_safely(row, delete_reason, actor) {
    // Legacy / hand-imported rows never went through Stage 3 — no SIP to delete.
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
            // AM's 202 carries the request id in data.id, sometimes data.uuid.
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
 * The event_reason text AM stores against the deletion request:
 * "Deleted by <actor> on <YYYY-MM-DD>. Reason: <reason>", capped at 1000 chars.
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
 * Each takes an array of pids, validates them all up front, and applies the
 * change in a single SQL UPDATE. All three:
 *   - Cap at MAX_BULK_PIDS (100); above that the controller chunks.
 *   - De-duplicate the input, which would otherwise inflate `affected`.
 *   - Return { affected, pids } with the validated/deduped list, so the
 *     controller can re-render exactly the rows the user selected.
 *   - Skip is_active=0 rows on publish/suppress, so a stale UI cannot bring a
 *     soft-deleted row back to life.
 *
 * Partial misses do not throw: the affected count reports what happened.
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
    if (value) {
        /*
         * Same gate as the single path, whole-batch semantics matching
         * bulk_soft_delete: if ANY selected row sits in an unpublished
         * collection, reject the entire batch — a partial publish would
         * leave staff guessing which rows went through.
         */
        const rows = await db()(tables.objects)
            .select('pid', 'is_member_of_collection')
            .whereIn('pid', unique)
            .andWhere('is_active', 1);
        const blocked = await _unpublished_parents(rows.map((r) => r.is_member_of_collection));
        if (blocked.size > 0) {
            const affected_count = rows.filter((r) =>
                blocked.has(r.is_member_of_collection)
            ).length;
            const titles = [...blocked.values()];
            const shown = titles
                .slice(0, 3)
                .map((t) => `"${t}"`)
                .join(', ');
            const more = titles.length > 3 ? ` and ${titles.length - 3} more` : '';
            throw new ValidationError(
                `Cannot publish: ${affected_count} of the selected item${
                    affected_count === 1 ? ' belongs' : 's belong'
                } to unpublished collection${titles.length === 1 ? '' : 's'} ` +
                    `(${shown}${more}). Publish the collection${
                        titles.length === 1 ? '' : 's'
                    } first. Nothing was published.`
            );
        }
    }
    // is_updated=1 on both paths — see set_publish_state above.
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
 * Bulk soft-delete, mirroring the single-row path:
 *
 *   1. Validate the input and look up every row. If ANY row is published,
 *      reject the WHOLE batch; staff suppress and retry.
 *   2. Fire one AM deletion request per row, serially. Best-effort: failures
 *      are recorded but do not abort the transaction.
 *   3. Soft-delete every row inside one transaction, using AM's returned
 *      request id as the delete_id where available.
 *
 * Returns { affected, pids, am_failed, am_outcomes }, where am_outcomes carries
 * the per-row AM result so the caller can name the rows with AM-side problems.
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

    // Serial, so AM never sees up to 100 concurrent delete_aip calls.
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
 * Update an object's metadata payload from a fresh ArchivesSpace fetch, in one
 * statement, setting is_updated=1. Returns { affected }.
 *
 * `payload` fields, all optional but at least one required:
 *   mods           — full ASpace JSON, stringified
 *   display_record — denormalized envelope, stringified
 *   compound_parts — '[]' for simple objects, the parts array for compound ones
 *   is_compound    — 0 | 1
 *
 * Does NOT touch is_indexed — that flag belongs to the indexer.
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
 * Update an object's thumbnail URL. Writes the column AND mirrors the URL into
 * the display_record JSON, in one transaction so the two cannot diverge — the
 * indexer reads display_record, the dashboard reads either.
 *
 * Returns the refreshed row for the caller to render.
 */
async function set_thumbnail(pid, url) {
    require_pid(pid);
    if (typeof url !== 'string' || url.length === 0) {
        throw new ValidationError('thumbnail url is required');
    }
    // Only http(s) reaches the DB, guarding against a caller passing user input.
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
             * sqlite (the test driver) has no FOR UPDATE and knex throws when
             * asked. Its BEGIN IMMEDIATE still serializes writers.
             */
            .catch(async (err) => {
                if (/forUpdate|FOR UPDATE/i.test(String(err && err.message))) {
                    return trx(tables.objects).select(PUBLIC_FIELDS).where({ pid }).first();
                }
                throw err;
            });
        if (!row) throw new NotFoundError(`Object ${pid} not found`);

        // A malformed blob leaves parsed={}, replacing it with just {thumbnail}.
        let parsed = {};
        if (row.display_record) {
            try {
                const candidate = JSON.parse(row.display_record);
                if (candidate && typeof candidate === 'object') parsed = candidate;
            } catch {
                /* Corrupt display_record — overwrite rather than fail the edit. */
            }
        }
        parsed.thumbnail = url;

        // is_updated=1: the thumbnail is part of the indexed projection.
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
 * Look up a collection row by its ArchivesSpace URI; returns the row or
 * undefined. Constrained to object_type='collection', so a stray
 * archival_object row with a matching URI can never satisfy the lookup.
 */
async function find_collection_by_uri(uri) {
    if (!uri || typeof uri !== 'string') return undefined;
    return db()(tables.objects)
        .select(PUBLIC_FIELDS)
        .where({ uri, object_type: 'collection' })
        .first();
}

/*
 * Create a collection row from an ArchivesSpace record.
 *
 *   uri     required — '/repositories/2/resources/1204'
 *   mods    required — the raw AS record JSON, stringified here
 *   pid     optional — caller-supplied UUID. The handle-minting flow generates
 *                      the PID up front so it can mint against the same UUID
 *                      that ends up in the row. Generated when absent.
 *   display_record  optional — pre-built envelope; when absent `mods` is
 *                              wrapped in the canonical envelope shape
 *   handle  optional — persistent identifier URL; '' when the handle service
 *                      is unreachable
 *   parent_collection_pid  optional — must be an active collection
 *
 * Sets is_active=1, is_published=0 (staff publish from the dashboard),
 * is_updated=1, and is_member_of_collection = parent_collection_pid || ''
 * ('' is top level; a PID nests it under that parent).
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
     * Reject a parent that is missing, soft-deleted, or not a collection, so
     * no orphan-nested row can be created. Ingest passes no parent.
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
     * The same envelope shape the metadata-refresh worker writes:
     * `{ display_record: <metadata> }` with title/abstract/f_subjects hoisted
     * to the top level, where libs/object_projection.js reads them.
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
         * A concurrent submit inserted the same URI first — return its row
         * rather than the constraint error. Matched by message substring
         * because drivers differ: MariaDB "Duplicate entry", sqlite "UNIQUE
         * constraint".
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
 * Test/bootstrap helper, not exposed via routes — production rows are written
 * by the ingester. Lets integration tests seed without reaching into knex.
 */
async function _insert(row) {
    if (!row.pid || !validator.isUUID(row.pid)) {
        throw new ValidationError('pid must be a UUID');
    }
    const [id] = await db()(tables.objects).insert(row);
    return get(row.pid).catch(async () => {
        // Fall back to the autoinc id if the pid lookup misses (test races).
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
