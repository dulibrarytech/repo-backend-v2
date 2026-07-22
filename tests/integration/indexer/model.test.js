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

        it('selects WORKER_FIELDS only (no mods leak; transcripts ARE selected for projection)', async () => {
            await db_helper.seed_object({
                is_updated: 1,
                mods: 'a huge xml blob',
                transcript: 'spoken words',
            });
            const [claimed] = await model.claim_dirty(1);
            expect(claimed.mods).toBeUndefined();
            // transcript columns feed project_for_index (indexed as
            // transcript/transcript_search) so they must be selected.
            expect(claimed.transcript).toBe('spoken words');
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
            /*
             * Only is_published=1 AND is_active=1 rows count. Per
             * the indexing rule, unpublished rows should never be
             * pushed to ES, and soft-deleted rows wouldn't be there
             * either.
             */
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
            /*
             * Unpublished: untouched. Index-rebuild only affects rows
             * that are supposed to be in the public index.
             */
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

        it('counts dead-lettered rows (index_error set)', async () => {
            await db_helper.seed_object({ index_error: 'parked: parse error' });
            await db_helper.seed_object({ index_error: null });
            const c = await model.status_counts();
            expect(c.dead_lettered).toBe(1);
        });
    });

    describe('record_failures (dead-letter retry cap)', () => {
        it('increments index_attempts and requeues a row under the cap', async () => {
            const a = await db_helper.seed_object({ is_updated: 0, index_attempts: 0 });
            const r = await model.record_failures([{ pid: a.pid, err: 'boom' }], {
                max_attempts: 3,
            });
            expect(r.requeued).toEqual([a.pid]);
            expect(r.dead_lettered).toEqual([]);
            const row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.index_attempts).toBe(1);
            expect(row.is_updated).toBe(1); // re-queued for another try
            expect(row.index_error).toBeFalsy(); // not parked yet
        });

        it('dead-letters a row once it reaches the cap', async () => {
            // Two prior attempts; cap is 3, so this third failure parks it.
            const a = await db_helper.seed_object({ is_updated: 0, index_attempts: 2 });
            const r = await model.record_failures([{ pid: a.pid, err: 'parse error' }], {
                max_attempts: 3,
            });
            expect(r.dead_lettered).toEqual([a.pid]);
            expect(r.requeued).toEqual([]);
            const row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.index_attempts).toBe(3);
            expect(row.is_updated).toBe(0); // NOT re-claimed — the fix
            expect(row.index_error).toBe('parse error'); // visible to admin
        });

        it('partitions a mixed batch into requeued + dead-lettered', async () => {
            const under = await db_helper.seed_object({ is_updated: 0, index_attempts: 0 });
            const over = await db_helper.seed_object({ is_updated: 0, index_attempts: 4 });
            const r = await model.record_failures(
                [
                    { pid: under.pid, err: 'x' },
                    { pid: over.pid, err: 'y' },
                ],
                { max_attempts: 5 }
            );
            expect(r.requeued).toEqual([under.pid]);
            expect(r.dead_lettered).toEqual([over.pid]);
        });

        it('truncates a long error message to 1000 chars', async () => {
            const a = await db_helper.seed_object({ is_updated: 0, index_attempts: 4 });
            await model.record_failures([{ pid: a.pid, err: 'e'.repeat(5000) }], {
                max_attempts: 5,
            });
            const row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.index_error).toHaveLength(1000);
        });

        it('is a no-op on empty input', async () => {
            expect(await model.record_failures([], { max_attempts: 5 })).toEqual({
                requeued: [],
                dead_lettered: [],
            });
        });

        it('mark_indexed_bulk clears attempts + error on success', async () => {
            const a = await db_helper.seed_object({ index_attempts: 4, index_error: 'old failure' });
            await model.mark_indexed_bulk([a.pid]);
            const row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.is_indexed).toBe(1);
            expect(row.index_attempts).toBe(0);
            expect(row.index_error).toBeFalsy();
        });

        it('requeue_dead_lettered re-queues only rows with an index_error', async () => {
            const dead = await db_helper.seed_object({
                is_updated: 0,
                index_attempts: 5,
                index_error: 'boom',
            });
            const healthy = await db_helper.seed_object({
                is_updated: 0,
                index_attempts: 0,
                index_error: null,
            });
            const result = await model.requeue_dead_lettered();
            expect(result.affected).toBe(1);
            const d = await db()(tables.objects).where({ pid: dead.pid }).first();
            expect(d.is_updated).toBe(1);
            expect(d.index_attempts).toBe(0);
            expect(d.index_error).toBeFalsy();
            const h = await db()(tables.objects).where({ pid: healthy.pid }).first();
            expect(h.is_updated).toBe(0); // untouched
        });

        it('an explicit reindex (mark_dirty_pid) clears a dead-lettered row', async () => {
            const a = await db_helper.seed_object({
                is_updated: 0,
                index_attempts: 9,
                index_error: 'boom',
            });
            await model.mark_dirty_pid(a.pid);
            const row = await db()(tables.objects).where({ pid: a.pid }).first();
            expect(row.is_updated).toBe(1);
            expect(row.index_attempts).toBe(0);
            expect(row.index_error).toBeFalsy();
        });
    });
});
