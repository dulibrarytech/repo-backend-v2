'use strict';

/*
 * System-wide metadata refresh — batch rollup model.
 * 
 * One row per system-refresh invocation in tbl_metadata_refresh_batches.
 * Surfaces the long-running batch's state to the admin page (lifecycle,
 * progress counters, who started it, transformer flag in effect) and
 * owns the producer/worker handoff for terminal-transition logic.
 * 
 * Why a separate table (not just an envelope around tbl_metadata_update_queue):
 * a batch's lifecycle is independent of any individual row's. The
 * producer enqueues rows paced over minutes; the worker drains them
 * over hours. Computing "is this batch done?" from scanning queue
 * rows would be a full-table scan (10k+ rows) on every poll. The
 * counters here are O(1) reads and O(1) writes per row transition.
 * 
 * Lifecycle (status column):
 *   'running'   — producer enqueuing OR worker draining
 *   'completed' — enqueue_complete=true AND every row terminal
 *   'cancelled' — operator pressed Cancel; producer stopped and
 *                 pending rows deleted from the queue
 *   'failed'    — producer itself errored (rare: DB outage mid-enqueue)
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
 * Resolve an actor (typically a du_id from the JWT) to a human-
 * readable "First Last" string by looking up tbl_users. Falls
 * through to the user's email if no name is on file, and finally
 * to '' so the column never carries a stale lookup attempt.
 * Mirrors ingester/jobs.js:_resolve_actor_name — kept here too
 * (not shared) because metadata/ and ingester/ are otherwise
 * independent and cross-importing would create a layering tangle
 * for one ~10-line helper.
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

/*
 * Refuse to start a new batch while one is still running. Two
 * concurrent system refreshes against the same AS instance would
 * just double the load with no benefit — one batch at a time keeps
 * the rate limit honest and makes the admin UI's "active batch"
 * section unambiguous.
 */
async function get_active_batch() {
    return db_queue()(BATCHES).where({ status: 'running' }).orderBy('id', 'desc').first();
}

/*
 * Create a new batch row. Snapshots the transformer flag + version
 * at creation time so the controller's pre-flight cutover guard has
 * a stable reference (see _validate_transformer_continuity below).
 * 
 * `actor` is the user identifier the controller pulls off the JWT
 * (typically a du_id). If `actor_name` isn't supplied, we resolve
 * it from tbl_users at write time so the history list can render
 * "Started by Ada Lovelace" instead of "by unknown" — denormalized
 * here so the listing page doesn't have to cross-join repo +
 * repo_queue at read time.
 * 
 * Returns the new batch_uuid; the controller hands this back to the
 * caller so they can monitor / cancel it.
 * Look up the most recent cancelled batch and derive a cursor the
 * new (resumed) batch should START at so the producer re-enqueues
 * every object the WORKER never got to terminal.
 * 
 * "Most recent" = ORDER BY id DESC over status='cancelled'.
 * 
 * Why not just return the cancelled batch's raw `cursor_id`: that
 * column tracks how far the PRODUCER walked tbl_objects, not how
 * far the WORKER actually processed. The producer typically races
 * ahead — it can enqueue every row in minutes while the worker
 * takes hours to drain. When the operator cancels:
 *   1. cursor_id is at/past max(tbl_objects.id) because the
 *      producer had finished enqueueing.
 *   2. request_cancel hard-deletes the pending queue rows.
 *   3. Resuming from the raw cursor → producer reads
 *      `WHERE id > max_id` → 0 rows → batch flips straight to
 *      'completed' with total=0, silently abandoning every
 *      object the worker never reached. That's the bug.
 * 
 * What we actually want: re-enqueue objects whose pid did NOT land
 * in a terminal (is_complete=1) queue row for the cancelled batch.
 * Those rows are the worker's reliable record of "done." We find
 * the LOWEST tbl_objects.id whose pid is not in that set and return
 * cursor = (id - 1), so the producer's `id > cursor_id` predicate
 * picks that row up on its first tick.
 * 
 * Yes, this re-refreshes some objects the producer had already
 * queued past on first run — wasteful, but the AS refresh is
 * idempotent and the alternative (silent data loss for the
 * unprocessed gap) is much worse. Eliminating the dupes would need
 * the producer to filter against the predecessor batch on every
 * chunk read, which is a deeper change.
 * 
 * Returns:
 *   { batch_uuid, cursor_id }   when a cancelled batch with an
 *                                advanced cursor exists
 *   null                         when no cancelled batch exists OR
 *                                the most recent one never had its
 *                                cursor advanced (e.g. cancelled
 *                                before the producer's first tick)
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
     * Pull the pids the worker terminally finalized for this batch.
     * is_complete=1 covers both COMPLETE (succeeded) and
     * DEAD_LETTERED (gave up after retries). request_cancel deleted
     * every PENDING row, so anything still here is reliable signal.
     */
    const completed_pids = await db_queue()(QUEUE)
        .where({ batch_uuid: row.batch_uuid, is_complete: 1 })
        .pluck('uuid');

    /*
     * No terminal rows means the worker never finished anything for
     * this batch — the producer's cursor is still the best resume
     * point we have.
     */
    if (completed_pids.length === 0) {
        return { batch_uuid: row.batch_uuid, cursor_id: Number(row.cursor_id) };
    }

    /*
     * Find the lowest active object whose pid is NOT in the
     * worker's done-set. That's where the producer should pick up.
     */
    const first_unprocessed = await db()(OBJECTS)
        .select('id')
        .where({ is_active: 1 })
        .whereNotNull('uri')
        .whereNot('uri', '')
        .whereNotIn('pid', completed_pids)
        .orderBy('id', 'asc')
        .first();

    /*
     * Every active row was already terminal — nothing to resume.
     * Fall through to the raw cursor (legacy behavior: producer
     * will read 0 rows and the batch completes empty). The operator
     * gets the same "instant complete" UX they would in the
     * "everything was done" case, which is accurate.
     */
    if (!first_unprocessed) {
        return { batch_uuid: row.batch_uuid, cursor_id: Number(row.cursor_id) };
    }

    const resume_cursor = Math.max(0, Number(first_unprocessed.id) - 1);
    return { batch_uuid: row.batch_uuid, cursor_id: resume_cursor };
}

/*
 * Create a new batch row.
 * 
 * Options:
 *   actor / actor_name  — see _resolve_actor_name above.
 *   inherit_cursor_id   — if set to a number, the new batch starts
 *                          with that cursor_id (the producer's
 *                          tick() reads cursor_id and walks
 *                          tbl_objects.id > cursor_id). Defaults to
 *                          null = fresh run from id=0. The
 *                          start_refresh controller passes the
 *                          cursor from get_last_cancelled_cursor()
 *                          when the operator opts into resume.
 * 
 * Returns: batch_uuid (string). The controller fetches resume
 * metadata separately via get_last_cancelled_cursor() if it needs
 * to surface "resume hit" vs. "resume requested but nothing to
 * resume" in the toast.
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
    /*
     * Resolve the human-readable name if the caller didn't.
     * Resolution is a single indexed users-table read; it happens
     * once per batch, not per row, so the latency cost is trivial.
     */
    const resolved_name = actor_name || (await _resolve_actor_name(actor));
    /*
     * Validate the inherited cursor: must be either null or a
     * non-negative integer. Anything else means a bug in the
     * caller; reject loudly rather than silently coerce.
     */
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

/*
 * Listing for the admin page. Returns the most-recent N batches in
 * reverse chronological order, plus active-batch sniff. Cheap — one
 * indexed scan (status, started_at) per call.
 */
async function list_batches({ limit = 25 } = {}) {
    return db_queue()(BATCHES).select('*').orderBy('id', 'desc').limit(limit);
}

// Producer-side primitives ------------------------------------------

/*
 * Atomically claim ownership of cursor advancement for a batch. The
 * producer uses this so a duplicate process running the producer
 * (which shouldn't happen, but be defensive) can't double-enqueue
 * the same id range.
 * 
 * Returns the batch row WITH the cursor_id BEFORE this tick's advance
 * — caller computes the new cursor from this + chunk size.
 */
async function lock_batch_for_tick(batch_uuid) {
    require_batch_uuid(batch_uuid);
    /*
     * No SELECT...FOR UPDATE because we're on knex/mysql2 — the test
     * sqlite driver lacks it. Instead we'll do an optimistic
     * compare-and-swap on `cursor_id` when we commit. The race
     * window is tiny (one producer process) so this is plenty.
     */
    return db_queue()(BATCHES).where({ batch_uuid, status: 'running' }).first();
}

/*
 * Advance the cursor + (optionally) mark enqueue complete in one
 * UPDATE. Producer calls this once per tick. CAS on (batch_uuid,
 * cursor_id=expected) so a stale producer never clobbers a fresh one.
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

/*
 * Update the batch's `total` count. Producer calls this once per
 * tick (with the delta enqueued) so a partial-failure mid-enqueue
 * doesn't lose the running count.
 */
async function increment_total(batch_uuid, delta) {
    require_batch_uuid(batch_uuid);
    if (!delta) return;
    await db_queue()(BATCHES).where({ batch_uuid }).increment('total', delta);
}

// Worker-side rollup ------------------------------------------------

/*
 * Called by the worker right after a queue row reaches a terminal
 * state. Bumps the matching counter and, if appropriate, transitions
 * the batch to its terminal status.
 * 
 * Concurrency: this is called from multiple worker fibers in
 * parallel (one per row). The COUNTERS are safe under concurrent
 * increments (knex .increment uses a single UPDATE … SET x = x + 1).
 * The TERMINAL TRANSITION is gated on (status='running') so only one
 * caller's compare-and-swap wins; the rest see status='completed' on
 * re-check and no-op.
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
    /*
     * Re-read to check whether we just hit the terminal condition.
     * Cheap (single indexed row) and only happens at row-finalization
     * rate (~12/min), not per-tick.
     */
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
 * Transition a batch to 'completed' if-and-only-if it has finished
 * enqueuing AND no rows were ever queued. Used by the producer after
 * a no-rows tick so a batch that ran with cursor past max(tbl_objects
 * .id) — e.g. a resume that picked up at the end of the table —
 * doesn't sit at 'running' forever waiting for an on_row_terminal
 * call that never comes (no row → no terminal).
 * 
 * The WHERE clause is the safety guarantee: only batches that are
 * CURRENTLY running, have already finished enqueuing, AND ended with
 * total=0 transition. Anything else (rows still pending, batch
 * already completed/cancelled) is left alone. Idempotent.
 * 
 * Returns { affected }; 0 means "nothing to do" (the common case).
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
 * Operator-initiated cancel: flip the flag so the producer stops
 * enqueuing, hard-delete pending rows for the batch, and roll the
 * status to 'cancelled'. In-flight rows (status='IN_PROGRESS') are
 * allowed to finish — we can't abort an in-flight HTTP request, and
 * the dead-letter / success counters still get updated for them.
 * 
 * Returns the count of pending rows that were removed so the UI can
 * confirm "we cancelled N pending rows."
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
    /*
     * Transition straight to cancelled — the worker's drain logic
     * will still bump per-row counters as in-flight rows finalize,
     * but the batch is no longer "running" from a UX standpoint.
     */
    await db_queue()(BATCHES)
        .where({ batch_uuid })
        .update({ status: 'cancelled', finished_at: db_queue().fn.now() });
    return { pending_removed: deleted };
}

// Activity snapshot --------------------------------------------------

/*
 * Two-part view used by the admin page to answer "is this batch
 * actually moving?":
 * 
 *   in_flight         — rows currently claimed by the worker
 *                       (status=IN_PROGRESS). One per worker fiber;
 *                       3 rows by default. Their `uri` is the record
 *                       being fetched RIGHT NOW.
 * 
 *   recently_completed — most recently terminal rows for this batch
 *                       (succeeded + dead-lettered), ordered newest
 *                       first. We order by id DESC because within a
 *                       batch the queue id roughly tracks completion
 *                       order (FIFO drain within the priority tier).
 *                       Not perfect across retries, but good enough
 *                       for "things are moving."
 * 
 * Both queries are O(limit) thanks to the (batch_uuid, is_complete,
 * id) index. Safe to call from the every-N-seconds status poll.
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
 * Producer captures this at batch start. The cursor terminates here
 * no matter how many new active rows land in tbl_objects mid-refresh.
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
