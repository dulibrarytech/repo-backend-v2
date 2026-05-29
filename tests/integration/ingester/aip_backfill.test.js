'use strict';

// Integration tests for ingester/aip_backfill.js. Real sqlite via
// the test harness; no Stage 6 execution (we cover the discovery +
// enqueue + cancel + status paths only). End-to-end Stage 6
// behavior is in tests/integration/ingester/aip_store_stage.test.js.

const { randomUUID } = require('node:crypto');

const aip_backfill = require('../../../ingester/aip_backfill');
const ingest_model = require('../../../ingester/model');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { ValidationError } = require('../../../libs/errors');

const QUEUE = tables.ingest_queue;

describe('ingester/aip_backfill', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('count_missing_aips + preview_next_chunk', () => {
        it('returns 0 when no objects exist', async () => {
            expect(await aip_backfill.count_missing_aips()).toBe(0);
            expect(await aip_backfill.preview_next_chunk(10)).toEqual([]);
        });

        it('counts active objects with an AM sip_uuid and no aip_store success row', async () => {
            // Eligible: active + has real sip_uuid + no aip_store row.
            const a = await db_helper.seed_object({ sip_uuid: 'aip-a' });
            // Eligible: active + sip + failed aip_store row.
            const b = await db_helper.seed_object({ sip_uuid: 'aip-b' });
            await db_helper.seed_aip_store({ uuid: b.pid, is_migrated: 7 });
            // Ineligible: already migrated successfully (legacy).
            const c = await db_helper.seed_object({ sip_uuid: 'aip-c' });
            await db_helper.seed_aip_store({ uuid: c.pid, is_migrated: 5 });
            // Ineligible: already migrated successfully (v2 ingest).
            const d = await db_helper.seed_object({ sip_uuid: 'aip-d' });
            await db_helper.seed_aip_store({ uuid: d.pid, is_migrated: 6 });
            // Ineligible: soft-deleted.
            await db_helper.seed_object({ sip_uuid: 'aip-e', is_active: 0 });
            // Ineligible: no usable sip_uuid.
            await db_helper.seed_object({ sip_uuid: null });
            await db_helper.seed_object({ sip_uuid: '' });
            await db_helper.seed_object({ sip_uuid: 'PENDING' });

            expect(await aip_backfill.count_missing_aips()).toBe(2);
            const preview = await aip_backfill.preview_next_chunk(10);
            expect(preview.map((r) => r.pid).sort()).toEqual([a.pid, b.pid].sort());
        });

        it('excludes orphan (AM_NOT_FOUND) rows from eligibility so they aren\'t re-enqueued', async () => {
            // Orphans are terminal-and-non-retryable. Stage 6 marks
            // them is_migrated=8 when AM returns 404; the backfill
            // must skip them on subsequent runs so the operator
            // doesn't keep enqueuing the same dead ends every time
            // they click Start.
            const a = await db_helper.seed_object({ sip_uuid: 'aip-a' });
            // Orphan: should NOT be eligible.
            const o = await db_helper.seed_object({ sip_uuid: 'aip-orphan' });
            await db_helper.seed_aip_store({ uuid: o.pid, is_migrated: 8 });
            // Retryable failure: SHOULD still be eligible.
            const r = await db_helper.seed_object({ sip_uuid: 'aip-retry' });
            await db_helper.seed_aip_store({ uuid: r.pid, is_migrated: 7 });

            expect(await aip_backfill.count_missing_aips()).toBe(2);
            const preview = await aip_backfill.preview_next_chunk(10);
            const eligible_pids = preview.map((p) => p.pid).sort();
            expect(eligible_pids).toEqual([a.pid, r.pid].sort());
            expect(eligible_pids).not.toContain(o.pid);
        });
    });

    describe('enqueue_backfill_batch', () => {
        it('inserts one queue row per eligible object, stamped with batch marker', async () => {
            const a = await db_helper.seed_object({ sip_uuid: 'aip-a' });
            const b = await db_helper.seed_object({ sip_uuid: 'aip-b' });
            const result = await aip_backfill.enqueue_backfill_batch({
                actor: 'tester@du.edu',
            });
            expect(result.count).toBe(2);
            expect(result.batch_uuid).toBeTruthy();
            expect(result.batch_marker).toBe(
                `${aip_backfill.BACKFILL_BATCH_PREFIX}${result.batch_uuid}`
            );

            const rows = await db_queue()(QUEUE).where({ batch: result.batch_marker });
            expect(rows).toHaveLength(2);
            for (const row of rows) {
                expect(row.pipeline_state).toBe('AIP_STORE_PENDING');
                expect(row.status).toBe('AIP_STORE_PENDING');
                expect(row.is_complete).toBe(0);
                expect(['aip-a', 'aip-b']).toContain(row.sip_uuid);
                expect(row.error).toBe('backfill_by:tester@du.edu');
            }
        });

        it('returns count=0 with null markers when nothing is eligible', async () => {
            const a = await db_helper.seed_object({ sip_uuid: 'aip-already-done' });
            await db_helper.seed_aip_store({ uuid: a.pid, is_migrated: 6 });
            const result = await aip_backfill.enqueue_backfill_batch();
            expect(result.count).toBe(0);
            expect(result.batch_uuid).toBeNull();
            expect(result.batch_marker).toBeNull();
        });

        it('respects the chunk size cap', async () => {
            for (let i = 0; i < 5; i++) {
                await db_helper.seed_object({ sip_uuid: `aip-${i}` });
            }
            const result = await aip_backfill.enqueue_backfill_batch({
                chunk_size: 2,
            });
            expect(result.count).toBe(2);
            // 3 still missing after the first chunk.
            expect(await aip_backfill.count_missing_aips()).toBe(5);
            // The 2 rows just enqueued are still in the queue, but
            // count_missing_aips is based on the aip_store table —
            // they only drop out once Stage 6 runs and writes a
            // success row. (This is the documented "wait for the
            // current backfill to finish before starting another"
            // operator caveat.)
        });
    });

    describe('get_status', () => {
        it('returns zeros when no backfill rows exist', async () => {
            const status = await aip_backfill.get_status();
            expect(status.total_backfill_rows).toBe(0);
            expect(status.pending).toBe(0);
            expect(status.in_progress).toBe(0);
            expect(status.complete).toBe(0);
            expect(status.failed).toBe(0);
            expect(status.latest_batch_marker).toBeNull();
        });

        it('aggregates counts by pipeline_state for backfill rows only', async () => {
            const a = await db_helper.seed_object({ sip_uuid: 'aip-x' });
            const b = await db_helper.seed_object({ sip_uuid: 'aip-y' });
            const result = await aip_backfill.enqueue_backfill_batch();
            // Flip one of the two to AIP_STORE_COMPLETE + is_complete=1.
            const rows = await db_queue()(QUEUE).where({ batch: result.batch_marker });
            await db_queue()(QUEUE)
                .where({ id: rows[0].id })
                .update({
                    status: 'AIP_STORE_COMPLETE',
                    pipeline_state: 'AIP_STORE_COMPLETE',
                    is_complete: 1,
                });
            // A non-backfill row in AIP_STORE_PENDING must NOT count
            // toward the backfill totals.
            await db_queue()(QUEUE).insert({
                package: 'real',
                batch: 'real-batch',
                collection_uuid: 'cf',
                sip_uuid: 'sip-real',
                status: 'AIP_STORE_PENDING',
                pipeline_state: 'AIP_STORE_PENDING',
                is_complete: 0,
            });

            const status = await aip_backfill.get_status();
            expect(status.total_backfill_rows).toBe(2);
            expect(status.complete).toBe(1);
            expect(status.pending).toBe(1);
            expect(status.in_progress).toBe(0);
            expect(status.latest_batch_marker).toBe(result.batch_marker);
        });
    });

    describe('cancel_backfill', () => {
        it('flips pending rows to CANCELLED_BY_USER + is_complete=1', async () => {
            await db_helper.seed_object({ sip_uuid: 'aip-x' });
            await db_helper.seed_object({ sip_uuid: 'aip-y' });
            const result = await aip_backfill.enqueue_backfill_batch();
            const cancel = await aip_backfill.cancel_backfill(result.batch_marker);
            expect(cancel.cancelled).toBe(2);
            const rows = await db_queue()(QUEUE).where({ batch: result.batch_marker });
            for (const r of rows) {
                expect(r.pipeline_state).toBe('CANCELLED_BY_USER');
                expect(r.is_complete).toBe(1);
            }
        });

        it('leaves IN_PROGRESS rows alone (worker finishes them)', async () => {
            const a = await db_helper.seed_object({ sip_uuid: 'aip-x' });
            const b = await db_helper.seed_object({ sip_uuid: 'aip-y' });
            const result = await aip_backfill.enqueue_backfill_batch();
            // Mark one as in-flight; cancel must NOT touch it.
            const rows = await db_queue()(QUEUE)
                .where({ batch: result.batch_marker })
                .orderBy('id', 'asc');
            await db_queue()(QUEUE)
                .where({ id: rows[0].id })
                .update({
                    status: 'AIP_STORE_IN_PROGRESS',
                    pipeline_state: 'AIP_STORE_IN_PROGRESS',
                });
            const cancel = await aip_backfill.cancel_backfill(result.batch_marker);
            // Only the second row (still PENDING) was cancelled.
            expect(cancel.cancelled).toBe(1);
            const after = await db_queue()(QUEUE)
                .where({ batch: result.batch_marker })
                .orderBy('id', 'asc');
            expect(after[0].pipeline_state).toBe('AIP_STORE_IN_PROGRESS');
            expect(after[1].pipeline_state).toBe('CANCELLED_BY_USER');
        });

        it('rejects a batch marker that lacks the backfill prefix', async () => {
            await expect(
                aip_backfill.cancel_backfill('something-else')
            ).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('ingester model list_queue — exclude_backfill', () => {
        it('hides backfill rows when exclude_backfill is true', async () => {
            await db_helper.seed_object({ sip_uuid: 'aip-z' });
            await aip_backfill.enqueue_backfill_batch();
            // Plus a non-backfill row to confirm we DO still see those.
            await db_queue()(QUEUE).insert({
                package: 'real',
                batch: 'real-batch',
                collection_uuid: 'cf',
                sip_uuid: 'sip-real',
                status: 'PENDING',
                pipeline_state: 'PENDING',
                is_complete: 0,
            });

            const with_backfill = await ingest_model.list_queue({});
            const without_backfill = await ingest_model.list_queue({
                exclude_backfill: true,
            });
            // With: backfill row + the non-backfill row.
            expect(with_backfill.length).toBeGreaterThanOrEqual(2);
            // Without: only the non-backfill row.
            const batches_seen = without_backfill.map((r) => r.batch);
            expect(batches_seen).toContain('real-batch');
            for (const b of batches_seen) {
                expect(b.startsWith('aip-backfill-')).toBe(false);
            }
        });
    });
});
