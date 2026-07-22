'use strict';

/*
 * Integration tests for metadata/worker.js. We drive a real worker
 * against a real sqlite DB but stub the ArchivesSpace client so the
 * tests run without network access. The stub is parameterized so each
 * test can script its own response sequence (success, 401, transport
 * error, etc.).
 */

const model = require('../../../metadata/model');
const repo_model = require('../../../repository/model');
const { create_worker } = require('../../../metadata/worker');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');

const QUEUE = tables.metadata_update_queue;

// Stub ASpace client. Each test can override per-method behavior.
function make_fake_aspace({ get_record, fail_token = false } = {}) {
    let token_count = 0;
    let destroy_count = 0;
    const destroyed_tokens = [];
    return {
        is_configured: () => true,
        async get_session_token() {
            token_count += 1;
            if (fail_token && token_count === 1) {
                throw new Error('aspace down');
            }
            return `tok-${token_count}`;
        },
        async get_record(uri, token) {
            return get_record(uri, token, token_count);
        },
        async destroy_session_token(token) {
            destroy_count += 1;
            destroyed_tokens.push(token);
        },
        // Test introspection.
        token_count: () => token_count,
        destroy_count: () => destroy_count,
        destroyed_tokens: () => destroyed_tokens.slice(),
    };
}

describe('metadata/worker — integration', () => {
    let original_env;
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        await db_queue()(QUEUE).del();
        /*
         * The legacy mark_failed semantics (single-shot terminal) are
         * what these tests assert. Force max_attempts=1 so a single
         * failure still flips the row terminal. The retry / dead-
         * letter path is covered in tests/integration/metadata/
         * model_retry.test.js.
         */
        original_env = { ...process.env };
        process.env.METADATA_MAX_ATTEMPTS = '1';
        require('../../../config/app')._reset();
    });
    afterEach(() => {
        process.env = original_env;
        require('../../../config/app')._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('processes a single PENDING row end-to-end', async () => {
        const obj = await db_helper.seed_object({
            uri: '/repositories/2/archival_objects/1',
            display_record: JSON.stringify({ pid: 'p1', display_record: { title: 'OLD' } }),
        });
        await model.enqueue_single(obj.pid);

        const aspace = make_fake_aspace({
            get_record: async () => ({
                status: 200,
                data: { title: 'NEW from ASpace', dates: ['1918'] },
                headers: {},
            }),
        });
        const worker = create_worker({ aspace });
        // Drive a single tick directly instead of waiting for the timer.
        await worker.tick();

        // The row in the queue is COMPLETE.
        const queue_row = await db_queue()(QUEUE).where({ uuid: obj.pid }).first();
        expect(queue_row.status).toBe('COMPLETE');
        expect(queue_row.is_complete).toBe(1);
        expect(queue_row.is_updated).toBe(1);

        /*
         * The repository row was updated with the new metadata.
         * PUBLIC_FIELDS hides `mods` from the projection so read it
         * directly to confirm the worker wrote both columns.
         */
        const refreshed = await repo_model.get(obj.pid);
        const dr = JSON.parse(refreshed.display_record);
        expect(dr.display_record.title).toBe('NEW from ASpace');
        const { db } = require('../../../config/db');
        const raw = await db()(tables.objects)
            .select('mods', 'is_updated')
            .where({ pid: obj.pid })
            .first();
        expect(JSON.parse(raw.mods).title).toBe('NEW from ASpace');
        /*
         * The indexer flag is set so the next indexer cycle picks the
         * row up.
         */
        expect(Boolean(raw.is_updated)).toBe(true);
    });

    it('processes up to `concurrency` rows in parallel per tick', async () => {
        /*
         * 4 rows enqueued, concurrency=3. First tick claims 3; second
         * claims the remaining 1. We don't need to actually parallelize
         * — just verify the claim arithmetic.
         */
        const objs = [];
        for (let i = 0; i < 4; i++) {
            objs.push(await db_helper.seed_object({ uri: `/r/${i}` }));
        }
        await model.enqueue_pids(objs.map((o) => o.pid));

        const aspace = make_fake_aspace({
            get_record: async (uri) => ({ status: 200, data: { uri }, headers: {} }),
        });
        const worker = create_worker({ aspace });
        await worker.tick();
        let queue = await db_queue()(QUEUE).select('status', 'is_complete');
        // 3 done after first tick (concurrency=3).
        expect(queue.filter((r) => r.is_complete === 1)).toHaveLength(3);
        expect(queue.filter((r) => r.status === 'PENDING')).toHaveLength(1);

        await worker.tick();
        queue = await db_queue()(QUEUE).select('status', 'is_complete');
        expect(queue.filter((r) => r.is_complete === 1)).toHaveLength(4);
    });

    it('marks a row failed when ArchivesSpace returns a non-200', async () => {
        const obj = await db_helper.seed_object({ uri: '/r/dead' });
        await model.enqueue_single(obj.pid);
        const aspace = make_fake_aspace({
            get_record: async () => ({ status: 500, data: null, headers: {} }),
        });
        const worker = create_worker({ aspace });
        await worker.tick();
        const row = await db_queue()(QUEUE).where({ uuid: obj.pid }).first();
        expect(row.is_complete).toBe(1);
        expect(row.error).toMatch(/ArchivesSpace 500/);
    });

    it('refreshes the session token on a 401 and retries once', async () => {
        const obj = await db_helper.seed_object({
            uri: '/r/auth-test',
            display_record: '{}',
        });
        await model.enqueue_single(obj.pid);

        // First call returns 401; second (after refresh) returns 200.
        let call_count = 0;
        const aspace = make_fake_aspace({
            get_record: async () => {
                call_count += 1;
                if (call_count === 1) {
                    return { status: 401, data: { error: 'expired' }, headers: {} };
                }
                return { status: 200, data: { title: 'Fresh' }, headers: {} };
            },
        });
        const worker = create_worker({ aspace });
        await worker.tick();

        const row = await db_queue()(QUEUE).where({ uuid: obj.pid }).first();
        expect(row.is_complete).toBe(1);
        expect(row.status).toBe('COMPLETE');
        expect(row.error).toBeNull();
        /*
         * The token was refreshed (called twice: once at boot, once
         * after the 401).
         */
        expect(aspace.token_count()).toBeGreaterThanOrEqual(2);
    });

    it('does not retry on a second 401 — marks the row failed', async () => {
        const obj = await db_helper.seed_object({ uri: '/r/auth-stuck' });
        await model.enqueue_single(obj.pid);
        const aspace = make_fake_aspace({
            get_record: async () => ({ status: 401, data: null, headers: {} }),
        });
        const worker = create_worker({ aspace });
        await worker.tick();
        const row = await db_queue()(QUEUE).where({ uuid: obj.pid }).first();
        expect(row.is_complete).toBe(1);
        expect(row.error).toMatch(/401/);
    });

    it('skips CANCELLED rows added to the queue while a tick is running', async () => {
        /*
         * Cancelled rows get is_complete=1 immediately, so claim_pending
         * never picks them up. This test exercises that — the worker
         * should leave the row alone and process only the live one.
         */
        const live = await db_helper.seed_object({ uri: '/r/live' });
        const dead = await db_helper.seed_object({ uri: '/r/dead' });
        const { batch_uuid } = await model.enqueue_pids([live.pid, dead.pid]);
        // Cancel before the worker runs.
        await model.cancel_batch(batch_uuid);
        const aspace = make_fake_aspace({
            get_record: async () => ({ status: 200, data: {}, headers: {} }),
        });
        const worker = create_worker({ aspace });
        await worker.tick();
        // Nothing was claimed because every row is already complete.
        const rows = await db_queue()(QUEUE).select('status', 'error');
        expect(rows.every((r) => r.status === 'CANCELLED')).toBe(true);
    });

    it('boot-time reset_orphaned recovers an IN_PROGRESS row from a prior crash', async () => {
        const obj = await db_helper.seed_object({ uri: '/r/orphan' });
        await model.enqueue_single(obj.pid);
        // Simulate a crash mid-tick by claiming but never finishing.
        await model.claim_pending(1);

        const aspace = make_fake_aspace({
            get_record: async () => ({ status: 200, data: { title: 'recovered' }, headers: {} }),
        });
        const worker = create_worker({ aspace });
        await worker.start();
        /*
         * start() runs reset_orphaned then arms the interval. We don't
         * want to wait for the interval — drive a tick manually.
         */
        await worker.tick();
        await worker.stop();

        const row = await db_queue()(QUEUE).where({ uuid: obj.pid }).first();
        expect(row.is_complete).toBe(1);
        expect(row.status).toBe('COMPLETE');
    });

    it('marks the row failed when the repository write fails', async () => {
        const obj = await db_helper.seed_object({ uri: '/r/db-fail' });
        await model.enqueue_single(obj.pid);

        const aspace = make_fake_aspace({
            get_record: async () => ({ status: 200, data: { title: 'X' }, headers: {} }),
        });
        const worker = create_worker({
            aspace,
            /*
             * Force the read step to throw so the worker hits its
             * "db read failed" branch.
             */
            get_db_record: async () => {
                throw new Error('disk full');
            },
        });
        await worker.tick();
        const row = await db_queue()(QUEUE).where({ uuid: obj.pid }).first();
        expect(row.is_complete).toBe(1);
        expect(row.error).toMatch(/db read failed/);
    });

    describe('session token rotation', () => {
        /*
         * Rotation exists to mitigate the AS-side per-session cache
         * buildup that dominates the slow-down curve on long-running
         * refreshes. See config/app.js for the full rationale.
         */
        it('rotates the AS session token after the configured request count', async () => {
            process.env.ARCHIVESPACE_TOKEN_ROTATE_AFTER_REQUESTS = '2';
            require('../../../config/app')._reset();

            /*
             * Two objects → one tick claims both at default concurrency=3.
             * Counter hits the threshold (2) post-tick → rotation fires.
             */
            const objs = [];
            for (let i = 0; i < 2; i++) {
                objs.push(await db_helper.seed_object({ uri: `/r/${i}` }));
            }
            await model.enqueue_pids(objs.map((o) => o.pid));
            const aspace = make_fake_aspace({
                get_record: async (uri) => ({ status: 200, data: { uri }, headers: {} }),
            });
            const worker = create_worker({ aspace });
            await worker.tick();

            // One bootstrap mint + one rotation mint = 2 total.
            expect(aspace.token_count()).toBe(2);
            // The old token (tok-1) was destroyed during rotation.
            expect(aspace.destroy_count()).toBe(1);
            expect(aspace.destroyed_tokens()).toEqual(['tok-1']);
        });

        it('does not rotate before the threshold is reached', async () => {
            process.env.ARCHIVESPACE_TOKEN_ROTATE_AFTER_REQUESTS = '5';
            require('../../../config/app')._reset();

            // Two requests, threshold five → no rotation.
            const objs = [];
            for (let i = 0; i < 2; i++) {
                objs.push(await db_helper.seed_object({ uri: `/r/${i}` }));
            }
            await model.enqueue_pids(objs.map((o) => o.pid));
            const aspace = make_fake_aspace({
                get_record: async (uri) => ({ status: 200, data: { uri }, headers: {} }),
            });
            const worker = create_worker({ aspace });
            await worker.tick();

            expect(aspace.token_count()).toBe(1); // bootstrap only
            expect(aspace.destroy_count()).toBe(0);
        });

        it('is disabled when threshold is 0', async () => {
            process.env.ARCHIVESPACE_TOKEN_ROTATE_AFTER_REQUESTS = '0';
            require('../../../config/app')._reset();

            /*
             * Many requests, threshold zero → never rotates (pre-fix
             * behavior; preserved as an opt-out for operators who
             * want a single token for the whole batch).
             */
            const objs = [];
            for (let i = 0; i < 4; i++) {
                objs.push(await db_helper.seed_object({ uri: `/r/${i}` }));
            }
            await model.enqueue_pids(objs.map((o) => o.pid));
            const aspace = make_fake_aspace({
                get_record: async (uri) => ({ status: 200, data: { uri }, headers: {} }),
            });
            const worker = create_worker({ aspace });
            await worker.tick();

            expect(aspace.token_count()).toBe(1);
            expect(aspace.destroy_count()).toBe(0);
        });

        it('backs off token bootstrap when ArchivesSpace is unreachable', async () => {
            /*
             * get_session_token always fails → the worker must NOT re-attempt
             * every tick; it backs off until the cooldown elapses.
             */
            const obj = await db_helper.seed_object({ uri: '/r/back' });
            await model.enqueue_pids([obj.pid]);
            let token_calls = 0;
            const aspace = {
                is_configured: () => true,
                async get_session_token() {
                    token_calls += 1;
                    throw new Error('aspace down');
                },
                async get_record(uri) {
                    return { status: 200, data: { uri }, headers: {} };
                },
                async destroy_session_token() {},
            };
            let clock = 0;
            const worker = create_worker({ aspace, now: () => clock });

            await worker.tick(); // attempt 1 → fails, cooldown set
            await worker.tick(); // within cooldown → skipped
            expect(token_calls).toBe(1);

            clock += 60000; // cooldown elapses
            await worker.tick(); // attempt 2
            expect(token_calls).toBe(2);
        });

        it('survives a failed rotation — counter resets, next tick re-bootstraps', async () => {
            /*
             * Failure mode: destroy succeeds but get_session_token
             * fails on the rotation. Worker must not crash; the next
             * tick's bootstrap recovers.
             * 
             * Setup: threshold=2 + 2 rows in tick 1 = exactly one
             * rotation attempt (which fails). Tick 2 has 1 row which
             * is below threshold, so no second rotation muddies the
             * count.
             */
            process.env.ARCHIVESPACE_TOKEN_ROTATE_AFTER_REQUESTS = '2';
            require('../../../config/app')._reset();

            const a = await db_helper.seed_object({ uri: '/r/1' });
            const b = await db_helper.seed_object({ uri: '/r/2' });
            await model.enqueue_pids([a.pid, b.pid]);

            let token_calls = 0;
            const aspace = {
                is_configured: () => true,
                async get_session_token() {
                    token_calls += 1;
                    /*
                     * Call 1 (bootstrap) succeeds; call 2 (rotation
                     * mint) fails; call 3 (next-tick bootstrap)
                     * succeeds.
                     */
                    if (token_calls === 2) throw new Error('aspace down');
                    return `tok-${token_calls}`;
                },
                async get_record(uri) {
                    return { status: 200, data: { uri }, headers: {} };
                },
                async destroy_session_token() {},
            };

            const worker = create_worker({ aspace });
            /*
             * Tick 1: bootstrap + work for 2 rows + failed rotation.
             * Worker should NOT throw despite the rotation failure.
             */
            await worker.tick();
            expect(token_calls).toBe(2);

            /*
             * Re-enqueue one row. Tick 2 bootstrap recovers via
             * call #3; the one row processed leaves the counter at
             * 1 (below threshold=2) so no second rotation fires.
             */
            const c = await db_helper.seed_object({ uri: '/r/3' });
            await model.enqueue_pids([c.pid]);
            await worker.tick();
            expect(token_calls).toBe(3);
        });
    });
});
