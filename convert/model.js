'use strict';

/*
 * Data layer for TIFF→JPG conversion.
 * 
 *   - Reads candidate objects from the `repo` DB (tbl_objects) — the
 *     same query the legacy post_tiff_convert.py ran: rows in a
 *     collection (or one sip_uuid / pid) that have a non-empty
 *     file_name.
 *   - Writes the work + batch rollup into the `repo_queue` DB
 *     (tbl_convert_queue / tbl_convert_batches).
 * 
 * Two pools, matching the rest of the app: db() = repo,
 * db_queue() = repo_queue. See config/db.js.
 */

const { basename } = require('node:path').posix;

const { db, db_queue } = require('../config/db');
const tables = require('../config/db_tables');
const app_config = require('../config/app');
const { ValidationError } = require('../libs/errors');

const OBJECTS = tables.objects;
const QUEUE = tables.convert_queue;
const BATCHES = tables.convert_batches;

// Columns we need from tbl_objects to build a payload + store the row.
const OBJECT_FIELDS = ['pid', 'sip_uuid', 'file_name', 'mime_type', 'is_member_of_collection'];

const STATUS = Object.freeze({
    PENDING: 'PENDING',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETE: 'COMPLETE',
    FAILED: 'FAILED',
});

/*
 * Build the convert-API payload for one object row. Mirrors
 * post_tiff_convert.py build_object(): full_path is the stored
 * file_name, object_name is its basename.
 */
function build_payload(row) {
    const full_path = row.file_name || '';
    return {
        sip_uuid: row.sip_uuid || '',
        full_path,
        object_name: basename(full_path),
        mime_type: row.mime_type || '',
    };
}

/*
 * Resolve the in-scope objects from the repo DB. Exactly one of
 * {sip_uuid, pid, collection} drives the WHERE; sip_uuid/pid target a
 * single object, collection targets every member. Only rows with a
 * non-empty file_name are eligible (you can't convert what has no
 * source path) — the same filter the legacy script applied.
 */
async function resolve_rows({ collection, sip_uuid, pid, limit } = {}) {
    const q = db()(OBJECTS).select(OBJECT_FIELDS);

    if (sip_uuid) q.where({ sip_uuid });
    else if (pid) q.where({ pid });
    else if (collection) q.where({ is_member_of_collection: collection });
    else throw new ValidationError('A collection, sip_uuid, or pid is required.');

    q.whereNotNull('file_name').whereNot('file_name', '').orderBy('id', 'asc');

    if (limit !== undefined && limit !== null && Number.isFinite(Number(limit))) {
        q.limit(Math.max(1, Number.parseInt(limit, 10)));
    }
    return q;
}

/*
 * Single-object guard, matching the script: a sip_uuid (or pid) is
 * expected to resolve to exactly one row. If it fans out, refuse rather
 * than silently enqueue a surprise multi-POST.
 */
function guard_single(rows, { sip_uuid, pid }) {
    if ((sip_uuid || pid) && rows.length > 1) {
        throw new ValidationError(
            `${sip_uuid ? 'sip_uuid' : 'pid'} matched ${rows.length} rows; expected exactly one. ` +
                `Use a collection batch if you intend to convert multiple objects.`
        );
    }
}

/*
 * Dry-run: resolve + build payloads without enqueuing. Returns the
 * exact count plus a capped sample for display.
 */
async function preview({ collection, sip_uuid, pid, limit } = {}) {
    const rows = await resolve_rows({ collection, sip_uuid, pid, limit });
    guard_single(rows, { sip_uuid, pid });
    const sample_size = app_config().convert_service.preview_sample;
    return {
        count: rows.length,
        sample: rows.slice(0, sample_size).map(build_payload),
        truncated: rows.length > sample_size,
    };
}

/*
 * Enqueue a batch. Creates the rollup row, then bulk-inserts one queue
 * row per object. Returns { batch_id, count, scope_type }.
 */
async function enqueue({ collection, sip_uuid, pid, limit, actor, actor_name } = {}) {
    const cfg = app_config().convert_service;
    const rows = await resolve_rows({ collection, sip_uuid, pid, limit });
    guard_single(rows, { sip_uuid, pid });

    if (rows.length === 0) {
        throw new ValidationError('No matching objects with a file to convert.');
    }
    if (rows.length > cfg.max_batch) {
        throw new ValidationError(
            `Scope resolves to ${rows.length} objects, over the ${cfg.max_batch} per-batch cap ` +
                `(CONVERT_MAX_BATCH). Narrow the scope or raise the cap.`
        );
    }

    const scope_type = sip_uuid || pid ? 'object' : 'collection';

    return db_queue().transaction(async (trx) => {
        /*
         * knex+mysql2 returns [insertId]; better-sqlite3 returns [rowid].
         * Either way the first element is the new batch's numeric id.
         */
        const [batch_id] = await trx(BATCHES).insert({
            scope_type,
            collection: collection || null,
            sip_uuid: sip_uuid || null,
            total: rows.length,
            actor: actor || '',
            actor_name: actor_name || '',
        });

        const queue_rows = rows.map((r) => ({
            batch_id,
            pid: r.pid || null,
            sip_uuid: r.sip_uuid || null,
            collection: r.is_member_of_collection || null,
            file_name: r.file_name || null,
            object_name: basename(r.file_name || ''),
            mime_type: r.mime_type || null,
            status: STATUS.PENDING,
        }));

        /*
         * Chunked insert keeps the single statement well under
         * max_allowed_packet for large collections.
         */
        await trx.batchInsert(QUEUE, queue_rows, 500);

        return { batch_id, count: queue_rows.length, scope_type };
    });
}

/*
 * Atomically claim the next eligible PENDING row, flipping it to
 * IN_PROGRESS. Single-process/single-worker means contention can't
 * really happen, but the transaction keeps the claim correct if the
 * worker is ever run in parallel. Ordered (attempts, id) so retries
 * sit behind fresh work.
 */
async function claim_one() {
    return db_queue().transaction(async (trx) => {
        const row = await trx(QUEUE)
            .where({ status: STATUS.PENDING })
            .orderBy([
                { column: 'attempts', order: 'asc' },
                { column: 'id', order: 'asc' },
            ])
            .first();
        if (!row) return null;
        await trx(QUEUE)
            .where({ id: row.id })
            .update({ status: STATUS.IN_PROGRESS, updated_at: trx.fn.now() });
        return row;
    });
}

function _truncate(s, n = 2000) {
    if (s === null || s === undefined) return null;
    const str = typeof s === 'string' ? s : JSON.stringify(s);
    return str.length > n ? str.slice(0, n) : str;
}

async function mark_complete(id, { http_status = null, body = null } = {}) {
    await db_queue()(QUEUE)
        .where({ id })
        .update({
            status: STATUS.COMPLETE,
            http_status,
            response_body: _truncate(body),
            last_error: null,
            updated_at: db_queue().fn.now(),
        });
}

/*
 * Record a failure. Increments attempts; returns the row to PENDING for
 * another paced attempt until attempts reaches max_attempts, then marks
 * FAILED (terminal). Returns { terminal, attempts }.
 */
async function mark_failed(row, { http_status = null, body = null, error = '' } = {}) {
    const cfg = app_config().convert_service;
    const attempts = (row.attempts || 0) + 1;
    const terminal = attempts >= cfg.max_attempts;
    await db_queue()(QUEUE)
        .where({ id: row.id })
        .update({
            status: terminal ? STATUS.FAILED : STATUS.PENDING,
            attempts,
            http_status,
            response_body: _truncate(body),
            last_error: _truncate(error, 1000),
            updated_at: db_queue().fn.now(),
        });
    return { terminal, attempts };
}

/*
 * Graceful-shutdown release: return an IN_PROGRESS row to PENDING
 * without spending an attempt (we cancelled the request, it didn't fail
 * on its merits).
 */
async function release(id) {
    await db_queue()(QUEUE)
        .where({ id })
        .update({ status: STATUS.PENDING, updated_at: db_queue().fn.now() });
}

/*
 * On worker boot, return any IN_PROGRESS rows (claimed by a process that
 * died mid-request) to PENDING.
 */
async function reset_orphaned() {
    const affected = await db_queue()(QUEUE)
        .where({ status: STATUS.IN_PROGRESS })
        .update({ status: STATUS.PENDING, updated_at: db_queue().fn.now() });
    return { affected };
}

async function _counts_for(where) {
    const rows = await db_queue()(QUEUE)
        .select('status')
        .count({ n: '*' })
        .where(where)
        .groupBy('status');
    const out = { PENDING: 0, IN_PROGRESS: 0, COMPLETE: 0, FAILED: 0 };
    for (const r of rows) out[r.status] = Number(r.n || 0);
    return out;
}

// Snapshot for the dashboard status panel.
async function status_summary() {
    const cfg = app_config().convert_service;

    const latest = await db_queue()(BATCHES).orderBy('id', 'desc').first();

    let latest_counts = null;
    if (latest) {
        const c = await _counts_for({ batch_id: latest.id });
        const done = c.COMPLETE + c.FAILED;
        const total = Number(latest.total) || c.PENDING + c.IN_PROGRESS + c.COMPLETE + c.FAILED;
        latest_counts = {
            pending: c.PENDING,
            in_progress: c.IN_PROGRESS,
            complete: c.COMPLETE,
            failed: c.FAILED,
            total,
            done,
            percent: total > 0 ? Math.floor((done / total) * 100) : 0,
        };
    }

    /*
     * The single row currently being POSTed (if any) — for a live "now
     * converting X" line.
     */
    const current = await db_queue()(QUEUE).where({ status: STATUS.IN_PROGRESS }).first();

    // Overall backlog across all batches.
    const pend = await db_queue()(QUEUE)
        .where({ status: STATUS.PENDING })
        .count({ n: '*' })
        .first();

    // Recent batches + their counts in two queries (no N+1).
    const recent = await db_queue()(BATCHES).orderBy('id', 'desc').limit(8);
    let history = [];
    if (recent.length > 0) {
        const ids = recent.map((b) => b.id);
        const grouped = await db_queue()(QUEUE)
            .select('batch_id', 'status')
            .count({ n: '*' })
            .whereIn('batch_id', ids)
            .groupBy('batch_id', 'status');
        const by_batch = {};
        for (const g of grouped) {
            if (!by_batch[g.batch_id]) {
                by_batch[g.batch_id] = { PENDING: 0, IN_PROGRESS: 0, COMPLETE: 0, FAILED: 0 };
            }
            by_batch[g.batch_id][g.status] = Number(g.n || 0);
        }
        history = recent.map((b) => {
            const c = by_batch[b.id] || { PENDING: 0, IN_PROGRESS: 0, COMPLETE: 0, FAILED: 0 };
            const done = c.COMPLETE + c.FAILED;
            const total = Number(b.total) || done + c.PENDING + c.IN_PROGRESS;
            const active = c.PENDING + c.IN_PROGRESS > 0;
            return {
                id: b.id,
                scope_type: b.scope_type,
                scope_label: b.scope_type === 'object' ? b.sip_uuid : b.collection,
                total,
                complete: c.COMPLETE,
                failed: c.FAILED,
                status: active ? 'running' : c.FAILED > 0 ? 'completed with errors' : 'completed',
                actor: b.actor_name || b.actor || '',
                created_at: b.created_at,
            };
        });
    }

    return {
        configured: Boolean(cfg.url && cfg.api_key),
        enabled: cfg.enabled,
        delay_ms: cfg.delay_ms,
        max_attempts: cfg.max_attempts,
        latest: latest
            ? {
                  id: latest.id,
                  scope_type: latest.scope_type,
                  scope_label: latest.scope_type === 'object' ? latest.sip_uuid : latest.collection,
                  actor: latest.actor_name || latest.actor || '',
                  created_at: latest.created_at,
                  counts: latest_counts,
              }
            : null,
        current: current ? { object_name: current.object_name, attempts: current.attempts } : null,
        pending_total: Number(pend && pend.n) || 0,
        history,
    };
}

module.exports = {
    STATUS,
    build_payload,
    resolve_rows,
    preview,
    enqueue,
    claim_one,
    mark_complete,
    mark_failed,
    release,
    reset_orphaned,
    status_summary,
};
