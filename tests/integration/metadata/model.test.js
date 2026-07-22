'use strict';

const { randomUUID } = require('node:crypto');

const model = require('../../../metadata/model');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { NotFoundError, ValidationError } = require('../../../libs/errors');

const QUEUE = tables.metadata_update_queue;

describe('metadata/model — queue CRUD', () => {
    let original_env;
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        await db_queue()(QUEUE).del();
        /*
         * Most assertions here predate the retry-then-dead-letter
         * behavior added with the system-wide refresh. Force a single-
         * shot mark_failed so the legacy expectations (one mark_failed
         * call → terminal row) still hold. New tests dedicated to the
         * retry path override this explicitly.
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

    describe('enqueue_single', () => {
        it('inserts one PENDING row with a fresh batch_uuid', async () => {
            const obj = await db_helper.seed_object({
                uri: '/repositories/2/archival_objects/42',
            });
            const result = await model.enqueue_single(obj.pid);
            expect(result.batch_uuid).toMatch(/-/);
            expect(result.count).toBe(1);
            const rows = await db_queue()(QUEUE).where({ batch_uuid: result.batch_uuid });
            expect(rows).toHaveLength(1);
            expect(rows[0].uuid).toBe(obj.pid);
            expect(rows[0].uri).toBe('/repositories/2/archival_objects/42');
            expect(rows[0].update_type).toBe('single');
            expect(rows[0].status).toBe('PENDING');
            expect(rows[0].is_complete).toBe(0);
        });

        it('throws NotFoundError on an unknown pid', async () => {
            await expect(model.enqueue_single(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
        });

        it('refuses soft-deleted objects', async () => {
            const obj = await db_helper.seed_object({
                uri: '/foo',
                is_active: 0,
            });
            await expect(model.enqueue_single(obj.pid)).rejects.toBeInstanceOf(ValidationError);
        });

        it('refuses objects with no ASpace URI', async () => {
            const obj = await db_helper.seed_object({ uri: null });
            await expect(model.enqueue_single(obj.pid)).rejects.toBeInstanceOf(ValidationError);
        });

        it('rejects malformed pid', async () => {
            await expect(model.enqueue_single('not-a-uuid')).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });

    describe('enqueue_collection', () => {
        it('expands a collection into one row per active member + the collection itself', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                uri: '/repositories/2/resources/100',
            });
            for (let i = 0; i < 3; i++) {
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                    uri: `/repositories/2/archival_objects/${i + 1}`,
                });
            }
            // A soft-deleted member; should be skipped.
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                uri: '/dead',
                is_active: 0,
            });
            const result = await model.enqueue_collection(c.pid);
            expect(result.count).toBe(4); // 3 members + the collection row
            const rows = await db_queue()(QUEUE).where({ batch_uuid: result.batch_uuid });
            expect(rows.every((r) => r.update_type === 'collection')).toBe(true);
        });

        it('skips members with empty/null uri', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                uri: '/c',
            });
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                uri: '/has-uri',
            });
            await db_helper.seed_object({ is_member_of_collection: c.pid, uri: null });
            await db_helper.seed_object({ is_member_of_collection: c.pid, uri: '' });
            const result = await model.enqueue_collection(c.pid);
            // Just the collection + the one valid member.
            expect(result.count).toBe(2);
        });

        it('throws when the pid is not a collection', async () => {
            const obj = await db_helper.seed_object({
                uri: '/foo',
                object_type: 'object',
            });
            await expect(model.enqueue_collection(obj.pid)).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('enqueue_collection_record', () => {
        it('enqueues only the collection row — no members', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                uri: '/repositories/2/resources/77',
            });
            /*
             * Two members that would have been picked up by
             * enqueue_collection — must NOT appear in the queue here.
             */
            for (let i = 0; i < 2; i++) {
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                    uri: `/repositories/2/archival_objects/${i + 1}`,
                });
            }
            const result = await model.enqueue_collection_record(c.pid);
            expect(result.count).toBe(1);
            const rows = await db_queue()(QUEUE).where({ batch_uuid: result.batch_uuid });
            expect(rows).toHaveLength(1);
            expect(rows[0].uuid).toBe(c.pid);
            expect(rows[0].uri).toBe('/repositories/2/resources/77');
            /*
             * Distinct from 'single' / 'collection' so the queue
             * audit trail records which surface enqueued the row.
             */
            expect(rows[0].update_type).toBe('collection-record');
            expect(rows[0].status).toBe('PENDING');
        });

        it('throws when the pid is not a collection', async () => {
            const obj = await db_helper.seed_object({
                uri: '/foo',
                object_type: 'object',
            });
            await expect(
                model.enqueue_collection_record(obj.pid)
            ).rejects.toBeInstanceOf(ValidationError);
        });

        it('refuses soft-deleted collections', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                uri: '/c',
                is_active: 0,
            });
            await expect(
                model.enqueue_collection_record(c.pid)
            ).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('enqueue_pids', () => {
        it('inserts one row per active pid', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            const b = await db_helper.seed_object({ uri: '/b' });
            const result = await model.enqueue_pids([a.pid, b.pid]);
            expect(result.count).toBe(2);
        });

        it('rejects more than max_batch_pids', async () => {
            const huge = Array.from({ length: 101 }, () => randomUUID());
            await expect(model.enqueue_pids(huge)).rejects.toBeInstanceOf(ValidationError);
        });

        it('rejects an empty array', async () => {
            await expect(model.enqueue_pids([])).rejects.toBeInstanceOf(ValidationError);
        });

        it('de-duplicates within a single call', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            const result = await model.enqueue_pids([a.pid, a.pid, a.pid]);
            expect(result.count).toBe(1);
        });
    });

    describe('claim_pending + lifecycle helpers', () => {
        it('claims rows in FIFO id order and flips them to IN_PROGRESS', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            const b = await db_helper.seed_object({ uri: '/b' });
            const c = await db_helper.seed_object({ uri: '/c' });
            await model.enqueue_pids([a.pid, b.pid, c.pid]);
            const claimed = await model.claim_pending(2);
            expect(claimed).toHaveLength(2);
            // The first two by id == the first two we inserted (a, b).
            expect(claimed.map((r) => r.uuid)).toEqual([a.pid, b.pid]);
            // Both rows are now IN_PROGRESS in the DB.
            const all = await db_queue()(QUEUE).select('uuid', 'status');
            const a_row = all.find((r) => r.uuid === a.pid);
            const c_row = all.find((r) => r.uuid === c.pid);
            expect(a_row.status).toBe('IN_PROGRESS');
            expect(c_row.status).toBe('PENDING');
        });

        it('mark_updated transitions to RECORD_UPDATED + is_updated=1', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            const { batch_uuid } = await model.enqueue_pids([a.pid]);
            const [claimed] = await model.claim_pending(1);
            await model.mark_updated(claimed.id);
            const row = await db_queue()(QUEUE).where({ batch_uuid }).first();
            expect(row.status).toBe('RECORD_UPDATED');
            expect(row.is_updated).toBe(1);
            expect(row.is_complete).toBe(0);
        });

        it('mark_complete flips is_complete=1', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);
            const [claimed] = await model.claim_pending(1);
            await model.mark_complete(claimed.id);
            const row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
            expect(row.status).toBe('COMPLETE');
            expect(row.is_complete).toBe(1);
        });

        it('mark_failed records the error and finalizes the row', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);
            const [claimed] = await model.claim_pending(1);
            await model.mark_failed(claimed.id, 'ASpace 502');
            const row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
            expect(row.error).toBe('ASpace 502');
            expect(row.is_complete).toBe(1);
        });

        it('mark_failed truncates very long error messages to 1000 chars', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);
            const [claimed] = await model.claim_pending(1);
            await model.mark_failed(claimed.id, 'x'.repeat(5000));
            const row = await db_queue()(QUEUE).where({ id: claimed.id }).first();
            expect(row.error.length).toBe(1000);
        });
    });

    describe('reset_orphaned', () => {
        it('moves IN_PROGRESS rows back to PENDING (boot recovery)', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);
            await model.claim_pending(1); // sets IN_PROGRESS
            const before = await db_queue()(QUEUE).where({ uuid: a.pid }).first();
            expect(before.status).toBe('IN_PROGRESS');
            const result = await model.reset_orphaned();
            expect(result.affected).toBe(1);
            const after = await db_queue()(QUEUE).where({ uuid: a.pid }).first();
            expect(after.status).toBe('PENDING');
        });

        it('ignores already-completed rows', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            await model.enqueue_pids([a.pid]);
            const [claimed] = await model.claim_pending(1);
            await model.mark_complete(claimed.id);
            const result = await model.reset_orphaned();
            expect(result.affected).toBe(0);
        });
    });

    describe('get_batch_progress', () => {
        it('computes total, completed, percent', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            const b = await db_helper.seed_object({ uri: '/b' });
            const { batch_uuid } = await model.enqueue_pids([a.pid, b.pid]);
            const [claimed_a] = await model.claim_pending(1);
            await model.mark_complete(claimed_a.id);
            const prog = await model.get_batch_progress(batch_uuid);
            expect(prog.total).toBe(2);
            expect(prog.completed).toBe(1);
            expect(prog.percent).toBe(50);
            expect(prog.status).toBe('in_progress');
        });

        it('separates failed from cancelled rows', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            const b = await db_helper.seed_object({ uri: '/b' });
            const c = await db_helper.seed_object({ uri: '/c' });
            const { batch_uuid } = await model.enqueue_pids([a.pid, b.pid, c.pid]);
            const claimed = await model.claim_pending(3);
            await model.mark_complete(claimed[0].id);
            await model.mark_failed(claimed[1].id, 'ASpace 500');
            await db_queue()(QUEUE)
                .where({ id: claimed[2].id })
                .update({ status: 'CANCELLED', is_complete: 1 });
            const prog = await model.get_batch_progress(batch_uuid);
            expect(prog.completed).toBe(3);
            expect(prog.failed).toBe(1);
            expect(prog.cancelled).toBe(1);
            expect(prog.status).toBe('done');
        });

        it('throws NotFoundError on a batch_uuid with no rows', async () => {
            await expect(model.get_batch_progress(randomUUID())).rejects.toBeInstanceOf(
                NotFoundError
            );
        });
    });

    describe('cancel_batch', () => {
        it('marks only non-terminal rows as CANCELLED', async () => {
            const a = await db_helper.seed_object({ uri: '/a' });
            const b = await db_helper.seed_object({ uri: '/b' });
            const c = await db_helper.seed_object({ uri: '/c' });
            const { batch_uuid } = await model.enqueue_pids([a.pid, b.pid, c.pid]);
            /*
             * Pretend the worker finished a; b is still PENDING; c is
             * IN_PROGRESS (already claimed).
             */
            const claimed = await model.claim_pending(2);
            await model.mark_complete(claimed[0].id);
            // Note: claimed[1] left IN_PROGRESS deliberately.
            const result = await model.cancel_batch(batch_uuid);
            /*
             * Two rows transitioned: the leftover PENDING + the
             * IN_PROGRESS claim. The already-COMPLETE row is untouched.
             */
            expect(result.affected).toBe(2);
            const rows = await db_queue()(QUEUE).where({ batch_uuid });
            const statuses = rows.map((r) => r.status).sort();
            expect(statuses).toEqual(['CANCELLED', 'CANCELLED', 'COMPLETE']);
        });
    });
});
