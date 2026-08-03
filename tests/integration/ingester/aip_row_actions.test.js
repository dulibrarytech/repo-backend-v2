'use strict';

/*
 * Stage 6 staff actions + submit-gate scoping (2026-08-01).
 *
 * The ingest itself is complete once a row reaches a Stage 6 state, so:
 *   - stop_aip_copy_action parks a PENDING/IN_PROGRESS copy at
 *     AIP_STORE_FAILED (no rollback, batch untouched)
 *   - dismiss_aip_row_action clears an acknowledged FAILED row from the
 *     open queue view (is_complete=1) while the AIPs dashboard keeps
 *     tracking it
 *   - active_ingest_count (the submit gate) counts stages 1–5 ONLY;
 *     Stage 6 activity is a separate, non-blocking count
 *
 * Handlers are exercised directly with mock req/res against the real
 * model + sqlite DB (same pattern as the stage tests).
 */

const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const model = require('../../../ingester/model');
const aip_store_model = require('../../../repository/aip_store_model');
const dashboard = require('../../../ingester/dashboard');

const QUEUE = tables.ingest_queue;

async function seed_queue(status, overrides = {}) {
    const [id] = await model.queue_packages([
        {
            batch: 'batch-A',
            package: `pkg-${Math.random().toString(16).slice(2, 8)}`,
            collection_uuid: 'codu:test',
            job_uuid: 'job-1',
            metadata_uri: '/repositories/2/resources/1',
            status,
            ...overrides,
        },
    ]);
    return db_queue()(QUEUE).where({ id }).first();
}

function mock_req(id) {
    return { params: { id: String(id) }, body: {}, user: { du_id: 'staff-1' }, ip: '127.0.0.1' };
}

function mock_res() {
    const out = {
        status_code: 200,
        json_body: null,
        rendered: null,
        headers: {},
    };
    return {
        out,
        status(code) {
            out.status_code = code;
            return this;
        },
        json(body) {
            out.json_body = body;
            return this;
        },
        set(k, v) {
            out.headers[k] = v;
            return this;
        },
        get(k) {
            return out.headers[k];
        },
        render(view, locals) {
            out.rendered = { view, locals };
        },
    };
}

describe('ingester/dashboard — Stage 6 row actions + gate counts', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('stop_aip_copy_action', () => {
        it('parks an AIP_STORE_IN_PROGRESS row at AIP_STORE_FAILED, no rollback implied', async () => {
            const obj = await db_helper.seed_object({ sip_uuid: 'aip-uuid-stop' });
            const row = await seed_queue('AIP_STORE_IN_PROGRESS', {
                sip_uuid: 'aip-uuid-stop',
            });
            const res = mock_res();
            await dashboard.stop_aip_copy_action(mock_req(row.id), res);

            expect(res.out.status_code).toBe(200);
            expect(res.out.headers['HX-Trigger']).toBe('queue:refresh');
            const after = await db_queue()(QUEUE).where({ id: row.id }).first();
            expect(after.pipeline_state).toBe('AIP_STORE_FAILED');
            /* Visible until staff dismisses it. */
            expect(after.is_complete).toBe(0);
            expect(after.error).toContain('stopped by staff');
            expect(after.suggested_action).toContain('ingest itself is complete');

            /* AIPs dashboard row created/marked so Retry is available. */
            const stored = await aip_store_model.get_by_uuid(obj.pid);
            expect(stored).toBeTruthy();
            expect(stored.message).toBe('STOPPED_BY_STAFF');
            expect(stored.is_migrated).toBe(aip_store_model.STATUS.INGEST_COPY_FAILED);

            /* Audit event carries the staff action. */
            const events = await db_queue()(tables.ingest_events)
                .where({ queue_id: row.id, event_type: 'staff_action' });
            expect(events.length).toBeGreaterThan(0);
        });

        it('works on AIP_STORE_PENDING (retry-loop parking) too', async () => {
            await db_helper.seed_object({ sip_uuid: 'aip-uuid-pend' });
            const row = await seed_queue('AIP_STORE_PENDING', {
                sip_uuid: 'aip-uuid-pend',
            });
            const res = mock_res();
            await dashboard.stop_aip_copy_action(mock_req(row.id), res);
            const after = await db_queue()(QUEUE).where({ id: row.id }).first();
            expect(after.pipeline_state).toBe('AIP_STORE_FAILED');
        });

        it('409s on a row that is not in a stoppable state', async () => {
            const row = await seed_queue('UPLOADING');
            const res = mock_res();
            await dashboard.stop_aip_copy_action(mock_req(row.id), res);
            expect(res.out.status_code).toBe(409);
            expect(res.out.json_body.error).toBe('not_stoppable');
            const after = await db_queue()(QUEUE).where({ id: row.id }).first();
            expect(after.pipeline_state).toBe('UPLOADING');
        });
    });

    describe('dismiss_aip_row_action', () => {
        it('flips is_complete=1 on AIP_STORE_FAILED without changing state', async () => {
            const row = await seed_queue('AIP_STORE_FAILED');
            const res = mock_res();
            await dashboard.dismiss_aip_row_action(mock_req(row.id), res);

            expect(res.out.status_code).toBe(200);
            const after = await db_queue()(QUEUE).where({ id: row.id }).first();
            expect(after.pipeline_state).toBe('AIP_STORE_FAILED');
            expect(after.is_complete).toBe(1);

            const events = await db_queue()(tables.ingest_events)
                .where({ queue_id: row.id, event_type: 'staff_action' });
            expect(events).toHaveLength(1);
            expect(JSON.parse(events[0].payload).step).toBe('dismissed_by_staff');
        });

        it('409s on a non-FAILED row', async () => {
            const row = await seed_queue('AIP_STORE_IN_PROGRESS');
            const res = mock_res();
            await dashboard.dismiss_aip_row_action(mock_req(row.id), res);
            expect(res.out.status_code).toBe(409);
            expect(res.out.json_body.error).toBe('not_dismissable');
        });

        it('a dismissed row is re-opened by the AIPs-dashboard Retry flip', async () => {
            /*
             * The invariant that makes Dismiss safe: aip_retry sets
             * status=AIP_STORE_PENDING + is_complete=0 on the queue
             * row regardless of dismissal. Emulate that write here.
             */
            const row = await seed_queue('AIP_STORE_FAILED');
            await dashboard.dismiss_aip_row_action(mock_req(row.id), mock_res());
            await model.update_queue(
                { id: row.id },
                { status: 'AIP_STORE_PENDING', is_complete: 0, error: null }
            );
            const after = await db_queue()(QUEUE).where({ id: row.id }).first();
            expect(after.pipeline_state).toBe('AIP_STORE_PENDING');
            expect(after.is_complete).toBe(0);
        });
    });

    describe('aip_retry_duracloud (AIPs dashboard)', () => {
        it('stamps RETRY_FROM_DURACLOUD and re-enqueues the queue row', async () => {
            const aip_controller = require('../../../dashboard/aip_controller');
            const store_row = await db_helper.seed_aip_store({
                is_migrated: 7,
                aip_uuid: 'aip-uuid-dc',
                error: 'am download returned HTTP 502',
                message: 'COPY_FAILED',
                attempts: 5,
            });
            const queue_row = await seed_queue('AIP_STORE_FAILED', {
                sip_uuid: 'aip-uuid-dc',
            });
            const res = mock_res();
            await aip_controller.aip_retry_duracloud(
                mock_req(store_row.id), res
            );

            const aip_store_model = require('../../../repository/aip_store_model');
            const fresh = await aip_store_model.get(store_row.id);
            expect(fresh.message).toBe('RETRY_FROM_DURACLOUD');
            expect(fresh.attempts).toBe(0);
            expect(fresh.next_attempt_at).toBeNull();

            const queue_after = await db_queue()(QUEUE)
                .where({ id: queue_row.id })
                .first();
            expect(queue_after.pipeline_state).toBe('AIP_STORE_PENDING');
            expect(queue_after.is_complete).toBe(0);
            expect(res.out.rendered.view).toBe('dashboard/partials/aip_row');
        });
    });

    describe('submit-gate counts', () => {
        it('active_ingest_count counts stages 1–5 but NOT Stage 6 states', async () => {
            await seed_queue('AIP_STORE_IN_PROGRESS');
            await seed_queue('AIP_STORE_PENDING');
            expect(await dashboard._active_ingest_count()).toBe(0);
            await seed_queue('UPLOADING');
            expect(await dashboard._active_ingest_count()).toBe(1);
        });

        it('aip_copy_count counts only open Stage 6 rows', async () => {
            await seed_queue('AIP_STORE_IN_PROGRESS');
            await seed_queue('AIP_STORE_PENDING');
            await seed_queue('UPLOADING');
            /* Dismissed/complete Stage 6 rows do not count. */
            await seed_queue('AIP_STORE_FAILED', { is_complete: 1 });
            expect(await dashboard._aip_copy_count()).toBe(2);
        });

        it('halted/terminal rows never block submits', async () => {
            await seed_queue('AIP_STORE_FAILED');
            await seed_queue('INGEST_HALTED');
            expect(await dashboard._active_ingest_count()).toBe(0);
        });
    });
});
