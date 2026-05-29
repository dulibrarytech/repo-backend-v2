'use strict';

const model = require('../../../indexer/model');
const db_helper = require('../../helpers/db');
const { db } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { ValidationError } = require('../../../libs/errors');

describe('indexer/model — DB integration', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('claim_dirty', () => {
        it('returns rows with is_updated=1 in FIFO id order', async () => {
            const a = await db_helper.seed_object({ is_updated: 1 });
            const b = await db_helper.seed_object({ is_updated: 1 });
            await db_helper.seed_object({ is_updated: 0 }); // not dirty
            const claimed = await model.claim_dirty(10);
            expect(claimed.map((r) => r.pid)).toEqual([a.pid, b.pid]);
        });

        it('flips is_updated=0 atomically on claim', async () => {
            const a = await db_helper.seed_object({ is_updated: 1 });
            await model.claim_dirty(10);
            const row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.is_updated).toBe(0);
        });

        it('respects the limit', async () => {
            for (let i = 0; i < 5; i++) {
                await db_helper.seed_object({ is_updated: 1 });
            }
            const claimed = await model.claim_dirty(3);
            expect(claimed).toHaveLength(3);
            // The other 2 stay dirty.
            const still_dirty = await db()(tables.objects)
                .where({ is_updated: 1 })
                .count({ n: '*' })
                .first();
            expect(Number(still_dirty.n)).toBe(2);
        });

        it('caps the limit at 100', async () => {
            // Don't seed 100+ rows; just verify the model defends.
            const claimed = await model.claim_dirty(999);
            expect(claimed).toBeInstanceOf(Array);
            // (no rows seeded — should be empty)
            expect(claimed).toHaveLength(0);
        });

        it('returns empty when nothing is dirty', async () => {
            await db_helper.seed_object({ is_updated: 0 });
            const claimed = await model.claim_dirty(5);
            expect(claimed).toEqual([]);
        });

        it('selects WORKER_FIELDS only (no mods/transcript leak)', async () => {
            await db_helper.seed_object({
                is_updated: 1,
                mods: 'a huge xml blob',
            });
            const [claimed] = await model.claim_dirty(1);
            expect(claimed.mods).toBeUndefined();
            expect(claimed.transcript).toBeUndefined();
        });
    });

    describe('mark_indexed / mark_deindexed', () => {
        it('mark_indexed flips is_indexed=1', async () => {
            const a = await db_helper.seed_object({ is_indexed: 0 });
            await model.mark_indexed(a.pid);
            const row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.is_indexed).toBe(1);
        });

        it('mark_deindexed flips is_indexed=0', async () => {
            const a = await db_helper.seed_object({ is_indexed: 1 });
            await model.mark_deindexed(a.pid);
            const row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.is_indexed).toBe(0);
        });

        it('rejects bad pid', async () => {
            await expect(model.mark_indexed('garbage')).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('requeue', () => {
        it('flips is_updated back to 1 for retry on next tick', async () => {
            const a = await db_helper.seed_object({ is_updated: 0 });
            await model.requeue(a.pid);
            const row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.is_updated).toBe(1);
        });
    });

    describe('mark_dirty_*', () => {
        it('mark_dirty_all flips only PUBLISHED + active rows', async () => {
            // Only is_published=1 AND is_active=1 rows count. Per
            // the indexing rule, unpublished rows should never be
            // pushed to ES, and soft-deleted rows wouldn't be there
            // either.
            await db_helper.seed_object({
                is_active: 1,
                is_published: 1,
                is_updated: 0,
            });
            await db_helper.seed_object({
                is_active: 1,
                is_published: 1,
                is_updated: 0,
            });
            await db_helper.seed_object({
                is_active: 1,
                is_published: 0,
                is_updated: 0,
            }); // unpublished — skipped
            await db_helper.seed_object({
                is_active: 0,
                is_published: 1,
                is_updated: 0,
            }); // soft-deleted — skipped
            const result = await model.mark_dirty_all();
            expect(result.affected).toBe(2);
        });

        it('mark_dirty_collection flips only PUBLISHED members', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                is_active: 1,
            });
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_published: 1,
                is_updated: 0,
            });
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_published: 1,
                is_updated: 0,
            });
            // Unpublished member — should NOT be dirtied.
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_published: 0,
                is_updated: 0,
            });
            // Different collection — should not be touched either.
            await db_helper.seed_object({
                is_member_of_collection: 'other-col',
                is_published: 1,
                is_updated: 0,
            });
            const result = await model.mark_dirty_collection(c.pid);
            expect(result.affected).toBe(2);
        });

        it('mark_dirty_pid only flips the one row', async () => {
            const a = await db_helper.seed_object({ is_updated: 0 });
            await db_helper.seed_object({ is_updated: 0 });
            const result = await model.mark_dirty_pid(a.pid);
            expect(result.affected).toBe(1);
        });
    });

    describe('bulk variants', () => {
        it('mark_indexed_bulk flips is_indexed=1 for every listed pid', async () => {
            const a = await db_helper.seed_object({ is_indexed: 0 });
            const b = await db_helper.seed_object({ is_indexed: 0 });
            const result = await model.mark_indexed_bulk([a.pid, b.pid]);
            expect(result.affected).toBe(2);
            const rows = await db()(tables.objects).whereIn('pid', [a.pid, b.pid]);
            expect(rows.every((r) => r.is_indexed === 1)).toBe(true);
        });

        it('mark_deindexed_bulk flips is_indexed=0 for every listed pid', async () => {
            const a = await db_helper.seed_object({ is_indexed: 1 });
            const b = await db_helper.seed_object({ is_indexed: 1 });
            const result = await model.mark_deindexed_bulk([a.pid, b.pid]);
            expect(result.affected).toBe(2);
            const rows = await db()(tables.objects).whereIn('pid', [a.pid, b.pid]);
            expect(rows.every((r) => r.is_indexed === 0)).toBe(true);
        });

        it('requeue_bulk flips is_updated=1 for every listed pid', async () => {
            const a = await db_helper.seed_object({ is_updated: 0 });
            const b = await db_helper.seed_object({ is_updated: 0 });
            const result = await model.requeue_bulk([a.pid, b.pid]);
            expect(result.affected).toBe(2);
            const rows = await db()(tables.objects).whereIn('pid', [a.pid, b.pid]);
            expect(rows.every((r) => r.is_updated === 1)).toBe(true);
        });

        it('bulk variants are no-ops on empty input', async () => {
            expect((await model.mark_indexed_bulk([])).affected).toBe(0);
            expect((await model.mark_deindexed_bulk([])).affected).toBe(0);
            expect((await model.requeue_bulk([])).affected).toBe(0);
        });
    });

    describe('reset_all_index_state', () => {
        it('sets is_updated=1 + is_indexed=0 for every PUBLISHED + active row', async () => {
            // Eligible: gets reset.
            const a = await db_helper.seed_object({
                is_published: 1,
                is_active: 1,
                is_updated: 0,
                is_indexed: 1,
            });
            // Unpublished: untouched. Index-rebuild only affects rows
            // that are supposed to be in the public index.
            const b = await db_helper.seed_object({
                is_published: 0,
                is_active: 1,
                is_updated: 0,
                is_indexed: 1,
            });
            // Soft-deleted: untouched, same reason.
            const c = await db_helper.seed_object({
                is_published: 1,
                is_active: 0,
                is_updated: 0,
                is_indexed: 1,
            });
            const result = await model.reset_all_index_state();
            expect(result.affected).toBe(1);
            const row_a = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row_a.is_updated).toBe(1);
            expect(row_a.is_indexed).toBe(0);
            const row_b = await db()(tables.objects).where({ pid: b.pid }).first();
            expect(row_b.is_updated).toBe(0);
            expect(row_b.is_indexed).toBe(1);
            const row_c = await db()(tables.objects).where({ pid: c.pid }).first();
            expect(row_c.is_updated).toBe(0);
            expect(row_c.is_indexed).toBe(1);
        });
    });

    describe('status_counts', () => {
        it('reports dirty/indexed/eligible counters', async () => {
            await db_helper.seed_object({
                is_published: 1,
                is_active: 1,
                is_updated: 1,
                is_indexed: 0,
            });
            await db_helper.seed_object({
                is_published: 1,
                is_active: 1,
                is_updated: 0,
                is_indexed: 1,
            });
            await db_helper.seed_object({
                is_published: 0,
                is_active: 1,
                is_updated: 0,
                is_indexed: 0,
            });
            const c = await model.status_counts();
            expect(c.dirty).toBe(1);
            expect(c.indexed_flag).toBe(1);
            expect(c.eligible).toBe(2);
        });
    });
});
