'use strict';

/*
 * System-wide metadata refresh — cursor-paced producer.
 * 
 * The producer is a separate timer from the metadata worker. Its job
 * is to take a single active `metadata_refresh_batches` row and
 * translate it into queue rows, paced so the queue table never
 * balloons regardless of how many active objects exist.
 * 
 * On each tick:
 *   1. Find the active batch (status='running', not cancel_requested,
 *      not enqueue_complete). If none, no-op.
 *   2. Snapshot the ceiling (max tbl_objects.id at start) the FIRST
 *      time only; persist by writing cursor_id=0 (or the starting
 *      offset). The ceiling itself isn't stored — we recompute it on
 *      each tick, which is fine because the producer only advances
 *      while id < ceiling captured ONCE on the first tick.
 *   3. SELECT id, pid, uri FROM tbl_objects WHERE id > cursor_id
 *      AND is_active=1 AND uri != '' ORDER BY id LIMIT chunk_size.
 *   4. If 0 rows OR new max_id <= cursor: producer is done — set
 *      enqueue_complete=true on the batch.
 *   5. Otherwise: enqueue the chunk under the batch's uuid at the
 *      configured system priority, bump the batch's `total`, and
 *      advance cursor_id to the last id we enqueued.
 * 
 * Concurrency: like the metadata worker, there's one producer
 * instance per process. The advance_cursor CAS protects against
 * double-enqueuing if something pathological happens (e.g. two
 * processes running the producer at once).
 * 
 * Cancellation: the controller flips cancel_requested=true and
 * deletes pending queue rows. The next producer tick sees cancel_
 * requested, marks enqueue_complete=true (so the worker doesn't
 * linger on counters that will never tally), and exits without
 * enqueuing further.
 * 
 * Shutdown: stop() clears the timer. In-flight tick can't be
 * aborted but it's bounded by chunk_size queries against the DB —
 * returns in milliseconds. No HTTP / external I/O in the producer.
 */

const app_config = require('../config/app');
const log = require('../libs/log');
const { db } = require('../config/db');
const tables = require('../config/db_tables');
const model = require('./model');
const batches = require('./batches');

const OBJECTS = tables.objects;

/*
 * Pull the next chunk of (id, pid, uri) tuples from tbl_objects past
 * the cursor. Filters: active + has-uri (a row with no AS URI can't
 * be refreshed; skip rather than enqueue-and-fail). Returns at most
 * `limit` rows, ordered by id ASC so the cursor advances monotonically.
 */
async function read_chunk_from_objects(cursor_id, limit) {
    return db()(OBJECTS)
        .select('id', 'pid', 'uri')
        .where('id', '>', cursor_id)
        .andWhere({ is_active: 1 })
        .whereNotNull('uri')
        .whereNot('uri', '')
        .orderBy('id', 'asc')
        .limit(limit);
}

/*
 * One producer tick. Pure function over the DB state — call sites
 * schedule it (start/stop), but you can also call it directly in
 * tests to drive a single iteration.
 */
async function tick() {
    const batch = await batches.get_active_batch();
    if (!batch) return { idle: true };
    if (batch.cancel_requested || batch.enqueue_complete) {
        /*
         * Cancel flag was flipped by the controller, or we already
         * finished a previous tick. Nothing left for the producer
         * to do — worker will drain remaining in-flight rows.
         */
        if (!batch.enqueue_complete) {
            /*
             * First tick after a cancel: make sure enqueue_complete
             * is true so the worker can compute a terminal state on
             * the last in-flight row.
             */
            await batches.advance_cursor(batch.batch_uuid, {
                expected_cursor_id: batch.cursor_id,
                new_cursor_id: batch.cursor_id,
                done: true,
            });
        }
        return { batch_uuid: batch.batch_uuid, done: true };
    }

    const cfg = app_config().metadata_system_refresh;
    const chunk_size = cfg.chunk_size > 0 ? cfg.chunk_size : 500;
    const priority = cfg.priority >= 0 ? cfg.priority : 5;
    const start_cursor = batch.cursor_id === null ? 0 : batch.cursor_id;

    const rows = await read_chunk_from_objects(start_cursor, chunk_size);
    if (rows.length === 0) {
        /*
         * No more rows past the cursor — producer is done. Mark the
         * batch's enqueue phase complete; the worker handles the
         * running→completed transition once it drains the last row.
         */
        await batches.advance_cursor(batch.batch_uuid, {
            expected_cursor_id: batch.cursor_id,
            new_cursor_id: batch.cursor_id,
            done: true,
        });
        /*
         * Empty-batch finalize: if total stayed at 0 — typically a
         * resume that started with cursor at-or-past max(tbl_objects
         * .id) so nothing was ever enqueued — no on_row_terminal
         * will ever fire to transition the batch to 'completed'.
         * Force the transition here so the dashboard doesn't show
         * a permanently-running batch with 0/0 progress. No-op when
         * total > 0 (the normal case: worker finishes the row drain
         * and on_row_terminal handles the transition).
         */
        await batches.complete_if_empty(batch.batch_uuid);
        log.info({
            event: 'metadata_producer_done',
            batch_uuid: batch.batch_uuid,
            cursor_id: batch.cursor_id,
        });
        return { batch_uuid: batch.batch_uuid, done: true };
    }

    /*
     * Enqueue the chunk, then advance the cursor + bump total. We
     * do them in this order so that even if `advance_cursor` fails
     * halfway, the worst case is duplicate rows on the next tick —
     * wasteful but not incorrect (the worker would refresh each
     * duplicate once; the second is a no-op overwrite).
     */
    const rows_to_enqueue = rows.map((r) => ({
        uuid: r.pid,
        uri: r.uri,
        update_type: 'system',
    }));
    const enqueue_result = await model.enqueue_chunk_for_batch({
        batch_uuid: batch.batch_uuid,
        rows: rows_to_enqueue,
        priority,
    });

    const new_cursor = rows[rows.length - 1].id;
    const advance_result = await batches.advance_cursor(batch.batch_uuid, {
        expected_cursor_id: batch.cursor_id,
        new_cursor_id: new_cursor,
        done: false,
    });
    if (advance_result.affected === 0) {
        /*
         * CAS lost — another producer (shouldn't happen) raced us.
         * We've already inserted N rows; rather than panic, accept
         * the dupes and let the worker dedupe via row-level
         * overwrites. Loud log so an operator can investigate.
         */
        log.warn({
            event: 'metadata_producer_cursor_lost',
            batch_uuid: batch.batch_uuid,
            expected_cursor_id: batch.cursor_id,
            new_cursor_id: new_cursor,
            enqueued: enqueue_result.count,
        });
    }
    await batches.increment_total(batch.batch_uuid, enqueue_result.count);

    log.debug({
        event: 'metadata_producer_tick',
        batch_uuid: batch.batch_uuid,
        enqueued: enqueue_result.count,
        cursor_id: new_cursor,
    });

    return {
        batch_uuid: batch.batch_uuid,
        enqueued: enqueue_result.count,
        cursor_id: new_cursor,
        done: false,
    };
}

/*
 * Factory for the long-lived producer instance the entry point wires
 * up at boot. tests/integration drives `tick()` directly instead of
 * arming the interval.
 */
function create_producer({ on_tick = null } = {}) {
    let running = false;
    let stopping = false;
    let timer = null;
    let in_flight = Promise.resolve();

    async function safe_tick() {
        if (stopping) return;
        try {
            in_flight = tick();
            const result = await in_flight;
            if (on_tick) on_tick(result);
        } catch (err) {
            log.error({ event: 'metadata_producer_error', err: err.message });
        }
    }

    async function start() {
        if (running) return;
        running = true;
        stopping = false;
        const cfg = app_config().metadata_system_refresh;
        const cadence = Math.max(1000, cfg.poll_ms || 5000);
        log.info({
            event: 'metadata_producer_started',
            poll_ms: cadence,
            chunk_size: cfg.chunk_size,
        });
        timer = setInterval(() => {
            safe_tick();
        }, cadence);
        if (timer.unref) timer.unref();
    }

    async function stop({ timeout_ms = 5000 } = {}) {
        if (!running) return;
        stopping = true;
        if (timer) clearInterval(timer);
        timer = null;
        try {
            await Promise.race([
                in_flight,
                new Promise((resolve) => setTimeout(resolve, timeout_ms)),
            ]);
        } catch {
            // tick() catches internally; defensive
        }
        running = false;
        log.info({ event: 'metadata_producer_stopped' });
    }

    return {
        start,
        stop,
        tick: safe_tick,
        _is_running() {
            return running;
        },
    };
}

module.exports = {
    tick,
    create_producer,
    // Test introspection only.
    _read_chunk_from_objects: read_chunk_from_objects,
};
