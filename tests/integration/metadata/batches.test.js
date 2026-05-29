'use strict';

// Batch-rollup model — system-refresh batch CRUD + the worker's
// terminal-transition logic (on_row_terminal). Mostly DB-shape and
// state-machine assertions; the producer's tick-by-tick flow is
// covered in producer.test.js.

const batches = require('../../../metadata/batches');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { NotFoundError, ValidationError } = require('../../../libs/errors');

const BATCHES = tables.metadata_refresh_batches;

describe('metadata/batches', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        // Re-export config defaults so transformer_flag captured at
        // batch start is deterministic.
        delete process.env.ASPACE_USE_TRANSFORMER;
        delete process.env.ASPACE_TRANSFORMER_VERSION;
        require('../../../config/app')._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('actor name resolution', () => {
        it('resolves actor_name from tbl_users by du_id at write time', async () => {
            // The dashboard JWT carries du_id but NOT first/last
            // name. create_batch looks the name up so the admin
            // listing renders "by Ada Lovelace" instead of "by
            // <du_id-string>".
            await db_helper.seed_user({
                du_id: 'ada-001',
                first_name: 'Ada',
                last_name: 'Lovelace',
            });
            const uuid = await batches.create_batch({ actor: 'ada-001' });
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.actor).toBe('ada-001');
            expect(row.actor_name).toBe('Ada Lovelace');
        });

        it("falls back to the user's email when no name is on file", async () => {
            // Bypass the seed_user helper here — its defaults
            // replace empty strings with 'Test'/'User', which would
            // mask the empty-name fallback we want to test.
            const { db } = require('../../../config/db');
            await db()(tables.users).insert({
                du_id: 'svc-only',
                email: 'service@du.edu',
                first_name: '',
                last_name: '',
                is_active: 1,
                token: '0',
            });
            const uuid = await batches.create_batch({ actor: 'svc-only' });
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.actor_name).toBe('service@du.edu');
        });

        it('leaves actor_name empty when the du_id has no matching user', async () => {
            const uuid = await batches.create_batch({ actor: 'ghost-id' });
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.actor).toBe('ghost-id');
            expect(row.actor_name).toBe('');
        });

        it('honors an explicit actor_name from the caller without re-looking-up', async () => {
            // An override path lets the controller pre-resolve if it
            // already has the display name in scope.
            const uuid = await batches.create_batch({
                actor: 'someone',
                actor_name: 'Manually Supplied',
            });
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.actor_name).toBe('Manually Supplied');
        });
    });

    describe('create_batch', () => {
        it('inserts a running batch with sane defaults', async () => {
            const uuid = await batches.create_batch({ actor: 'svc', actor_name: 'Service' });
            expect(uuid).toMatch(/-/);
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.status).toBe('running');
            expect(row.total).toBe(0);
            expect(row.succeeded).toBe(0);
            expect(row.cursor_id).toBeNull();
            expect(row.enqueue_complete).toBe(0);
            expect(row.cancel_requested).toBe(0);
            expect(row.actor).toBe('svc');
            expect(row.actor_name).toBe('Service');
            // Flag defaults to '0' when ASPACE_USE_TRANSFORMER is unset.
            expect(row.transformer_flag).toBe('0');
        });

        it('captures the current transformer flag at creation time', async () => {
            process.env.ASPACE_USE_TRANSFORMER = '1';
            process.env.ASPACE_TRANSFORMER_VERSION = '7';
            require('../../../config/app')._reset();
            const uuid = await batches.create_batch();
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.transformer_flag).toBe('1');
            expect(row.transformer_version).toBe('7');
        });

        it('refuses to start a second batch while one is running', async () => {
            await batches.create_batch();
            await expect(batches.create_batch()).rejects.toBeInstanceOf(ValidationError);
        });

        it('allows a new batch after the previous one completed', async () => {
            const u1 = await batches.create_batch();
            await db_queue()(BATCHES).where({ batch_uuid: u1 }).update({ status: 'completed' });
            const u2 = await batches.create_batch();
            expect(u2).not.toBe(u1);
        });

        it('inherit_cursor_id starts the new batch at the supplied cursor', async () => {
            // Caller-supplied cursor — the controller passes this
            // value from get_last_cancelled_cursor() when the
            // operator opts into resume on the start form.
            const uuid = await batches.create_batch({
                inherit_cursor_id: 12345,
            });
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.cursor_id).toBe(12345);
            // status='running' is unchanged.
            expect(row.status).toBe('running');
        });

        it('inherit_cursor_id=null defaults to a fresh-run cursor', async () => {
            const uuid = await batches.create_batch({ inherit_cursor_id: null });
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.cursor_id).toBeNull();
        });

        it('inherit_cursor_id rejects non-integer / negative values', async () => {
            await expect(
                batches.create_batch({ inherit_cursor_id: -5 })
            ).rejects.toBeInstanceOf(ValidationError);
            await expect(
                batches.create_batch({ inherit_cursor_id: 'oops' })
            ).rejects.toBeInstanceOf(ValidationError);
            await expect(
                batches.create_batch({ inherit_cursor_id: 1.5 })
            ).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('get_last_cancelled_cursor', () => {
        it('returns null when no cancelled batch exists', async () => {
            expect(await batches.get_last_cancelled_cursor()).toBeNull();
        });

        it('returns null when the most recent cancelled batch never advanced its cursor', async () => {
            // Edge case: cancelled before the producer's first
            // tick. cursor_id stays NULL → nothing to resume from.
            const uuid = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: uuid })
                .update({ status: 'cancelled', cursor_id: null });
            expect(await batches.get_last_cancelled_cursor()).toBeNull();
        });

        it('returns the most recent cancelled batchs uuid + cursor_id', async () => {
            // Two cancelled batches; we want the LATEST one.
            const u1 = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: u1 })
                .update({ status: 'cancelled', cursor_id: 100 });
            const u2 = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: u2 })
                .update({ status: 'cancelled', cursor_id: 200 });

            const got = await batches.get_last_cancelled_cursor();
            expect(got).toEqual({ batch_uuid: u2, cursor_id: 200 });
        });

        it('ignores non-cancelled batches (completed, running, failed)', async () => {
            const cancelled = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: cancelled })
                .update({ status: 'cancelled', cursor_id: 50 });
            const completed = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: completed })
                .update({ status: 'completed', cursor_id: 999 });
            // get_last_cancelled_cursor must return the CANCELLED
            // batch even though the completed one has a higher
            // cursor / later id.
            const got = await batches.get_last_cancelled_cursor();
            expect(got).toEqual({ batch_uuid: cancelled, cursor_id: 50 });
        });

        // Bug scenario: producer had finished enqueueing every active
        // object (cursor at max_id) but the worker only got through a
        // fraction before the operator cancelled. Resuming naively
        // from the producer's cursor would read 0 rows and the new
        // batch would flip straight to 'completed' with total=0,
        // silently abandoning every un-processed object. The fix
        // returns a cursor positioned just BELOW the lowest active
        // object whose pid wasn't terminally processed.
        it('returns a cursor that re-enqueues objects the worker did not finalize', async () => {
            const tables = require('../../../config/db_tables');
            const { db } = require('../../../config/db');

            // Five active objects, sequential ids.
            const objs = [];
            for (let i = 0; i < 5; i++) {
                objs.push(await db_helper.seed_object({ uri: `/repositories/2/digital_objects/${i}` }));
            }

            // Cancelled batch whose producer had walked past the
            // last object (cursor at the table max). The worker
            // only terminalised the first two pids before cancel.
            const cancelled = await batches.create_batch();
            const last_object_id = Number(
                (await db()(tables.objects).max('id as m').first()).m
            );
            await db_queue()(BATCHES)
                .where({ batch_uuid: cancelled })
                .update({ status: 'cancelled', cursor_id: last_object_id });

            await db_queue()(tables.metadata_update_queue).insert([
                {
                    batch_uuid: cancelled,
                    uuid: objs[0].pid,
                    uri: objs[0].uri,
                    update_type: 'system',
                    status: 'COMPLETE',
                    is_complete: 1,
                    is_updated: 1,
                    is_indexed: 0,
                    priority: 5,
                    attempts: 1,
                },
                {
                    batch_uuid: cancelled,
                    uuid: objs[1].pid,
                    uri: objs[1].uri,
                    update_type: 'system',
                    status: 'DEAD_LETTERED',
                    is_complete: 1,
                    is_updated: 0,
                    is_indexed: 0,
                    priority: 5,
                    attempts: 3,
                },
            ]);

            const got = await batches.get_last_cancelled_cursor();
            // Resume cursor = id of first unprocessed (objs[2]) - 1
            // so the producer's `id > cursor_id` predicate picks
            // that row up on its first tick.
            expect(got).toEqual({
                batch_uuid: cancelled,
                cursor_id: objs[2].id - 1,
            });
        });

        it('falls back to the producer cursor when every active object was terminalised', async () => {
            const tables = require('../../../config/db_tables');

            const obj = await db_helper.seed_object({ uri: '/repositories/2/digital_objects/only' });
            const cancelled = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: cancelled })
                .update({ status: 'cancelled', cursor_id: 999 });
            await db_queue()(tables.metadata_update_queue).insert({
                batch_uuid: cancelled,
                uuid: obj.pid,
                uri: obj.uri,
                update_type: 'system',
                status: 'COMPLETE',
                is_complete: 1,
                is_updated: 1,
                is_indexed: 0,
                priority: 5,
                attempts: 1,
            });
            // Nothing left to re-enqueue → return the producer cursor;
            // the producer's no-rows tick will close out the new batch
            // honestly (which is correct: there's no work to do).
            const got = await batches.get_last_cancelled_cursor();
            expect(got).toEqual({ batch_uuid: cancelled, cursor_id: 999 });
        });

        it('uses the producer cursor when the worker never finalised any row', async () => {
            // Cancelled before any IN_PROGRESS row reached terminal.
            // request_cancel deleted every PENDING row, so the queue
            // has nothing tied to this batch_uuid. The producer
            // cursor is the best signal we have.
            await db_helper.seed_object({ uri: '/repositories/2/digital_objects/seeded' });
            const cancelled = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: cancelled })
                .update({ status: 'cancelled', cursor_id: 0 });
            const got = await batches.get_last_cancelled_cursor();
            expect(got).toEqual({ batch_uuid: cancelled, cursor_id: 0 });
        });
    });

    describe('advance_cursor', () => {
        it('CAS protects against a stale producer racing a fresh one', async () => {
            const uuid = await batches.create_batch();
            // Pretend producer A advances cursor to 100.
            const r1 = await batches.advance_cursor(uuid, {
                expected_cursor_id: null,
                new_cursor_id: 100,
                done: false,
            });
            expect(r1.affected).toBe(1);

            // Stale producer B thinks cursor is still null — should
            // be rejected by the CAS.
            const r2 = await batches.advance_cursor(uuid, {
                expected_cursor_id: null,
                new_cursor_id: 200,
                done: false,
            });
            expect(r2.affected).toBe(0);
        });

        it('marks enqueue_complete when done flag is set', async () => {
            const uuid = await batches.create_batch();
            await batches.advance_cursor(uuid, {
                expected_cursor_id: null,
                new_cursor_id: 0,
                done: true,
            });
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.enqueue_complete).toBe(1);
        });
    });

    describe('on_row_terminal', () => {
        it('increments the matching counter', async () => {
            const uuid = await batches.create_batch();
            await batches.increment_total(uuid, 3);
            await batches.on_row_terminal(uuid, 'succeeded');
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.succeeded).toBe(1);
            expect(row.failed).toBe(0);
            expect(row.dead_lettered).toBe(0);
            expect(row.status).toBe('running'); // not done yet
        });

        it('transitions running → completed when enqueue_complete + sum >= total', async () => {
            const uuid = await batches.create_batch();
            await batches.increment_total(uuid, 2);
            await batches.advance_cursor(uuid, {
                expected_cursor_id: null,
                new_cursor_id: 0,
                done: true,
            });
            await batches.on_row_terminal(uuid, 'succeeded');
            // 1 of 2 done — still running.
            let row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.status).toBe('running');
            await batches.on_row_terminal(uuid, 'dead_lettered');
            row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.status).toBe('completed');
            expect(row.finished_at).not.toBeNull();
        });

        it('does NOT transition while enqueue_complete is false (avoids false-done mid-enqueue)', async () => {
            const uuid = await batches.create_batch();
            await batches.increment_total(uuid, 1);
            // Producer still enqueuing — enqueue_complete=false.
            await batches.on_row_terminal(uuid, 'succeeded');
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            // sum=1, total=1, but enqueue_complete=false → stay
            // running.
            expect(row.status).toBe('running');
        });

        it('rejects an unknown outcome string', async () => {
            const uuid = await batches.create_batch();
            await expect(batches.on_row_terminal(uuid, 'maybe')).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });

    describe('request_cancel', () => {
        it('flips cancel_requested + status, hard-deletes pending rows', async () => {
            const uuid = await batches.create_batch();
            const model = require('../../../metadata/model');
            const a = await db_helper.seed_object({ uri: '/a' });
            const b = await db_helper.seed_object({ uri: '/b' });
            await model.enqueue_chunk_for_batch({
                batch_uuid: uuid,
                rows: [
                    { uuid: a.pid, uri: a.uri, update_type: 'system' },
                    { uuid: b.pid, uri: b.uri, update_type: 'system' },
                ],
                priority: 5,
            });
            const result = await batches.request_cancel(uuid);
            expect(result.pending_removed).toBe(2);
            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.status).toBe('cancelled');
            expect(row.cancel_requested).toBe(1);
        });

        it('refuses to cancel a batch that is not running', async () => {
            const uuid = await batches.create_batch();
            await db_queue()(BATCHES).where({ batch_uuid: uuid }).update({ status: 'completed' });
            await expect(batches.request_cancel(uuid)).rejects.toBeInstanceOf(ValidationError);
        });

        it('throws NotFoundError on an unknown uuid', async () => {
            const { randomUUID } = require('node:crypto');
            await expect(batches.request_cancel(randomUUID())).rejects.toBeInstanceOf(
                NotFoundError
            );
        });
    });

    describe('complete_if_empty', () => {
        it('transitions a running+enqueue_complete+total=0 batch to completed', async () => {
            // The empty-batch scenario: a resume that started past
            // max(tbl_objects.id) → producer's first tick finds no
            // rows → sets enqueue_complete=true → total stays 0.
            // Without complete_if_empty the batch sits at 'running'
            // forever (no on_row_terminal can fire to transition it).
            const uuid = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: uuid })
                .update({ enqueue_complete: true, total: 0 });

            const result = await batches.complete_if_empty(uuid);
            expect(result.affected).toBe(1);

            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.status).toBe('completed');
            expect(row.finished_at).toBeTruthy();
        });

        it('does NOT transition a batch with rows enqueued (total > 0)', async () => {
            const uuid = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: uuid })
                .update({ enqueue_complete: true, total: 100 });

            const result = await batches.complete_if_empty(uuid);
            expect(result.affected).toBe(0);

            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.status).toBe('running');
        });

        it('does NOT transition a batch that has not finished enqueuing', async () => {
            const uuid = await batches.create_batch();
            // total=0 but enqueue_complete=false → producer might
            // still be working. Don't preempt.
            await db_queue()(BATCHES)
                .where({ batch_uuid: uuid })
                .update({ enqueue_complete: false, total: 0 });

            const result = await batches.complete_if_empty(uuid);
            expect(result.affected).toBe(0);

            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.status).toBe('running');
        });

        it('does NOT transition a non-running batch', async () => {
            // Already cancelled / completed — leave alone.
            const uuid = await batches.create_batch();
            await db_queue()(BATCHES)
                .where({ batch_uuid: uuid })
                .update({
                    status: 'cancelled',
                    enqueue_complete: true,
                    total: 0,
                });

            const result = await batches.complete_if_empty(uuid);
            expect(result.affected).toBe(0);

            const row = await db_queue()(BATCHES).where({ batch_uuid: uuid }).first();
            expect(row.status).toBe('cancelled');
        });
    });

    describe('list_batches', () => {
        it('returns most-recent first, capped by limit', async () => {
            const ids = [];
            for (let i = 0; i < 3; i++) {
                const u = await batches.create_batch({ actor: `u${i}` });
                ids.push(u);
                await db_queue()(BATCHES).where({ batch_uuid: u }).update({ status: 'completed' });
            }
            const rows = await batches.list_batches({ limit: 2 });
            expect(rows).toHaveLength(2);
            // Most-recent first → u2, u1.
            expect(rows[0].batch_uuid).toBe(ids[2]);
            expect(rows[1].batch_uuid).toBe(ids[1]);
        });
    });
});
