'use strict';

// Orphan-sweep behavior — reset_orphaned() with the new
// older_than_seconds option, plus the worker tick calling it
// before each claim.
//
// Why a separate file: keeps the new assertions next to each other
// without bloating the existing reset_orphaned tests in
// model.test.js (which assert the boot-time behavior under
// max_attempts=1).

const model = require('../../../metadata/model');
const { create_worker } = require('../../../metadata/worker');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');

const QUEUE = tables.metadata_update_queue;

// Tiny stub so worker.tick can run without network. Fetches always
// succeed with an empty body; the worker just calls mark_complete.
function make_fake_aspace() {
    return {
        is_configured: () => true,
        async get_session_token() {
            return 'tok';
        },
        async get_record() {
            return { status: 200, data: { title: 'ok' }, headers: {} };
        },
        async destroy_session_token() {},
    };
}

describe('metadata/model — reset_orphaned({ older_than_seconds })', () => {
    let original_env;
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        original_env = { ...process.env };
    });
    afterEach(() => {
        process.env = original_env;
        require('../../../config/app')._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('with no args, resets every IN_PROGRESS row (boot-time behavior)', async () => {
        const a = await db_helper.seed_object({ uri: '/a' });
        const b = await db_helper.seed_object({ uri: '/b' });
        await model.enqueue_pids([a.pid, b.pid]);
        await model.claim_pending(2); // both → IN_PROGRESS
        const result = await model.reset_orphaned();
        expect(result.affected).toBe(2);
        const rows = await db_queue()(QUEUE).select('status');
        expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
    });

    it('with older_than_seconds, leaves fresh IN_PROGRESS rows alone', async () => {
        // A row that was just claimed has date_updated = now. The
        // sweep at 300s threshold should NOT touch it.
        const a = await db_helper.seed_object({ uri: '/fresh' });
        await model.enqueue_pids([a.pid]);
        await model.claim_pending(1);
        const result = await model.reset_orphaned({ older_than_seconds: 300 });
        expect(result.affected).toBe(0);
        const row = await db_queue()(QUEUE).where({ uuid: a.pid }).first();
        expect(row.status).toBe('IN_PROGRESS');
    });

    it('with older_than_seconds, resets stale IN_PROGRESS rows', async () => {
        const a = await db_helper.seed_object({ uri: '/stale' });
        await model.enqueue_pids([a.pid]);
        const [claimed] = await model.claim_pending(1);
        // Backdate the row 1 hour into the past — well beyond the
        // 300s threshold.
        const an_hour_ago = new Date(Date.now() - 60 * 60 * 1000);
        await db_queue()(QUEUE).where({ id: claimed.id }).update({ date_updated: an_hour_ago });

        const result = await model.reset_orphaned({ older_than_seconds: 300 });
        expect(result.affected).toBe(1);
        const row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
        expect(row.status).toBe('PENDING');
        expect(row.is_complete).toBe(0);
        // attempts is NOT incremented — the row was orphaned, not
        // failed. The next claim re-uses the existing attempts count.
        expect(row.attempts).toBe(0);
    });

    it('does not touch terminal rows (COMPLETE / DEAD_LETTERED) regardless of age', async () => {
        const a = await db_helper.seed_object({ uri: '/done' });
        await model.enqueue_pids([a.pid]);
        const [claimed] = await model.claim_pending(1);
        await model.mark_complete(claimed.id);
        const an_hour_ago = new Date(Date.now() - 60 * 60 * 1000);
        await db_queue()(QUEUE).where({ id: claimed.id }).update({ date_updated: an_hour_ago });

        const result = await model.reset_orphaned({ older_than_seconds: 300 });
        expect(result.affected).toBe(0);
    });
});

describe('metadata/worker — orphan sweep runs each tick', () => {
    let original_env;
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        original_env = { ...process.env };
        // Tight threshold for the test — anything older than 1s is
        // stale. Production default is 300s.
        process.env.METADATA_ORPHAN_RESET_SECONDS = '1';
        require('../../../config/app')._reset();
    });
    afterEach(() => {
        process.env = original_env;
        require('../../../config/app')._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('sweeps a stuck IN_PROGRESS row before claiming and processes it', async () => {
        // Pre-stuck row: claimed long ago (simulating a hung fetch
        // from a previous tick), status=IN_PROGRESS, date_updated 1h
        // in the past.
        const stuck = await db_helper.seed_object({ uri: '/stuck' });
        await model.enqueue_pids([stuck.pid]);
        const [claimed] = await model.claim_pending(1);
        const an_hour_ago = new Date(Date.now() - 60 * 60 * 1000);
        await db_queue()(QUEUE).where({ id: claimed.id }).update({ date_updated: an_hour_ago });

        // Sanity: the row IS stuck before the worker runs.
        const before = await db_queue()(QUEUE).where({ id: claimed.id }).first();
        expect(before.status).toBe('IN_PROGRESS');

        // One worker tick. Order of operations:
        //   1. orphan sweep flips the stuck row PENDING (matches
        //      because date_updated is 1h old, threshold is 1s)
        //   2. claim_pending claims it back
        //   3. fake aspace returns 200
        //   4. mark_complete finalizes it
        const worker = create_worker({ aspace: make_fake_aspace() });
        await worker.tick();

        const after = await db_queue()(QUEUE).where({ id: claimed.id }).first();
        expect(after.status).toBe('COMPLETE');
        expect(after.is_complete).toBe(1);
    });

    it('leaves a freshly-claimed row alone (does not false-positive on healthy work)', async () => {
        // Set the orphan threshold large enough that a row claimed
        // moments ago won't qualify.
        process.env.METADATA_ORPHAN_RESET_SECONDS = '600';
        require('../../../config/app')._reset();

        const ok = await db_helper.seed_object({ uri: '/ok' });
        await model.enqueue_pids([ok.pid]);

        // Worker tick: sweep finds no stale rows, claim_pending
        // picks up the PENDING one, process_row completes it.
        const worker = create_worker({ aspace: make_fake_aspace() });
        await worker.tick();

        const row = await db_queue()(QUEUE).where({ uuid: ok.pid }).first();
        expect(row.status).toBe('COMPLETE');
        // attempts stayed at 0 — no orphan reset triggered, no
        // process_row retry.
        expect(row.attempts).toBe(0);
    });

    it('logs but does not crash the tick when the sweep query fails', async () => {
        // Construct a worker pointed at a busted model and confirm
        // tick() completes (returns) rather than throwing. We mock
        // model.reset_orphaned by temporarily replacing it on the
        // module — easier than DI'ing the whole model.
        const orig = model.reset_orphaned;
        model.reset_orphaned = async () => {
            throw new Error('sweep DB busted');
        };
        try {
            const worker = create_worker({ aspace: make_fake_aspace() });
            await expect(worker.tick()).resolves.toBeUndefined();
        } finally {
            model.reset_orphaned = orig;
        }
    });
});
