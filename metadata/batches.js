'use strict';

/*
 * System-wide metadata refresh — batch rollup model.
 *
 * One row per system-refresh invocation in tbl_metadata_refresh_batches,
 * carrying lifecycle, progress counters, actor, and the transformer flag
 * in effect. Owns the producer/worker handoff for terminal transitions.
 *
 * Lifecycle (status column):
 *   'running'   — producer enqueuing OR worker draining
 *   'completed' — enqueue_complete=true AND every row terminal
 *   'cancelled' — operator pressed Cancel; producer stopped and
 *                 pending rows deleted from the queue
 *   'failed'    — producer itself errored
 *
 * See knex/migrations/repo_queue/20260522000004_metadata_refresh_batches.js
 * for column-by-column documentation.
 */

const { randomUUID } = require('node:crypto');
const validator = require('validator');

const { db_queue, db } = require('../config/db');
const tables = require('../config/db_tables');
const app_config = require('../config/app');
const users_model = require('../users/model');
const { NotFoundError, ValidationError } = require('../libs/errors');

const BATCHES = tables.metadata_refresh_batches;
const QUEUE = tables.metadata_update_queue;
const OBJECTS = tables.objects;

/*
 * Resolve an actor (typically a du_id from the JWT) to a "First Last"
 * string from tbl_users. Falls back to the user's email, then to ''.
 */
async function _resolve_actor_name(actor) {
    if (!actor) return '';
    try {
        const user = await users_model.get_by_du_id(actor).catch(() => null);
        if (user) {
            const first = user.first_name || '';
            const last = user.last_name || '';
            const combined = `${first} ${last}`.trim();
            if (combined) return combined;
            if (user.email) return user.email;
        }
    } catch {
        // ignore — fall through to empty string
    }
    return '';
}

function require_batch_uuid(batch_uuid) {
    if (!batch_uuid || typeof batch_uuid !== 'string') {
        throw new ValidationError('batch_uuid is required');
    }
    if (!validator.isUUID(batch_uuid)) {
        throw new ValidationError('batch_uuid must be a UUID');
    }
}

/* Return the running batch, if any. Only one may run at a time. */
async function get_active_batch() {
    return db_queue()(BATCHES).where({ status: 'running' }).orderBy('id', 'desc').first();
}

/*
 * Derive the cursor a resumed batch should start at, from the most
 * recent cancelled batch (ORDER BY id DESC over status='cancelled').
 *
 * Returns the lowest active tbl_objects.id whose pid did NOT reach a
 * terminal (is_complete=1) queue row in that batch, minus one, so the
 * producer's `id > cursor_id` predicate picks it up on its first tick.
 * Falls back to the batch's stored cursor_id when the worker finalized
 * nothing, or when every active row was already terminal.
 *
 * Returns:
 *   { batch_uuid, cursor_id }  when a cancelled batch with an advanced
 *                              cursor exists
 *   null                       when no cancelled batch exists, or its
 *                              cursor was never advanced
 */
async function get_last_cancelled_cursor() {
    const row = await db_queue()(BATCHES)
        .select('batch_uuid', 'cursor_id')
        .where({ status: 'cancelled' })
        .orderBy('id', 'desc')
        .first();
    if (!row || row.cursor_id === null || row.cursor_id === undefined) {
        return null;
    }

    /*
     * Pids the worker terminally finalized for this batch. is_complete=1
     * covers COMPLETE and DEAD_LETTERED; request_cancel already deleted
     * every PENDING row.
     */
    const completed_pids = await db_queue()(QUEUE)
        .where({ batch_uuid: row.batch_uuid, is_complete: 1 })
        .pluck('uuid');

    if (completed_pids.length === 0) {
        return { batch_uuid: row.batch_uuid, cursor_id: Number(row.cursor_id) };
    }

    /* Lowest active object not in the worker's done-set. */
    const first_unprocessed = await db()(OBJECTS)
        .select('id')
        .where({ is_active: 1 })
        .whereNotNull('uri')
        .whereNot('uri', '')
        .whereNotIn('pid', completed_pids)
        .orderBy('id', 'asc')
        .first();

    /* Every active row already terminal — nothing to resume. */
    if (!first_unprocessed) {
        return { batch_uuid: row.batch_uuid, cursor_id: Number(row.cursor_id) };
    }

    const resume_cursor = Math.max(0, Number(first_unprocessed.id) - 1);
    return { batch_uuid: row.batch_uuid, cursor_id: resume_cursor };
}

/*
 * Create a new batch row, snapshotting the transformer flag + version at
 * creation time. Throws ValidationError if a batch is already running.
 *
 * Options:
 *   actor / actor_name  — actor_name is resolved from tbl_users when not
 *                         supplied.
 *   inherit_cursor_id   — number to start the producer at
 *                         (tbl_objects.id > cursor_id), or null for a
 *                         fresh run from id=0.
 *
 * Returns: batch_uuid (string).
 */
async function create_batch({
    actor = '',
    actor_name = '',
    inherit_cursor_id = null,
} = {}) {
    const active = await get_active_batch();
    if (active) {
        throw new ValidationError(
            `A system metadata refresh is already running (batch ${active.batch_uuid}). ` +
                `Cancel it or wait for completion before starting another.`
        );
    }
    const cfg = app_config().archivespace;
    const batch_uuid = randomUUID();
    const resolved_name = actor_name || (await _resolve_actor_name(actor));
    /* Must be null or a non-negative integer; reject rather than coerce. */
    let starting_cursor = null;
    if (inherit_cursor_id !== null && inherit_cursor_id !== undefined) {
        const n = Number(inherit_cursor_id);
        if (!Number.isInteger(n) || n < 0) {
            throw new ValidationError(
                `inherit_cursor_id must be a non-negative integer (got ${inherit_cursor_id})`
            );
        }
        starting_cursor = n;
    }
    await db_queue()(BATCHES).insert({
        batch_uuid,
        status: 'running',
        total: 0,
        succeeded: 0,
        failed: 0,
        dead_lettered: 0,
        cursor_id: starting_cursor,
        enqueue_complete: false,
        cancel_requested: false,
        transformer_flag: cfg.use_transformer ? '1' : '0',
        transformer_version: cfg.transformer_version || '',
        actor,
        actor_name: resolved_name,
    });
    return batch_uuid;
}

async function get_batch(batch_uuid) {
    require_batch_uuid(batch_uuid);
    const row = await db_queue()(BATCHES).where({ batch_uuid }).first();
    if (!row) throw new NotFoundError(`Batch ${batch_uuid} not found`);
    return row;
}

/* Most-recent N batches, newest first, for the admin page. */
async function list_batches({ limit = 25 } = {}) {
    return db_queue()(BATCHES).select('*').orderBy('id', 'desc').limit(limit);
}

// Producer-side primitives ------------------------------------------

/*
 * Read the running batch row for this tick. Returns it with the
 * cursor_id BEFORE this tick's advance — the caller computes the new
 * cursor from this plus the chunk size.
 */
async function lock_batch_for_tick(batch_uuid) {
    require_batch_uuid(batch_uuid);
    return db_queue()(BATCHES).where({ batch_uuid, status: 'running' }).first();
}

/*
 * Advance the cursor and optionally mark enqueue complete, in one
 * UPDATE. Compare-and-swap on (batch_uuid, cursor_id=expected).
 */
async function advance_cursor(batch_uuid, { expected_cursor_id, new_cursor_id, done }) {
    require_batch_uuid(batch_uuid);
    const patch = { cursor_id: new_cursor_id };
    if (done) patch.enqueue_complete = true;
    const q = db_queue()(BATCHES).where({ batch_uuid });
    if (expected_cursor_id === null || expected_cursor_id === undefined) {
        q.whereNull('cursor_id');
    } else {
        q.where({ cursor_id: expected_cursor_id });
    }
    const affected = await q.update(patch);
    return { affected };
}

/* Add `delta` to the batch's total. Called once per producer tick. */
async function increment_total(batch_uuid, delta) {
    require_batch_uuid(batch_uuid);
    if (!delta) return;
    await db_queue()(BATCHES).where({ batch_uuid }).increment('total', delta);
}

// Worker-side rollup ------------------------------------------------

/*
 * Called after a queue row reaches a terminal state. Bumps the matching
 * counter and transitions the batch to 'completed' once enqueue is done
 * and every row is terminal. Safe to call from parallel worker fibers:
 * the increment is a single UPDATE and the terminal transition is a CAS
 * on status='running'.
 */
async function on_row_terminal(batch_uuid, outcome) {
    require_batch_uuid(batch_uuid);
    const col = {
        succeeded: 'succeeded',
        failed: 'failed',
        dead_lettered: 'dead_lettered',
    }[outcome];
    if (!col) throw new ValidationError(`unknown outcome: ${outcome}`);
    await db_queue()(BATCHES).where({ batch_uuid }).increment(col, 1);
    const row = await db_queue()(BATCHES).where({ batch_uuid }).first();
    if (!row || row.status !== 'running') return;
    if (!row.enqueue_complete) return;
    const sum = row.succeeded + row.failed + row.dead_lettered;
    if (sum >= row.total) {
        // CAS — only one caller wins this update.
        await db_queue()(BATCHES)
            .where({ batch_uuid, status: 'running' })
            .update({ status: 'completed', finished_at: db_queue().fn.now() });
    }
}

// Empty-batch finalize ----------------------------------------------

/*
 * Transition a batch to 'completed' only if it has finished enqueuing
 * and never queued a row. Idempotent; returns { affected }, where 0
 * means nothing to do (the common case).
 */
async function complete_if_empty(batch_uuid) {
    require_batch_uuid(batch_uuid);
    const affected = await db_queue()(BATCHES)
        .where({
            batch_uuid,
            status: 'running',
            total: 0,
            enqueue_complete: true,
        })
        .update({ status: 'completed', finished_at: db_queue().fn.now() });
    return { affected };
}

// Cancellation ------------------------------------------------------

/*
 * Operator-initiated cancel: set cancel_requested so the producer stops,
 * hard-delete the batch's PENDING rows, and roll status to 'cancelled'.
 * In-flight (IN_PROGRESS) rows are left to finish and still update the
 * counters.
 *
 * Returns { pending_removed }.
 */
async function request_cancel(batch_uuid) {
    require_batch_uuid(batch_uuid);
    const batch = await db_queue()(BATCHES).where({ batch_uuid }).first();
    if (!batch) throw new NotFoundError(`Batch ${batch_uuid} not found`);
    if (batch.status !== 'running') {
        throw new ValidationError(`Batch ${batch_uuid} is not running (status=${batch.status})`);
    }
    await db_queue()(BATCHES)
        .where({ batch_uuid })
        .update({ cancel_requested: true, enqueue_complete: true });
    const deleted = await db_queue()(QUEUE)
        .where({ batch_uuid, status: 'PENDING', is_complete: 0 })
        .del();
    await db_queue()(BATCHES)
        .where({ batch_uuid })
        .update({ status: 'cancelled', finished_at: db_queue().fn.now() });
    return { pending_removed: deleted };
}

// Activity snapshot --------------------------------------------------

/*
 * Two-part liveness view for the admin page:
 *   in_flight          — rows currently claimed by the worker
 *                        (status=IN_PROGRESS); `uri` is the record being
 *                        fetched right now.
 *   recently_completed — most recent terminal rows for this batch,
 *                        newest first by id.
 *
 * Both queries are O(limit) via the (batch_uuid, is_complete, id) index.
 */
async function get_activity_snapshot(batch_uuid, { in_flight_limit = 5, recent_limit = 8 } = {}) {
    require_batch_uuid(batch_uuid);
    const in_flight = await db_queue()(QUEUE)
        .select('id', 'uri', 'attempts', 'date_updated')
        .where({ batch_uuid, status: 'IN_PROGRESS', is_complete: 0 })
        .orderBy('id', 'asc')
        .limit(in_flight_limit);
    const recent = await db_queue()(QUEUE)
        .select('id', 'uri', 'status', 'attempts', 'last_error', 'date_updated')
        .where({ batch_uuid, is_complete: 1 })
        .orderBy('id', 'desc')
        .limit(recent_limit);
    return { in_flight, recently_completed: recent };
}

// Ceiling helper ----------------------------------------------------

/*
 * Highest active tbl_objects.id, captured by the producer at batch
 * start. The cursor terminates here regardless of rows added mid-refresh.
 */
async function snapshot_objects_ceiling() {
    const row = await db()(OBJECTS).where({ is_active: 1 }).max('id as max_id').first();
    return row && row.max_id ? Number(row.max_id) : 0;
}

module.exports = {
    create_batch,
    get_batch,
    get_active_batch,
    get_last_cancelled_cursor,
    list_batches,
    lock_batch_for_tick,
    advance_cursor,
    increment_total,
    on_row_terminal,
    request_cancel,
    snapshot_objects_ceiling,
    get_activity_snapshot,
    complete_if_empty,
};
