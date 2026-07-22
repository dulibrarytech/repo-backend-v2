'use strict';

/*
 * Producer tick-by-tick flow. End-to-end without HTTP — we just call
 * producer.tick() directly and assert the DB state after each call.
 * 
 * What's covered:
 *   - No active batch → no-op
 *   - Active batch + N active objects with URIs → enqueues chunk,
 *     advances cursor, bumps total
 *   - Subsequent ticks paginate via cursor; ending tick sets
 *     enqueue_complete=true
 *   - Inactive objects + objects without URI are skipped
 *   - cancel_requested → producer marks enqueue_complete and stops
 *   - chunk_size config respected
 */

const batches = require('../../../metadata/batches');
const producer = require('../../../metadata/producer');
const db_helper = require('../../helpers/db');
const { db, db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');

const QUEUE = tables.metadata_update_queue;
const BATCHES = tables.metadata_refresh_batches;
const OBJECTS = tables.objects;

describe('metadata/producer', () => {
    let original_env;
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        original_env = { ...process.env };
        // Keep chunk size small + priority deterministic for tests.
        process.env.METADATA_REFRESH_CHUNK_SIZE = '2';
        process.env.METADATA_REFRESH_PRIORITY = '5';
        require('../../../config/app')._reset();
    });
    afterEach(() => {
        process.env = original_env;
        require('../../../config/app')._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('no-ops when there is no active batch', async () => {
        const result = await producer.tick();
        expect(result.idle).toBe(true);
        const queue = await db_queue()(QUEUE);
        expect(queue).toHaveLength(0);
    });

    it('enqueues chunk_size rows per tick + advances cursor', async () => {
        // 5 active objects with URIs.
        const objs = [];
        for (let i = 0; i < 5; i++) {
            objs.push(await db_helper.seed_object({ uri: `/r/${i}` }));
        }
        const batch_uuid = await batches.create_batch();

        // First tick: enqueue 2 rows (chunk_size=2).
        const r1 = await producer.tick();
        expect(r1.batch_uuid).toBe(batch_uuid);
        expect(r1.enqueued).toBe(2);
        let queue = await db_queue()(QUEUE).where({ batch_uuid });
        expect(queue).toHaveLength(2);
        expect(queue.every((r) => r.priority === 5)).toBe(true);
        let batch = await db_queue()(BATCHES).where({ batch_uuid }).first();
        expect(batch.total).toBe(2);
        expect(batch.cursor_id).toBe(queue[1].id); // cursor = last queue row's id…
        /*
         * Actually cursor is the last tbl_objects.id we enqueued; verify
         * against the objects table instead.
         */
        const max_id_in_queue_chunk = (await db()(OBJECTS).where({ pid: queue[1].uuid }).first())
            .id;
        expect(batch.cursor_id).toBe(max_id_in_queue_chunk);

        // Second tick: next 2 rows.
        const r2 = await producer.tick();
        expect(r2.enqueued).toBe(2);
        queue = await db_queue()(QUEUE).where({ batch_uuid });
        expect(queue).toHaveLength(4);
        batch = await db_queue()(BATCHES).where({ batch_uuid }).first();
        expect(batch.total).toBe(4);

        // Third tick: 1 more (the remainder).
        const r3 = await producer.tick();
        expect(r3.enqueued).toBe(1);
        queue = await db_queue()(QUEUE).where({ batch_uuid });
        expect(queue).toHaveLength(5);
        batch = await db_queue()(BATCHES).where({ batch_uuid }).first();
        expect(batch.total).toBe(5);

        // Fourth tick: nothing left → mark enqueue_complete.
        const r4 = await producer.tick();
        expect(r4.done).toBe(true);
        batch = await db_queue()(BATCHES).where({ batch_uuid }).first();
        expect(batch.enqueue_complete).toBe(1);
    });

    it('skips is_active=0 and missing-URI rows', async () => {
        await db_helper.seed_object({ uri: '/has' });
        await db_helper.seed_object({ uri: '', is_active: 1 });
        await db_helper.seed_object({ uri: '/inactive', is_active: 0 });
        await batches.create_batch();
        const r = await producer.tick();
        expect(r.enqueued).toBe(1);
    });

    it('honors cancel_requested by short-circuiting to done', async () => {
        await db_helper.seed_object({ uri: '/r/0' });
        const batch_uuid = await batches.create_batch();
        // Operator flipped cancel before producer ran.
        await db_queue()(BATCHES).where({ batch_uuid }).update({ cancel_requested: true });
        const r = await producer.tick();
        expect(r.done).toBe(true);
        const queue = await db_queue()(QUEUE).where({ batch_uuid });
        expect(queue).toHaveLength(0);
        const batch = await db_queue()(BATCHES).where({ batch_uuid }).first();
        expect(batch.enqueue_complete).toBe(1);
    });

    it('no-ops on a batch already in enqueue_complete state', async () => {
        const batch_uuid = await batches.create_batch();
        await db_queue()(BATCHES).where({ batch_uuid }).update({ enqueue_complete: true });
        const r = await producer.tick();
        expect(r.done).toBe(true);
    });

    it('finalizes an empty batch to completed when no rows are ever enqueued', async () => {
        /*
         * The resume-past-end-of-table scenario. Operator resumes
         * from a cancelled batch whose cursor was already at-or-past
         * max(tbl_objects.id). Producer's first tick finds zero
         * eligible rows → marks enqueue_complete=true → total stays
         * at 0. Previously the batch would sit at 'running' forever
         * because on_row_terminal (the normal path to 'completed')
         * never fires without a row.
         * 
         * Seed an object with a low id so we can place the cursor
         * past it.
         */
        const obj = await db_helper.seed_object({ uri: '/r/below-cursor' });
        const batch_uuid = await batches.create_batch();
        /*
         * Set the cursor past the seeded row's id so the chunk
         * query returns nothing.
         */
        await db_queue()(BATCHES)
            .where({ batch_uuid })
            .update({ cursor_id: obj.id + 1000 });

        const result = await producer.tick();
        expect(result.done).toBe(true);

        const batch = await db_queue()(BATCHES).where({ batch_uuid }).first();
        // The empty-batch finalize ran.
        expect(batch.status).toBe('completed');
        expect(batch.enqueue_complete).toBe(1);
        expect(batch.total).toBe(0);
        expect(batch.finished_at).toBeTruthy();
    });
});
