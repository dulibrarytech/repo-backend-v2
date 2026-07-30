'use strict';

/*
 * In-process ingest worker.
 * 
 * Mirrors the shape of metadata/worker.js and indexer/worker.js so
 * operators only have to learn one pattern:
 * 
 *   - one instance per process (single boot/stop lifecycle)
 *   - polls the queue every `poll_ms`, claims up to `concurrency`
 *     PENDING rows per tick
 *   - fans out the stage work in parallel up to `concurrency`
 *   - graceful stop drains in-flight work for `timeout_ms`
 * 
 * Differences vs. the metadata worker:
 *   - dispatches by `pipeline_state`, not status='PENDING' alone. The
 *     ingest queue has many entry/resume states (PENDING, QA_COMPLETE,
 *     UPLOAD_COMPLETE, etc.); each maps to a stage.
 *   - each row gets its own AbortSignal so graceful stop can cancel
 *     long polls (stage 2's upload-status, stage 3's transfer-status)
 *     mid-flight.
 *   - tick claims work via a single status-aware SELECT (claim_for_run
 *     in the model — to be added later) rather than the metadata
 *     worker's "claim N PENDING + mark IN_PROGRESS" pattern. For now
 *     (Phase 3a) we claim by listing the active states.
 * 
 * Resume on boot:
 *   The model's reset_orphaned() is for transitively-running states
 *   (STARTING, REPLICATING_PACKAGE, etc. — see ingester/model.js).
 *   Polling states (UPLOADING, TRANSFER_IN_PROGRESS, etc.) are NOT
 *   reset; the worker simply picks them back up at the same stage
 *   and re-runs the poll. Idempotent by construction — the QA /
 *   AM upstream returns the same status whether polled once or
 *   a thousand times.
 */

const app_config = require('../config/app');
const log = require('../libs/log');
const model_default = require('./model');

const process_metadata_stage = require('./stages/process_metadata');
const upload_stage = require('./stages/upload');
const transfer_stage = require('./stages/transfer');
const ingest_stage = require('./stages/ingest');
const repository_stage = require('./stages/repository');
const aip_store_stage = require('./stages/aip_store');

/*
 * State → stage handler. The worker only processes rows whose
 * pipeline_state appears here; rows in terminal states (COMPLETE,
 * AIP_STORE_COMPLETE, FAILED, AS_METADATA_INVALID, etc.) or in states
 * owned by a not-yet-built stage are skipped on that tick.
 * 
 * Resume semantics by state:
 *   - PENDING / PROCESSING_METADATA  → stage 1 (idempotent re-run)
 *   - QA_COMPLETE / UPLOADING        → stage 2
 *   - UPLOAD_COMPLETE / TRANSFER_STARTED / TRANSFER_IN_PROGRESS → stage 3
 *   - TRANSFER_COMPLETE / INGEST_IN_PROGRESS / INGEST_COMPLETE /
 *     WAITING_FOR_DURACLOUD → stage 4
 *   - MASTER_OBJECT_DATA_SAVED / METADATA_PROCESSED /
 *     CREATING_REPOSITORY_RECORD → stage 5
 *   - AIP_STORE_PENDING / AIP_STORE_IN_PROGRESS → stage 6 (preservation
 *     copy to Wasabi). Only fires when AIP_STORE_ENABLED is on;
 *     otherwise Stage 5 jumps straight to COMPLETE+is_complete=1 and
 *     Stage 6 never enters the picture.
 */
const STAGE_BY_STATE = {
    PENDING: process_metadata_stage,
    PROCESSING_METADATA: process_metadata_stage,
    QA_COMPLETE: upload_stage,
    UPLOADING: upload_stage,
    UPLOAD_COMPLETE: transfer_stage,
    TRANSFER_STARTED: transfer_stage,
    TRANSFER_IN_PROGRESS: transfer_stage,
    TRANSFER_COMPLETE: ingest_stage,
    INGEST_IN_PROGRESS: ingest_stage,
    INGEST_COMPLETE: ingest_stage,
    WAITING_FOR_DURACLOUD: ingest_stage,
    METADATA_PROCESSED: repository_stage,
    CREATING_REPOSITORY_RECORD: repository_stage,
    AIP_STORE_PENDING: aip_store_stage,
    AIP_STORE_IN_PROGRESS: aip_store_stage,
};

/*
 * States we consider "ready to be picked up by a worker tick". These
 * are the keys of STAGE_BY_STATE plus a guard against accidentally
 * re-claiming completed rows (is_complete=0).
 */
function ready_states() {
    return Object.keys(STAGE_BY_STATE);
}

/*
 * "AM-active" — the window between `start_transfer` (Stage 3 entry)
 * and AM reporting ingest_status=COMPLETE (mid-Stage 4). Archivematica
 * chokes on parallel transfers in batches with hundreds of packages,
 * so the worker admits at most ONE row into this window at a time.
 * 
 * Split into two halves with different gate semantics:
 * 
 *   AM_ENTRY_STATES — Stage 3 hasn't started yet. Claiming a row here
 *     would call start_transfer and put a NEW job into AM's queue.
 *     Block when ANY row exists in AM_INSIDE_STATES (in the DB) —
 *     that's the "AM has work" signal regardless of which worker
 *     is processing it.
 * 
 *   AM_INSIDE_STATES — already past start_transfer. The row may be
 *     resuming from a crashed worker. Block when an AM-active row
 *     is currently dispatched in THIS worker (cap concurrent
 *     resumes at 1).
 * 
 * What's deliberately OUT of both sets:
 *   INGEST_COMPLETE / WAITING_FOR_DURACLOUD — AM has finished its
 *     work; DC propagation poll is a DuraCloud call, not AM. The
 *     next package's start_transfer can fire here in parallel —
 *     this is where the bulk of post-AM time lives (~1h DC budget),
 *     so leaving the gate open here matters for throughput.
 *   METADATA_PROCESSED / CREATING_REPOSITORY_RECORD — Stage 5, AM idle.
 *   PENDING / PROCESSING_METADATA / QA_COMPLETE / UPLOADING — Stage 1+2,
 *     ASpace + curation-API only.
 */
const AM_ENTRY_STATES = new Set(['UPLOAD_COMPLETE']);
const AM_INSIDE_STATES = new Set([
    'TRANSFER_STARTED',
    'TRANSFER_IN_PROGRESS',
    'TRANSFER_COMPLETE',
    'INGEST_IN_PROGRESS',
]);
const AM_ACTIVE_STATES = new Set([...AM_ENTRY_STATES, ...AM_INSIDE_STATES]);

function create_worker(deps = {}) {
    const model = deps.model || model_default;
    const stages = deps.stages || STAGE_BY_STATE;
    let running = false;
    let stopping = false;
    let timer = null;
    let in_flight = Promise.resolve();
    /*
     * Per-row abort controllers, keyed by queue id. Populated when a
     * tick dispatches a stage; cleared when the stage settles.
     */
    const abort_controllers = new Map();
    /*
     * IDs of rows currently dispatched in an AM-active state. The
     * gate in tick() uses .size to cap concurrent AM work at 1. We
     * track this in-memory (not via DB) because a row's pipeline_state
     * can advance OUT of AM_ACTIVE during a single dispatch (Stage 4
     * walks TRANSFER_COMPLETE → INGEST_IN_PROGRESS → INGEST_COMPLETE
     * → WAITING_FOR_DURACLOUD all in one call); the in-memory set
     * releases the moment dispatch_one returns, not when the row's
     * state changes. Combined with the DB-side inside_db_count check
     * for new entries, this preserves the "1 AM at a time" invariant.
     */
    const am_dispatched = new Set();

    async function dispatch_one(row) {
        const stage = stages[row.pipeline_state];
        if (!stage || typeof stage.run !== 'function') {
            log.warn({
                event: 'ingest_no_stage_for_state',
                queue_id: row.id,
                state: row.pipeline_state,
            });
            return;
        }
        const controller = new AbortController();
        abort_controllers.set(row.id, controller);
        const is_am = AM_ACTIVE_STATES.has(row.pipeline_state);
        if (is_am) am_dispatched.add(row.id);
        try {
            await stage.run(row, { signal: controller.signal });
        } catch (err) {
            /*
             * Stage threw something it didn't catch. Mark the row as
             * halted so the dashboard surfaces it; the worker keeps
             * running for the other rows in flight.
             */
            log.error({
                event: 'ingest_stage_unhandled_error',
                queue_id: row.id,
                state: row.pipeline_state,
                err: err.message,
                stack: err.stack,
            });
            try {
                await model.update_queue(
                    { id: row.id },
                    { status: 'INGEST_HALTED', error: `worker error: ${err.message}` },
                    {
                        actor: 'worker',
                        event_type: 'state_change',
                        payload: {
                            stage: row.pipeline_state,
                            reason: 'unhandled_exception',
                            error: err.message,
                        },
                    }
                );
            } catch (write_err) {
                /*
                 * The DB write itself failed. Nothing more we can do
                 * — log and continue. Resume will reclaim the row.
                 */
                log.error({
                    event: 'ingest_halt_write_failed',
                    queue_id: row.id,
                    err: write_err.message,
                });
            }
        } finally {
            abort_controllers.delete(row.id);
            if (is_am) am_dispatched.delete(row.id);
        }
    }

    async function tick() {
        if (stopping) return;
        const cfg = app_config().ingest_worker;
        if (!cfg.enabled) return;

        let rows;
        try {
            /*
             * AM-active gate. Two-tier:
             * 
             *   ENTRY  — UPLOAD_COMPLETE is the only state that fires
             *     a NEW start_transfer. Block when ANY row is in
             *     AM_INSIDE_STATES (in the DB). This is the "AM has
             *     unfinished work" signal that's invariant across
             *     worker restarts — even with a fresh worker booting,
             *     leftover INSIDE rows close the gate.
             * 
             *   INSIDE — these are resume claims. Block when an
             *     AM-active row is currently dispatched in THIS
             *     worker (am_dispatched.size > 0). Caps concurrent
             *     resumes at 1.
             * 
             * The override hatch (cfg.am_parallel === true) bypasses
             * both gates and restores pre-gate behavior. Production
             * never sets this — AM crashes on parallel transfers.
             */
            const am_parallel = cfg.am_parallel === true;
            const inside_db_count = am_parallel
                ? 0
                : await model.count_rows_in_states([...AM_INSIDE_STATES]);
            const am_in_flight = am_dispatched.size;
            let am_admitted_this_tick = 0;

            /*
             * Claim up to `concurrency` rows whose state is in the
             * ready set. list_queue already accepts a status filter;
             * we make N calls and union the results to dodge a model
             * change for now. Phase 3b adds a dedicated claim_for_run.
             */
            const claimed = [];
            for (const state of ready_states()) {
                if (claimed.length >= cfg.concurrency) break;
                if (!am_parallel) {
                    if (AM_ENTRY_STATES.has(state)) {
                        /*
                         * ENTRY must also respect the IN-MEMORY
                         * dispatched set (am_in_flight), not just the
                         * DB count (2026-07-30): a freshly admitted
                         * row stays UPLOAD_COMPLETE in the DB until
                         * AM's start_transfer returns — up to 30 min
                         * under the large-media budget — and during
                         * that window inside_db_count sees nothing,
                         * so every tick could admit ANOTHER package
                         * into AM. The set covers the same-process
                         * window; the DB count covers restarts.
                         */
                        if (inside_db_count > 0 || am_in_flight > 0 || am_admitted_this_tick > 0)
                            continue;
                    } else if (AM_INSIDE_STATES.has(state)) {
                        if (am_in_flight + am_admitted_this_tick > 0) continue;
                    }
                }
                const remaining = cfg.concurrency - claimed.length;
                /*
                 * Sequential await is intentional — each list_queue
                 * call is cheap (indexed status lookup) and the loop
                 * body short-circuits once `concurrency` rows are
                 * claimed, so parallelizing would waste DB roundtrips
                 * we'd just discard.
                 */
                const batch = await model.list_queue(
                    { status: state, is_complete: false },
                    { limit: remaining, offset: 0 }
                );
                /*
                 * Skip rows already in flight (in another tick that
                 * hasn't completed). Cheap O(N) check; concurrency is
                 * small (2-3) so the inner Map lookup is fine.
                 */
                for (const row of batch) {
                    if (abort_controllers.has(row.id)) continue;
                    claimed.push(row);
                    if (AM_ACTIVE_STATES.has(state)) am_admitted_this_tick++;
                    if (claimed.length >= cfg.concurrency) break;
                    /*
                     * Cap AM admits at one per tick — prevents two
                     * UPLOAD_COMPLETE rows from being claimed before
                     * the first one updates the DB to TRANSFER_STARTED.
                     */
                    if (!am_parallel && AM_ACTIVE_STATES.has(state)) break;
                }
            }
            rows = claimed;
        } catch (err) {
            log.error({ event: 'ingest_claim_failed', err: err.message });
            return;
        }
        if (rows.length === 0) return;

        log.debug({ event: 'ingest_tick', claimed: rows.length });

        in_flight = Promise.allSettled(rows.map((row) => dispatch_one(row)));
        await in_flight;
    }

    async function start() {
        if (running) return;
        running = true;
        stopping = false;
        const cfg = app_config().ingest_worker;
        if (!cfg.enabled) {
            log.info({ event: 'ingest_worker_disabled' });
            running = false;
            return;
        }

        /*
         * Sweep ACTIVELY_RUNNING rows (those crashed mid-step) back
         * to PENDING so we can re-run them cleanly. WAIT-state rows
         * (TRANSFER_IN_PROGRESS, WAITING_FOR_DURACLOUD) are NOT swept
         * — the worker resumes their polls in place.
         */
        try {
            const reset = await model.reset_orphaned({ actor: 'worker-boot' });
            if (reset.affected > 0) {
                log.info({ event: 'ingest_orphans_reset', count: reset.affected });
            }
        } catch (err) {
            log.warn({ event: 'ingest_orphan_reset_failed', err: err.message });
        }

        /*
         * Finalize any COMPLETE rows left at is_complete=0 — Stage 5's
         * post-success hold (see ingester/stages/repository.js) keeps
         * the "Ingest Complete" message visible for a few seconds; if
         * the worker died inside that window the row never got its
         * is_complete=1 flip. Clean those up now so they drop out of
         * the default queue view.
         */
        try {
            const finalized = await model.finalize_pending_completes();
            if (finalized.affected > 0) {
                log.info({
                    event: 'ingest_complete_holds_finalized',
                    count: finalized.affected,
                });
            }
        } catch (err) {
            log.warn({ event: 'ingest_complete_finalize_failed', err: err.message });
        }

        log.info({
            event: 'ingest_worker_started',
            concurrency: cfg.concurrency,
            poll_ms: cfg.poll_ms,
            stages: Object.keys(stages),
        });

        const cadence = Math.max(500, cfg.poll_ms);
        timer = setInterval(() => {
            tick().catch((err) => log.error({ event: 'ingest_tick_error', err: err.message }));
        }, cadence);
        if (timer.unref) timer.unref();
    }

    async function stop({ timeout_ms = 15000 } = {}) {
        if (!running) return;
        stopping = true;
        if (timer) clearInterval(timer);
        timer = null;

        /*
         * Fire abort on every in-flight row's signal so long polls
         * wake immediately. The stage handlers see signal.aborted and
         * return cleanly without writing a "halt" event — the row's
         * state stays in its current polling state for resume.
         */
        for (const controller of abort_controllers.values()) {
            try {
                controller.abort();
            } catch {
                // No-op; abort is idempotent.
            }
        }

        try {
            await Promise.race([
                in_flight,
                new Promise((resolve) => setTimeout(resolve, timeout_ms)),
            ]);
        } catch {
            // allSettled never rejects; defensive.
        }

        running = false;
        log.info({ event: 'ingest_worker_stopped' });
    }

    /*
     * Staff-initiated cancel hook. Signals the AbortController for
     * the row (if one is registered — i.e. the worker is currently
     * dispatching this row through a polling stage). Stages that
     * honor the signal exit on the next poll wake; the
     * controller-layer cancel handler updates the queue row to
     * CANCELLED_BY_USER concurrently. Stages without polling
     * (Stage 1, Stage 5) are bounded enough that staff doesn't
     * need a mid-stage abort — the cancel still updates state and
     * the worker simply won't re-claim the row.
     * 
     * Returns:
     *   { aborted: true }   — controller signalled (row was mid-stage)
     *   { aborted: false }  — no in-flight stage for this id
     *                         (already terminal, or PENDING + not
     *                          claimed by this tick yet)
     * 
     * Idempotent — calling cancel_row on an id that's no longer
     * in-flight is a clean no-op.
     */
    function cancel_row(id) {
        const controller = abort_controllers.get(id);
        if (!controller) return { aborted: false };
        controller.abort();
        /*
         * Don't delete the map entry here — dispatch_one's finally
         * block does that, and the stage may still be unwinding.
         */
        return { aborted: true };
    }

    return {
        start,
        stop,
        cancel_row,
        /*
         * Exposed for tests: force a single tick instead of waiting
         * for the interval. Returns the promise so tests can await.
         */
        tick,
        // Test introspection.
        _is_running() {
            return running;
        },
        _in_flight_count() {
            return abort_controllers.size;
        },
    };
}

/*
 * Module-level reference to the worker instance currently driving the
 * queue in this process. Set by the entry point (repo-backend-v2.js)
 * after `create_worker()` so the controller layer can reach in for
 * staff-initiated cancels without each request needing to recreate
 * the worker. Tests don't touch this — they create their own worker
 * instance and exercise `cancel_row` on it directly.
 */
let _active_worker = null;
function set_active_worker(w) {
    _active_worker = w;
}
function get_active_worker() {
    return _active_worker;
}

module.exports = {
    create_worker,
    STAGE_BY_STATE,
    AM_ENTRY_STATES,
    AM_INSIDE_STATES,
    AM_ACTIVE_STATES,
    set_active_worker,
    get_active_worker,
};
