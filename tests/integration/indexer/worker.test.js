'use strict';

const { create_worker } = require('../../../indexer/worker');
const db_helper = require('../../helpers/db');
const { db } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const app_config = require('../../../config/app');

// Fake ES client. Captures every call + scripts responses per test.
//
// The worker calls ES via the bulk_write path now; the per-op test
// helpers (calls.index / calls.delete) flatten across all bulk_write
// calls so assertions reading "how many docs were indexed?" stay
// straightforward even though the wire-level call is batched.
function make_fake_es() {
    const calls = { bulk: [], ensure: 0 };
    const throw_on = {};
    return {
        is_configured: () => true,
        async ensure_index() {
            calls.ensure += 1;
            if (throw_on.ensure) throw new Error('ensure failed');
            return { created: false };
        },
        async bulk_write(ops) {
            calls.bulk.push(ops);
            if (throw_on.bulk_all) throw new Error('bulk transport failed');
            // Per-item failure scripting: if a per-pid throw is armed
            // for this op kind, return ok:false for that one and ok:true
            // for the rest. Mirrors how real ES bulk returns partial
            // failures inline.
            const items = ops.map((op) => {
                const fail_pid = throw_on[op.op];
                if (fail_pid && fail_pid === op.pid) {
                    return { op: op.op, pid: op.pid, ok: false, err: `${op.op} failed` };
                }
                return { op: op.op, pid: op.pid, ok: true };
            });
            return { items };
        },
        project_for_index(row, dr) {
            return { pid: row.pid, dr };
        },
        // test helpers — derived views over calls.bulk so legacy
        // assertions ("expect(es.calls.index).toHaveLength(N)") read
        // naturally.
        calls,
        get _index_ops() {
            return calls.bulk.flat().filter((op) => op.op === 'index');
        },
        get _delete_ops() {
            return calls.bulk.flat().filter((op) => op.op === 'delete');
        },
        fail(op, pid_or_true = true) {
            throw_on[op] = pid_or_true;
        },
    };
}

// Flatten helpers used by tests. Defined as functions to mirror how
// callers think ("get me all index ops across every bulk call").
function index_ops(es) {
    return es.calls.bulk.flat().filter((op) => op.op === 'index');
}
function delete_ops(es) {
    return es.calls.bulk.flat().filter((op) => op.op === 'delete');
}

describe('indexer/worker — integration', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('indexes an eligible dirty row + flips is_indexed=1, is_updated=0', async () => {
        const a = await db_helper.seed_object({
            is_published: 1,
            is_active: 1,
            is_updated: 1,
            display_record: JSON.stringify({ title: 'X' }),
        });
        const es = make_fake_es();
        const worker = create_worker({ es });
        await worker.tick();

        const row = await db()(tables.objects).where({ pid: a.pid }).first();
        expect(row.is_updated).toBe(0);
        expect(row.is_indexed).toBe(1);
        expect(index_ops(es)).toHaveLength(1);
        expect(index_ops(es)[0].pid).toBe(a.pid);
        expect(delete_ops(es)).toHaveLength(0);
    });

    it('deletes an ineligible row (unpublished) from the index', async () => {
        const a = await db_helper.seed_object({
            is_published: 0,
            is_active: 1,
            is_updated: 1,
        });
        const es = make_fake_es();
        const worker = create_worker({ es });
        await worker.tick();
        expect(index_ops(es)).toHaveLength(0);
        expect(delete_ops(es)).toHaveLength(1);
        expect(delete_ops(es)[0].pid).toBe(a.pid);
        const row = await db()(tables.objects).where({ pid: a.pid }).first();
        expect(row.is_updated).toBe(0);
        expect(row.is_indexed).toBe(0);
    });

    it('deletes a soft-deleted row from the index', async () => {
        const a = await db_helper.seed_object({
            is_published: 1,
            is_active: 0, // soft-deleted overrides published
            is_updated: 1,
        });
        const es = make_fake_es();
        const worker = create_worker({ es });
        await worker.tick();
        expect(delete_ops(es)).toHaveLength(1);
        expect(delete_ops(es)[0].pid).toBe(a.pid);
    });

    it('claims up to `concurrency` rows per tick into a single bulk call', async () => {
        // Force concurrency=5 so we can exercise the cap with a
        // handful of rows. The default is much higher (50) since
        // bulk requests amortize well; here we just want to verify
        // claim_dirty respects the cap.
        const orig = process.env.INDEXER_CONCURRENCY;
        process.env.INDEXER_CONCURRENCY = '5';
        app_config._reset();
        try {
            for (let i = 0; i < 7; i++) {
                await db_helper.seed_object({
                    is_published: 1,
                    is_active: 1,
                    is_updated: 1,
                });
            }
            const es = make_fake_es();
            const worker = create_worker({ es });
            await worker.tick();
            // First tick: one bulk call carrying 5 index ops.
            expect(es.calls.bulk).toHaveLength(1);
            expect(es.calls.bulk[0]).toHaveLength(5);
            await worker.tick();
            // Second tick: one more bulk call carrying the remaining 2.
            expect(es.calls.bulk).toHaveLength(2);
            expect(es.calls.bulk[1]).toHaveLength(2);
            expect(index_ops(es)).toHaveLength(7);
        } finally {
            if (orig === undefined) delete process.env.INDEXER_CONCURRENCY;
            else process.env.INDEXER_CONCURRENCY = orig;
            app_config._reset();
        }
    });

    it('requeues a row whose bulk item came back errored', async () => {
        const a = await db_helper.seed_object({
            is_published: 1,
            is_active: 1,
            is_updated: 1,
        });
        const es = make_fake_es();
        // Script ES to return ok:false for this row's index op.
        es.fail('index', a.pid);
        const worker = create_worker({ es });
        await worker.tick();
        // After the failed item, is_updated flipped back to 1
        // (requeue), and is_indexed left alone.
        const row = await db()(tables.objects).where({ pid: a.pid }).first();
        expect(row.is_updated).toBe(1);
    });

    it('dead-letters a row after INDEXER_MAX_ATTEMPTS consecutive item failures', async () => {
        const orig = process.env.INDEXER_MAX_ATTEMPTS;
        process.env.INDEXER_MAX_ATTEMPTS = '3';
        app_config._reset();
        try {
            const a = await db_helper.seed_object({
                is_published: 1,
                is_active: 1,
                is_updated: 1,
            });
            const es = make_fake_es();
            es.fail('index', a.pid); // this row's index op always errors

            const worker = create_worker({ es });

            // Ticks 1 & 2: under the cap → requeued (is_updated back to 1).
            await worker.tick();
            let row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.is_updated).toBe(1);
            expect(row.index_attempts).toBe(1);
            expect(row.index_error).toBeFalsy();

            await worker.tick();
            row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.is_updated).toBe(1);
            expect(row.index_attempts).toBe(2);

            // Tick 3: hits the cap → dead-lettered (parked, not re-claimed).
            await worker.tick();
            row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.index_attempts).toBe(3);
            expect(row.is_updated).toBe(0); // no longer auto-claimed
            expect(row.index_error).toBeTruthy(); // recorded for the admin page

            // Tick 4: nothing left to claim → no new bulk call, no churn.
            // This is the whole point of the fix: the poison row stops
            // re-failing every poll.
            const bulk_before = es.calls.bulk.length;
            await worker.tick();
            expect(es.calls.bulk.length).toBe(bulk_before);
            row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.index_attempts).toBe(3);
        } finally {
            if (orig === undefined) delete process.env.INDEXER_MAX_ATTEMPTS;
            else process.env.INDEXER_MAX_ATTEMPTS = orig;
            app_config._reset();
        }
    });

    it('does NOT count a whole-batch transport failure toward the dead-letter cap', async () => {
        // An ES outage (bulk call throws) requeues every claimed row, but
        // the rows are blameless — their attempt counter must stay 0 so an
        // outage can never dead-letter the entire queue.
        const a = await db_helper.seed_object({
            is_published: 1,
            is_active: 1,
            is_updated: 1,
        });
        const es = make_fake_es();
        es.fail('bulk_all');
        const worker = create_worker({ es });
        await worker.tick();
        await worker.tick();
        const row = await db()(tables.objects).where({ pid: a.pid }).first();
        expect(row.is_updated).toBe(1); // requeued for retry
        expect(row.index_attempts).toBe(0); // but NOT penalized
        expect(row.index_error).toBeFalsy();
    });

    it('requeues every claimed row when the bulk call itself throws', async () => {
        // Bulk-level failure (transport/auth/cluster red) is distinct
        // from a per-item failure: NO rows made it to ES, so every
        // claimed pid must be requeued.
        const a = await db_helper.seed_object({
            is_published: 1,
            is_active: 1,
            is_updated: 1,
        });
        const b = await db_helper.seed_object({
            is_published: 1,
            is_active: 1,
            is_updated: 1,
        });
        const es = make_fake_es();
        es.fail('bulk_all');
        const worker = create_worker({ es });
        await worker.tick();
        const rows = await db()(tables.objects)
            .whereIn('pid', [a.pid, b.pid])
            .orderBy('id', 'asc');
        expect(rows.every((r) => r.is_updated === 1)).toBe(true);
    });

    it('ensures the index exactly once on the first tick that finds work', async () => {
        await db_helper.seed_object({ is_updated: 1 });
        const es = make_fake_es();
        const worker = create_worker({ es });
        await worker.tick();
        await worker.tick();
        expect(es.calls.ensure).toBe(1);
    });

    it('retries ensure on the next tick if the first call failed', async () => {
        // The seeded row IS eligible (published + active) so the
        // worker takes the index path, not delete.
        await db_helper.seed_object({
            is_published: 1,
            is_active: 1,
            is_updated: 1,
        });

        // Fake whose ensure_index fails the first call, succeeds the
        // second. The worker should retry on the next tick.
        let ensure_calls = 0;
        const bulk_calls = [];
        const es = {
            is_configured: () => true,
            async ensure_index() {
                ensure_calls += 1;
                if (ensure_calls === 1) throw new Error('cluster waking up');
            },
            async bulk_write(ops) {
                bulk_calls.push(ops);
                return { items: ops.map((o) => ({ op: o.op, pid: o.pid, ok: true })) };
            },
            project_for_index: (row, dr) => ({ pid: row.pid, dr }),
        };

        let clock = 0;
        const worker = create_worker({ es, now: () => clock });
        await worker.tick();
        // First tick: ensure failed, no claim, no bulk write.
        expect(ensure_calls).toBe(1);
        expect(bulk_calls).toHaveLength(0);

        // Advance past the post-failure backoff window before the retry.
        clock += 60000;
        await worker.tick();
        // Second tick: ensure succeeded; the still-dirty row got
        // bulk-written. The fake's ensure_calls is now 2.
        expect(ensure_calls).toBe(2);
        expect(bulk_calls).toHaveLength(1);
        expect(bulk_calls[0]).toHaveLength(1);
    });

    it('backs off ensure retries within the cooldown window', async () => {
        await db_helper.seed_object({ is_published: 1, is_active: 1, is_updated: 1 });
        let ensure_calls = 0;
        const es = {
            is_configured: () => true,
            async ensure_index() {
                ensure_calls += 1;
                throw new Error('cluster down');
            },
            async bulk_write(ops) {
                return { items: ops.map((o) => ({ op: o.op, pid: o.pid, ok: true })) };
            },
            project_for_index: (row, dr) => ({ pid: row.pid, dr }),
        };
        let clock = 0;
        const worker = create_worker({ es, now: () => clock });

        // Three back-to-back ticks, but ensure_index is attempted only
        // once — the cooldown gates the next two (no 10s-timeout flood).
        await worker.tick();
        await worker.tick();
        await worker.tick();
        expect(ensure_calls).toBe(1);

        // Once the cooldown elapses, the next tick attempts again.
        clock += 60000;
        await worker.tick();
        expect(ensure_calls).toBe(2);
    });

    it('skips ticking entirely when ES is not configured', async () => {
        await db_helper.seed_object({ is_updated: 1 });
        const es = make_fake_es();
        es.is_configured = () => false;
        const worker = create_worker({ es });
        await worker.tick();
        expect(es.calls.ensure).toBe(0);
        expect(es.calls.bulk).toHaveLength(0);
        // Row stays dirty for the next tick (or the next live ES).
        const row = await db()(tables.objects).where({ is_updated: 1 }).first();
        expect(row).toBeDefined();
    });
});
