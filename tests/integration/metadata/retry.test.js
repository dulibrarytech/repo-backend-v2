'use strict';

/*
 * Retry + dead-letter behavior on mark_failed. Separate file from the
 * legacy model.test.js so we can run it under the new default
 * (max_attempts > 1) without contradicting the older single-shot
 * assertions there.
 * 
 * Coverage:
 *   - attempts increments on failure, status returns to PENDING
 *     until the cap is reached
 *   - cap reached → DEAD_LETTERED with error + last_error set
 *   - mark_complete after a retry-PENDING row is normal
 *   - claim_pending respects (priority ASC, id ASC) ordering
 */

const model = require('../../../metadata/model');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');

const QUEUE = tables.metadata_update_queue;

describe('metadata/model — retry + dead-letter', () => {
    let original_env;
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        /*
         * Default: 3 attempts (matches production default). Some tests
         * override to 2 for terser scenarios.
         */
        original_env = { ...process.env };
        process.env.METADATA_MAX_ATTEMPTS = '3';
        /*
         * Disable retry backoff for these tests. They drive
         * mark_failed -> claim_pending in immediate succession; with
         * backoff on, the second claim would skip the row until the
         * backoff elapsed. Backoff behavior itself is covered by the
         * dedicated test below ('mark_failed retry backoff').
         */
        process.env.METADATA_RETRY_BASE_BACKOFF_MS = '0';
        require('../../../config/app')._reset();
    });
    afterEach(() => {
        process.env = original_env;
        require('../../../config/app')._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('mark_failed retry', () => {
        it('returns {outcome: "retry"} and flips row back to PENDING on first failure', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);
            const [claimed] = await model.claim_pending(1);
            const result = await model.mark_failed(claimed.id, 'ASpace 502');
            expect(result.outcome).toBe('retry');
            expect(result.attempts).toBe(1);
            const row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
            expect(row.status).toBe('PENDING');
            expect(row.is_complete).toBe(0);
            expect(row.attempts).toBe(1);
            expect(row.last_error).toBe('ASpace 502');
            /*
             * `error` column stays null on retries (reserved for the
             * final dead-letter message).
             */
            expect(row.error).toBeNull();
        });

        it('increments attempts on each retry until the cap fires', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);
            /*
             * 3 attempts total; first two should be retries, third
             * dead-letters.
             */
            for (let i = 1; i <= 2; i++) {
                const [claimed] = await model.claim_pending(1);
                const r = await model.mark_failed(claimed.id, `attempt ${i}`);
                expect(r.outcome).toBe('retry');
                expect(r.attempts).toBe(i);
            }
            const [claimed] = await model.claim_pending(1);
            const final = await model.mark_failed(claimed.id, 'attempt 3');
            expect(final.outcome).toBe('dead_lettered');
            expect(final.attempts).toBe(3);
            const row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
            expect(row.status).toBe('DEAD_LETTERED');
            expect(row.is_complete).toBe(1);
            expect(row.attempts).toBe(3);
            expect(row.error).toBe('attempt 3');
            expect(row.last_error).toBe('attempt 3');
        });

        it('respects METADATA_MAX_ATTEMPTS=1 (single-shot terminal)', async () => {
            process.env.METADATA_MAX_ATTEMPTS = '1';
            require('../../../config/app')._reset();
            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);
            const [claimed] = await model.claim_pending(1);
            const r = await model.mark_failed(claimed.id, 'one shot');
            expect(r.outcome).toBe('dead_lettered');
            const row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
            expect(row.status).toBe('DEAD_LETTERED');
            expect(row.is_complete).toBe(1);
        });
    });

    describe('mark_failed retry backoff', () => {
        it('stamps next_attempt_at in the future on retry when backoff is configured', async () => {
            /*
             * Override backoff for this test only — the suite-wide
             * default is 0 (see beforeEach).
             */
            process.env.METADATA_RETRY_BASE_BACKOFF_MS = '60000';
            process.env.METADATA_RETRY_MAX_BACKOFF_MS = '300000';
            require('../../../config/app')._reset();

            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);
            const [claimed] = await model.claim_pending(1);
            const before = Date.now();
            await model.mark_failed(claimed.id, 'first try');
            const row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
            /*
             * Stored as a string (sqlite) or Date (mariadb depending on
             * driver); coerce through Date to normalize.
             */
            const next_at = new Date(row.next_attempt_at).getTime();
            // 60s ± a couple of seconds of test slop.
            expect(next_at - before).toBeGreaterThanOrEqual(55_000);
            expect(next_at - before).toBeLessThanOrEqual(70_000);
        });

        it('skips backed-off rows in claim_pending until next_attempt_at elapses', async () => {
            /*
             * Stamp a future next_attempt_at directly and verify the
             * claim skips it; then rewind the timestamp and verify it
             * becomes claimable. Avoids real-time waiting in the test.
             */
            const a = await db_helper.seed_object({ uri: '/blocked' });
            await model.enqueue_pids([a.pid]);
            // Stamp into the future.
            const future = new Date(Date.now() + 60_000);
            await db_queue()(QUEUE).update({ next_attempt_at: future });
            let claimed = await model.claim_pending(1);
            expect(claimed).toHaveLength(0);
            // Rewind to the past.
            const past = new Date(Date.now() - 1000);
            await db_queue()(QUEUE).update({ next_attempt_at: past });
            claimed = await model.claim_pending(1);
            expect(claimed).toHaveLength(1);
            expect(claimed[0].uri).toBe('/blocked');
        });

        it('doubles the backoff between successive retries (n=1 → 60s, n=2 → 120s)', async () => {
            process.env.METADATA_RETRY_BASE_BACKOFF_MS = '60000';
            process.env.METADATA_RETRY_MAX_BACKOFF_MS = '600000';
            require('../../../config/app')._reset();

            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);

            // First failure — should backoff ~60s.
            let [claimed] = await model.claim_pending(1);
            let t = Date.now();
            await model.mark_failed(claimed.id, 'try 1');
            let row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
            let delta = new Date(row.next_attempt_at).getTime() - t;
            expect(delta).toBeGreaterThanOrEqual(55_000);
            expect(delta).toBeLessThanOrEqual(70_000);

            /*
             * Move the row into the past so the second claim picks it
             * up without a wall-clock sleep.
             */
            await db_queue()(QUEUE)
                .where({ id: claimed.id })
                .update({ next_attempt_at: new Date(Date.now() - 1000) });

            // Second failure — should backoff ~120s.
            [claimed] = await model.claim_pending(1);
            t = Date.now();
            await model.mark_failed(claimed.id, 'try 2');
            row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
            delta = new Date(row.next_attempt_at).getTime() - t;
            expect(delta).toBeGreaterThanOrEqual(115_000);
            expect(delta).toBeLessThanOrEqual(130_000);
        });
    });

    describe('claim_pending priority ordering', () => {
        it('claims priority=0 (on-demand) before priority=5 (system) regardless of id', async () => {
            /*
             * System rows enqueued FIRST (lower ids) — without
             * priority ordering they'd drain first. With priority,
             * the on-demand row jumps ahead.
             */
            const sys_a = await db_helper.seed_object({ uri: '/sys-a' });
            const sys_b = await db_helper.seed_object({ uri: '/sys-b' });
            const on_demand = await db_helper.seed_object({ uri: '/od' });

            // Mint a real batch row so enqueue_chunk_for_batch accepts it.
            const batches = require('../../../metadata/batches');
            const batch_uuid = await batches.create_batch({ actor: 'tester' });
            await model.enqueue_chunk_for_batch({
                batch_uuid,
                rows: [
                    { uuid: sys_a.pid, uri: sys_a.uri, update_type: 'system' },
                    { uuid: sys_b.pid, uri: sys_b.uri, update_type: 'system' },
                ],
                priority: 5,
            });
            await model.enqueue_single(on_demand.pid);

            const claimed = await model.claim_pending(1);
            expect(claimed).toHaveLength(1);
            expect(claimed[0].uri).toBe('/od');
            expect(claimed[0].priority).toBe(0);
        });

        it('falls back to id order within the same priority tier (FIFO)', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            const b = await db_helper.seed_object({ uri: '/b' });
            const c = await db_helper.seed_object({ uri: '/c' });
            await model.enqueue_pids([a.pid, b.pid, c.pid]);
            const claimed = await model.claim_pending(3);
            expect(claimed.map((r) => r.uri)).toEqual(['/a', '/b', '/c']);
        });
    });

    describe('enqueue_chunk_for_batch', () => {
        it('writes rows under the given batch_uuid + priority', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            const batches = require('../../../metadata/batches');
            const batch_uuid = await batches.create_batch({ actor: 'tester' });
            const result = await model.enqueue_chunk_for_batch({
                batch_uuid,
                rows: [{ uuid: a.pid, uri: a.uri, update_type: 'system' }],
                priority: 5,
            });
            expect(result.batch_uuid).toBe(batch_uuid);
            expect(result.count).toBe(1);
            const row = await db_queue()(QUEUE).where({ batch_uuid }).first();
            expect(row.priority).toBe(5);
            expect(row.attempts).toBe(0);
        });

        it('rejects when batch_uuid is missing or non-UUID', async () => {
            await expect(
                model.enqueue_chunk_for_batch({ batch_uuid: '', rows: [], priority: 0 })
            ).rejects.toThrow(/batch_uuid/);
        });
    });
});
