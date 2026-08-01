'use strict';

/*
 * Ingest queue CRUD. Wraps tbl_ingest_queue + tbl_ingest_events with
 * the lifecycle invariants the worker depends on:
 * 
 *   1. `status` and `pipeline_state` are kept in sync. The model is
 *      the only writer; callers don't manage both. `pipeline_state`
 *      is the canonical column the dashboard reads.
 * 
 *   2. Every `pipeline_state` change writes a row to tbl_ingest_events
 *      with from_state/to_state/event_type/actor/payload. The event
 *      log is append-only — never updated, never deleted.
 * 
 *   3. `severity` and `suggested_action` are auto-populated from
 *      ingester/state_metadata.js whenever a status is written.
 *      Callers can override either by passing them explicitly.
 * 
 *   4. `updated` is bumped on every row UPDATE.
 *
 * All writes to tbl_ingest_queue go through this model; writing knex
 * directly from elsewhere leaves gaps in the event log.
 */

const { db_queue } = require('../config/db');
const tables = require('../config/db_tables');
const { get_status_metadata } = require('./state_metadata');
const { ValidationError } = require('../libs/errors');

const QUEUE = tables.ingest_queue;
const EVENTS = tables.ingest_events;

// --- Helpers ---------------------------------------------------------

/*
 * Stringify a payload for the events row's TEXT column. Returns null
 * for null/undefined so the column reads back as null, not 'null'.
 */
function serialize_payload(payload) {
    if (payload === undefined || payload === null) return null;
    if (typeof payload === 'string') return payload;
    try {
        return JSON.stringify(payload);
    } catch {
        return String(payload);
    }
}

/*
 * Take a caller-supplied update spec and enrich it with the columns
 * the model owns: pipeline_state mirrors status, severity +
 * suggested_action come from state_metadata unless explicitly set,
 * and updated gets bumped to now. Returns a new object (does not
 * mutate input).
 */
function enrich_update(data, knex) {
    const out = { ...data };
    if (data.status !== undefined && data.pipeline_state === undefined) {
        out.pipeline_state = data.status;
    }
    /*
     * Resolve against `out.pipeline_state`, not `data.pipeline_state` —
     * status-only updates have just had their state mirrored onto `out`.
     */
    if (out.pipeline_state !== undefined) {
        const meta = get_status_metadata(out.pipeline_state);
        if (out.severity === undefined) out.severity = meta.severity;
        if (out.suggested_action === undefined) out.suggested_action = meta.suggested_action;
    }
    out.updated = knex.fn.now();
    return out;
}

// --- Public surface -------------------------------------------------

/*
 * Bulk-insert N queue rows in a single transaction. Each row is
 * enriched (pipeline_state, severity, suggested_action) and gets an
 * 'created' event in the audit log.
 * 
 * `rows` should look like:
 *   [{ batch, package, job_uuid, collection_uuid, status='PENDING',
 *      metadata_uri, metadata, ... }, ...]
 * 
 * Returns the array of inserted row ids in input order.
 */
async function queue_packages(rows, { actor = 'system' } = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new ValidationError('rows must be a non-empty array');
    }
    const knex = db_queue();
    return knex.transaction(async (trx) => {
        const ids = [];
        for (const row of rows) {
            const data = enrich_update(
                { status: row.status || 'PENDING', ...row, is_complete: row.is_complete || 0 },
                knex
            );
            /*
             * knex on MySQL returns [insertId]; on SQLite, just the
             * autoincrement value. Normalize.
             */
            const result = await trx(QUEUE).insert(data);
            const id = Array.isArray(result) ? result[0] : result;
            ids.push(id);
            await trx(EVENTS).insert({
                queue_id: id,
                from_state: null,
                to_state: data.pipeline_state || 'PENDING',
                event_type: 'state_change',
                actor,
                payload: serialize_payload({
                    note: 'row created',
                    batch: row.batch,
                    package: row.package,
                }),
            });
        }
        return ids;
    });
}

/*
 * Update one or more queue rows. Mirrors status → pipeline_state,
 * auto-fills severity + suggested_action, bumps `updated`, and writes
 * an event row for EACH affected queue row IF the pipeline_state
 * actually changes. Same-state updates are silent (no event spam).
 * 
 * `where` is a knex-compatible criteria object (e.g. `{ id: 42 }` or
 * `{ package: 'object-001' }`). `data` is whatever columns to set;
 * most callers pass at least `status`.
 * 
 * `opts.actor` is recorded on the event; defaults to 'system' for
 * worker writes. `opts.event_type` overrides the default
 * 'state_change' (used by staff actions: 'rollback', 'reset', etc.).
 * `opts.payload` is attached to the event row as JSON.
 */
async function update_queue(where, data, opts = {}) {
    if (!where || typeof where !== 'object') {
        throw new ValidationError('where clause is required');
    }
    if (!data || typeof data !== 'object') {
        throw new ValidationError('update data is required');
    }
    /*
     * One-shot retry on an optimistic-concurrency conflict. Re-runs the
     * whole transaction, so the event log still records the correct
     * from→to transition.
     */
    try {
        return await _update_queue_txn(where, data, opts);
    } catch (err) {
        if (_is_concurrent_modification(err)) {
            return _update_queue_txn(where, data, opts);
        }
        throw err;
    }
}

async function _update_queue_txn(where, data, opts) {
    const knex = db_queue();
    return knex.transaction(async (trx) => {
        /*
         * Read current state for the affected rows BEFORE the update,
         * so we can compute the from_state for the event log.
         */
        const before = await trx(QUEUE).where(where).select('id', 'pipeline_state');
        if (before.length === 0) return { affected: 0, ids: [] };

        const enriched = enrich_update(data, knex);
        const affected = await trx(QUEUE).where(where).update(enriched);

        /*
         * Write events only for rows whose pipeline_state actually
         * changed. Defensive: if the update didn't include a status/
         * pipeline_state, no transition — no event.
         */
        if (enriched.pipeline_state !== undefined) {
            const event_type = opts.event_type || 'state_change';
            const actor = opts.actor || 'system';
            const payload_str = serialize_payload(opts.payload);
            for (const row of before) {
                if (row.pipeline_state === enriched.pipeline_state) continue;
                await trx(EVENTS).insert({
                    queue_id: row.id,
                    from_state: row.pipeline_state || null,
                    to_state: enriched.pipeline_state,
                    event_type,
                    actor,
                    payload: payload_str,
                });
            }
        }

        return { affected, ids: before.map((r) => r.id) };
    });
}

/*
 * Append an informational event to a queue row's timeline without
 * touching the queue row itself — for marking long windows that have
 * no pipeline_state transition of their own.
 *
 * `to_state` is required and renders as the event label; `from_state`
 * defaults to null so the entry reads as a single label rather than a
 * transition.
 */
async function insert_event(
    queue_id,
    { event_type = 'info', actor = 'system', from_state = null, to_state, payload } = {}
) {
    if (!queue_id) throw new ValidationError('queue_id is required');
    if (!to_state) throw new ValidationError('to_state is required');
    return db_queue()(EVENTS).insert({
        queue_id,
        from_state,
        to_state,
        event_type,
        actor,
        payload: serialize_payload(payload),
    });
}

/*
 * Detect MariaDB's optimistic row-version conflict. Matched by message
 * substring rather than errno, because mysql2 surfaces the condition
 * under different codes across MariaDB releases.
 */
function _is_concurrent_modification(err) {
    if (!err || !err.message) return false;
    return /Record has changed since last read/i.test(err.message);
}

// Convenience: fetch one queue row by id or by (batch, package).
async function get_queue_row(criteria) {
    return db_queue()(QUEUE).where(criteria).first();
}

/*
 * List queue rows, newest first. Used by the dashboard listing.
 * Optional filters: status, batch, is_complete.
 */
async function list_queue(filters = {}, { limit = 100, offset = 0 } = {}) {
    const q = db_queue()(QUEUE);
    if (filters.status) q.where({ status: filters.status });
    if (filters.batch) q.where({ batch: filters.batch });
    if (filters.is_complete !== undefined) q.where({ is_complete: filters.is_complete ? 1 : 0 });
    /* Join key to tbl_aip_store rows (AM's SIP UUID). */
    if (filters.sip_uuid) q.where({ sip_uuid: filters.sip_uuid });
    /*
     * Hide the synthetic backfill rows (batch='aip-backfill-<uuid>')
     * that ingester/aip_backfill.js inserts. Opt-in: the worker leaves
     * the flag off so its claim queries still pick them up.
     */
    if (filters.exclude_backfill) q.whereNot('batch', 'like', 'aip-backfill-%');
    return q.orderBy('id', 'desc').limit(limit).offset(offset);
}

/*
 * Count non-complete rows whose pipeline_state is in `states`. Drives
 * the worker's AM-active gate. Returns a plain number.
 */
async function count_rows_in_states(states) {
    if (!Array.isArray(states) || states.length === 0) return 0;
    const row = await db_queue()(QUEUE)
        .whereIn('pipeline_state', states)
        .andWhere({ is_complete: 0 })
        .count('* as n')
        .first();
    return row ? Number(row.n) : 0;
}

/*
 * Read the timeline (event log) for a queue row, oldest first. The
 * dashboard row-detail view renders this as a stacked list. Returns
 * payload parsed if it's JSON, raw string otherwise — convenience for
 * the EJS template, which doesn't want to do its own JSON.parse.
 */
async function get_timeline(queue_id) {
    const rows = await db_queue()(EVENTS).where({ queue_id }).orderBy('id', 'asc');
    return rows.map((r) => ({
        ...r,
        payload: parse_payload(r.payload),
    }));
}

function parse_payload(p) {
    if (!p) return null;
    if (typeof p !== 'string') return p;
    try {
        return JSON.parse(p);
    } catch {
        return p; // raw string; that's fine for display
    }
}

/*
 * States that mean "the worker was mid-step". At startup, rows in
 * these are reset to PENDING so the stage restarts cleanly.
 *
 * Wait states (WAITING_FOR_DURACLOUD, TRANSFER_IN_PROGRESS, …) are
 * excluded: those are waiting on an external system and are resumed in
 * place rather than restarted.
 */
const ACTIVELY_RUNNING_STATES = new Set([
    'STARTING',
    'UPLOADING',
    'REPLICATING_PACKAGE',
    'CONSTRUCTED_OBJECT_PATHS',
    'METADATA_RECORD_PARTS_UPDATED',
    'CREATING_REPOSITORY_RECORD',
]);

/*
 * Staff-initiated cancel of an in-flight row. Flips the row's
 * pipeline_state to CANCELLED_BY_USER and records an audit event
 * whose payload carries the PRIOR state — the dashboard's
 * `available_actions(state, prev_state)` consults that to pick
 * the right rollback target (pre-AM vs AM-side).
 * 
 * Guarded against:
 *   - terminal rows (COMPLETE, *_TIMEOUT, FAILED, INGEST_HALTED,
 *     CANCELLED_BY_USER, ROLLED_BACK_TO_READY, AM_DELETION_REQUESTED)
 *     — no-op, returns { ok:false, reason:'already_terminal' }.
 *   - rows that don't exist — throws NotFoundError.
 *
 * Signalling the worker's AbortController is the caller's job;
 * controller.cancel_row pairs the two.
 */
async function cancel(id, { actor = 'system', reason = 'Cancelled by staff' } = {}) {
    const row = await get_queue_row({ id });
    if (!row) {
        const err = new Error(`queue row ${id} not found`);
        err.code = 'NOT_FOUND';
        err.status = 404;
        throw err;
    }
    /*
     * Anything in a terminal/halted state is left alone. The
     * dashboard caller surfaces this as a toast — easier UX than
     * hiding the kebab item the instant a timeout fires.
     */
    if (TERMINAL_FOR_CANCEL.has(row.pipeline_state)) {
        return {
            ok: false,
            reason: 'already_terminal',
            current_state: row.pipeline_state,
        };
    }
    const r = await update_queue(
        { id },
        { status: 'CANCELLED_BY_USER', error: reason },
        {
            actor,
            event_type: 'staff_action',
            payload: { action: 'cancel', from: row.pipeline_state, reason },
        }
    );
    return { ok: true, affected: r.affected, prev_state: row.pipeline_state };
}

/*
 * Read the row's prior pipeline_state from the audit log. Used by
 * the dashboard to decide which rollback action to show after a
 * cancel — see state_metadata.available_actions(state, prev_state).
 * Returns null if no cancel event exists for the row.
 */
async function get_prev_state_for_cancel(id) {
    const knex = db_queue();
    const row = await knex(EVENTS)
        .where({ queue_id: id, event_type: 'staff_action', to_state: 'CANCELLED_BY_USER' })
        .orderBy('created_at', 'desc')
        .first();
    if (!row || !row.payload) return null;
    try {
        const parsed = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        return (parsed && parsed.from) || null;
    } catch {
        return null;
    }
}

/*
 * States that block a cancel. These are either already terminal
 * (no further work to abort) or already in a staff-cleanup state
 * (cancel would muddy the audit log).
 */
const TERMINAL_FOR_CANCEL = new Set([
    'COMPLETE',
    'CANCELLED_BY_USER',
    'INGEST_HALTED',
    'UPLOAD_TIMEOUT',
    'APPROVE_TIMEOUT',
    'TRANSFER_STATUS_TIMEOUT',
    'INGEST_STATUS_TIMEOUT',
    'DURACLOUD_TIMEOUT',
    'FAILED',
    'AS_METADATA_DRIFT',
    'AS_METADATA_INVALID',
    'ROLLED_BACK_TO_READY',
    'RETURNED_TO_PACKAGING',
    'AM_DELETION_REQUESTED',
]);

/*
 * Finalize COMPLETE rows left at is_complete=0 by a worker that died
 * during Stage 5's post-hold window. Idempotent, and writes no event —
 * Stage 5 already recorded COMPLETE; this touches is_complete only.
 */
async function finalize_pending_completes() {
    const knex = db_queue();
    const affected = await knex(QUEUE)
        .where({ pipeline_state: 'COMPLETE', is_complete: 0 })
        .update({ is_complete: 1, updated: knex.fn.now() });
    return { affected };
}

async function reset_orphaned({ actor = 'system' } = {}) {
    const knex = db_queue();
    const candidates = await knex(QUEUE)
        .whereIn('pipeline_state', [...ACTIVELY_RUNNING_STATES])
        .andWhere({ is_complete: 0 })
        .select('id', 'pipeline_state');
    if (candidates.length === 0) return { affected: 0 };

    /* Per-row update_queue so the events log captures each reset. */
    let affected = 0;
    for (const row of candidates) {
        const r = await update_queue(
            { id: row.id },
            { status: 'PENDING' },
            { actor, event_type: 'orphan_reset', payload: { from: row.pipeline_state } }
        );
        affected += r.affected;
    }
    return { affected };
}

/*
 * Test/integration helper. Hard-deletes everything (queue rows AND
 * their events) for a given batch — useful for tests that want to
 * reset state cleanly. Never call from production code; rollback is
 * a different concept (staff-initiated, audited via update_queue).
 */
async function _purge_batch(batch) {
    const knex = db_queue();
    return knex.transaction(async (trx) => {
        const ids = (await trx(QUEUE).where({ batch }).select('id')).map((r) => r.id);
        if (ids.length === 0) return { queue: 0, events: 0 };
        const events = await trx(EVENTS).whereIn('queue_id', ids).del();
        const queue = await trx(QUEUE).where({ batch }).del();
        return { queue, events };
    });
}

module.exports = {
    queue_packages,
    update_queue,
    insert_event,
    get_queue_row,
    list_queue,
    count_rows_in_states,
    get_timeline,
    reset_orphaned,
    finalize_pending_completes,
    cancel,
    get_prev_state_for_cancel,
    ACTIVELY_RUNNING_STATES,
    _purge_batch,
};
