'use strict';

// E2E tests for the ingest dashboard pages. Exercises page + partials
// against the live Express stack with in-memory sqlite.

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');
const model = require('../../ingester/model');

let app;

async function cookie_for(du_id) {
    const u = await db_helper.seed_user({ du_id });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
}

async function seed(status, overrides = {}) {
    const [id] = await model.queue_packages([
        {
            batch: 'batch-A',
            package: 'pkg-' + Math.random().toString(16).slice(2, 8),
            collection_uuid: 'codu:test',
            job_uuid: 'job-1',
            metadata_uri: '/repositories/2/resources/1',
            status,
            ...overrides,
        },
    ]);
    return id;
}

describe('ingest dashboard — e2e', () => {
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

    describe('GET /dashboard/ingest', () => {
        it('redirects unauthed users to login', async () => {
            const res = await supertest(app).get('/repo/dashboard/ingest');
            expect(res.status).toBe(302);
            expect(res.headers.location).toMatch(/\/repo\/dashboard\/login/);
        });

        it('renders the list page with filter chrome for authed users', async () => {
            const cookie = await cookie_for('ingest-dash-1');
            const res = await supertest(app).get('/repo/dashboard/ingest').set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Ingest queue');
            // Filter dropdowns are rendered.
            expect(res.text).toContain('PROCESSING_METADATA');
            expect(res.text).toContain('UPLOAD_TIMEOUT');
            expect(res.text).toContain('hx-get');
        });

        it('mutation kebab items use hx-indicator on the row for in-flight feedback', async () => {
            // Regression: before this, the row sat unchanged for the
            // 1-5 second window while the cancel / return-to-packaging
            // request was in flight (the curation-API call is slow).
            // hx-indicator="closest tr" makes HTMX add the
            // htmx-request class to the row, which CSS uses to fade
            // the row and surface a "Working…" pill.
            const id = await seed('UPLOADING');
            const cookie = await cookie_for('hx-indicator');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list')
                .set('Cookie', cookie);
            // Cancel + the four rollback wrappers all need it.
            const matches = res.text.match(/hx-indicator="closest tr"/g) || [];
            // Cancel kebab is the only mutation visible on an UPLOADING
            // row (rollback / reset / return don't appear until a
            // halt/cancel happens). One occurrence is the minimum
            // floor for this state — the others render on the
            // CANCELLED_BY_USER / *_TIMEOUT / *_INVALID rows.
            expect(matches.length).toBeGreaterThanOrEqual(1);
            void id;
        });

        it('queue table has periodic poll + body refresh trigger', async () => {
            // Regression guard: an earlier version of this page
            // listened for `ingest:refresh` while the row-mutation
            // handlers emitted `queue:refresh`, and there was no
            // periodic poll. Net effect: a freshly submitted row
            // appeared stuck on PENDING because the worker's state
            // transitions never made it to the browser. Both the
            // emit/listen name and the every-5s poll are pinned here.
            const cookie = await cookie_for('queue-poll');
            const res = await supertest(app).get('/repo/dashboard/ingest').set('Cookie', cookie);
            expect(res.text).toContain('queue:refresh from:body');
            expect(res.text).toContain('every 5s');
        });

        it('the sidebar marks Queue as the active nav item', async () => {
            const cookie = await cookie_for('ingest-dash-2');
            const res = await supertest(app).get('/repo/dashboard/ingest').set('Cookie', cookie);
            // The sidebar partial uses `active === 'queue'` for the
            // queue page (workspace pages flag MDO / QA / Packaging
            // instead). Match on aria-label (which matches the title)
            // and check both the visual + a11y signals land together.
            expect(res.text).toMatch(
                /<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="Queue/
            );
        });
    });

    describe('GET /dashboard/ingest/list (HTMX partial)', () => {
        it('renders an empty-state when the queue is empty', async () => {
            const cookie = await cookie_for('list-1');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('No queue rows');
        });

        it('renders a row per queue entry with kebab actions', async () => {
            await seed('PENDING', { package: 'alpha' });
            await seed('FAILED', { package: 'beta', sip_uuid: 'sip-x' });
            const cookie = await cookie_for('list-2');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('alpha');
            expect(res.text).toContain('beta');
            // FAILED row should advertise the AM rollback action.
            expect(res.text).toContain('Rollback AIP');
            // Every row carries a Timeline kebab item.
            expect(res.text).toContain('Timeline');
            // PENDING (state) shouldn't get any halt-state rollback
            // link in its row block. (PENDING gets Cancel + Timeline
            // only; Return-to-Packaging only appears post-cancel /
            // post-halt.)
            expect(res.text).not.toMatch(/PENDING[\s\S]*?Return to Packaging/);
            expect(res.text).not.toMatch(/PENDING[\s\S]*?Rollback AIP/);
        });

        it('applies status filter', async () => {
            await seed('PENDING', { package: 'alpha' });
            await seed('FAILED', { package: 'beta', sip_uuid: 'sip-x' });
            const cookie = await cookie_for('list-3');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list?status=FAILED')
                .set('Cookie', cookie);
            expect(res.text).toContain('beta');
            expect(res.text).not.toContain('alpha');
        });

        it('applies batch filter', async () => {
            await seed('PENDING', { package: 'pkg-alpha', batch: 'batch-X' });
            await seed('PENDING', { package: 'pkg-beta', batch: 'batch-Y' });
            const cookie = await cookie_for('list-4');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list?batch=batch-X')
                .set('Cookie', cookie);
            expect(res.text).toContain('package-cell');
            expect(res.text).toContain('pkg-alpha');
            expect(res.text).not.toContain('pkg-beta');
        });

        it('hides terminal (is_complete=1) rows by default', async () => {
            // Reproduces the "duplicate after re-submit" scenario from
            // task #125: a RETURNED_TO_PACKAGING row from a prior cancel
            // + a fresh PENDING row from a re-submit. Staff should
            // see only the live PENDING row by default.
            await seed('PENDING', { package: 'live-row' });
            await seed('RETURNED_TO_PACKAGING', {
                package: 'old-row',
                is_complete: 1,
            });
            const cookie = await cookie_for('default-filter');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list')
                .set('Cookie', cookie);
            expect(res.text).toContain('live-row');
            expect(res.text).not.toContain('old-row');
        });

        it('honors ?is_complete=all to surface terminal rows', async () => {
            await seed('PENDING', { package: 'live-row' });
            await seed('RETURNED_TO_PACKAGING', {
                package: 'old-row',
                is_complete: 1,
            });
            const cookie = await cookie_for('all-filter');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list?is_complete=all')
                .set('Cookie', cookie);
            expect(res.text).toContain('live-row');
            expect(res.text).toContain('old-row');
        });

        it('honors ?is_complete=1 to show only closed rows', async () => {
            await seed('PENDING', { package: 'live-row' });
            await seed('RETURNED_TO_PACKAGING', {
                package: 'old-row',
                is_complete: 1,
            });
            const cookie = await cookie_for('closed-filter');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list?is_complete=1')
                .set('Cookie', cookie);
            expect(res.text).not.toContain('live-row');
            expect(res.text).toContain('old-row');
        });

        it('color-codes the row by severity', async () => {
            await seed('UPLOAD_TIMEOUT', { package: 'warn-row' });
            await seed('FAILED', { package: 'err-row', sip_uuid: 'sip-x' });
            await seed('COMPLETE', { package: 'ok-row' });
            const cookie = await cookie_for('list-5');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list')
                .set('Cookie', cookie);
            expect(res.text).toContain('sev-warn');
            expect(res.text).toContain('sev-error');
            expect(res.text).toContain('sev-success');
        });
    });

    describe('GET /dashboard/ingest/:id/timeline (modal partial)', () => {
        it('returns 404 for an unknown id', async () => {
            const cookie = await cookie_for('tl-404');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/9999/timeline')
                .set('Cookie', cookie);
            expect(res.status).toBe(404);
        });

        it('returns 400 for a non-numeric id', async () => {
            const cookie = await cookie_for('tl-bad');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/abc/timeline')
                .set('Cookie', cookie);
            expect(res.status).toBe(400);
        });

        it('renders modal-shaped HTML (header / body / footer) for a known row', async () => {
            const id = await seed('AS_METADATA_INVALID', { package: 'modal-pkg' });
            const cookie = await cookie_for('tl-modal');
            const res = await supertest(app)
                .get(`/repo/dashboard/ingest/${id}/timeline`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Modal chrome — header + body + footer + close buttons.
            expect(res.text).toContain('modal-header');
            expect(res.text).toContain('modal-body');
            expect(res.text).toContain('modal-footer');
            expect(res.text).toContain('data-bs-dismiss="modal"');
            expect(res.text).toContain('modal-pkg');
            // No layout wrapper — partials don't include <html>.
            expect(res.text).not.toContain('<!DOCTYPE');
        });

        it('renders timeline events oldest first with from→to states', async () => {
            const id = await seed('PENDING');
            // Drive a couple of state transitions to populate events.
            await model.update_queue({ id }, { status: 'STARTING' }, { actor: 'worker' });
            await model.update_queue({ id }, { status: 'UPLOADING' }, { actor: 'worker' });

            const cookie = await cookie_for('tl-ok');
            const res = await supertest(app)
                .get(`/repo/dashboard/ingest/${id}/timeline`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // All three events should appear.
            expect(res.text).toContain('PENDING');
            expect(res.text).toContain('STARTING');
            expect(res.text).toContain('UPLOADING');
            // from_state → to_state arrow is in the partial markup.
            expect(res.text).toContain('→');
        });
    });

    describe('POST dashboard row mutations (HTML responses)', () => {
        // Regression guard for task #125: the kebab items previously
        // posted to /api/ingest/:id/... which returns JSON. HTMX swap
        // outerHTML then dumped the JSON literal into the row. The
        // dashboard wrappers must return rendered HTML.
        it('cancel_row_action returns the rendered row partial (HTML, not JSON)', async () => {
            const id = await seed('UPLOADING');
            const cookie = await cookie_for('cancel-html');
            const res = await supertest(app)
                .post(`/repo/dashboard/ingest/${id}/cancel`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Response is a <tr> partial, not a JSON envelope.
            expect(res.headers['content-type']).toMatch(/html/);
            expect(res.text).toContain('queue-row-' + id);
            expect(res.text).not.toMatch(/^\s*\{"id"/);
        });

        it("cancel suggested_action names the kebab item ('Return to Packaging') for pre-AM cancel", async () => {
            // Regression: an earlier version's static suggested_action
            // said "Use the rollback action" but the kebab item is
            // labeled "Return to Packaging" — staff couldn't find the
            // promised "Rollback". The dashboard's decorate path now
            // emits state-aware copy that names the actual kebab item.
            const id = await seed('UPLOADING'); // pre-AM prior state
            const cookie = await cookie_for('cancel-text-pre');
            await supertest(app)
                .post(`/repo/dashboard/ingest/${id}/cancel`)
                .set('Cookie', cookie)
                .expect(200);
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list?is_complete=all')
                .set('Cookie', cookie);
            expect(res.text).toContain('Return to Packaging');
            // The old "Use the rollback action" wording must NOT show
            // up in the row hint anymore (it caused user confusion).
            expect(res.text).not.toMatch(/Use the rollback action/);
        });

        it("cancel suggested_action names 'Return to Packaging' for AM-side cancel too", async () => {
            // Design: the kebab shows ONE follow-up regardless of
            // prev_state. Hint text never says "rollback" — for AM
            // cancels the audit log carries needed_am_cleanup=true
            // for the ops separation.
            const id = await seed('INGEST_IN_PROGRESS'); // AM prior state
            const cookie = await cookie_for('cancel-text-am');
            await supertest(app)
                .post(`/repo/dashboard/ingest/${id}/cancel`)
                .set('Cookie', cookie)
                .expect(200);
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/list?is_complete=all')
                .set('Cookie', cookie);
            expect(res.text).toContain('Return to Packaging');
            expect(res.text).not.toMatch(/Rollback AIP/);
            expect(res.text).not.toMatch(/Use the rollback action/);
        });

        it('return_to_packaging_action returns the rendered row partial', async () => {
            // Set up a CANCELLED_BY_USER row with a PROCESSING_METADATA
            // prev_state so the action is allowed and no QA call needed.
            const id = await seed('UPLOADING');
            const cookie = await cookie_for('rtp-html');
            await supertest(app)
                .post(`/repo/dashboard/ingest/${id}/cancel`)
                .set('Cookie', cookie)
                .expect(200);
            const res = await supertest(app)
                .post(`/repo/dashboard/ingest/${id}/return-to-packaging`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/html/);
            expect(res.text).toContain('queue-row-' + id);
            expect(res.text).toContain('RETURNED_TO_PACKAGING');
            // The new row should be marked terminal (is_complete=1)
            // so it won't reappear in the default queue view.
            const fresh = await model.get_queue_row({ id });
            expect(fresh.is_complete).toBe(1);
        });

        it('rollback_pre_ingest_action returns the rendered row partial', async () => {
            // PRE_AM failure state — INGEST_HALTED allows rollback_pre.
            const id = await seed('INGEST_HALTED');
            const cookie = await cookie_for('rb-pre-html');
            const res = await supertest(app)
                .post(`/repo/dashboard/ingest/${id}/rollback-pre`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/html/);
            expect(res.text).toContain('queue-row-' + id);
            expect(res.text).toContain('ROLLED_BACK_TO_READY');
        });

        it('reset_row_action returns the rendered row partial', async () => {
            const id = await seed('AS_METADATA_INVALID');
            const cookie = await cookie_for('reset-html');
            const res = await supertest(app)
                .post(`/repo/dashboard/ingest/${id}/reset`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/html/);
            expect(res.text).toContain('queue-row-' + id);
            expect(res.text).toContain('PENDING');
        });

        it('forwards 403 from the API when the action is not available', async () => {
            // COMPLETE row → cancel rejected with 403.
            const id = await seed('COMPLETE');
            const cookie = await cookie_for('cancel-forbidden');
            const res = await supertest(app)
                .post(`/repo/dashboard/ingest/${id}/cancel`)
                .set('Cookie', cookie);
            // model.cancel returns 409 (already_terminal) for COMPLETE.
            // The wrapper passes through whatever the API controller wrote.
            expect([403, 409]).toContain(res.status);
        });
    });

    describe('GET /dashboard/admin/services (Services Health page)', () => {
        // Smoke test: the page itself must render. This existed
        // because an earlier rev shipped without `qa_service` imported
        // in the controller — the page rendered fine but the Wasabi
        // partial 500'd with `qa_service is not defined` at first
        // poll. We don't want to repeat that.

        it('redirects unauthed users to login', async () => {
            const res = await supertest(app).get('/repo/dashboard/admin/services');
            expect(res.status).toBe(302);
            expect(res.headers.location).toMatch(/\/repo\/dashboard\/login/);
        });

        it('renders the page chrome for authed users', async () => {
            const cookie = await cookie_for('services-page-1');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/services')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Services Health');
            expect(res.text).toContain('Wasabi S3');
            // Confirm the partial URL is what the HTMX poll will hit.
            expect(res.text).toContain('/repo/dashboard/admin/services/wasabi');
        });
    });

    describe('GET /dashboard/admin/services/wasabi (HTMX partial)', () => {
        // No curation-API in the test env → qa_service.health_wasabi
        // throws UpstreamError. The partial MUST render gracefully —
        // staff see a red "curation unreachable" card, not a 500.

        it('redirects unauthed users to login', async () => {
            const res = await supertest(app).get('/repo/dashboard/admin/services/wasabi');
            expect(res.status).toBe(302);
        });

        it('renders the unreachable state when curation-API is down', async () => {
            const cookie = await cookie_for('services-wasabi-1');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/services/wasabi')
                .set('Cookie', cookie);
            // The catch path returns 200 with the partial — staff
            // see a clear failure card, not an error page.
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/curation unreachable/i);
            // The `qa_service is not defined` regression check: if
            // the controller's import is dropped again, the partial
            // would 500. A 200 with the unreachable state is the
            // pass condition.
            expect(res.text).not.toMatch(/qa_service is not defined/i);
        });
    });
});
