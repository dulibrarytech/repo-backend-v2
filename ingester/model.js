'use strict';

// Ingest queue CRUD. Wraps tbl_ingest_queue + tbl_ingest_events with
// the lifecycle invariants the worker depends on:
//
//   1. `status` and `pipeline_state` are kept in sync. The model is
//      the only writer; callers don't manage both. `pipeline_state`
//      is the canonical column the dashboard reads.
//
//   2. Every `pipeline_state` change writes a row to tbl_ingest_events
//      with from_state/to_state/event_type/actor/payload. The event
//      log is append-only — never updated, never deleted.
//
//   3. `severity` and `suggested_action` are auto-populated from
//      ingester/state_metadata.js whenever a status is written.
//      Callers can override either by passing them explicitly.
//
//   4. `updated` is bumped on every row UPDATE. Used by the dashboard
//      to sort by recent activity and by the worker's orphan recovery
//      logic to find rows that haven't progressed in a while.
//
// The model is intentionally narrow: the worker + the dashboard call
// these functions, not knex directly. Anyone tempted to UPDATE
// tbl_ingest_queue from elsewhere should add a method here instead —
// otherwise the event log silently develops gaps.

const { db_queue } = require('../config/db');
const tables = require('../config/db_tables');
const { get_status_metadata } = require('./state_metadata');
const { ValidationError } = require('../libs/errors');

const QUEUE = tables.ingest_queue;
const EVENTS = tables.ingest_events;

// --- Helpers ---------------------------------------------------------

// Stringify a payload for the events row. We store JSON in a TEXT
// column to stay portable across MariaDB + SQLite (the latter only
// recently learned native JSON). Returns null for null/undefined so
// the column reads cleanly back as null, not 'null'.
function serialize_payload(payload) {
    if (payload === undefined || payload === null) return null;
    if (typeof payload === 'string') return payload;
    try {
        return JSON.stringify(payload);
    } catch {
        return String(payload);
    }
}

// Take a caller-supplied update spec and enrich it with the columns
// the model owns: pipeline_state mirrors status, severity +
// suggested_action come from state_metadata unless explicitly set,
// and updated gets bumped to now. Returns a new object (does not
// mutate input).
function enrich_update(data, knex) {
    const out = { ...data };
    if (data.status !== undefined && data.pipeline_state === undefined) {
        out.pipeline_state = data.status;
    }
    // Look up severity/suggested_action against the *resolved*
    // pipeline_state on `out`, not the raw `data` — the common caller
    // pattern is to pass only `status`, which the mirror step above
    // has just copied into `out.pipeline_state`. Reading `data.pipeline_state`
    // here would skip metadata population for every status-only update.
    if (out.pipeline_state !== undefined) {
        const meta = get_status_metadata(out.pipeline_state);
        if (out.severity === undefined) out.severity = meta.severity;
        if (out.suggested_action === undefined) out.suggested_action = meta.suggested_action;
    }
    out.updated = knex.fn.now();
    return out;
}

// --- Public surface -------------------------------------------------

// Bulk-insert N queue rows in a single transaction. Each row is
// enriched (pipeline_state, severity, suggested_action) and gets an
// 'created' event in the audit log.
//
// `rows` should look like:
//   [{ batch, package, job_uuid, collection_uuid, status='PENDING',
//      metadata_uri, metadata, ... }, ...]
//
// Returns the array of inserted row ids in input order.
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
            // knex on MySQL returns [insertId]; on SQLite, just the
            // autoincrement value. Normalize.
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

// Update one or more queue rows. Mirrors status → pipeline_state,
// auto-fills severity + suggested_action, bumps `updated`, and writes
// an event row for EACH affected queue row IF the pipeline_state
// actually changes. Same-state updates are silent (no event spam).
//
// `where` is a knex-compatible criteria object (e.g. `{ id: 42 }` or
// `{ package: 'object-001' }`). `data` is whatever columns to set;
// most callers pass at least `status`.
//
// `opts.actor` is recorded on the event; defaults to 'system' for
// worker writes. `opts.event_type` overrides the default
// 'state_change' (used by staff actions: 'rollback', 'reset', etc.).
// `opts.payload` is attached to the event row as JSON.
async function update_queue(where, data, opts = {}) {
    if (!where || typeof where !== 'object') {
        throw new ValidationError('where clause is required');
    }
    if (!data || typeof data !== 'object') {
        throw new ValidationError('update data is required');
    }
    // One-shot retry on optimistic-concurrency conflicts. MariaDB
    // throws "Record has changed since last read in table" when a
    // concurrent transaction commits a write to the same row between
    // our SELECT and UPDATE. Callers (esp. the worker's stage code)
    // are supposed to serialize their own writes, but the retry is
    // here as a belt-and-braces guard against any race that slips
    // through. The retry re-runs the whole txn from scratch, so the
    // event log still records the correct from→to transition.
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
        // Read current state for the affected rows BEFORE the update,
        // so we can compute the from_state for the event log.
        const before = await trx(QUEUE).where(where).select('id', 'pipeline_state');
        if (before.length === 0) return { affected: 0, ids: [] };

        const enriched = enrich_update(data, knex);
        const affected = await trx(QUEUE).where(where).update(enriched);

        // Write events only for rows whose pipeline_state actually
        // changed. Defensive: if the update didn't include a status/
        // pipeline_state, no transition — no event.
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

// MariaDB throws this specific error text when an InnoDB optimistic
// row-version check fails between SELECT and UPDATE inside a
// transaction. (Same family as ER_LOCK_DEADLOCK / ER_LOCK_WAIT_TIMEOUT,
// but distinct: this one fires under READ COMMITTED + concurrent
// writer.) We match by substring rather than errno because the
// underlying mysql2 driver versions surface the condition under
// different codes across MariaDB releases.
function _is_concurrent_modification(err) {
    if (!err || !err.message) return false;
    return /Record has changed since last read/i.test(err.message);
}

// Convenience: fetch one queue row by id or by (batch, package).
async function get_queue_row(criteria) {
    return db_queue()(QUEUE).where(criteria).first();
}

// List queue rows, newest first. Used by the dashboard listing.
// Optional filters: status, batch, is_complete.
async function list_queue(filters = {}, { limit = 100, offset = 0 } = {}) {
    const q = db_queue()(QUEUE);
    if (filters.status) q.where({ status: filters.status });
    if (filters.batch) q.where({ batch: filters.batch });
    if (filters.is_complete !== undefined) q.where({ is_complete: filters.is_complete ? 1 : 0 });
    // sip_uuid lookup is used by the AIPs dashboard's retry action
    // to find the ingest queue row corresponding to a tbl_aip_store
    // row. The natural join key is AM's SIP UUID (which we stored on
    // the aip_store row as aip_uuid at copy time).
    if (filters.sip_uuid) q.where({ sip_uuid: filters.sip_uuid });
    // The AIP backfill (ingester/aip_backfill.js) inserts synthetic
    // queue rows with batch='aip-backfill-<uuid>'. They drive Stage 6
    // for already-ingested objects and are real work — the WORKER
    // must see them — but the regular ingest queue dashboard would
    // get noisy if they showed up alongside actual ingest jobs.
    // Callers opt in to hiding them; the worker leaves the flag off
    // so its claim queries still pick them up.
    if (filters.exclude_backfill) q.whereNot('batch', 'like', 'aip-backfill-%');
    return q.orderBy('id', 'desc').limit(limit).offset(offset);
}

// Count non-complete rows whose pipeline_state is in `states`.
// Used by the worker's AM-active gate (see ingester/worker.js) to
// decide whether it's safe to admit a new package into Archivematica.
// Cheap — indexed status lookup with COUNT(*) and a small whereIn set.
// Returns a plain number (not a knex object) so callers don't need
// to know about driver quirks.
async function count_rows_in_states(states) {
    if (!Array.isArray(states) || states.length === 0) return 0;
    const row = await db_queue()(QUEUE)
        .whereIn('pipeline_state', states)
        .andWhere({ is_complete: 0 })
        .count('* as n')
        .first();
    return row ? Number(row.n) : 0;
}

// Read the timeline (event log) for a queue row, oldest first. The
// dashboard row-detail view renders this as a stacked list. Returns
// payload parsed if it's JSON, raw string otherwise — convenience for
// the EJS template, which doesn't want to do its own JSON.parse.
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

// Orphan recovery. Called at worker startup: any row whose pipeline_state
// indicates "actively running" (not a terminal or wait state) gets
// moved back to PENDING so the worker can pick it up cleanly. This
// mirrors metadata/worker.js's reset_orphaned but is keyed off a
// different state set because the ingest pipeline has more stages.
//
// The set of "actively running" states is fixed here — the worker
// puts a row into one of these, then advances OR halts. If we see one
// after a process restart, the worker died mid-step and the row needs
// to start its current stage over.
//
// We deliberately exclude WAIT states (e.g. WAITING_FOR_DURACLOUD,
// TRANSFER_IN_PROGRESS) — those are "we're waiting on an external
// system to do something" and don't need to restart from PENDING;
// the resume logic in Phase 3 will reconcile with the external state.
const ACTIVELY_RUNNING_STATES = new Set([
    'STARTING',
    'UPLOADING',
    'REPLICATING_PACKAGE',
    'CONSTRUCTED_OBJECT_PATHS',
    'METADATA_RECORD_PARTS_UPDATED',
    'CREATING_REPOSITORY_RECORD',
]);

// Staff-initiated cancel of an in-flight row. Flips the row's
// pipeline_state to CANCELLED_BY_USER and records an audit event
// whose payload carries the PRIOR state — the dashboard's
// `available_actions(state, prev_state)` consults that to pick
// the right rollback target (pre-AM vs AM-side).
//
// Guarded against:
//   - terminal rows (COMPLETE, *_TIMEOUT, FAILED, INGEST_HALTED,
//     CANCELLED_BY_USER, ROLLED_BACK_TO_READY, AM_DELETION_REQUESTED)
//     — cancel is a no-op, returns { ok:false, reason:'already_terminal' }.
//   - rows that don't exist — throws NotFoundError up the stack.
//
// The worker-side AbortController signalling is the caller's job
// (controller.cancel_row pairs the two). Doing them separately
// means the model has no transitive dependency on the worker,
// and tests can exercise each half in isolation.
async function cancel(id, { actor = 'system', reason = 'Cancelled by staff' } = {}) {
    const row = await get_queue_row({ id });
    if (!row) {
        const err = new Error(`queue row ${id} not found`);
        err.code = 'NOT_FOUND';
        err.status = 404;
        throw err;
    }
    // Anything in a terminal/halted state is left alone. The
    // dashboard caller surfaces this as a toast — easier UX than
    // hiding the kebab item the instant a timeout fires.
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

// Read the row's prior pipeline_state from the audit log. Used by
// the dashboard to decide which rollback action to show after a
// cancel — see state_metadata.available_actions(state, prev_state).
// Returns null if no cancel event exists for the row.
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

// States that block a cancel. These are either already terminal
// (no further work to abort) or already in a staff-cleanup state
// (cancel would muddy the audit log).
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

// Finalize any COMPLETE rows left with is_complete=0. These are rows
// where Stage 5 wrote the success state but the worker died (or was
// gracefully aborted) before the post-hold is_complete=1 flip fired.
// Idempotent — bulk UPDATE skips rows already at is_complete=1.
//
// We deliberately don't write an event row here: the COMPLETE event
// was already recorded by Stage 5; this sweep is a cleanup of the
// is_complete column only.
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

    // Use update_queue so the events log captures each transition
    // back to PENDING. Slightly slower than a bulk UPDATE but the
    // audit-trail correctness is worth it.
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

// Test/integration helper. Hard-deletes everything (queue rows AND
// their events) for a given batch — useful for tests that want to
// reset state cleanly. Never call from production code; rollback is
// a different concept (staff-initiated, audited via update_queue).
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
