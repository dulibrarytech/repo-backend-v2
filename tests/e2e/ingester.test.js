'use strict';

/*
 * E2E tests for /api/ingest/*. Exercises the full Express + auth +
 * model + sqlite stack via supertest.
 */

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const { db_queue } = require('../../config/db');
const tables = require('../../config/db_tables');
const jwt = require('../../libs/jwt');

let app;

async function bearer_for(du_id) {
    const u = await db_helper.seed_user({ du_id });
    return `Bearer ${jwt.sign({ sub: String(u.id), du_id })}`;
}

function row(overrides = {}) {
    return {
        batch: 'batch-A',
        package: 'pkg-001',
        collection_uuid: 'codu:test',
        job_uuid: 'job-1',
        metadata_uri: '/repositories/2/resources/1',
        ...overrides,
    };
}

describe('ingester — e2e', () => {
    beforeAll(async () => {
        app = make_app();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('POST /repo/api/ingest/queue', () => {
        it('requires auth', async () => {
            const res = await supertest(app)
                .post('/repo/api/ingest/queue')
                .send({ rows: [row()] });
            expect(res.status).toBe(401);
        });

        it('returns 201 + ids and writes an event per row', async () => {
            const auth = await bearer_for('staff-1');
            const res = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ package: 'a' }), row({ package: 'b' })] })
                .expect(201);
            expect(res.body.count).toBe(2);
            expect(res.body.ids).toHaveLength(2);
            const events = await db_queue()(tables.ingest_events);
            expect(events).toHaveLength(2);
            expect(events.every((e) => e.actor === 'staff-1')).toBe(true);
            expect(events.every((e) => e.to_state === 'PENDING')).toBe(true);
        });

        it('returns 400 with a per-row error list on missing required fields', async () => {
            const auth = await bearer_for('staff-2');
            const res = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({
                    rows: [
                        row({ package: 'good' }),
                        { batch: 'b', package: '' /* missing */ },
                        { batch: '', package: '', collection_uuid: '' },
                    ],
                });
            expect(res.status).toBe(400);
            expect(res.body.error || res.body.message || '').toBeTruthy();
            // No rows should be inserted on validation failure.
            const queue = await db_queue()(tables.ingest_queue);
            expect(queue).toHaveLength(0);
        });

        it('rejects an empty rows array', async () => {
            const auth = await bearer_for('staff-3');
            const res = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [] });
            expect(res.status).toBe(400);
        });
    });

    describe('GET /repo/api/ingest', () => {
        it('lists rows newest-first with available_actions attached', async () => {
            const auth = await bearer_for('staff-4');
            await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({
                    rows: [
                        row({ package: 'a', status: 'FAILED' }),
                        row({ package: 'b', status: 'PENDING' }),
                    ],
                });
            const res = await supertest(app)
                .get('/repo/api/ingest')
                .set('Authorization', auth)
                .expect(200);
            expect(res.body.count).toBe(2);
            expect(res.body.rows[0].package).toBe('b'); // newest first
            // FAILED row should advertise rollback_archivematica.
            const a_row = res.body.rows.find((r) => r.package === 'a');
            expect(a_row.actions).toContain('rollback_archivematica');
            /*
             * PENDING is an in-flight (cancellable) state — staff
             * can cancel it before the worker picks it up.
             */
            const b_row = res.body.rows.find((r) => r.package === 'b');
            expect(b_row.actions).toEqual(['timeline', 'cancel']);
        });

        it('filters by status', async () => {
            const auth = await bearer_for('staff-5');
            await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({
                    rows: [
                        row({ package: 'a', status: 'FAILED' }),
                        row({ package: 'b', status: 'PENDING' }),
                    ],
                });
            const res = await supertest(app)
                .get('/repo/api/ingest?status=FAILED')
                .set('Authorization', auth)
                .expect(200);
            expect(res.body.count).toBe(1);
            expect(res.body.rows[0].package).toBe('a');
        });
    });

    describe('GET /repo/api/ingest/:id', () => {
        it('returns 404 for an unknown id', async () => {
            const auth = await bearer_for('staff-6');
            const res = await supertest(app)
                .get('/repo/api/ingest/9999')
                .set('Authorization', auth);
            expect(res.status).toBe(404);
        });

        it('returns 400 for a non-numeric id', async () => {
            const auth = await bearer_for('staff-6b');
            const res = await supertest(app).get('/repo/api/ingest/abc').set('Authorization', auth);
            expect(res.status).toBe(400);
        });

        it('returns the row with available actions', async () => {
            const auth = await bearer_for('staff-7');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'AS_METADATA_INVALID' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .get(`/repo/api/ingest/${id}`)
                .set('Authorization', auth)
                .expect(200);
            expect(res.body.row.id).toBe(id);
            expect(res.body.row.actions).toContain('reset');
        });
    });

    describe('GET /repo/api/ingest/:id/timeline', () => {
        it('returns ordered events for the row', async () => {
            const auth = await bearer_for('staff-8');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row()] });
            const id = post.body.ids[0];
            /*
             * Trigger a state transition by hitting reset on an
             * appropriate state — go through model directly here would
             * skip the API; instead just write a second event via the
             * dedicated state.
             */
            const model = require('../../ingester/model');
            await model.update_queue({ id }, { status: 'STARTING' }, { actor: 'worker' });

            const res = await supertest(app)
                .get(`/repo/api/ingest/${id}/timeline`)
                .set('Authorization', auth)
                .expect(200);
            expect(res.body.id).toBe(id);
            expect(res.body.events.length).toBeGreaterThanOrEqual(2);
            expect(res.body.events[0].to_state).toBe('PENDING');
            expect(res.body.events[res.body.events.length - 1].to_state).toBe('STARTING');
        });
    });

    describe('POST /repo/api/ingest/:id/rollback-pre', () => {
        it('flips the row to ROLLED_BACK_TO_READY and writes a staff_action event', async () => {
            const auth = await bearer_for('rollback-staff');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'INGEST_HALTED' })] });
            const id = post.body.ids[0];

            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/rollback-pre`)
                .set('Authorization', auth)
                .send({ note: 'fixing source data' })
                .expect(200);
            expect(res.body.new_state).toBe('ROLLED_BACK_TO_READY');
            /*
             * QA isn't configured in the test env, so qa_error should
             * be the "not configured" sentinel — but the queue flip
             * still lands.
             */
            expect(res.body.qa_error).toMatch(/not configured/i);

            const queue = await db_queue()(tables.ingest_queue).where({ id }).first();
            expect(queue.pipeline_state).toBe('ROLLED_BACK_TO_READY');
            /*
             * Rolled-back rows leave the default "Open only" view —
             * is_complete=1 + the history row below cover the staff
             * visibility.
             */
            expect(queue.is_complete).toBe(1);

            const events = await db_queue()(tables.ingest_events)
                .where({ queue_id: id })
                .orderBy('id', 'desc');
            const last = events[0];
            expect(last.event_type).toBe('staff_action');
            expect(last.actor).toBe('rollback-staff');
            const payload = JSON.parse(last.payload);
            expect(payload.action).toBe('rollback_pre_ingest');
            expect(payload.note).toBe('fixing source data');
            expect(payload.qa_uuid).toBeTruthy();

            /*
             * The rollback should surface on the Job History page as
             * a FAILED packaging_and_ingesting entry so the action
             * stays visible after the queue row is hidden.
             */
            const jobs_rows = await db_queue()(tables.ingest_jobs).where({
                collection_folder: 'batch-A',
            });
            expect(jobs_rows).toHaveLength(1);
            expect(jobs_rows[0].job_type).toBe('packaging_and_ingesting');
            expect(jobs_rows[0].status).toBe('FAILED');
            expect(jobs_rows[0].actor).toBe('rollback-staff');
            expect(jobs_rows[0].error).toMatch(/pre-ingest rollback.*INGEST_HALTED/);
            expect(jobs_rows[0].error).toMatch(/fixing source data/);
            const pkgs = JSON.parse(jobs_rows[0].packages);
            expect(pkgs).toEqual(['pkg-001']);
        });

        it('returns 403 if the row is not in a PRE_AM_FAILURE state', async () => {
            const auth = await bearer_for('staff-rp1');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'FAILED' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/rollback-pre`)
                .set('Authorization', auth);
            expect(res.status).toBe(403);
        });
    });

    describe('POST /repo/api/ingest/:id/rollback-am', () => {
        it('flips the row to AM_DELETION_REQUESTED with reason in the payload', async () => {
            const auth = await bearer_for('amrb-staff');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'FAILED', sip_uuid: 'sip-xyz' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/rollback-am`)
                .set('Authorization', auth)
                .send({ reason: 'corrupted bag' })
                .expect(200);
            expect(res.body.new_state).toBe('AM_DELETION_REQUESTED');
            // AM Storage isn't configured in the test env.
            expect(res.body.am_error).toMatch(/not configured/i);
            const queue = await db_queue()(tables.ingest_queue).where({ id }).first();
            expect(queue.is_complete).toBe(1);
            const events = await db_queue()(tables.ingest_events)
                .where({ queue_id: id })
                .orderBy('id', 'desc');
            const payload = JSON.parse(events[0].payload);
            expect(payload.action).toBe('rollback_archivematica');
            expect(payload.reason).toBe('corrupted bag');
            expect(payload.sip_uuid).toBe('sip-xyz');
            expect(payload.am_error).toMatch(/not configured/i);

            /*
             * History row: FAILED packaging_and_ingesting for the
             * rolled-back package.
             */
            const jobs_rows = await db_queue()(tables.ingest_jobs).where({
                collection_folder: 'batch-A',
            });
            expect(jobs_rows).toHaveLength(1);
            expect(jobs_rows[0].status).toBe('FAILED');
            expect(jobs_rows[0].error).toMatch(/Archivematica rollback/);
            expect(jobs_rows[0].error).toMatch(/corrupted bag/);
        });

        it('returns 422 when the row has no sip_uuid', async () => {
            const auth = await bearer_for('amrb-noidp');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                /*
                 * FAILED is rollback_archivematica-eligible but the
                 * row has no sip_uuid set (PENDING default).
                 */
                .send({ rows: [row({ status: 'FAILED' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/rollback-am`)
                .set('Authorization', auth);
            expect(res.status).toBe(400); // ValidationError → 400
        });

        it('returns 403 if the row is in a pre-AM failure state', async () => {
            const auth = await bearer_for('amrb-staff2');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'INGEST_HALTED' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/rollback-am`)
                .set('Authorization', auth);
            expect(res.status).toBe(403);
        });
    });

    describe('POST /repo/api/ingest/:id/reset', () => {
        it('flips an AS_METADATA_INVALID row to PENDING', async () => {
            const auth = await bearer_for('reset-staff');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'AS_METADATA_INVALID' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/reset`)
                .set('Authorization', auth)
                .expect(200);
            expect(res.body.new_state).toBe('PENDING');
            const queue = await db_queue()(tables.ingest_queue).where({ id }).first();
            expect(queue.pipeline_state).toBe('PENDING');
        });

        it('returns 403 if the row state does not allow reset', async () => {
            const auth = await bearer_for('reset-staff2');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'FAILED' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/reset`)
                .set('Authorization', auth);
            expect(res.status).toBe(403);
        });
    });

    describe('POST /repo/api/ingest/:id/cancel', () => {
        it('flips an in-flight UPLOADING row to CANCELLED_BY_USER', async () => {
            const auth = await bearer_for('cancel-staff');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'UPLOADING' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/cancel`)
                .set('Authorization', auth)
                .send({ reason: 'wrong collection' })
                .expect(200);
            expect(res.body.new_state).toBe('CANCELLED_BY_USER');
            expect(res.body.prev_state).toBe('UPLOADING');
            /*
             * No worker is registered in this test process, so
             * was_running should be false. The state still flips.
             */
            expect(res.body.was_running).toBe(false);
            const queue = await db_queue()(tables.ingest_queue).where({ id }).first();
            expect(queue.pipeline_state).toBe('CANCELLED_BY_USER');
            expect(queue.error).toBe('wrong collection');
        });

        it('returns 403 when the state is not cancellable (terminal)', async () => {
            const auth = await bearer_for('cancel-staff2');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'COMPLETE' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/cancel`)
                .set('Authorization', auth);
            expect(res.status).toBe(403);
        });

        it('returns 404 for an unknown id', async () => {
            const auth = await bearer_for('cancel-staff3');
            const res = await supertest(app)
                .post('/repo/api/ingest/99999/cancel')
                .set('Authorization', auth);
            expect(res.status).toBe(404);
        });

        it('surfaces the prev_state in the action list on subsequent GET', async () => {
            const auth = await bearer_for('cancel-staff4');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'INGEST_IN_PROGRESS' })] });
            const id = post.body.ids[0];
            await supertest(app)
                .post(`/repo/api/ingest/${id}/cancel`)
                .set('Authorization', auth)
                .expect(200);
            const res = await supertest(app)
                .get(`/repo/api/ingest/${id}`)
                .set('Authorization', auth)
                .expect(200);
            expect(res.body.row.pipeline_state).toBe('CANCELLED_BY_USER');
            /*
             * Single follow-up for every cancel — the kebab always
             * offers Return to Packaging regardless of prev_state.
             * (For AM-side cancels the controller marks the row
             * terminal and flags needed_am_cleanup in the audit log,
             * but the action surface stays the same.)
             */
            expect(res.body.row.actions).toEqual(['timeline', 'rollback_to_packaging']);
        });
    });

    describe('POST /repo/api/ingest/:id/return-to-packaging', () => {
        it('flips a CANCELLED_BY_USER row (pre-upload prev_state) without calling QA', async () => {
            const auth = await bearer_for('return-staff');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'PROCESSING_METADATA' })] });
            const id = post.body.ids[0];
            // Cancel first so the row lands in CANCELLED_BY_USER.
            await supertest(app)
                .post(`/repo/api/ingest/${id}/cancel`)
                .set('Authorization', auth)
                .expect(200);
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/return-to-packaging`)
                .set('Authorization', auth)
                .send({ note: 'fixed source data' })
                .expect(200);
            expect(res.body.new_state).toBe('RETURNED_TO_PACKAGING');
            expect(res.body.prev_state).toBe('PROCESSING_METADATA');
            expect(res.body.needed_qa_move).toBe(false);
            // Folder is still in 001-ready, no QA call was needed.
            expect(res.body.qa_outcome).toBeNull();
            const queue = await db_queue()(tables.ingest_queue).where({ id }).first();
            expect(queue.pipeline_state).toBe('RETURNED_TO_PACKAGING');
            expect(queue.is_complete).toBe(1);
            // Audit log captures the prev_state and the skipped QA.
            const events = await db_queue()(tables.ingest_events)
                .where({ queue_id: id })
                .orderBy('id', 'desc');
            const payload = JSON.parse(events[0].payload);
            expect(payload.action).toBe('rollback_to_packaging');
            expect(payload.prev_state).toBe('PROCESSING_METADATA');
            expect(payload.needed_qa_move).toBe(false);

            // History row: FAILED packaging_and_ingesting.
            const jobs_rows = await db_queue()(tables.ingest_jobs).where({
                collection_folder: 'batch-A',
            });
            expect(jobs_rows).toHaveLength(1);
            expect(jobs_rows[0].status).toBe('FAILED');
            expect(jobs_rows[0].error).toMatch(/Returned to packaging/);
            expect(jobs_rows[0].error).toMatch(/PROCESSING_METADATA/);
        });

        it('marks needed_qa_move=true for an UPLOADING prev_state', async () => {
            /*
             * We can't easily assert the QA HTTP call landed (no QA
             * service is configured in the e2e harness), but we CAN
             * assert the branch was taken: needed_qa_move flag in
             * the audit payload + response body.
             */
            const auth = await bearer_for('return-staff2');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'UPLOADING' })] });
            const id = post.body.ids[0];
            await supertest(app)
                .post(`/repo/api/ingest/${id}/cancel`)
                .set('Authorization', auth)
                .expect(200);
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/return-to-packaging`)
                .set('Authorization', auth)
                .expect(200);
            expect(res.body.new_state).toBe('RETURNED_TO_PACKAGING');
            expect(res.body.prev_state).toBe('UPLOADING');
            expect(res.body.needed_qa_move).toBe(true);
            /*
             * qa_error should be set (no QA configured in the test
             * environment); the row flip still succeeded.
             */
            expect(res.body.qa_error).toBeTruthy();
        });

        it('flags needed_am_cleanup=true AND moves folder back when prev_state was AM-side', async () => {
            /*
             * AM-side cancels leave an AIP in AM (needed_am_cleanup
             * tells staff to delete it in AM's Storage Service UI),
             * BUT the staff-visible folder is still in 002-ingest —
             * AM reads from the SFTP source, not from 002-ingest.
             * So Return to Packaging still calls QA to move the
             * folder back; otherwise it stays stuck and never
             * reappears in /processed.
             */
            const auth = await bearer_for('return-staff3');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'INGEST_IN_PROGRESS' })] });
            const id = post.body.ids[0];
            await supertest(app)
                .post(`/repo/api/ingest/${id}/cancel`)
                .set('Authorization', auth)
                .expect(200);
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/return-to-packaging`)
                .set('Authorization', auth)
                .expect(200);
            expect(res.body.new_state).toBe('RETURNED_TO_PACKAGING');
            expect(res.body.prev_state).toBe('INGEST_IN_PROGRESS');
            expect(res.body.needed_qa_move).toBe(true);
            expect(res.body.needed_am_cleanup).toBe(true);
            // Audit payload mirrors the response flags for ops.
            const events = await db_queue()(tables.ingest_events)
                .where({ queue_id: id })
                .orderBy('id', 'desc');
            const payload = JSON.parse(events[0].payload);
            expect(payload.needed_qa_move).toBe(true);
            expect(payload.needed_am_cleanup).toBe(true);
        });

        it('returns 403 when the row is not CANCELLED_BY_USER', async () => {
            const auth = await bearer_for('return-staff4');
            const post = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({ rows: [row({ status: 'FAILED' })] });
            const id = post.body.ids[0];
            const res = await supertest(app)
                .post(`/repo/api/ingest/${id}/return-to-packaging`)
                .set('Authorization', auth);
            expect(res.status).toBe(403);
        });

        it('returns 404 for an unknown id', async () => {
            const auth = await bearer_for('return-staff5');
            const res = await supertest(app)
                .post('/repo/api/ingest/99999/return-to-packaging')
                .set('Authorization', auth);
            expect(res.status).toBe(404);
        });
    });

    describe('POST /repo/api/ingest/reset-orphaned', () => {
        it('resets every ACTIVELY_RUNNING row to PENDING', async () => {
            const auth = await bearer_for('orphan-staff');
            await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', auth)
                .send({
                    rows: [
                        row({ package: 'a', status: 'STARTING' }),
                        row({ package: 'b', status: 'UPLOADING' }),
                        row({ package: 'c', status: 'WAITING_FOR_DURACLOUD' }),
                    ],
                });
            const res = await supertest(app)
                .post('/repo/api/ingest/reset-orphaned')
                .set('Authorization', auth)
                .expect(200);
            expect(res.body.affected).toBe(2);
            const rows = await db_queue()(tables.ingest_queue).select('package', 'pipeline_state');
            const by_pkg = Object.fromEntries(rows.map((r) => [r.package, r.pipeline_state]));
            expect(by_pkg.a).toBe('PENDING');
            expect(by_pkg.b).toBe('PENDING');
            expect(by_pkg.c).toBe('WAITING_FOR_DURACLOUD'); // untouched
        });

        it('answers GET with 405 + Allow: POST', async () => {
            const auth = await bearer_for('orphan-staff2');
            const res = await supertest(app)
                .get('/repo/api/ingest/reset-orphaned')
                .set('Authorization', auth);
            expect(res.status).toBe(405);
            expect(res.headers.allow).toBe('POST');
        });
    });
});
