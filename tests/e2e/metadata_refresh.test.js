'use strict';

/*
 * e2e for the system-wide metadata-refresh admin surface.
 * 
 * Coverage:
 *   - GET /admin/metadata-refresh renders the page + status partial
 *   - POST .../start creates an active batch + toasts on success
 *   - POST .../start refuses a second concurrent batch
 *   - POST .../start refuses when transformer flag has changed without force=1
 *   - POST .../:uuid/cancel deletes pending rows + flips status
 *   - GET .../preview returns the eligible row count
 * 
 * We don't drive the producer here — that's covered in
 * tests/integration/metadata/producer.test.js. The admin page is a
 * pure orchestration layer over batches.create_batch /
 * batches.request_cancel.
 */

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');
const batches = require('../../metadata/batches');
const { db_queue } = require('../../config/db');
const tables = require('../../config/db_tables');

const BATCHES = tables.metadata_refresh_batches;

let app;
let original_env;

async function cookie_for(du_id) {
    const u = await db_helper.seed_user({ du_id, first_name: 'Ada' });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
}

describe('admin: metadata refresh — e2e', () => {
    beforeAll(async () => {
        app = make_app();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        original_env = { ...process.env };
    });
    afterEach(() => {
        process.env = original_env;
        require('../../config/app')._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('GET /admin/metadata-refresh renders the admin page', async () => {
        const cookie = await cookie_for('mref-page');
        const res = await supertest(app)
            .get('/repo/dashboard/admin/metadata-refresh')
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.text).toMatch(/<h1[^>]*>Metadata Refresh<\/h1>/);
        expect(res.text).toMatch(/id="metadata-refresh-status"/);
        expect(res.text).toMatch(/hx-get="\/repo\/dashboard\/admin\/metadata-refresh\/status"/);
        /*
         * The trigger MUST use the keyword `every` — dashboard.js's
         * htmx:beforeRequest hook keys off that to identify polling
         * requests it should pause while the confirm modal is open.
         * If a future refactor changes "every 2s" to something
         * exotic (e.g. a custom JS trigger or hx-trigger-poll-url),
         * the JS pause will silently stop working and the confirm-
         * mid-swap race will reappear. This assertion is the
         * tripwire.
         */
        expect(res.text).toMatch(/hx-trigger="load, every 2s"/);
    });

    it('GET /admin/metadata-refresh/status renders the no-active-batch hint when idle', async () => {
        const cookie = await cookie_for('mref-status');
        const res = await supertest(app)
            .get('/repo/dashboard/admin/metadata-refresh/status')
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.text).toMatch(/No active system refresh/);
        expect(res.text).toMatch(/Refresh all system metadata/);
    });

    it('GET .../status surfaces "Currently fetching" + in-flight URI when worker is mid-tick', async () => {
        const cookie = await cookie_for('mref-inflight');
        /*
         * Seed a running batch with one IN_PROGRESS row (simulating
         * the worker mid-fetch without actually running the worker).
         */
        const batch_uuid = await batches.create_batch();
        const a = await db_helper.seed_object({ uri: '/repositories/2/archival_objects/777' });
        const model = require('../../metadata/model');
        await model.enqueue_chunk_for_batch({
            batch_uuid,
            rows: [{ uuid: a.pid, uri: a.uri, update_type: 'system' }],
            priority: 5,
        });
        await model.claim_pending(1);
        const res = await supertest(app)
            .get('/repo/dashboard/admin/metadata-refresh/status')
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        // The "currently fetching" header.
        expect(res.text).toMatch(/Currently fetching/);
        // The actual URI being worked on.
        expect(res.text).toMatch(/\/repositories\/2\/archival_objects\/777/);
        // Spinner element (visual "yes it's alive" signal).
        expect(res.text).toMatch(/spinner-border/);
    });

    it('GET .../status surfaces "Recent activity" with a completed URI', async () => {
        const cookie = await cookie_for('mref-recent');
        const batch_uuid = await batches.create_batch();
        const a = await db_helper.seed_object({ uri: '/r/done' });
        const model = require('../../metadata/model');
        await model.enqueue_chunk_for_batch({
            batch_uuid,
            rows: [{ uuid: a.pid, uri: a.uri, update_type: 'system' }],
            priority: 5,
        });
        const [c] = await model.claim_pending(1);
        await model.mark_complete(c.id);

        const res = await supertest(app)
            .get('/repo/dashboard/admin/metadata-refresh/status')
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.text).toMatch(/Recent activity/);
        expect(res.text).toMatch(/\/r\/done/);
    });

    it('POST .../start creates a batch and toasts success', async () => {
        const cookie = await cookie_for('mref-start');
        const res = await supertest(app)
            .post('/repo/dashboard/admin/metadata-refresh/start')
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        const trigger = JSON.parse(res.headers['hx-trigger']);
        expect(trigger.toast.level).toBe('success');
        expect(trigger.toast.message).toMatch(/Started system metadata refresh/);

        const batch = await db_queue()(BATCHES).first();
        expect(batch.status).toBe('running');
        /*
         * Actor capture: cookie_for() seeds a user with du_id +
         * first_name='Ada' (default 'User' last name). The controller
         * reads req.user.du_id from the JWT; the model resolves the
         * display name via tbl_users. Regression guard for the
         * "by unknown" bug — earlier the controller looked at
         * res.locals.user (never populated) and dropped both fields.
         */
        expect(batch.actor).toBe('mref-start');
        expect(batch.actor_name).toBe('Ada User');
        // Page renders the active-batch panel now.
        expect(res.text).toMatch(/Active batch/);
        // Display name surfaces in the rendered HTML, not "unknown".
        expect(res.text).toMatch(/Ada User/);
        expect(res.text).not.toMatch(/by <strong>unknown<\/strong>/);
    });

    it('status partial renders the resume checkbox with hx-preserve so it survives polling', async () => {
        /*
         * Regression: the status partial polls every 5s. Without
         * hx-preserve, the checkbox would be wiped from the DOM on
         * each swap (a new unchecked <input> replaces the old one).
         * The fix is hx-preserve + a stable id on the checkbox so
         * htmx morphs across swaps.
         */
        const cookie = await cookie_for('mref-checkbox-preserve');
        const res = await supertest(app)
            .get('/repo/dashboard/admin/metadata-refresh/status')
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        // The checkbox carries an id AND hx-preserve="true".
        expect(res.text).toMatch(
            /id="metadata-refresh-resume"[\s\S]*?hx-preserve="true"|hx-preserve="true"[\s\S]*?id="metadata-refresh-resume"/
        );
    });

    it('POST .../start with resume=1 inherits cursor from last cancelled batch', async () => {
        const cookie = await cookie_for('mref-resume-ok');
        // Seed a cancelled prior batch with an advanced cursor.
        const cancelled_uuid = await batches.create_batch();
        await db_queue()(BATCHES)
            .where({ batch_uuid: cancelled_uuid })
            .update({ status: 'cancelled', cursor_id: 4242 });

        const res = await supertest(app)
            .post('/repo/dashboard/admin/metadata-refresh/start')
            .set('Cookie', cookie)
            .type('form')
            .send({ resume: '1' });
        expect(res.status).toBe(200);
        const trigger = JSON.parse(res.headers['hx-trigger']);
        expect(trigger.toast.level).toBe('success');
        expect(trigger.toast.message).toMatch(/resuming from cancelled batch/);
        expect(trigger.toast.message).toMatch(/cursor 4242/);

        // The new batch's cursor inherited from the cancelled one.
        const new_batch = await db_queue()(BATCHES)
            .where({ status: 'running' })
            .first();
        expect(new_batch.cursor_id).toBe(4242);
        expect(new_batch.batch_uuid).not.toBe(cancelled_uuid);
    });

    it('POST .../start with resume=1 but no cancelled batch falls through to fresh run with a warn toast', async () => {
        const cookie = await cookie_for('mref-resume-empty');
        // No prior batches at all.
        const res = await supertest(app)
            .post('/repo/dashboard/admin/metadata-refresh/start')
            .set('Cookie', cookie)
            .type('form')
            .send({ resume: '1' });
        expect(res.status).toBe(200);
        const trigger = JSON.parse(res.headers['hx-trigger']);
        expect(trigger.toast.level).toBe('warn');
        expect(trigger.toast.message).toMatch(
            /Resume requested but no prior cancelled batch/
        );

        // New batch is a fresh run (cursor_id=null).
        const new_batch = await db_queue()(BATCHES).first();
        expect(new_batch.cursor_id).toBeNull();
    });

    it('POST .../start without resume defaults to a fresh-run cursor', async () => {
        /*
         * Regression guard: prior tests don't accidentally rely on
         * resume being on by default. Even with a cancelled batch
         * sitting in the DB, an unchecked-resume start produces a
         * fresh-cursor batch.
         */
        const cookie = await cookie_for('mref-no-resume');
        const cancelled_uuid = await batches.create_batch();
        await db_queue()(BATCHES)
            .where({ batch_uuid: cancelled_uuid })
            .update({ status: 'cancelled', cursor_id: 999 });

        const res = await supertest(app)
            .post('/repo/dashboard/admin/metadata-refresh/start')
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        const new_batch = await db_queue()(BATCHES)
            .where({ status: 'running' })
            .first();
        expect(new_batch.cursor_id).toBeNull();
    });

    it('POST .../start refuses a second batch while one is running (toast error)', async () => {
        const cookie = await cookie_for('mref-second');
        await batches.create_batch();
        const res = await supertest(app)
            .post('/repo/dashboard/admin/metadata-refresh/start')
            .set('Cookie', cookie);
        /*
         * Still 200 — handler caught ValidationError and rendered the
         * status partial with an error toast.
         */
        expect(res.status).toBe(200);
        const trigger = JSON.parse(res.headers['hx-trigger']);
        expect(trigger.toast.level).toBe('error');
        expect(trigger.toast.message).toMatch(/already running/);
    });

    it('POST .../start refuses when transformer flag changed without force=1', async () => {
        const cookie = await cookie_for('mref-flag');
        // Seed a completed batch under flag '0'.
        const old_uuid = await batches.create_batch();
        await db_queue()(BATCHES)
            .where({ batch_uuid: old_uuid })
            .update({ status: 'completed', transformer_flag: '0' });
        // Now flip the live flag to '1'.
        process.env.ASPACE_USE_TRANSFORMER = '1';
        require('../../config/app')._reset();
        const res = await supertest(app)
            .post('/repo/dashboard/admin/metadata-refresh/start')
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        const trigger = JSON.parse(res.headers['hx-trigger']);
        expect(trigger.toast.level).toBe('error');
        expect(trigger.toast.message).toMatch(/Transformer flag has changed/);
        // No new batch was inserted.
        const all = await db_queue()(BATCHES);
        expect(all).toHaveLength(1);
    });

    it('POST .../start accepts force=1 to bypass the flag-cutover guard', async () => {
        const cookie = await cookie_for('mref-force');
        const old_uuid = await batches.create_batch();
        await db_queue()(BATCHES)
            .where({ batch_uuid: old_uuid })
            .update({ status: 'completed', transformer_flag: '0' });
        process.env.ASPACE_USE_TRANSFORMER = '1';
        require('../../config/app')._reset();
        const res = await supertest(app)
            .post('/repo/dashboard/admin/metadata-refresh/start')
            .set('Cookie', cookie)
            .type('form')
            .send({ force: '1' });
        expect(res.status).toBe(200);
        const trigger = JSON.parse(res.headers['hx-trigger']);
        expect(trigger.toast.level).toBe('success');
        const new_batch = await db_queue()(BATCHES).where({ status: 'running' }).first();
        expect(new_batch.transformer_flag).toBe('1');
    });

    it('POST .../:uuid/cancel removes pending rows + flips status to cancelled', async () => {
        const cookie = await cookie_for('mref-cancel');
        const batch_uuid = await batches.create_batch();
        // Seed two pending queue rows for the batch.
        const a = await db_helper.seed_object({ uri: '/a' });
        const b = await db_helper.seed_object({ uri: '/b' });
        const model = require('../../metadata/model');
        await model.enqueue_chunk_for_batch({
            batch_uuid,
            rows: [
                { uuid: a.pid, uri: a.uri, update_type: 'system' },
                { uuid: b.pid, uri: b.uri, update_type: 'system' },
            ],
            priority: 5,
        });

        const res = await supertest(app)
            .post(`/repo/dashboard/admin/metadata-refresh/${batch_uuid}/cancel`)
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        const trigger = JSON.parse(res.headers['hx-trigger']);
        expect(trigger.toast.level).toBe('success');
        expect(trigger.toast.message).toMatch(/removed 2 pending rows/);

        const batch = await db_queue()(BATCHES).where({ batch_uuid }).first();
        expect(batch.status).toBe('cancelled');
        expect(batch.cancel_requested).toBe(1);
        const queue_rows = await db_queue()(tables.metadata_update_queue);
        expect(queue_rows).toHaveLength(0);
    });

    it('GET .../preview returns the count of refresh-eligible rows', async () => {
        const cookie = await cookie_for('mref-prev');
        await db_helper.seed_object({ uri: '/a' });
        await db_helper.seed_object({ uri: '/b' });
        await db_helper.seed_object({ uri: '', is_active: 1 }); // no URI
        await db_helper.seed_object({ uri: '/inactive', is_active: 0 }); // inactive
        const res = await supertest(app)
            .get('/repo/dashboard/admin/metadata-refresh/preview')
            .set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(2);
    });

    it('GETs require auth (no cookie → 401/redirect)', async () => {
        const res = await supertest(app).get('/repo/dashboard/admin/metadata-refresh');
        /*
         * The shared require_dashboard_auth redirects unauthenticated
         * requests to /login (302).
         */
        expect([302, 401]).toContain(res.status);
    });
});
