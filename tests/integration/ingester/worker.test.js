'use strict';

/*
 * Worker integration tests — exercises the claim loop, dispatcher,
 * graceful shutdown, and orphan reset. Stages are stubbed so we
 * assert dispatch behavior cleanly.
 */

const app_config = require('../../../config/app');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const model = require('../../../ingester/model');
const { create_worker } = require('../../../ingester/worker');

async function seed(status, overrides = {}) {
    const [id] = await model.queue_packages([
        {
            batch: 'batch-A',
            package: `pkg-${Math.random().toString(16).slice(2, 8)}`,
            collection_uuid: 'codu:test',
            job_uuid: 'job-1',
            metadata_uri: '/repositories/2/resources/1',
            status,
            ...overrides,
        },
    ]);
    return db_queue()(tables.ingest_queue).where({ id }).first();
}

function dispatched_stage(seen, name) {
    return {
        async run(row, { signal } = {}) {
            seen.push({ name, id: row.id, state: row.pipeline_state, has_signal: !!signal });
            /*
             * Move the row out of the active state so the next tick
             * doesn't re-claim it.
             */
            await model.update_queue({ id: row.id }, { status: 'UPLOAD_COMPLETE' });
        },
    };
}

describe('ingester/worker', () => {
    let saved_env;
    beforeAll(async () => {
        saved_env = { ...process.env };
        process.env.INGEST_WORKER_ENABLED = 'true';
        process.env.INGEST_WORKER_CONCURRENCY = '3';
        process.env.INGEST_WORKER_POLL_MS = '500';
        /*
         * The legacy interleaved behavior (multiple packages advancing
         * concurrently, AM-only gating) is what most of this suite
         * pins — run it under the escape hatch. The serial-pipeline
         * default gets its own describe at the bottom.
         */
        process.env.INGEST_PIPELINE_SERIAL = 'false';
        app_config._reset();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        process.env = saved_env;
        app_config._reset();
        await db_helper.teardown();
    });

    it('tick dispatches PENDING rows to the process_metadata stage', async () => {
        await seed('PENDING');
        await seed('PENDING');
        const seen = [];
        const worker = create_worker({
            stages: {
                PENDING: dispatched_stage(seen, 'process_metadata'),
            },
        });
        await worker.tick();
        expect(seen).toHaveLength(2);
        expect(seen.every((s) => s.name === 'process_metadata')).toBe(true);
        expect(seen.every((s) => s.has_signal)).toBe(true);
    });

    it('tick dispatches QA_COMPLETE rows to the upload stage', async () => {
        await seed('QA_COMPLETE');
        const seen = [];
        const worker = create_worker({
            stages: { QA_COMPLETE: dispatched_stage(seen, 'upload') },
        });
        await worker.tick();
        expect(seen).toHaveLength(1);
        expect(seen[0].name).toBe('upload');
    });

    it('respects the concurrency cap on a single tick', async () => {
        // Seed 5 PENDING rows; concurrency is 3.
        for (let i = 0; i < 5; i++) await seed('PENDING');
        const seen = [];
        const worker = create_worker({
            stages: { PENDING: dispatched_stage(seen, 'process_metadata') },
        });
        await worker.tick();
        expect(seen).toHaveLength(3);
    });

    it('skips terminal-state rows (FAILED, COMPLETE, etc.)', async () => {
        await seed('FAILED');
        await seed('COMPLETE');
        await seed('AS_METADATA_INVALID');
        const seen = [];
        const worker = create_worker({
            stages: { PENDING: dispatched_stage(seen, 'p') },
        });
        await worker.tick();
        expect(seen).toHaveLength(0);
    });

    it('skips rows whose state has no registered stage', async () => {
        await seed('TRANSFER_IN_PROGRESS'); // Stage 3 not registered yet
        const seen = [];
        const worker = create_worker({
            stages: { PENDING: dispatched_stage(seen, 'p') },
        });
        await worker.tick();
        expect(seen).toHaveLength(0);
    });

    it('marks the row INGEST_HALTED when a stage throws an unhandled exception', async () => {
        const row = await seed('PENDING');
        const worker = create_worker({
            stages: {
                PENDING: {
                    async run() {
                        throw new Error('stage exploded');
                    },
                },
            },
        });
        await worker.tick();
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
        expect(fresh.error).toContain('stage exploded');
    });

    it('start() resets orphans and stop() drains in-flight work', async () => {
        // Seed an ACTIVELY_RUNNING row that will be swept on boot.
        const orphan = await seed('STARTING');
        const seen = [];
        /*
         * Use a stage that blocks until the abort signal fires —
         * mimics a long QA poll. We DON'T await the tick (it can't
         * resolve until stop() aborts the signal), so the test
         * structure is: kick the tick → wait for in-flight → stop().
         */
        const worker = create_worker({
            stages: {
                PENDING: {
                    async run(row, { signal }) {
                        await new Promise((resolve) => {
                            if (signal.aborted) return resolve();
                            signal.addEventListener('abort', resolve, { once: true });
                        });
                        seen.push({ id: row.id, aborted: true });
                    },
                },
            },
        });

        await worker.start();

        /*
         * After start(), the orphan should have been reset to PENDING
         * even before any tick runs.
         */
        const orphan_after_boot = await db_queue()(tables.ingest_queue)
            .where({ id: orphan.id })
            .first();
        expect(orphan_after_boot.pipeline_state).toBe('PENDING');

        /*
         * Kick a tick but don't await — it won't resolve until stop()
         * aborts the in-flight signal.
         */
        const tick_done = worker.tick();
        // Wait for the dispatcher to register the row's controller.
        for (let i = 0; i < 50; i++) {
            if (worker._in_flight_count() > 0) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        expect(worker._in_flight_count()).toBeGreaterThan(0);

        await worker.stop({ timeout_ms: 2000 });
        /*
         * The blocked stage resolved when the abort fired; the tick
         * promise should now resolve too.
         */
        await tick_done;
        expect(worker._is_running()).toBe(false);
        expect(worker._in_flight_count()).toBe(0);
        expect(seen).toHaveLength(1);
        expect(seen[0].id).toBe(orphan.id);
    });

    it('cancel_row() signals the in-flight AbortController and returns aborted=true', async () => {
        await seed('PENDING');
        let signalled = null;
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const worker = create_worker({
            stages: {
                PENDING: {
                    async run(row, { signal }) {
                        signal.addEventListener('abort', () => {
                            signalled = row.id;
                            release();
                        });
                        await gate;
                    },
                },
            },
        });
        const tick_done = worker.tick();
        // Wait for the dispatcher to register the row's controller.
        for (let i = 0; i < 50; i++) {
            if (worker._in_flight_count() > 0) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        // The dispatched row's id — read from the queue.
        const inflight = await db_queue()(tables.ingest_queue)
            .where({ pipeline_state: 'PENDING' })
            .first();
        const out = worker.cancel_row(inflight.id);
        expect(out).toEqual({ aborted: true });
        await tick_done;
        expect(signalled).toBe(inflight.id);
        /*
         * Sanity: a second cancel on the same id is a clean no-op
         * because dispatch_one's finally cleared the controller.
         */
        const out2 = worker.cancel_row(inflight.id);
        expect(out2).toEqual({ aborted: false });
    });

    it('cancel_row() returns aborted=false when the row is not in flight', async () => {
        const worker = create_worker({ stages: {} });
        const out = worker.cancel_row(9999);
        expect(out).toEqual({ aborted: false });
    });

    describe('AM-active gate', () => {
        /*
         * The gate admits at most one row at a time into the AM
         * window (UPLOAD_COMPLETE through INGEST_IN_PROGRESS). These
         * tests pin the behavior so a future tick refactor can't
         * silently re-introduce parallel start_transfer calls.
         */

        /*
         * Use a "noop" stage that just records the dispatch and
         * leaves the row in its state — lets us assert "row not
         * dispatched" without the stage moving the row elsewhere.
         */
        function noop_stage(seen, name) {
            return {
                async run(row) {
                    seen.push({ name, id: row.id, state: row.pipeline_state });
                },
            };
        }

        it('admits exactly one UPLOAD_COMPLETE row when two are pending', async () => {
            await seed('UPLOAD_COMPLETE');
            await seed('UPLOAD_COMPLETE');
            const seen = [];
            const worker = create_worker({
                stages: { UPLOAD_COMPLETE: noop_stage(seen, 'transfer') },
            });
            await worker.tick();
            /*
             * Concurrency is 3 in this suite, but the AM gate caps
             * AM-state claims at 1 per tick.
             */
            expect(seen).toHaveLength(1);
        });

        it('does NOT claim UPLOAD_COMPLETE while another row is TRANSFER_IN_PROGRESS', async () => {
            await seed('TRANSFER_IN_PROGRESS');
            await seed('UPLOAD_COMPLETE');
            const seen = [];
            const worker = create_worker({
                stages: {
                    UPLOAD_COMPLETE: noop_stage(seen, 'transfer'),
                    /*
                     * No handler for TRANSFER_IN_PROGRESS in this test
                     * — the row in the DB is what gates the new admit.
                     */
                },
            });
            await worker.tick();
            expect(seen).toHaveLength(0);
        });

        it('does NOT claim UPLOAD_COMPLETE while another row is INGEST_IN_PROGRESS', async () => {
            await seed('INGEST_IN_PROGRESS');
            await seed('UPLOAD_COMPLETE');
            const seen = [];
            const worker = create_worker({
                stages: { UPLOAD_COMPLETE: noop_stage(seen, 'transfer') },
            });
            await worker.tick();
            expect(seen).toHaveLength(0);
        });

        it('admits UPLOAD_COMPLETE once existing AM-active rows reach INGEST_COMPLETE', async () => {
            /*
             * INGEST_COMPLETE is intentionally OUT of the gate set —
             * AM is done; DC propagation poll doesn't load AM. Next
             * package can safely start_transfer.
             */
            await seed('INGEST_COMPLETE');
            await seed('UPLOAD_COMPLETE');
            const seen = [];
            const worker = create_worker({
                stages: { UPLOAD_COMPLETE: noop_stage(seen, 'transfer') },
            });
            await worker.tick();
            expect(seen).toHaveLength(1);
            expect(seen[0].state).toBe('UPLOAD_COMPLETE');
        });

        it('still runs PENDING and QA_COMPLETE rows in parallel while an AM row is active', async () => {
            /*
             * Non-AM stages aren't gated — the whole point of the
             * design is to preserve Stage 1+2 parallelism while
             * serializing the AM window.
             */
            await seed('TRANSFER_IN_PROGRESS'); // holds the AM slot
            await seed('PENDING');
            await seed('QA_COMPLETE');
            const seen = [];
            const worker = create_worker({
                stages: {
                    PENDING: noop_stage(seen, 'process_metadata'),
                    QA_COMPLETE: noop_stage(seen, 'upload'),
                },
            });
            await worker.tick();
            /*
             * Both non-AM rows dispatched; the gate only blocks
             * AM-state claims.
             */
            expect(seen).toHaveLength(2);
            const names = seen.map((s) => s.name).sort();
            expect(names).toEqual(['process_metadata', 'upload']);
        });

        it('gate releases the moment the AM row leaves AM-active states', async () => {
            /*
             * Tick 1: AM row holds the slot, UPLOAD_COMPLETE row is gated.
             * Then we manually advance the AM row past the gate, and a
             * fresh tick admits the previously-gated row.
             */
            const am_row = await seed('TRANSFER_IN_PROGRESS');
            await seed('UPLOAD_COMPLETE');
            const seen = [];
            const worker = create_worker({
                stages: { UPLOAD_COMPLETE: noop_stage(seen, 'transfer') },
            });
            await worker.tick();
            expect(seen).toHaveLength(0);
            /*
             * Simulate AM ingest finishing — the row moves past the
             * gate set into INGEST_COMPLETE (which is NOT gated).
             */
            await model.update_queue({ id: am_row.id }, { status: 'INGEST_COMPLETE' });
            await worker.tick();
            expect(seen).toHaveLength(1);
        });

        it('INGEST_AM_PARALLEL=true bypasses the gate (legacy / dev escape hatch)', async () => {
            /*
             * Pre-gate behavior: two UPLOAD_COMPLETE rows both
             * dispatched in a single tick. Production should NEVER
             * enable this — it's only for tests and small-batch dev.
             */
            const prior = process.env.INGEST_AM_PARALLEL;
            process.env.INGEST_AM_PARALLEL = 'true';
            app_config._reset();
            try {
                await seed('UPLOAD_COMPLETE');
                await seed('UPLOAD_COMPLETE');
                const seen = [];
                const worker = create_worker({
                    stages: { UPLOAD_COMPLETE: noop_stage(seen, 'transfer') },
                });
                await worker.tick();
                expect(seen).toHaveLength(2);
            } finally {
                if (prior === undefined) delete process.env.INGEST_AM_PARALLEL;
                else process.env.INGEST_AM_PARALLEL = prior;
                app_config._reset();
            }
        });
    });

    it('does not double-claim a row that is already in flight from a prior tick', async () => {
        /*
         * This tests the in_flight guard inside tick(). Seed one row,
         * start a slow stage, kick two ticks; the second one should
         * see no claim because the first hasn't released the row's
         * controller yet.
         */
        await seed('PENDING');
        const seen = [];
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const worker = create_worker({
            stages: {
                PENDING: {
                    async run(row) {
                        seen.push(row.id);
                        await gate;
                    },
                },
            },
        });
        const first = worker.tick();
        /*
         * Give the first tick a moment to populate abort_controllers
         * before kicking off the second.
         */
        await new Promise((r) => setTimeout(r, 20));
        const second = worker.tick();
        await second; // second tick sees nothing to claim
        expect(seen).toHaveLength(1);
        release();
        await first;
    });

    describe('serial pipeline (INGEST_PIPELINE_SERIAL, the default)', () => {
        /*
         * 2026-07-30: one package at a time through stages 1–5. A new
         * package (PENDING) starts only when NOTHING is mid-pipeline;
         * mid-pipeline rows advance one dispatch at a time; stage 6
         * (AIP→Wasabi) runs alongside untouched.
         */
        beforeAll(() => {
            process.env.INGEST_PIPELINE_SERIAL = 'true';
            app_config._reset();
        });
        afterAll(() => {
            process.env.INGEST_PIPELINE_SERIAL = 'false';
            app_config._reset();
        });

        function noop_stage(seen, name) {
            return {
                async run(row) {
                    seen.push({ name, id: row.id, state: row.pipeline_state });
                },
            };
        }

        it('admits exactly one PENDING package per tick, even under concurrency 3', async () => {
            await seed('PENDING');
            await seed('PENDING');
            await seed('PENDING');
            const seen = [];
            const worker = create_worker({
                stages: { PENDING: noop_stage(seen, 'process_metadata') },
            });
            await worker.tick();
            expect(seen).toHaveLength(1);
        });

        it('a resting mid-pipeline row blocks any NEW package from starting', async () => {
            /*
             * Previous package is between stages (e.g. metadata done,
             * upload not yet claimed) — the next package must wait.
             */
            await seed('QA_COMPLETE');
            await seed('PENDING');
            const seen = [];
            const worker = create_worker({
                stages: { PENDING: noop_stage(seen, 'process_metadata') },
            });
            await worker.tick();
            expect(seen).toHaveLength(0);
        });

        it('advancing the in-flight package wins over starting a new one', async () => {
            await seed('UPLOAD_COMPLETE');
            await seed('PENDING');
            const seen = [];
            const worker = create_worker({
                stages: {
                    UPLOAD_COMPLETE: noop_stage(seen, 'transfer'),
                    PENDING: noop_stage(seen, 'process_metadata'),
                },
            });
            await worker.tick();
            expect(seen).toHaveLength(1);
            expect(seen[0].name).toBe('transfer');
        });

        it('stage 6 (AIP store) dispatches alongside the serial pipeline', async () => {
            await seed('UPLOAD_COMPLETE');
            await seed('AIP_STORE_PENDING');
            const seen = [];
            const worker = create_worker({
                stages: {
                    UPLOAD_COMPLETE: noop_stage(seen, 'transfer'),
                    AIP_STORE_PENDING: noop_stage(seen, 'aip_store'),
                },
            });
            await worker.tick();
            const names = seen.map((s) => s.name).sort();
            expect(names).toEqual(['aip_store', 'transfer']);
        });

        it('the next package starts once the previous one completes (or halts)', async () => {
            await seed('PENDING');
            await seed('PENDING');
            const seen = [];
            const completing_stage = {
                async run(row) {
                    seen.push(row.id);
                    /* Simulate the package finishing stage 5. */
                    await model.update_queue(
                        { id: row.id },
                        { status: 'COMPLETE', is_complete: 1 }
                    );
                },
            };
            const worker = create_worker({ stages: { PENDING: completing_stage } });
            await worker.tick();
            expect(seen).toHaveLength(1);
            await worker.tick();
            expect(seen).toHaveLength(2);
            expect(seen[0]).not.toBe(seen[1]);

            /*
             * Halted packages step aside the same way: seed one halted
             * mid-pipeline row — it must NOT block a new PENDING.
             */
            await db_helper.reset_data();
            await seed('INGEST_HALTED');
            const halted_seen = [];
            const w2 = create_worker({
                stages: { PENDING: noop_stage(halted_seen, 'process_metadata') },
            });
            await seed('PENDING');
            await w2.tick();
            expect(halted_seen).toHaveLength(1);
        });
    });

    describe('stage 6 gate (AIP_STORE_SERIAL, the default)', () => {
        /*
         * 2026-07-31: one AIP copy at a time. Two concurrent large-AIP
         * copies wedged AM Storage's download path (2×66GB-scale), so
         * Stage 6 gets the same two-tier gate shape as the AM gate:
         * in-memory dispatch cap + DB-side AIP_STORE_IN_PROGRESS count
         * for the restart-invariant entry check.
         */
        function noop_stage(seen, name) {
            return {
                async run(row) {
                    seen.push({ name, id: row.id, state: row.pipeline_state });
                },
            };
        }

        it('admits exactly one AIP_STORE_PENDING row per tick', async () => {
            await seed('AIP_STORE_PENDING');
            await seed('AIP_STORE_PENDING');
            const seen = [];
            const worker = create_worker({
                stages: { AIP_STORE_PENDING: noop_stage(seen, 'aip_store') },
            });
            await worker.tick();
            expect(seen).toHaveLength(1);
        });

        it('a resting AIP_STORE_IN_PROGRESS row blocks a NEW copy; the resume wins', async () => {
            /*
             * Post-restart shape: one copy was underway when the
             * worker died (row rests at IN_PROGRESS in the DB), and
             * another package has since reached Stage 6. The resume
             * must be the one dispatched; the new copy waits.
             */
            await seed('AIP_STORE_PENDING');
            await seed('AIP_STORE_IN_PROGRESS');
            const seen = [];
            const worker = create_worker({
                stages: {
                    AIP_STORE_PENDING: noop_stage(seen, 'aip_store_new'),
                    AIP_STORE_IN_PROGRESS: noop_stage(seen, 'aip_store_resume'),
                },
            });
            await worker.tick();
            expect(seen).toHaveLength(1);
            expect(seen[0].name).toBe('aip_store_resume');
        });

        it('the next copy starts once the in-progress one completes', async () => {
            await seed('AIP_STORE_PENDING');
            await seed('AIP_STORE_PENDING');
            const seen = [];
            const completing_stage = {
                async run(row) {
                    seen.push(row.id);
                    await model.update_queue(
                        { id: row.id },
                        { status: 'AIP_STORE_COMPLETE', is_complete: 1 }
                    );
                },
            };
            const worker = create_worker({
                stages: { AIP_STORE_PENDING: completing_stage },
            });
            await worker.tick();
            expect(seen).toHaveLength(1);
            await worker.tick();
            expect(seen).toHaveLength(2);
            expect(seen[0]).not.toBe(seen[1]);
        });

        it('AIP_STORE_SERIAL=false restores parallel Stage 6 (escape hatch)', async () => {
            process.env.AIP_STORE_SERIAL = 'false';
            app_config._reset();
            try {
                await seed('AIP_STORE_PENDING');
                await seed('AIP_STORE_PENDING');
                const seen = [];
                const worker = create_worker({
                    stages: { AIP_STORE_PENDING: noop_stage(seen, 'aip_store') },
                });
                await worker.tick();
                expect(seen).toHaveLength(2);
            } finally {
                delete process.env.AIP_STORE_SERIAL;
                app_config._reset();
            }
        });
    });
});
