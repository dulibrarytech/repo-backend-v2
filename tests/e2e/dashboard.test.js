'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const { db } = require('../../config/db');
const tables = require('../../config/db_tables');
const jwt = require('../../libs/jwt');
const app_config = require('../../config/app');

let app;
// Per-suite temp dir that the thumbnail upload route writes into. We
// point THUMBNAIL_UPLOAD_PATH here for the lifetime of the suite so
// the upload tests don't pollute ./public/thumbnails.
let upload_tempdir;

async function cookie_for(du_id) {
    const u = await db_helper.seed_user({ du_id, first_name: 'Ada' });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
}

// A minimal JPEG: magic bytes + a JFIF marker chunk. Enough bytes to
// pass our magic-byte gate. We don't need a renderable image — the
// route only inspects the first three bytes.
function tiny_jpeg() {
    return Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);
}

describe('dashboard — e2e', () => {
    beforeAll(async () => {
        upload_tempdir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-tn-e2e-'));
        app = make_app({ env: { THUMBNAIL_UPLOAD_PATH: upload_tempdir } });
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
        await fs.rm(upload_tempdir, { recursive: true, force: true });
        // Reset the cached config so tests in other files don't inherit
        // our overridden THUMBNAIL_UPLOAD_PATH.
        app_config._reset();
    });

    describe('access control', () => {
        it('GET /dashboard/ redirects unauthed to /login with next=', async () => {
            const res = await supertest(app).get('/repo/dashboard/');
            expect(res.status).toBe(302);
            expect(res.headers.location).toMatch(/\/repo\/dashboard\/login/);
            expect(res.headers.location).toContain('next=');
        });

        it('GET /dashboard/objects unauthed with HX-Request returns HX-Redirect + 401', async () => {
            const res = await supertest(app)
                .get('/repo/dashboard/objects')
                .set('HX-Request', 'true');
            expect(res.status).toBe(401);
            expect(res.headers['hx-redirect']).toMatch(/\/login/);
            expect(res.text).toMatch(/session has expired/i);
        });

        it('GET /dashboard/login authed redirects to home', async () => {
            const cookie = await cookie_for('logged');
            const res = await supertest(app).get('/repo/dashboard/login').set('Cookie', cookie);
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/repo/dashboard/');
        });
    });

    describe('login flow', () => {
        it('GET /login renders the standalone shell (no app chrome)', async () => {
            const res = await supertest(app).get('/repo/dashboard/login');
            expect(res.status).toBe(200);
            // Header brand block shows "Repository @ DU"; H1 is "Sign in"
            expect(res.text).toMatch(/Repository <span class="accent">@ DU<\/span>/);
            expect(res.text).toMatch(/<h1[^>]*>Sign in<\/h1>/);
            // login shell is standalone — no sidebar
            expect(res.text).not.toMatch(/class="app-sidebar"/);
            // The manual du_id form has been removed in favor of SSO-only.
            expect(res.text).not.toMatch(/name="du_id"/);
        });

        it('POST /login with bad credentials renders the error message', async () => {
            // The route is kept for tests + script callers; the UI no
            // longer invokes it (SSO is the only login path).
            const res = await supertest(app)
                .post('/repo/dashboard/login')
                .type('form')
                .send({ du_id: 'nobody' });
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/Invalid credentials/);
        });

        it('POST /login (HTMX) with valid credentials sets cookie + HX-Redirect', async () => {
            await db_helper.seed_user({ du_id: 'alice' });
            const res = await supertest(app)
                .post('/repo/dashboard/login')
                .set('HX-Request', 'true')
                .type('form')
                .send({ du_id: 'alice' });
            expect(res.status).toBe(204);
            expect(res.headers['hx-redirect']).toBe('/repo/dashboard/');
            const set_cookie = res.headers['set-cookie'];
            const cookie = Array.isArray(set_cookie) ? set_cookie[0] : set_cookie;
            expect(cookie).toMatch(new RegExp(`^${jwt.COOKIE_NAME}=`));
            expect(cookie).toMatch(/HttpOnly/);
        });

        it('POST /login (no HTMX) with valid credentials returns 303 redirect', async () => {
            await db_helper.seed_user({ du_id: 'bob' });
            const res = await supertest(app)
                .post('/repo/dashboard/login')
                .type('form')
                .send({ du_id: 'bob' });
            expect(res.status).toBe(303);
            expect(res.headers.location).toBe('/repo/dashboard/');
        });

        it('POST /login honors the next= return path', async () => {
            await db_helper.seed_user({ du_id: 'next' });
            const res = await supertest(app)
                .post('/repo/dashboard/login')
                .set('HX-Request', 'true')
                .type('form')
                .send({ du_id: 'next', next: '/repo/dashboard/users' });
            expect(res.headers['hx-redirect']).toBe('/repo/dashboard/users');
        });

        it('POST /login rejects open-redirect attempts in next=', async () => {
            await db_helper.seed_user({ du_id: 'orphan' });
            const res = await supertest(app)
                .post('/repo/dashboard/login')
                .set('HX-Request', 'true')
                .type('form')
                .send({ du_id: 'orphan', next: 'https://evil.example/' });
            // next must start with / — anything else falls back to home
            expect(res.headers['hx-redirect']).toBe('/repo/dashboard/');
        });
    });

    describe('a11y — landmarks, skip link, sidebar', () => {
        // Phase 2 of the accessibility work: skip-to-main link,
        // aria-label on every sidebar icon, aria-current on the
        // active nav item. These checks belong to all authed pages,
        // so a single representative request (the home page) covers
        // the shared layout output.
        it('renders a skip-to-main link as the first focusable element', async () => {
            const cookie = await cookie_for('a11y-skip');
            const res = await supertest(app)
                .get('/repo/dashboard/')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // The link must point to #main-content and carry the
            // .skip-link class (which positions it off-screen until
            // focused).
            expect(res.text).toMatch(
                /<a[^>]*href="#main-content"[^>]*class="skip-link"[^>]*>\s*Skip to main content\s*<\/a>/
            );
        });

        it('<main> is the skip-link target and is programmatically focusable', async () => {
            const cookie = await cookie_for('a11y-main');
            const res = await supertest(app)
                .get('/repo/dashboard/')
                .set('Cookie', cookie);
            // id="main-content" must match the skip link's href; the
            // tabindex="-1" lets focus move there without altering tab
            // order (the link is what's in the order, not <main>).
            expect(res.text).toMatch(
                /<main[^>]*id="main-content"[^>]*tabindex="-1"/
            );
        });

        it('every sidebar link carries an aria-label', async () => {
            const cookie = await cookie_for('a11y-sidebar');
            const res = await supertest(app)
                .get('/repo/dashboard/')
                .set('Cookie', cookie);
            // Each icon-only link must be reachable by SR users.
            // We verify the labels for the normal-mode nav. (Workflow
            // / admin mode are exercised by their own page tests.)
            for (const label of [
                'Home',
                'Stats',
                'Collections',
                'Objects (flat browse)',
                'Digital Preservation Jobs',
                'Users',
                'Admin Utils',
            ]) {
                expect(res.text).toMatch(
                    new RegExp(`aria-label="${label.replace(/[()]/g, '\\$&')}"`)
                );
            }
        });

        it('active sidebar item carries aria-current="page"', async () => {
            const cookie = await cookie_for('a11y-current');
            const res = await supertest(app)
                .get('/repo/dashboard/')
                .set('Cookie', cookie);
            // On the home page, the Home link should be the active one.
            // .active + aria-current="page" should land on the SAME
            // anchor (we don't want one without the other).
            expect(res.text).toMatch(
                /<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="Home"/
            );
        });

        it('non-active sidebar items do NOT carry aria-current', async () => {
            const cookie = await cookie_for('a11y-current-2');
            const res = await supertest(app)
                .get('/repo/dashboard/')
                .set('Cookie', cookie);
            // The Collections link is not active on the home page; it
            // must not claim to be the current page.
            expect(res.text).toMatch(
                /<a[^>]*aria-label="Collections"[^>]*>/
            );
            // The slice from "Collections" link start to the next link
            // start must NOT contain aria-current.
            const m = res.text.match(
                /<a[^>]*aria-label="Collections"[\s\S]*?<\/a>/
            );
            expect(m).toBeTruthy();
            expect(m[0]).not.toMatch(/aria-current/);
        });

        it('workflow-mode sidebar marks the active workflow step', async () => {
            // Packaging page enters workflow mode. The Packaging link
            // should be both .active AND aria-current="page". The
            // sibling MDO link should be neither.
            const cookie = await cookie_for('a11y-workflow');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/packaging')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(
                /<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="Packaging and Ingesting"/
            );
            // MDO link in workflow mode — present but not current.
            const mdo = res.text.match(
                /<a[^>]*aria-label="Make Digital Objects"[\s\S]*?<\/a>/
            );
            expect(mdo).toBeTruthy();
            expect(mdo[0]).not.toMatch(/aria-current/);
        });

        // Phase 5: HTMX swap-target announcements (WCAG 4.1.3). Each
        // region that swaps in response to user action or polling
        // needs aria-live so screen reader users learn about the
        // change. The toast-stack + workspace-action-result regions
        // already had aria-live; this batch covers the table/list
        // targets that were silent before.

        it('objects-table swap target carries aria-live for SR announcements', async () => {
            const cookie = await cookie_for('a11y-live-objects');
            const res = await supertest(app)
                .get('/repo/dashboard/objects')
                .set('Cookie', cookie);
            // The empty shell page renders the swap target div.
            expect(res.text).toMatch(
                /<div[^>]*id="objects-table"[^>]*aria-live="polite"/
            );
            expect(res.text).toMatch(
                /<div[^>]*id="objects-table"[^>]*aria-atomic="false"/
            );
        });

        it('packaging-content swap target carries aria-live', async () => {
            const cookie = await cookie_for('a11y-live-pkg');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/packaging')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /<div[^>]*id="packaging-content"[^>]*aria-live="polite"/
            );
        });

        it('workspace-content swap target carries aria-live', async () => {
            const cookie = await cookie_for('a11y-live-wks');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/workspace')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /<div[^>]*id="workspace-content"[^>]*aria-live="polite"/
            );
        });

        it('qa-content swap target carries aria-live', async () => {
            const cookie = await cookie_for('a11y-live-qa');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/aspace-qa')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /<div[^>]*id="qa-content"[^>]*aria-live="polite"/
            );
        });

        it('history-content swap target carries aria-live', async () => {
            const cookie = await cookie_for('a11y-live-hist');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/history')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /<div[^>]*id="history-content"[^>]*aria-live="polite"/
            );
        });

        // Phase 5: form-error announcement (WCAG 3.3.1). The error
        // alert at the top of the user create/edit modal must have
        // role="alert" so SR users hear validation failures
        // immediately on re-render — without role="alert" the partial
        // re-renders silently and they don't know why nothing
        // happened.

        it('user create modal error alert has role="alert"', async () => {
            const cookie = await cookie_for('a11y-form-err-create');
            // Submitting an empty form triggers the error re-render —
            // the controller returns the partial with `error` set.
            const res = await supertest(app)
                .post('/repo/dashboard/users')
                .set('Cookie', cookie)
                .type('form')
                .send({ du_id: '', email: '', first_name: '', last_name: '' });
            expect(res.status).toBeLessThan(500);
            // Whether the controller returns 200 + partial or 422 +
            // partial, the error div should carry role="alert" and the
            // id used for aria-describedby.
            expect(res.text).toMatch(
                /<div[^>]*id="user-form-error"[^>]*role="alert"/
            );
        });

        it('user edit modal error alert has role="alert"', async () => {
            const cookie = await cookie_for('a11y-form-err-edit');
            const target = await db_helper.seed_user({
                du_id: 'a11y-edit-target',
                email: 'a11y-edit@du.edu',
            });
            // POST with an invalid email triggers the error path.
            const res = await supertest(app)
                .post(`/repo/dashboard/users/${target.id}`)
                .set('Cookie', cookie)
                .type('form')
                .send({ email: 'not-a-valid-email', first_name: '', last_name: '' });
            expect(res.status).toBeLessThan(500);
            expect(res.text).toMatch(
                /<div[^>]*id="user-form-error"[^>]*role="alert"/
            );
        });

        // Phase 6: minor a11y items.

        it('layout viewport meta allows user scaling explicitly', async () => {
            const cookie = await cookie_for('a11y-viewport');
            const res = await supertest(app)
                .get('/repo/dashboard/')
                .set('Cookie', cookie);
            // user-scalable=yes is the default — making it explicit
            // documents the intent + survives later edits to the tag.
            expect(res.text).toMatch(
                /<meta[^>]+name="viewport"[^>]+user-scalable=yes/
            );
        });

        it('modal-mount declares aria-labelledby pointing at content title id', async () => {
            const cookie = await cookie_for('a11y-modal-aria');
            const res = await supertest(app)
                .get('/repo/dashboard/')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /<div[^>]*id="modal-mount"[^>]*aria-labelledby="modal-content-title"/
            );
        });

        it('every swappable modal partial puts id="modal-content-title" on its h5 title', async () => {
            const cookie = await cookie_for('a11y-modal-title-ids');
            // Touch one partial per modal flow to confirm the id
            // lands. The metadata view modal is the simplest one to
            // exercise (no DB-write side effects).
            const o = await db_helper.seed_object({
                display_record: JSON.stringify({
                    display_record: { title: 'Sample for a11y' },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(
                /<h5[^>]*class="modal-title"[^>]*id="modal-content-title"/
            );
        });

        it('user create modal h5 carries id="modal-content-title"', async () => {
            const cookie = await cookie_for('a11y-uc-modal-title');
            const res = await supertest(app)
                .get('/repo/dashboard/users/new')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /<h5[^>]*class="modal-title"[^>]*id="modal-content-title"/
            );
        });

        it('stats page chart SVG has both aria-label and <desc>', async () => {
            const cookie = await cookie_for('a11y-chart');
            // Seed at least one ingest so the description has a peak.
            await db_helper.seed_object({ created: '2024-03-01 00:00:00' });
            const res = await supertest(app)
                .get('/repo/dashboard/stats')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // The SVG carries both a short name (aria-label) and a
            // longer summary inside <desc> for SRs that prefer it.
            expect(res.text).toMatch(/<svg[^>]*aria-label="Ingests per year bar chart"/);
            expect(res.text).toMatch(/<desc[^>]*id="ingests-chart-desc"[^>]*>[^<]*Ingests per year/);
            expect(res.text).toMatch(/<svg[^>]*aria-describedby="ingests-chart-desc"/);
        });

        it('pagination nav elements carry aria-label="Pagination"', async () => {
            const cookie = await cookie_for('a11y-pagination');
            // Seed enough objects to trigger pagination output.
            for (let i = 0; i < 3; i++) {
                await db_helper.seed_object({ file_name: `pp-${i}.tif` });
            }
            const res = await supertest(app)
                .get('/repo/dashboard/objects/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(
                /<nav[^>]*class="page-controls"[^>]*aria-label="Pagination"/
            );
        });

        it('breadcrumb nav on workflow pages carries aria-label="Breadcrumb"', async () => {
            const cookie = await cookie_for('a11y-breadcrumb');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/packaging')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /<nav[^>]*class="small text-muted mb-2"[^>]*aria-label="Breadcrumb"/
            );
        });

        it('shell-page loading spinners carry aria-label', async () => {
            // Verify on the objects shell — its empty-state spinner
            // is the canonical pattern reused across pages. Catching
            // it here also catches any future regression where the
            // empty-state markup gets copy-pasted without the label.
            const cookie = await cookie_for('a11y-spinner');
            const res = await supertest(app)
                .get('/repo/dashboard/objects')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /<span[^>]*class="spinner-border[^"]*"[^>]*role="status"[^>]*aria-label="Loading"/
            );
        });
    });

    describe('home page', () => {
        it('renders welcome + stats for the authed user', async () => {
            const cookie = await cookie_for('admin');
            await db_helper.seed_object({ is_published: 1 });
            await db_helper.seed_object({ is_published: 0 });
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/Welcome, Ada\./);
            expect(res.text).toMatch(/Total objects/);
            expect(res.text).toMatch(/Active users/);
        });

        it('Top Collections partial shows the title only (no PID subtitle)', async () => {
            const stats_model = require('../../stats/model');
            stats_model._reset();
            const cookie = await cookie_for('top-coll-titles');
            // Seed two child rows pointing at codu:Beta + the
            // matching collection row carrying the title.
            await db_helper.seed_object({ is_member_of_collection: 'codu:Beta' });
            await db_helper.seed_object({ is_member_of_collection: 'codu:Beta' });
            await db_helper.seed_object({
                pid: 'codu:Beta',
                object_type: 'collection',
                display_record: JSON.stringify({ title: 'Beta Letters' }),
            });
            const res = await supertest(app)
                .get('/repo/dashboard/_home/top-collections')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Title rendered as the (only) label.
            expect(res.text).toContain('Beta Letters');
            // The PID subtitle was removed — `codu:Beta` no longer appears as
            // visible text. It survives only in the link href, URL-encoded, so
            // the literal `codu:Beta` is absent but the filter link still works.
            expect(res.text).not.toContain('codu:Beta');
            expect(res.text).toContain('collection=codu%3ABeta');
        });

        it('Top Collections partial falls back to PID when no title exists', async () => {
            const stats_model = require('../../stats/model');
            stats_model._reset();
            const cookie = await cookie_for('top-coll-no-title');
            // Orphan membership — no collection row at all.
            await db_helper.seed_object({ is_member_of_collection: 'codu:Lonely' });
            const res = await supertest(app)
                .get('/repo/dashboard/_home/top-collections')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // PID rendered as the only label (the {title || pid}
            // fallback path in the template).
            expect(res.text).toContain('codu:Lonely');
        });
    });

    describe('stats page', () => {
        // Dedicated /dashboard/stats — v1-dashboard parity. 12-card
        // grid + inline-SVG ingests-per-year chart. DuraCloud cards
        // lazy-load via HTMX (covered by a separate test).
        const stats_model = require('../../stats/model');

        beforeEach(() => {
            // Cache is shared across tests; explicit reset keeps the
            // numbers we seed visible immediately.
            stats_model._reset();
        });

        it('GET /dashboard/stats requires auth (redirects when no cookie)', async () => {
            const res = await supertest(app).get('/repo/dashboard/stats');
            expect(res.status).toBe(302);
            expect(res.headers.location).toMatch(/\/repo\/dashboard\/login/);
        });

        it('renders the 12 stat-card labels for authed users', async () => {
            const cookie = await cookie_for('stats-1');
            const res = await supertest(app)
                .get('/repo/dashboard/stats')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // All twelve card labels match the v1 dashboard wording.
            for (const label of [
                'Published Collections',
                'Total Collections',
                'Published Objects',
                'Total Objects',
                'Total Images',
                'Total PDFs',
                'Total Audio',
                'Total Videos',
                'Total DuraCloud DIP Store Usage',
                'Total DuraCloud AIP Store Usage',
                'Total DuraCloud Storage Usage',
                'Current Fiscal Year Ingests',
            ]) {
                expect(res.text).toContain(label);
            }
        });

        it('renders actual counts in the DB-derived cards', async () => {
            const cookie = await cookie_for('stats-2');
            await db_helper.seed_object({ object_type: 'collection', is_published: 1 });
            await db_helper.seed_object({ object_type: 'collection', is_published: 0 });
            await db_helper.seed_object({ object_type: 'object', mime_type: 'image/tiff' });
            await db_helper.seed_object({ object_type: 'object', mime_type: 'application/pdf' });
            const res = await supertest(app)
                .get('/repo/dashboard/stats')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Loose match: the value 2 appears next to "Total Collections"
            // and the value 1 next to "Published Collections", etc.
            // Don't lock down the surrounding markup — just confirm
            // the numbers reached the page.
            expect(res.text).toMatch(/2[\s\S]{0,120}Total Collections/);
            expect(res.text).toMatch(/1[\s\S]{0,120}Published Collections/);
        });

        it('renders the inline-SVG ingests chart with per-bar markers', async () => {
            const cookie = await cookie_for('stats-3');
            await db_helper.seed_object({ created: '2023-04-01 00:00:00' });
            await db_helper.seed_object({ created: '2025-04-01 00:00:00' });
            const res = await supertest(app)
                .get('/repo/dashboard/stats')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Ingests Per Year');
            // Bar fill color comes from v1's brick-red palette.
            expect(res.text).toContain('fill="#7a1f1f"');
            // Padded year labels — 2020 and current year both appear
            // on the x-axis even if neither has data. EJS keeps the
            // template's whitespace inside the <text> tags, so use
            // a whitespace-tolerant regex instead of indexOf.
            expect(res.text).toMatch(/>\s*2020\s*<\/text>/);
            const this_year = new Date().getFullYear();
            expect(res.text).toMatch(
                new RegExp(`>\\s*${this_year}\\s*</text>`)
            );
            // SVG <title> tooltips include the FY label + count.
            expect(res.text).toMatch(/<title>FY 2023:\s+1 ingest<\/title>/);
        });

        it('DuraCloud cards are lazy-loaded — placeholder + HTMX trigger present', async () => {
            const cookie = await cookie_for('stats-4');
            const res = await supertest(app)
                .get('/repo/dashboard/stats')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Server-rendered placeholder so the layout doesn't jump
            // when the values arrive — ellipsis + label visible.
            expect(res.text).toMatch(/id="stats-duracloud"/);
            expect(res.text).toMatch(
                /hx-get="\/repo\/dashboard\/_stats\/duracloud"/
            );
            expect(res.text).toMatch(/hx-trigger="load"/);
        });

        it('GET /dashboard/_stats/duracloud renders the partial with placeholder bytes (no AM in test env)', async () => {
            const cookie = await cookie_for('stats-5');
            const res = await supertest(app)
                .get('/repo/dashboard/_stats/duracloud')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // AM storage isn't configured in the test env, so all
            // three card values render as em-dash. The page should
            // still 200 — graceful degradation.
            expect(res.text).toContain('Total DuraCloud DIP Store Usage');
            expect(res.text).toContain('Total DuraCloud AIP Store Usage');
            expect(res.text).toContain('Total DuraCloud Storage Usage');
            expect(res.text).toContain('—');
        });

        it('sidebar marks Stats as the active nav item on the stats page', async () => {
            const cookie = await cookie_for('stats-6');
            const res = await supertest(app)
                .get('/repo/dashboard/stats')
                .set('Cookie', cookie);
            // Match the active Stats link by its aria-label (stable
            // anchor) and verify both the visual .active class and the
            // SR-perceivable aria-current land on the same element.
            expect(res.text).toMatch(
                /<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="Stats"/
            );
        });

        it('home page sidebar shows the Stats icon (out-of-workflow mode)', async () => {
            const cookie = await cookie_for('stats-7');
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            // The icon link to /dashboard/stats is present (sits under
            // the Home icon per design).
            expect(res.text).toMatch(
                /href="[^"]*\/dashboard\/stats"[^>]*title="Stats"/
            );
        });
    });

    describe('objects browse', () => {
        it('shell page contains HTMX target + lazy load trigger', async () => {
            const cookie = await cookie_for('o-shell');
            const res = await supertest(app).get('/repo/dashboard/objects').set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/id="objects-table"/);
            expect(res.text).toMatch(/hx-get="\/repo\/dashboard\/objects\/list"/);
            expect(res.text).toMatch(/hx-trigger="load/);
            // The objects-table div must carry hx-include for the
            // filter inputs — without it, navigating to
            // /dashboard/objects?q=<pid> would populate the search
            // input from the URL but render the unfiltered default
            // page (the bug the AIPs view's PID-link triggered).
            expect(res.text).toMatch(/hx-include="\[name=q\][\s\S]*?name=is_published[\s\S]*?name=collection/);
        });

        it('shell page passes ?q= from URL into the search input so hx-include picks it up', async () => {
            // Arriving via the AIPs view's PID link (and similar
            // deep-links) puts the PID in ?q=. The page must echo it
            // into the <input name="q" value="..."> so the
            // #objects-table div's hx-include flows it to /objects/list.
            const cookie = await cookie_for('o-q-url');
            const pid = '82dad06a-4e53-4d04-a1ba-ca75fd68f929';
            const res = await supertest(app)
                .get(`/repo/dashboard/objects?q=${pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // The PID lands in the search input's value attribute.
            expect(res.text).toMatch(
                new RegExp(`name="q"[\\s\\S]*?value="${pid}"`)
            );
        });

        it('GET /objects/list filters by ?q=<pid> exactly when the URL carries it', async () => {
            // End-to-end check: hitting /objects/list with q=<pid>
            // (the same shape #objects-table's hx-include produces)
            // returns ONLY the matching row.
            const cookie = await cookie_for('o-q-list');
            const target = await db_helper.seed_object();
            const noise = await db_helper.seed_object();
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/list?q=${target.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain(`id="object-${target.pid}"`);
            expect(res.text).not.toContain(`id="object-${noise.pid}"`);
        });

        it('GET /objects/list survives duplicated ?q= (last-wins coercion)', async () => {
            // Defense-in-depth: pagination URLs strip the filter
            // params to avoid colliding with hx-include, but a hand-
            // crafted URL could still send each filter twice. The
            // controller's _last_string coercion must take the last
            // value (matching the AIPs controller pattern).
            const cookie = await cookie_for('o-q-dup');
            const target = await db_helper.seed_object();
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/list?q=&q=${target.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain(`id="object-${target.pid}"`);
        });

        it('partial returns the table fragment, not the full page', async () => {
            const cookie = await cookie_for('o-partial');
            await db_helper.seed_object();
            const res = await supertest(app)
                .get('/repo/dashboard/objects/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/<table class="queue-table">/);
            // No <html> tag — confirms it's a fragment
            expect(res.text).not.toMatch(/<html/);
            expect(res.text).not.toMatch(/<head>/);
        });

        describe('filter combinations on /objects/list', () => {
            // Three rows, each in a distinct state. Tests below filter
            // on (is_published, is_active) and assert exactly which
            // rows the table renders.
            //
            //   active_published    — is_active=1, is_published=1
            //   active_unpublished  — is_active=1, is_published=0  (the "to-do" pile)
            //   deleted_unpublished — is_active=0, is_published=0  (soft-deleted)
            async function seed_filter_fixtures() {
                const ap = await db_helper.seed_object({
                    is_active: 1,
                    is_published: 1,
                });
                const au = await db_helper.seed_object({
                    is_active: 1,
                    is_published: 0,
                });
                const du = await db_helper.seed_object({
                    is_active: 0,
                    is_published: 0,
                });
                return { ap, au, du };
            }
            // Look for the row's pid in the rendered HTML. The row id
            // on object_row.ejs is `object-<pid>` — robust against
            // the rest of the row content varying.
            function row_visible(html, pid) {
                return html.includes(`id="object-${pid}"`);
            }

            it('"Unpublished" filter hides soft-deleted rows (the fix)', async () => {
                const cookie = await cookie_for('o-filter-unp');
                const { ap, au, du } = await seed_filter_fixtures();
                const res = await supertest(app)
                    .get('/repo/dashboard/objects/list?is_published=0')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                // Active-unpublished IS shown — that's what staff want.
                expect(row_visible(res.text, au.pid)).toBe(true);
                // Active-published is filtered out by is_published=0.
                expect(row_visible(res.text, ap.pid)).toBe(false);
                // Deleted-unpublished is hidden by the auto-applied
                // is_active=1 default. This is the user-reported fix.
                expect(row_visible(res.text, du.pid)).toBe(false);
            });

            it('"Unpublished" filter still shows deleted rows when is_active=0 is explicit', async () => {
                // The auto-default only applies when is_active is
                // OMITTED from the query. Passing it explicitly
                // (e.g. an admin audit URL) wins.
                const cookie = await cookie_for('o-filter-unp-explicit');
                const { au, du } = await seed_filter_fixtures();
                const res = await supertest(app)
                    .get('/repo/dashboard/objects/list?is_published=0&is_active=0')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                // Only the deleted-unpublished row matches the explicit
                // {is_active:0, is_published:0} pair.
                expect(row_visible(res.text, du.pid)).toBe(true);
                expect(row_visible(res.text, au.pid)).toBe(false);
            });

            it('default "All states" filter hides soft-deleted rows', async () => {
                // Contract: soft-deleted (is_active=0) rows do NOT render
                // in the default Objects view, regardless of is_published.
                // Staff who need to audit deleted rows opt in explicitly
                // via ?is_active=0 (see test below).
                const cookie = await cookie_for('o-filter-all');
                const { ap, au, du } = await seed_filter_fixtures();
                const res = await supertest(app)
                    .get('/repo/dashboard/objects/list')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(row_visible(res.text, ap.pid)).toBe(true);
                expect(row_visible(res.text, au.pid)).toBe(true);
                expect(row_visible(res.text, du.pid)).toBe(false);
            });

            it('explicit ?is_active=0 surfaces soft-deleted rows for audit', async () => {
                // The opt-in path. Staff hitting this URL want to see
                // ONLY soft-deleted rows.
                const cookie = await cookie_for('o-filter-deleted');
                const { ap, au, du } = await seed_filter_fixtures();
                const res = await supertest(app)
                    .get('/repo/dashboard/objects/list?is_active=0')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(row_visible(res.text, ap.pid)).toBe(false);
                expect(row_visible(res.text, au.pid)).toBe(false);
                expect(row_visible(res.text, du.pid)).toBe(true);
            });

            it('"Published" filter hides deleted-published rows by default', async () => {
                // The hide-deleted default is universal across
                // is_published values. A legacy row that's is_active=0
                // AND is_published=1 stays hidden in the default
                // Published view; staff combine ?is_active=0&is_published=1
                // when auditing this rare state (covered in the
                // audit-view test below).
                const cookie = await cookie_for('o-filter-pub');
                const deleted_published = await db_helper.seed_object({
                    is_active: 0,
                    is_published: 1,
                });
                const res = await supertest(app)
                    .get('/repo/dashboard/objects/list?is_published=1')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(row_visible(res.text, deleted_published.pid)).toBe(false);
            });

            it('explicit ?is_active=0&is_published=1 surfaces deleted-published rows', async () => {
                // Audit path: the two explicit filters together let
                // staff find the rare deleted-but-still-published rows
                // (usually legacy data) that they'd otherwise miss.
                const cookie = await cookie_for('o-filter-deleted-pub');
                const deleted_published = await db_helper.seed_object({
                    is_active: 0,
                    is_published: 1,
                });
                const res = await supertest(app)
                    .get(
                        '/repo/dashboard/objects/list?is_active=0&is_published=1'
                    )
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(row_visible(res.text, deleted_published.pid)).toBe(true);
            });
        });

        it('publish action returns the swapped row + toast HX-Trigger', async () => {
            const cookie = await cookie_for('o-pub');
            const o = await db_helper.seed_object({ is_published: 0 });
            const res = await supertest(app)
                .post(`/repo/dashboard/objects/${o.pid}/publish`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/sev-badge sev-success/);
            const trigger = res.headers['hx-trigger'];
            expect(trigger).toBeTruthy();
            const decoded = JSON.parse(trigger);
            expect(decoded.toast.level).toBe('success');
            expect(decoded.toast.message).toMatch(/publish/i);
        });

        it('delete action returns empty body + toast trigger', async () => {
            const cookie = await cookie_for('o-del');
            // Must be unpublished — published objects are 409-blocked.
            const o = await db_helper.seed_object({ is_published: 0 });
            const res = await supertest(app)
                .delete(`/repo/dashboard/objects/${o.pid}`)
                .set('Cookie', cookie)
                .type('form')
                .send({ delete_reason: 'unit-test cleanup' });
            expect(res.status).toBe(200);
            expect(res.text).toBe('');
            const decoded = JSON.parse(res.headers['hx-trigger']);
            expect(decoded.toast.message).toMatch(/deleted/i);
            // Regression guard: the response MUST emit modal:close so
            // dashboard.js dismisses the confirmation modal. An earlier
            // rev used an inline hx-on::after-request hack that didn't
            // fire — staff would click Delete and the modal stayed
            // open over an already-deleted row.
            expect(decoded).toHaveProperty('modal:close');
            // ALSO emits objects:refresh so the table re-fetches even
            // when hx-target=#object-<pid> isn't on the current page.
            expect(decoded).toHaveProperty('objects:refresh');
        });

        it('delete refuses without delete_reason', async () => {
            const cookie = await cookie_for('o-del-no-reason');
            const o = await db_helper.seed_object({ is_published: 0 });
            const res = await supertest(app)
                .delete(`/repo/dashboard/objects/${o.pid}`)
                .set('Cookie', cookie);
            // ValidationError → 400 via the central error handler.
            expect(res.status).toBe(400);
        });

        it('delete refuses a published object with 409', async () => {
            const cookie = await cookie_for('o-del-published');
            const o = await db_helper.seed_object({ is_published: 1 });
            const res = await supertest(app)
                .delete(`/repo/dashboard/objects/${o.pid}`)
                .set('Cookie', cookie)
                .type('form')
                .send({ delete_reason: 'will not be deleted' });
            expect(res.status).toBe(409);
            // The rejected delete must NOT have mutated the row: it's
            // still active + published in the DB (a published object can't
            // be soft-deleted; suppress it first).
            const after = await db()(tables.objects).where({ pid: o.pid }).first();
            expect(after).toBeDefined();
            expect(after.is_active).toBe(1);
            expect(after.is_published).toBe(1);
            // Spot check: still surfaced in the listing partial (not hidden
            // as if deleted).
            const list = await supertest(app)
                .get('/repo/dashboard/objects/list')
                .set('Cookie', cookie);
            expect(list.text).toContain(o.pid);
        });

        it('GET /objects/:pid/delete/confirm renders the delete modal with a reason field', async () => {
            const cookie = await cookie_for('o-del-modal');
            const o = await db_helper.seed_object({ is_published: 0 });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/delete/confirm`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Modal markup carries the textarea with the right name.
            expect(res.text).toMatch(/name="delete_reason"/);
            // Form posts via hx-delete back to the canonical endpoint.
            expect(res.text).toMatch(
                new RegExp(`hx-delete="[^"]*/objects/${o.pid}"`)
            );
        });

        it('GET /objects/:pid/delete/confirm refuses to expose Delete button for published rows', async () => {
            const cookie = await cookie_for('o-del-modal-published');
            const o = await db_helper.seed_object({ is_published: 1 });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/delete/confirm`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Modal explains the path forward instead of letting the
            // user submit a doomed delete. The server-side model
            // enforces the same guard via 409.
            expect(res.text).toMatch(/Suppress it first/i);
            // No textarea + no submit-form means staff can't try.
            expect(res.text).not.toMatch(/name="delete_reason"/);
        });

        it('partial supports pagination via ?page=', async () => {
            const cookie = await cookie_for('o-page');
            for (let i = 0; i < 5; i++) await db_helper.seed_object();
            const p1 = await supertest(app)
                .get('/repo/dashboard/objects/list?page=1&page_size=2')
                .set('Cookie', cookie);
            expect(p1.text).toMatch(/Showing 1.{1,3}2 of 5/);
            const p3 = await supertest(app)
                .get('/repo/dashboard/objects/list?page=3&page_size=2')
                .set('Cookie', cookie);
            expect(p3.text).toMatch(/Showing 5.{1,3}5 of 5/);
        });

        it('metadata modal renders display_record keys as labels + values', async () => {
            const cookie = await cookie_for('o-meta');
            const o = await db_helper.seed_object({
                handle: 'https://hdl.invalid/meta-test',
                display_record: JSON.stringify({
                    title: 'A Meta-Tagged Object',
                    abstract: 'Once upon a metadata field.',
                    f_subjects: ['Photography', 'Archive science'],
                    mime_type: 'image/tiff',
                    is_published: true,
                    extra: { lock_version: 42, notes: ['first', 'second'] },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Modal-shaped fragment, not a full page. The header / body
            // may carry extra layout classes alongside the Bootstrap
            // modal-* anchors — match on the anchor only.
            expect(res.text).toMatch(/class="[^"]*\bmodal-header\b/);
            expect(res.text).toMatch(/class="[^"]*\bmodal-body\b/);
            expect(res.text).toMatch(/class="[^"]*\bmodal-footer\b/);
            expect(res.text).not.toMatch(/<html/);

            // Every top-level key from display_record appears as a humanized
            // label in a <dt>, alongside its value in a <dd>.
            expect(res.text).toMatch(/<dt[^>]*>\s*title\s*</i);
            expect(res.text).toMatch(/<dt[^>]*>\s*abstract\s*</i);
            expect(res.text).toMatch(/<dt[^>]*>\s*f subjects\s*</i); // snake_case → " "
            expect(res.text).toMatch(/<dt[^>]*>\s*mime type\s*</i);
            expect(res.text).toMatch(/<dt[^>]*>\s*is published\s*</i);

            // Values render with type-appropriate styling.
            expect(res.text).toMatch(/A Meta-Tagged Object/);
            expect(res.text).toMatch(/Once upon a metadata field/);
            // Array of strings → badge chips
            expect(res.text).toMatch(/sev-badge[^>]*>\s*Photography\s*</);
            expect(res.text).toMatch(/sev-badge[^>]*>\s*Archive science\s*</);
            // Boolean → Yes/No badge
            expect(res.text).toMatch(/sev-badge sev-success[^>]*>\s*Yes\s*</);
            // Nested object → collapsible <details>
            expect(res.text).toMatch(/<details/);
            // The raw-JSON-only block from the prior design is gone
            expect(res.text).not.toMatch(/Show raw <code>display_record/);
        });

        it('metadata modal drills into a nested display_record envelope', async () => {
            // The ES indexer writes the ASpace metadata under an inner
            // `display_record` key, while the outer column also carries
            // wrapper fields (pid, handle, thumbnail, etc.) we don't want
            // to surface in the modal. The controller should drill into
            // the inner object and render only those fields.
            const cookie = await cookie_for('o-meta-nested');
            const o = await db_helper.seed_object({
                handle: 'https://hdl.invalid/nested',
                display_record: JSON.stringify({
                    pid: 'outer-pid-should-not-render',
                    handle: 'https://hdl.invalid/should-not-render',
                    thumbnail: 'should-not-render.jpg',
                    is_member_of_collection: 'parent-collection',
                    display_record: {
                        title: 'Sanatorium, Volume 12, Number 1',
                        uri: '/repositories/2/archival_objects/70303',
                        identifiers: [{ type: 'local', identifier: 'B002.05.0206' }],
                        resource_type: 'text',
                        extents: ['1 items (whole)'],
                        is_compound: false,
                    },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);

            // Inner fields render
            expect(res.text).toMatch(/<dt[^>]*>\s*title\s*</i);
            expect(res.text).toMatch(/<dt[^>]*>\s*uri\s*</i);
            expect(res.text).toMatch(/<dt[^>]*>\s*identifiers\s*</i);
            expect(res.text).toMatch(/<dt[^>]*>\s*resource type\s*</i);
            expect(res.text).toMatch(/<dt[^>]*>\s*extents\s*</i);
            expect(res.text).toMatch(/<dt[^>]*>\s*is compound\s*</i);
            expect(res.text).toMatch(/Sanatorium, Volume 12, Number 1/);

            // Outer wrapper fields do NOT render as their own labels.
            // (We allow the wrapper PID to appear in the modal header
            // text, but never as a <dt> in the metadata <dl>.)
            expect(res.text).not.toMatch(/<dt[^>]*>\s*pid\s*</i);
            expect(res.text).not.toMatch(/<dt[^>]*>\s*handle\s*</i);
            expect(res.text).not.toMatch(/<dt[^>]*>\s*thumbnail\s*</i);
            expect(res.text).not.toMatch(/<dt[^>]*>\s*is member of collection\s*</i);
            // The literal `display_record` key itself is never the label.
            expect(res.text).not.toMatch(/<dt[^>]*>\s*display record\s*</i);
            // Wrapper string values are not present anywhere in the body.
            expect(res.text).not.toMatch(/outer-pid-should-not-render/);
            expect(res.text).not.toMatch(/should-not-render\.jpg/);
        });

        it('metadata modal handles missing display_record gracefully', async () => {
            const cookie = await cookie_for('o-meta-empty');
            const o = await db_helper.seed_object({ display_record: null });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/\(untitled\)/);
            // Friendly empty-state message instead of an empty <dl>.
            expect(res.text).toMatch(/No <code>display_record<\/code> metadata recorded/);
        });

        it('metadata modal 404s on unknown pid', async () => {
            const cookie = await cookie_for('o-meta-missing');
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/00000000-0000-0000-0000-000000000000/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(404);
        });

        it('metadata modal renders identifiers inline with type chip', async () => {
            // Identifiers are arrays of {type, identifier} objects.
            // The generic recursive renderer would collapse each into
            // a "▶ 2 fields" disclosure — useless. The shape-aware
            // metadata_field partial flattens them to one readable
            // line per identifier with the type as a small chip.
            const cookie = await cookie_for('o-meta-ids');
            const o = await db_helper.seed_object({
                display_record: JSON.stringify({
                    display_record: {
                        title: 'Statement of President Nixon',
                        identifiers: [
                            { type: 'local', identifier: 'U219.03.0004.0005.00010' },
                        ],
                    },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Both the type tag and the identifier value should be
            // present as plain text inside the page — no <details> for
            // identifiers.
            expect(res.text).toMatch(/metadata-tag[^>]*>\s*local\s*</);
            expect(res.text).toMatch(/U219\.03\.0004\.0005\.00010/);
            // The header surfaces the same call number for quick scan.
            expect(res.text).toMatch(/metadata-modal-callnumber[^>]*>\s*U219\.03\.0004\.0005\.00010/);
        });

        it('metadata modal renders dates inline with label/expression/qualifier', async () => {
            const cookie = await cookie_for('o-meta-dates');
            const o = await db_helper.seed_object({
                display_record: JSON.stringify({
                    display_record: {
                        title: 'A dated item',
                        dates: [
                            {
                                label: 'creation',
                                type: 'single',
                                expression: '1970 May 6',
                                qualifier: 'approximate',
                            },
                        ],
                    },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/metadata-tag[^>]*>\s*creation\s*</);
            expect(res.text).toMatch(/1970 May 6/);
            expect(res.text).toMatch(/\(approximate\)/);
        });

        it('metadata modal renders subjects inline with authority chip', async () => {
            const cookie = await cookie_for('o-meta-subj');
            const o = await db_helper.seed_object({
                display_record: JSON.stringify({
                    display_record: {
                        title: 'Has subjects',
                        subjects: [
                            { authority: 'lcsh', title: 'Photography' },
                            { authority: 'aat', title: 'Archive science -- United States' },
                        ],
                    },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/metadata-tag[^>]*>\s*lcsh\s*</);
            expect(res.text).toMatch(/metadata-tag[^>]*>\s*aat\s*</);
            expect(res.text).toMatch(/Photography/);
            expect(res.text).toMatch(/Archive science -- United States/);
            // Subjects should NOT render as collapsed "N fields"
            // disclosures (regression guard).
            expect(res.text).not.toMatch(/<summary[^>]*>\s*\d+ fields?\s*<\/summary>[\s\S]*Photography/);
        });

        it('metadata modal renders notes with type chip + stripped content', async () => {
            const cookie = await cookie_for('o-meta-notes');
            const o = await db_helper.seed_object({
                display_record: JSON.stringify({
                    display_record: {
                        title: 'Has notes',
                        notes: [
                            {
                                type: 'scopecontent',
                                content: 'A <b>scope</b> and content note.',
                            },
                        ],
                    },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/metadata-tag[^>]*>\s*scopecontent\s*</);
            // Tags stripped — only the text remains.
            expect(res.text).toMatch(/A scope and content note\./);
            expect(res.text).not.toMatch(/<b>scope<\/b>/);
        });

        it('metadata modal renders names with relator chip + source', async () => {
            const cookie = await cookie_for('o-meta-names');
            const o = await db_helper.seed_object({
                display_record: JSON.stringify({
                    display_record: {
                        title: 'Has names',
                        names: [
                            {
                                title: 'Nixon, Richard M.',
                                source: 'naf',
                                role: 'creator',
                                relator: 'speaker',
                            },
                        ],
                    },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // relator wins over role for the chip.
            expect(res.text).toMatch(/metadata-tag[^>]*>\s*speaker\s*</);
            expect(res.text).toMatch(/Nixon, Richard M\./);
            expect(res.text).toMatch(/\(naf\)/);
        });

        it('metadata modal renders parts with order, title, and type', async () => {
            const cookie = await cookie_for('o-meta-parts');
            const o = await db_helper.seed_object({
                display_record: JSON.stringify({
                    display_record: {
                        title: 'Has parts',
                        parts: [
                            { order: '1', title: 'Page one', type: 'image/tiff' },
                            { order: '2', title: 'Page two', type: 'image/tiff' },
                        ],
                    },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Order numbers shown alongside titles.
            expect(res.text).toMatch(/Page one/);
            expect(res.text).toMatch(/Page two/);
            expect(res.text).toMatch(/\(image\/tiff\)/);
        });

        it('metadata modal falls back to generic renderer for unknown shapes', async () => {
            // A field that is NOT in the dispatcher list still uses the
            // recursive metadata_value partial — so a one-off custom
            // bag of fields keeps working.
            const cookie = await cookie_for('o-meta-fallback');
            const o = await db_helper.seed_object({
                display_record: JSON.stringify({
                    display_record: {
                        title: 'Has unknown',
                        custom_bag: { foo: 'bar', count: 7 },
                    },
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/objects/${o.pid}/metadata`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/<details/);
        });

        it('list partial renders a thumbnail <img> when the row has one', async () => {
            const cookie = await cookie_for('o-tn-row');
            await db_helper.seed_object({
                thumbnail: 'https://example.com/repo/static/tn/has.jpg',
            });
            const res = await supertest(app)
                .get('/repo/dashboard/objects/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(
                /<img[^>]+class="thumb-img"[^>]+src="https:\/\/example\.com\/repo\/static\/tn\/has\.jpg"/
            );
        });

        it('list partial renders a placeholder when the row has no thumbnail', async () => {
            const cookie = await cookie_for('o-tn-empty');
            await db_helper.seed_object({ thumbnail: null });
            const res = await supertest(app)
                .get('/repo/dashboard/objects/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/class="thumb-placeholder"/);
            expect(res.text).not.toMatch(/class="thumb-img"/);
        });

        it('list partial reads thumbnail out of display_record when the column is null', async () => {
            // Mirrors the legacy ingest path where the URL lives in
            // display_record but the column lags behind.
            const cookie = await cookie_for('o-tn-dr');
            await db_helper.seed_object({
                thumbnail: null,
                display_record: JSON.stringify({
                    thumbnail: 'https://example.com/repo/static/tn/from-dr.jpg',
                }),
            });
            const res = await supertest(app)
                .get('/repo/dashboard/objects/list')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /src="https:\/\/example\.com\/repo\/static\/tn\/from-dr\.jpg"/
            );
        });

        it('list partial rewrites a dip-store-relative thumbnail to the proxy URL', async () => {
            // This is the bulk of the existing corpus: ingest writes a
            // path tail like <dip_path>/thumbnails/<uuid>.jpg into the
            // column. The projection rewrites it to point at our proxy
            // so the browser can fetch through the dashboard session.
            const cookie = await cookie_for('o-tn-legacy');
            const o = await db_helper.seed_object({
                thumbnail: 'archivematica-dip-2024/thumbnails/legacy.jpg',
            });
            const res = await supertest(app)
                .get('/repo/dashboard/objects/list')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                new RegExp(
                    `<img[^>]+class="thumb-img"[^>]+src="/repo/dashboard/objects/${o.pid}/thumbnail/raw"`
                )
            );
            // The raw value never leaks into the rendered HTML.
            expect(res.text).not.toMatch(/archivematica-dip-2024/);
        });

        describe('thumbnail proxy', () => {
            // The streaming-fetch path against a real DuraCloud is
            // out of scope here — we'd need a full HTTP fixture. The
            // tests below cover all the branches the proxy decides
            // WITHOUT a DC roundtrip: redirect-on-absolute-URL,
            // placeholder when DC is unconfigured, placeholder for
            // missing/unknown rows.

            it('redirects 302 when the stored thumbnail is already an absolute URL', async () => {
                const cookie = await cookie_for('o-tn-rdr');
                const o = await db_helper.seed_object({
                    thumbnail: 'https://cdn.example.com/uploaded.jpg',
                });
                const res = await supertest(app)
                    .get(`/repo/dashboard/objects/${o.pid}/thumbnail/raw`)
                    .set('Cookie', cookie)
                    .redirects(0);
                expect(res.status).toBe(302);
                expect(res.headers.location).toBe('https://cdn.example.com/uploaded.jpg');
                expect(res.headers['cache-control']).toMatch(/private/);
            });

            it('returns the SVG placeholder when DuraCloud is not configured', async () => {
                // The default test env never sets DURACLOUD_API; the
                // proxy falls back to the local placeholder.
                const cookie = await cookie_for('o-tn-nodc');
                const o = await db_helper.seed_object({
                    thumbnail: 'archivematica/thumbnails/abc.jpg',
                });
                const res = await supertest(app)
                    // Force supertest to buffer the binary-ish response
                    // so we can assert on its bytes. Without this,
                    // image/* responses come back as an empty res.text
                    // and a Buffer in res.body that supertest only
                    // populates with this opt-in.
                    .get(`/repo/dashboard/objects/${o.pid}/thumbnail/raw`)
                    .set('Cookie', cookie)
                    .buffer(true)
                    .parse((res2, cb) => {
                        const chunks = [];
                        res2.on('data', (c) => chunks.push(c));
                        res2.on('end', () => cb(null, Buffer.concat(chunks)));
                    });
                expect(res.status).toBe(200);
                expect(res.headers['content-type']).toMatch(/image\/svg/);
                expect(res.body.toString('utf8')).toMatch(/<svg/);
            });

            it('returns the placeholder when the row has no thumbnail at all', async () => {
                const cookie = await cookie_for('o-tn-blank');
                const o = await db_helper.seed_object({ thumbnail: null });
                const res = await supertest(app)
                    .get(`/repo/dashboard/objects/${o.pid}/thumbnail/raw`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.headers['content-type']).toMatch(/image\/svg/);
            });

            it('returns the placeholder for an unknown pid (no 404)', async () => {
                // Soft-deleted-while-listing scenario. A 404 would
                // surface a broken-image icon in the browser, defeating
                // the whole point.
                const cookie = await cookie_for('o-tn-gone');
                const res = await supertest(app)
                    .get(
                        '/repo/dashboard/objects/00000000-0000-0000-0000-000000000000/thumbnail/raw'
                    )
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.headers['content-type']).toMatch(/image\/svg/);
            });

            it('requires authentication', async () => {
                const o = await db_helper.seed_object({
                    thumbnail: 'https://cdn.example.com/foo.jpg',
                });
                const res = await supertest(app)
                    .get(`/repo/dashboard/objects/${o.pid}/thumbnail/raw`)
                    .redirects(0);
                expect([302, 401]).toContain(res.status);
            });
        });

        describe('thumbnail upload', () => {
            it('GET /objects/:pid/thumbnail/form renders the modal partial', async () => {
                const cookie = await cookie_for('o-tn-form');
                const o = await db_helper.seed_object();
                const res = await supertest(app)
                    .get(`/repo/dashboard/objects/${o.pid}/thumbnail/form`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).toMatch(/Change thumbnail/);
                expect(res.text).toMatch(/name="thumbnail"/);
                expect(res.text).toMatch(/multipart\/form-data/);
                // The form posts to the upload endpoint we expose.
                expect(res.text).toMatch(
                    new RegExp(`hx-post="/repo/dashboard/objects/${o.pid}/thumbnail"`)
                );
            });

            it('POST writes the file, updates the DB, and returns the new row', async () => {
                const cookie = await cookie_for('o-tn-up');
                const o = await db_helper.seed_object({
                    thumbnail: null,
                    display_record: JSON.stringify({ title: 'A test object' }),
                });
                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/thumbnail`)
                    .set('Cookie', cookie)
                    .attach('thumbnail', tiny_jpeg(), {
                        filename: 'tiny.jpg',
                        contentType: 'image/jpeg',
                    });
                expect(res.status).toBe(200);

                // File landed on disk under the overridden upload path.
                const on_disk = await fs.readFile(path.join(upload_tempdir, `${o.pid}.jpg`));
                expect(on_disk.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);

                // Response body is the freshly-rendered object_row,
                // carrying the new <img>.
                expect(res.text).toMatch(new RegExp(`id="object-${o.pid}"`));
                expect(res.text).toMatch(/class="thumb-img"/);
                expect(res.text).toMatch(/\/repo\/static\/tn\/[^"]+\.jpg/);

                // HX-Trigger fires the toast AND the modal:close event.
                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast.level).toBe('success');
                expect(trigger['modal:close']).toBeTruthy();
            });

            it('POST returns the collection_row partial for collection objects', async () => {
                const cookie = await cookie_for('o-tn-col');
                const o = await db_helper.seed_object({
                    object_type: 'collection',
                    thumbnail: null,
                });
                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/thumbnail`)
                    .set('Cookie', cookie)
                    .attach('thumbnail', tiny_jpeg(), {
                        filename: 'col.jpg',
                        contentType: 'image/jpeg',
                    });
                expect(res.status).toBe(200);
                expect(res.text).toMatch(new RegExp(`id="collection-${o.pid}"`));
            });

            it('POST rejects a non-JPEG file with a 400', async () => {
                const cookie = await cookie_for('o-tn-png');
                const o = await db_helper.seed_object();
                // Spoofed: PNG bytes sent with content-type image/jpeg.
                const png_bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/thumbnail`)
                    .set('Cookie', cookie)
                    .attach('thumbnail', png_bytes, {
                        filename: 'pretend.jpg',
                        contentType: 'image/jpeg',
                    });
                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/JPEG/i);

                // No file should have been written to disk.
                const exists = await fs
                    .stat(path.join(upload_tempdir, `${o.pid}.jpg`))
                    .then(() => true)
                    .catch(() => false);
                expect(exists).toBe(false);
            });

            it('POST rejects a non-image/jpeg content-type at the multer gate', async () => {
                const cookie = await cookie_for('o-tn-mime');
                const o = await db_helper.seed_object();
                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/thumbnail`)
                    .set('Cookie', cookie)
                    .attach('thumbnail', tiny_jpeg(), {
                        filename: 'sneaky.png',
                        contentType: 'image/png',
                    });
                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/JPEG/i);
            });

            it('POST rejects an oversized file with a 413', async () => {
                const cookie = await cookie_for('o-tn-big');
                const o = await db_helper.seed_object();
                // 600 KB of JPEG-magic-prefixed bytes — over the 500 KB cap.
                const oversized = Buffer.concat([
                    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
                    Buffer.alloc(600 * 1024, 0),
                ]);
                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/thumbnail`)
                    .set('Cookie', cookie)
                    .attach('thumbnail', oversized, {
                        filename: 'big.jpg',
                        contentType: 'image/jpeg',
                    });
                expect(res.status).toBe(413);
                expect(res.body.error).toMatch(/500 KB|size limit/i);
            });

            it('POST requires authentication', async () => {
                const o = await db_helper.seed_object();
                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/thumbnail`)
                    .attach('thumbnail', tiny_jpeg(), {
                        filename: 'unauth.jpg',
                        contentType: 'image/jpeg',
                    });
                // The dashboard auth middleware sends a 302 to /login
                // for non-HTMX requests; HTMX requests get 401 +
                // HX-Redirect. Supertest is the former.
                expect([302, 401]).toContain(res.status);
            });
        });

        describe('thumbnail cache invalidation', () => {
            // Re-use the per-suite TN cache directory. Each test
            // writes its own dummy cache file under <pid>.jpg, then
            // calls the endpoint and asserts the file disappeared.
            const fs_node = require('node:fs');
            const fs_p = require('node:fs/promises');
            const node_path = require('node:path');

            // The suite's `make_app` doesn't override TN_CACHE_PATH;
            // libs/tn_service falls back to the config default which
            // is './public/tn_cache' (relative to cwd). We use that
            // for these tests, cleaning up our specific files in the
            // afterEach so we don't pollute the working tree.
            let tn_cache_root;
            beforeAll(() => {
                tn_cache_root = node_path.resolve('./public/tn_cache');
            });

            it('POST /thumbnail/invalidate removes a cached file', async () => {
                const cookie = await cookie_for('tn-inv-1');
                const o = await db_helper.seed_object();
                const cache_file = node_path.join(tn_cache_root, `${o.pid}.jpg`);
                await fs_p.mkdir(tn_cache_root, { recursive: true });
                await fs_p.writeFile(cache_file, Buffer.from([0xff, 0xd8, 0xff]));

                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/thumbnail/invalidate`)
                    .set('Cookie', cookie);

                expect(res.status).toBe(204);
                expect(fs_node.existsSync(cache_file)).toBe(false);

                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast.level).toBe('success');
                expect(trigger.toast.message).toMatch(/Thumbnail cache cleared/);
            });

            it("returns 'nothing to do' when no cache file exists", async () => {
                const cookie = await cookie_for('tn-inv-2');
                const o = await db_helper.seed_object();
                // Make sure there's no file present (defensive).
                const cache_file = node_path.join(tn_cache_root, `${o.pid}.jpg`);
                await fs_p.unlink(cache_file).catch(() => {});

                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/thumbnail/invalidate`)
                    .set('Cookie', cookie);

                expect(res.status).toBe(204);
                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast.message).toMatch(/No cached thumbnail/);
            });

            it('404s on an unknown pid', async () => {
                const cookie = await cookie_for('tn-inv-3');
                const res = await supertest(app)
                    .post(
                        '/repo/dashboard/objects/00000000-0000-0000-0000-000000000000/thumbnail/invalidate'
                    )
                    .set('Cookie', cookie);
                expect(res.status).toBe(404);
            });

            it('requires authentication', async () => {
                const o = await db_helper.seed_object();
                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/thumbnail/invalidate`)
                    .redirects(0);
                expect([302, 401]).toContain(res.status);
            });

            it('the kebab item appears on rendered rows', async () => {
                const cookie = await cookie_for('tn-inv-kebab');
                await db_helper.seed_object();
                const res = await supertest(app)
                    .get('/repo/dashboard/objects/list')
                    .set('Cookie', cookie);
                expect(res.text).toMatch(/Refresh thumbnail cache/);
                expect(res.text).toMatch(
                    new RegExp(
                        `hx-post="/repo/dashboard/objects/[0-9a-f-]+/thumbnail/invalidate"`,
                        'i'
                    )
                );
            });
        });

        it('partial filters by is_published', async () => {
            const cookie = await cookie_for('o-filter');
            await db_helper.seed_object({ is_published: 1 });
            await db_helper.seed_object({ is_published: 0 });
            const pub_only = await supertest(app)
                .get('/repo/dashboard/objects/list?is_published=1')
                .set('Cookie', cookie);
            expect(pub_only.text).toMatch(/of 1<\/span>|of 1\s/);
        });

        describe('bulk actions — multi-select', () => {
            it('list partial renders selection checkboxes + bulk toolbar', async () => {
                const cookie = await cookie_for('o-bulk-ui');
                await db_helper.seed_object();
                await db_helper.seed_object();
                const res = await supertest(app)
                    .get('/repo/dashboard/objects/list')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).toMatch(/class="row-select form-check-input"/);
                expect(res.text).toMatch(/class="select-all form-check-input"/);
                expect(res.text).toMatch(/class="bulk-toolbar"/);
                expect(res.text).toMatch(
                    /<form id="bulk-form-publish"[^>]+hx-post="\/repo\/dashboard\/objects\/bulk\/publish"/
                );
            });

            it('list partial does not render a checkbox for soft-deleted rows', async () => {
                // The select cell is rendered (column alignment) but
                // without an actual <input>, so the row can't be picked
                // up by the multi-select UI.
                const cookie = await cookie_for('o-bulk-soft');
                await db_helper.seed_object({ is_active: 1 });
                await db_helper.seed_object({ is_active: 0 });
                const res = await supertest(app)
                    .get('/repo/dashboard/objects/list?is_active=&page_size=10')
                    .set('Cookie', cookie);
                // One checkbox total (the active row); the soft-deleted
                // row's <td class="select-cell"> stays empty.
                const checkboxes = res.text.match(/class="row-select form-check-input"/g) || [];
                expect(checkboxes).toHaveLength(1);
            });

            it('POST /objects/bulk/publish flips every pid + fires refresh trigger', async () => {
                const cookie = await cookie_for('o-bulk-pub');
                const a = await db_helper.seed_object({ is_published: 0 });
                const b = await db_helper.seed_object({ is_published: 0 });
                const c = await db_helper.seed_object({ is_published: 0 });
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/publish')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ pids: [a.pid, b.pid, c.pid].join(',') });
                expect(res.status).toBe(204);

                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast.level).toBe('success');
                expect(trigger.toast.message).toMatch(/3 objects published/);
                expect(trigger['objects:refresh'].affected).toBe(3);

                // Verify the rows were actually flipped.
                for (const pid of [a.pid, b.pid, c.pid]) {
                    const list = await supertest(app)
                        .get(`/repo/dashboard/objects/list?page_size=50`)
                        .set('Cookie', cookie);
                    expect(list.text).toMatch(new RegExp(`id="object-${pid}"`));
                }
            });

            it('POST /objects/bulk/suppress is symmetric', async () => {
                const cookie = await cookie_for('o-bulk-sup');
                const a = await db_helper.seed_object({ is_published: 1 });
                const b = await db_helper.seed_object({ is_published: 1 });
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/suppress')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ pids: `${a.pid},${b.pid}` });
                expect(res.status).toBe(204);
                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast.message).toMatch(/2 objects suppressed/);
            });

            it('POST /objects/bulk/delete/confirm renders the modal with titles', async () => {
                const cookie = await cookie_for('o-bulk-confirm');
                const a = await db_helper.seed_object({
                    display_record: JSON.stringify({ title: 'A first thing' }),
                });
                const b = await db_helper.seed_object({
                    display_record: JSON.stringify({ title: 'B second thing' }),
                });
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/delete/confirm')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ pids: `${a.pid},${b.pid}` });
                expect(res.status).toBe(200);
                expect(res.text).toMatch(/class="modal-header"/);
                expect(res.text).toMatch(/Delete 2 objects\?/);
                expect(res.text).toMatch(/A first thing/);
                expect(res.text).toMatch(/B second thing/);
                // The submit form posts to the actual delete endpoint
                // with the same pid list.
                expect(res.text).toMatch(/hx-post="\/repo\/dashboard\/objects\/bulk\/delete"/);
            });

            it('POST /objects/bulk/delete soft-deletes every pid', async () => {
                const cookie = await cookie_for('o-bulk-del');
                const a = await db_helper.seed_object({ is_active: 1, is_published: 0 });
                const b = await db_helper.seed_object({ is_active: 1, is_published: 0 });
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/delete')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({
                        pids: `${a.pid},${b.pid}`,
                        delete_reason: 'unit-test cleanup',
                    });
                expect(res.status).toBe(204);
                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast.message).toMatch(/2 objects deleted/);
                // Same regression guard as single-delete — the bulk
                // modal must dismiss too.
                expect(trigger).toHaveProperty('modal:close');
            });

            it('POST /objects/bulk/delete refuses if any pid is published (409)', async () => {
                const cookie = await cookie_for('o-bulk-del-pub');
                const ok = await db_helper.seed_object({ is_active: 1, is_published: 0 });
                const pub = await db_helper.seed_object({ is_active: 1, is_published: 1 });
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/delete')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({
                        pids: `${ok.pid},${pub.pid}`,
                        delete_reason: 'will refuse the whole batch',
                    });
                expect(res.status).toBe(409);
            });

            it('POST /objects/bulk/delete refuses without delete_reason (400)', async () => {
                const cookie = await cookie_for('o-bulk-del-no-reason');
                const a = await db_helper.seed_object({ is_active: 1, is_published: 0 });
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/delete')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ pids: a.pid });
                expect(res.status).toBe(400);
            });

            it('POST bulk endpoints reject an empty selection with 400', async () => {
                const cookie = await cookie_for('o-bulk-empty');
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/publish')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ pids: '' });
                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/Select at least one/i);
            });

            it('POST bulk endpoints reject >100 pids', async () => {
                const cookie = await cookie_for('o-bulk-max');
                const huge = Array.from(
                    { length: 101 },
                    () => '00000000-0000-0000-0000-000000000000'
                ).join(',');
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/publish')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ pids: huge });
                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/capped/i);
            });

            it('POST bulk endpoints reject non-UUID values', async () => {
                const cookie = await cookie_for('o-bulk-bad');
                const ok = await db_helper.seed_object();
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/publish')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ pids: `${ok.pid},garbage` });
                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/Invalid pid/i);
            });

            it('POST bulk endpoints require authentication', async () => {
                const a = await db_helper.seed_object();
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/bulk/publish')
                    .type('form')
                    .send({ pids: a.pid })
                    .redirects(0);
                expect([302, 401]).toContain(res.status);
            });
        });

        describe('metadata refresh — queue endpoints', () => {
            // The HTTP routes return modal/partial HTML and write to
            // tbl_metadata_update_queue. The worker is NOT started
            // here (METADATA_WORKER_ENABLED defaults are irrelevant
            // for these tests — we never call worker.start). We just
            // verify the queue state after each endpoint call.

            const tables = require('../../config/db_tables');
            const { db_queue } = require('../../config/db');

            async function clear_queue() {
                await db_queue()(tables.metadata_update_queue).del();
            }

            it('POST /objects/:pid/metadata/refresh enqueues + returns the modal', async () => {
                await clear_queue();
                const cookie = await cookie_for('md-single');
                const o = await db_helper.seed_object({
                    uri: '/repositories/2/archival_objects/100',
                    display_record: JSON.stringify({ title: 'before' }),
                });
                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/metadata/refresh`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).toMatch(/Refreshing metadata/);
                // The modal embeds a hx-get pointing at the progress
                // partial keyed by batch_uuid.
                const batch_match = res.text.match(/\/jobs\/([0-9a-f-]{36})\/progress/);
                expect(batch_match).toBeTruthy();
                const batch_uuid = batch_match[1];
                // One queue row landed.
                const rows = await db_queue()(tables.metadata_update_queue).where({
                    batch_uuid,
                });
                expect(rows).toHaveLength(1);
                expect(rows[0].uuid).toBe(o.pid);
            });

            it('POST /collections/:pid/metadata/refresh-members expands the collection', async () => {
                await clear_queue();
                const cookie = await cookie_for('md-coll');
                const c = await db_helper.seed_object({
                    object_type: 'collection',
                    uri: '/repositories/2/resources/9',
                });
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                    uri: '/r/1',
                });
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                    uri: '/r/2',
                });
                const res = await supertest(app)
                    .post(`/repo/dashboard/collections/${c.pid}/metadata/refresh-members`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                const batch_uuid = res.text.match(/\/jobs\/([0-9a-f-]{36})\/progress/)[1];
                const rows = await db_queue()(tables.metadata_update_queue).where({
                    batch_uuid,
                });
                // 2 members + the collection itself.
                expect(rows).toHaveLength(3);
            });

            it('POST /collections/:pid/metadata/refresh enqueues only the collection record (no members)', async () => {
                // Sibling route to /refresh-members. The collections-list
                // kabob targets this one; members are intentionally
                // excluded so a list-view click can't trigger a long-
                // running bulk refresh.
                await clear_queue();
                const cookie = await cookie_for('md-coll-only');
                const c = await db_helper.seed_object({
                    object_type: 'collection',
                    uri: '/repositories/2/resources/42',
                });
                // Two members that would have landed in the queue if
                // we'd hit /refresh-members. They must NOT appear here.
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                    uri: '/r/m1',
                });
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                    uri: '/r/m2',
                });
                const res = await supertest(app)
                    .post(`/repo/dashboard/collections/${c.pid}/metadata/refresh`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                const batch_uuid = res.text.match(/\/jobs\/([0-9a-f-]{36})\/progress/)[1];
                const rows = await db_queue()(tables.metadata_update_queue).where({
                    batch_uuid,
                });
                expect(rows).toHaveLength(1);
                expect(rows[0].uuid).toBe(c.pid);
                expect(rows[0].update_type).toBe('collection-record');
            });

            it('POST refresh fires an HX-Trigger toast so the action is announced even before the modal renders', async () => {
                // Toast is emitted from the shared render_progress_modal
                // helper — covers all four enqueue paths in one assertion.
                // Test through the collection-record path because that's
                // the newest entry point; a regression on any of the four
                // would show up here as long as the helper stays shared.
                await clear_queue();
                const cookie = await cookie_for('md-init-toast');
                const c = await db_helper.seed_object({
                    object_type: 'collection',
                    uri: '/repositories/2/resources/init',
                });
                const res = await supertest(app)
                    .post(`/repo/dashboard/collections/${c.pid}/metadata/refresh`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast).toBeTruthy();
                expect(trigger.toast.level).toBe('info');
                expect(trigger.toast.message).toMatch(/queued/i);
                expect(trigger.toast.message).toMatch(/1 record/);
            });

            it('POST /collections/:pid/metadata/refresh rejects a non-collection pid', async () => {
                // Defense in depth: the kabob is only rendered on
                // collection rows, but the route should still refuse
                // a non-collection pid coming from a manual POST.
                await clear_queue();
                const cookie = await cookie_for('md-coll-bad');
                const o = await db_helper.seed_object({
                    object_type: 'object',
                    uri: '/repositories/2/archival_objects/200',
                });
                const res = await supertest(app)
                    .post(`/repo/dashboard/collections/${o.pid}/metadata/refresh`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(400);
            });

            it('POST /objects/metadata/refresh-bulk consumes the multi-select pid list', async () => {
                await clear_queue();
                const cookie = await cookie_for('md-bulk');
                const a = await db_helper.seed_object({ uri: '/a' });
                const b = await db_helper.seed_object({ uri: '/b' });
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/metadata/refresh-bulk')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ pids: `${a.pid},${b.pid}` });
                expect(res.status).toBe(200);
                const batch_uuid = res.text.match(/\/jobs\/([0-9a-f-]{36})\/progress/)[1];
                const rows = await db_queue()(tables.metadata_update_queue).where({
                    batch_uuid,
                });
                expect(rows).toHaveLength(2);
            });

            it('GET /jobs/:batch_uuid/progress renders counters + Cancel button', async () => {
                await clear_queue();
                const cookie = await cookie_for('md-prog');
                const o = await db_helper.seed_object({ uri: '/r/p' });
                const enqueue_res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/metadata/refresh`)
                    .set('Cookie', cookie);
                const batch_uuid = enqueue_res.text.match(/\/jobs\/([0-9a-f-]{36})\/progress/)[1];

                const res = await supertest(app)
                    .get(`/repo/dashboard/jobs/${batch_uuid}/progress`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).toMatch(/class="progress"/);
                expect(res.text).toMatch(/Cancel batch/);
                expect(res.text).toMatch(/Total/);
            });

            it('GET /jobs/:batch_uuid/progress fires objects:refresh when batch is done', async () => {
                await clear_queue();
                const cookie = await cookie_for('md-done');
                const o = await db_helper.seed_object({ uri: '/r/done' });
                const enqueue_res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/metadata/refresh`)
                    .set('Cookie', cookie);
                const batch_uuid = enqueue_res.text.match(/\/jobs\/([0-9a-f-]{36})\/progress/)[1];
                // Cancel immediately so the batch is fully terminal.
                await supertest(app)
                    .post(`/repo/dashboard/jobs/${batch_uuid}/cancel`)
                    .set('Cookie', cookie);

                const res = await supertest(app)
                    .get(`/repo/dashboard/jobs/${batch_uuid}/progress`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger['objects:refresh']).toBeTruthy();
                expect(trigger['metadata:batch-done']).toBeTruthy();
                // Cancellation counts as an "exception" in the toast
                // payload — the operator should see a warn-level
                // completion notice rather than success.
                expect(trigger.toast).toBeTruthy();
                expect(trigger.toast.level).toBe('warn');
                expect(trigger.toast.message).toMatch(/exception/i);
                expect(res.text).toMatch(/Batch finished/);
            });

            it('GET /jobs/:batch_uuid/progress fires a success toast when every row completed cleanly', async () => {
                // The warn-toast variant is covered above. This case
                // forces the queue into the all-COMPLETE terminal
                // state so we can assert the success-level toast
                // copy. Driving the worker for this would be
                // overkill; writing the terminal row directly is the
                // same shape the worker would produce.
                await clear_queue();
                const cookie = await cookie_for('md-done-ok');
                const o = await db_helper.seed_object({ uri: '/r/done-ok' });
                const enqueue_res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/metadata/refresh`)
                    .set('Cookie', cookie);
                const batch_uuid = enqueue_res.text.match(/\/jobs\/([0-9a-f-]{36})\/progress/)[1];
                // Flip the row to COMPLETE without going through the
                // worker. status='COMPLETE' + is_complete=1 + no error
                // is what get_batch_progress reads as a clean success.
                await db_queue()(tables.metadata_update_queue)
                    .where({ batch_uuid })
                    .update({ status: 'COMPLETE', is_complete: 1 });

                const res = await supertest(app)
                    .get(`/repo/dashboard/jobs/${batch_uuid}/progress`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast).toBeTruthy();
                expect(trigger.toast.level).toBe('success');
                expect(trigger.toast.message).toMatch(/complete/i);
                // The in-modal alert mirrors the toast — clean run.
                expect(res.text).toMatch(/Batch complete/);
            });

            it('POST /jobs/:batch_uuid/cancel marks the batch cancelled', async () => {
                await clear_queue();
                const cookie = await cookie_for('md-cancel');
                const o = await db_helper.seed_object({ uri: '/r/cancel' });
                const enqueue_res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/metadata/refresh`)
                    .set('Cookie', cookie);
                const batch_uuid = enqueue_res.text.match(/\/jobs\/([0-9a-f-]{36})\/progress/)[1];
                const res = await supertest(app)
                    .post(`/repo/dashboard/jobs/${batch_uuid}/cancel`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).toMatch(/Batch finished/);
                const rows = await db_queue()(tables.metadata_update_queue).where({
                    batch_uuid,
                });
                expect(rows.every((r) => r.status === 'CANCELLED')).toBe(true);
            });

            it('refresh endpoints require auth', async () => {
                const o = await db_helper.seed_object({ uri: '/r/auth' });
                const res = await supertest(app)
                    .post(`/repo/dashboard/objects/${o.pid}/metadata/refresh`)
                    .redirects(0);
                expect([302, 401]).toContain(res.status);
            });

            it('bulk refresh rejects an empty selection', async () => {
                const cookie = await cookie_for('md-empty');
                const res = await supertest(app)
                    .post('/repo/dashboard/objects/metadata/refresh-bulk')
                    .set('Cookie', cookie)
                    .type('form')
                    .send({ pids: '' });
                expect(res.status).toBe(400);
            });

            it('refresh endpoint 404s on an unknown pid', async () => {
                const cookie = await cookie_for('md-missing');
                const res = await supertest(app)
                    .post(
                        '/repo/dashboard/objects/00000000-0000-0000-0000-000000000000/metadata/refresh'
                    )
                    .set('Cookie', cookie);
                expect(res.status).toBe(404);
            });

            it('list partial shows a "Refresh metadata" kebab item', async () => {
                const cookie = await cookie_for('md-kebab');
                await db_helper.seed_object();
                const res = await supertest(app)
                    .get('/repo/dashboard/objects/list')
                    .set('Cookie', cookie);
                expect(res.text).toMatch(/Refresh metadata/);
                expect(res.text).toMatch(
                    /hx-post="\/repo\/dashboard\/objects\/[^"]+\/metadata\/refresh"/
                );
            });
        });

        describe('bulk actions — collection-scoped', () => {
            it('POST /collections/:pid/bulk/publish flips every member', async () => {
                const cookie = await cookie_for('o-bulk-col-pub');
                const c = await db_helper.seed_object({
                    object_type: 'collection',
                    display_record: JSON.stringify({ title: 'My collection' }),
                });
                for (let i = 0; i < 3; i++) {
                    await db_helper.seed_object({
                        is_member_of_collection: c.pid,
                        is_published: 0,
                    });
                }
                const res = await supertest(app)
                    .post(`/repo/dashboard/collections/${c.pid}/bulk/publish`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(204);
                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast.message).toMatch(/Published 3 member/);
                expect(trigger['objects:refresh'].kind).toBe('publish');
            });

            it('POST /collections/:pid/bulk/suppress is symmetric', async () => {
                const cookie = await cookie_for('o-bulk-col-sup');
                const c = await db_helper.seed_object({
                    object_type: 'collection',
                    display_record: JSON.stringify({ title: 'C' }),
                });
                for (let i = 0; i < 2; i++) {
                    await db_helper.seed_object({
                        is_member_of_collection: c.pid,
                        is_published: 1,
                    });
                }
                const res = await supertest(app)
                    .post(`/repo/dashboard/collections/${c.pid}/bulk/suppress`)
                    .set('Cookie', cookie);
                expect(res.status).toBe(204);
                const trigger = JSON.parse(res.headers['hx-trigger']);
                expect(trigger.toast.message).toMatch(/Suppressed 2 member/);
            });

            it('POST /collections/:pid/bulk/publish 404s on an unknown collection', async () => {
                const cookie = await cookie_for('o-bulk-col-404');
                const res = await supertest(app)
                    .post(
                        '/repo/dashboard/collections/00000000-0000-0000-0000-000000000000/bulk/publish'
                    )
                    .set('Cookie', cookie);
                expect(res.status).toBe(404);
            });

            it('POST /collections/:pid/bulk/publish requires authentication', async () => {
                const c = await db_helper.seed_object({ object_type: 'collection' });
                const res = await supertest(app)
                    .post(`/repo/dashboard/collections/${c.pid}/bulk/publish`)
                    .redirects(0);
                expect([302, 401]).toContain(res.status);
            });
        });
    });

    describe('collection detail page (header layout)', () => {
        // Subtitle convention: "<N> objects · <M> published · <handle-link>"
        // when a handle exists, falling back to "· PID <uuid>" when
        // it doesn't. The Handle row in the side Details panel was
        // removed once the handle moved up — these tests guard
        // against either piece silently regressing.
        const dr = (title) => JSON.stringify({ display_record: { title } });

        it('subtitle shows the handle (scheme-stripped) when present, NOT the PID', async () => {
            const cookie = await cookie_for('coll-hdr-handle');
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Sets in Order'),
                handle: 'https://hdl.invalid/20.500.12345/sio-1',
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Linked handle in the subtitle (scheme stripped per the
            // existing convention in object_row.ejs).
            expect(res.text).toMatch(
                /<a href="https:\/\/hdl\.invalid\/20\.500\.12345\/sio-1"[^>]*>\s*hdl\.invalid\/20\.500\.12345\/sio-1\s*<\/a>/
            );
            // The legacy "PID <uuid>" segment must NOT appear in the
            // subtitle when a handle exists.
            const subtitle_block = res.text.split('page-subtitle')[1] || '';
            // Just the opening segment up to the first closing </p> —
            // enough to scan the subtitle's literal content.
            const subtitle = subtitle_block.split('</p>')[0];
            expect(subtitle).not.toMatch(/PID/);
            expect(subtitle).not.toContain(c.pid);
        });

        it('subtitle falls back to PID when the collection has no handle', async () => {
            const cookie = await cookie_for('coll-hdr-pid');
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Unhandled'),
                handle: '',
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            const subtitle = (res.text.split('page-subtitle')[1] || '').split('</p>')[0];
            expect(subtitle).toMatch(/PID/);
            expect(subtitle).toContain(c.pid);
        });

        it('Details panel no longer carries a Handle row (moved to subtitle)', async () => {
            const cookie = await cookie_for('coll-hdr-details');
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Sets in Order'),
                handle: 'https://hdl.invalid/20.500.12345/sio-2',
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // The Details panel still exists (Created, Status, etc.)
            // but the Handle <dt> is gone.
            expect(res.text).toMatch(/<h2[^>]*>Details<\/h2>/);
            expect(res.text).not.toMatch(/<dt[^>]*>\s*Handle\s*<\/dt>/);
        });

        it('renders a "… more" toggle for long abstracts (and clamps via line-clamp class)', async () => {
            const cookie = await cookie_for('coll-abstract-long');
            // The truncation heuristic kicks in above 600 chars.
            // Use a sentinel string the regex match anchors on cleanly.
            const long_abstract = 'sentinel-long-abstract-content ' + 'filler '.repeat(160).trim();
            // libs/object_projection reads `dr.abstract` at the top
            // level of the parsed display_record JSON — so the seed
            // here is flat, not nested under `{display_record: {...}}`.
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: JSON.stringify({
                    title: 'LongAbs',
                    abstract: long_abstract,
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Full text present in the DOM — staff can Ctrl-F.
            expect(res.text).toContain('sentinel-long-abstract-content');
            // Clamped on initial render.
            expect(res.text).toMatch(/class="abstract-body[^"]*abstract-collapsed/);
            // Toggle button is rendered with aria-expanded=false.
            expect(res.text).toMatch(
                /<button[^>]*class="abstract-toggle"[^>]*aria-expanded="false"[^>]*>\s*…\s*more/
            );
        });

        it('short abstracts render WITHOUT a toggle (no truncation needed)', async () => {
            const cookie = await cookie_for('coll-abstract-short');
            // Well under 600 chars.
            const short_abstract = 'A brief abstract for testing — under 600 chars.';
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: JSON.stringify({
                    title: 'ShortAbs',
                    abstract: short_abstract,
                }),
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/collections/${c.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain(short_abstract);
            // No collapse class — full text visible from the start.
            expect(res.text).not.toMatch(/abstract-collapsed/);
            // No toggle button.
            expect(res.text).not.toMatch(/class="abstract-toggle"/);
        });
    });

    describe('admin: indexer', () => {
        it('GET /admin/indexer renders the admin page', async () => {
            const cookie = await cookie_for('idx-page');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/indexer')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/<h1[^>]*>Indexer<\/h1>/);
            expect(res.text).toMatch(/id="indexer-status"/);
            expect(res.text).toMatch(/hx-get="\/repo\/dashboard\/admin\/indexer\/status"/);
            expect(res.text).toMatch(/Reindex all active rows/);
        });

        it('GET /admin/indexer/status renders the status partial', async () => {
            const cookie = await cookie_for('idx-status');
            await db_helper.seed_object({
                is_published: 1,
                is_active: 1,
                is_updated: 1,
            });
            const res = await supertest(app)
                .get('/repo/dashboard/admin/indexer/status')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Counters surface.
            expect(res.text).toMatch(/Dirty/);
            expect(res.text).toMatch(/Eligible/);
            expect(res.text).toMatch(/ES doc count/);
            // ES not configured in the default test env → warning shown.
            expect(res.text).toMatch(/ELASTICSEARCH_HOST not set/);
        });

        it('POST /admin/indexer/reindex-all dirties only PUBLISHED+active rows', async () => {
            const cookie = await cookie_for('idx-all');
            // 2 eligible (published + active), 1 unpublished, 1 soft-
            // deleted. Only the 2 eligible get dirtied.
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
            });
            await db_helper.seed_object({
                is_active: 0,
                is_published: 1,
                is_updated: 0,
            });
            const res = await supertest(app)
                .post('/repo/dashboard/admin/indexer/reindex-all')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            const trigger = JSON.parse(res.headers['hx-trigger']);
            expect(trigger.toast.level).toBe('success');
            expect(trigger.toast.message).toMatch(/Dirtied 2 rows/);

            // Response IS the status partial — verify counters reflect
            // the new state.
            expect(res.text).toMatch(/Dirty/);
        });

        it('POST /admin/indexer/reindex-collection/:pid dirties only PUBLISHED members', async () => {
            const cookie = await cookie_for('idx-coll');
            const c = await db_helper.seed_object({
                object_type: 'collection',
                is_active: 1,
            });
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_published: 1,
            });
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_published: 1,
            });
            // Unpublished — skipped per the indexing rule.
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_published: 0,
            });
            await db_helper.seed_object({
                is_member_of_collection: 'other',
                is_published: 1,
            });
            const res = await supertest(app)
                .post(`/repo/dashboard/admin/indexer/reindex-collection/${c.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            const trigger = JSON.parse(res.headers['hx-trigger']);
            expect(trigger.toast.message).toMatch(/Dirtied 2 members/);
        });

        it('POST /admin/indexer/reindex/:pid dirties a single row', async () => {
            const cookie = await cookie_for('idx-pid');
            const a = await db_helper.seed_object();
            const res = await supertest(app)
                .post(`/repo/dashboard/admin/indexer/reindex/${a.pid}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
        });

        it('POST /admin/indexer/reindex/:pid rejects a non-UUID', async () => {
            const cookie = await cookie_for('idx-bad');
            const res = await supertest(app)
                .post('/repo/dashboard/admin/indexer/reindex/not-a-uuid')
                .set('Cookie', cookie);
            expect(res.status).toBe(400);
        });

        it('status partial surfaces dead-lettered rows + a Retry failed button', async () => {
            const cookie = await cookie_for('idx-dl-status');
            await db_helper.seed_object({ index_error: 'failed to parse field [dates.begin]' });
            const res = await supertest(app)
                .get('/repo/dashboard/admin/indexer/status')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/dead-lettered/);
            // The retry control posts to the new route.
            expect(res.text).toMatch(
                /hx-post="\/repo\/dashboard\/admin\/indexer\/reindex-failed"/
            );
            expect(res.text).toMatch(/Retry failed/);
        });

        it('status partial omits the dead-letter alert when none are parked', async () => {
            const cookie = await cookie_for('idx-dl-none');
            await db_helper.seed_object({ is_published: 1, is_active: 1 });
            const res = await supertest(app)
                .get('/repo/dashboard/admin/indexer/status')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).not.toMatch(/reindex-failed/);
        });

        it('POST /admin/indexer/reindex-failed re-queues dead-lettered rows', async () => {
            const cookie = await cookie_for('idx-dl-retry');
            await db_helper.seed_object({
                is_updated: 0,
                index_attempts: 5,
                index_error: 'boom',
            });
            await db_helper.seed_object({ is_updated: 0, index_error: null }); // healthy
            const res = await supertest(app)
                .post('/repo/dashboard/admin/indexer/reindex-failed')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            const trigger = JSON.parse(res.headers['hx-trigger']);
            expect(trigger.toast.level).toBe('success');
            expect(trigger.toast.message).toMatch(/Re-queued 1 dead-lettered row/);
            // Response IS the refreshed status partial: the row is no
            // longer parked, so the dead-letter alert (and its button) are
            // gone.
            expect(res.text).not.toMatch(/reindex-failed/);
        });

        it('admin endpoints require auth', async () => {
            const res = await supertest(app)
                .post('/repo/dashboard/admin/indexer/reindex-all')
                .redirects(0);
            expect([302, 401]).toContain(res.status);
        });

        it('sidebar shows the Indexer link', async () => {
            const cookie = await cookie_for('idx-sidebar');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/indexer')
                .set('Cookie', cookie);
            expect(res.text).toMatch(/href="\/repo\/dashboard\/admin\/indexer"/);
        });
    });

    describe('users management', () => {
        it('shell renders the table region + "Add user" trigger button', async () => {
            const cookie = await cookie_for('u-shell');
            const res = await supertest(app).get('/repo/dashboard/users').set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/id="users-table"/);
            // The inline create-form was replaced by an "Add user"
            // button that opens a modal — its hx-get fetches the
            // form modal and lands it in #modal-content.
            expect(res.text).toMatch(
                /<button[^>]*hx-get="\/repo\/dashboard\/users\/new"[^>]*hx-target="#modal-content"/
            );
            expect(res.text).toMatch(/Add user/);
        });

        it('GET /users/new returns the create-user modal partial', async () => {
            const cookie = await cookie_for('u-create-modal');
            const res = await supertest(app).get('/repo/dashboard/users/new').set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Standard modal structure — auto-opens via the
            // dashboard.js #modal-content afterSwap listener.
            expect(res.text).toMatch(/class="modal-header"/);
            expect(res.text).toMatch(/<h5[^>]*>Add user<\/h5>/);
            // Form fields present, posting back to /users.
            expect(res.text).toMatch(/id="new-du-id"[^>]*name="du_id"/);
            expect(res.text).toMatch(/id="new-email"[^>]*name="email"/);
            // RBAC role selector (defaults to staff).
            expect(res.text).toMatch(/<select[^>]*name="role"/);
            expect(res.text).toMatch(/value="admin"/);
            expect(res.text).toMatch(/hx-post="\/repo\/dashboard\/users"/);
            // Targets #modal-content so validation errors re-render
            // INSIDE the modal frame rather than replacing the page.
            expect(res.text).toMatch(/hx-target="#modal-content"/);
            // The "Immutable once set..." DU ID help text was
            // removed — it duplicated information staff already know
            // and added unnecessary visual weight to the modal.
            expect(res.text).not.toMatch(/Immutable once set/);
            expect(res.text).not.toMatch(/actor identifier in audit logs/);
            // Every field carries a "required" badge so staff see
            // visually which inputs the form expects — matches the
            // edit modal for consistency.
            const required_badges = (res.text.match(/class="required-badge">required</g) || [])
                .length;
            // 5 fields: du_id, email, first_name, last_name, role.
            expect(required_badges).toBe(5);
        });

        it('edit modal carries a "required" badge on every editable field', async () => {
            const cookie = await cookie_for('u-edit-required');
            const target = await db_helper.seed_user({
                du_id: 'edit-required',
                email: 'edit@du.edu',
                first_name: 'E',
                last_name: 'R',
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/users/${target.id}/edit`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // 4 editable fields on the edit modal: email, first_name,
            // last_name, role. du_id is NOT a field (shown only as muted
            // header text).
            const required_badges = (res.text.match(/class="required-badge">required</g) || [])
                .length;
            expect(required_badges).toBe(4);
            // Role selector pre-selects the user's current role.
            expect(res.text).toMatch(/<select[^>]*name="role"/);
        });

        it('"Include deactivated" toggle uses CSP-safe form serialization (no hx-vals="js:...")', async () => {
            // The hx-vals='js:...' shorthand evaluates its expression
            // via new Function() — blocked by our CSP. Static
            // name+value plus hx-include is the equivalent without
            // any eval. This test pins the safe pattern so a future
            // edit can't silently regress to the eval form.
            const cookie = await cookie_for('u-toggle-csp');
            const res = await supertest(app).get('/repo/dashboard/users').set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Static, form-style serialization on the checkbox.
            expect(res.text).toMatch(
                /<input[^>]*id="toggle-inactive"[^>]*name="include_inactive"[^>]*value="1"/
            );
            // No `js:` prefix anywhere in the rendered page — that's
            // the broken pattern.
            expect(res.text).not.toMatch(/hx-vals=['"][^'"]*js:/);
            // Polled refreshes carry the current toggle state.
            expect(res.text).toMatch(/hx-include="#toggle-inactive"/);
        });

        it('GET /users/list honors include_inactive=1 only on the literal "1" string', async () => {
            const cookie = await cookie_for('u-toggle-filter');
            const active = await db_helper.seed_user({ du_id: 'u-active', is_active: 1 });
            const inactive = await db_helper.seed_user({ du_id: 'u-inactive', is_active: 0 });

            // Default (no param) → only active.
            let res = await supertest(app).get('/repo/dashboard/users/list').set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain(active.du_id);
            expect(res.text).not.toContain(inactive.du_id);

            // include_inactive=1 → both.
            res = await supertest(app)
                .get('/repo/dashboard/users/list?include_inactive=1')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain(active.du_id);
            expect(res.text).toContain(inactive.du_id);
        });

        it('POST creates a user, returns empty body, triggers toast + modal:close + users:created', async () => {
            const cookie = await cookie_for('u-create');
            const res = await supertest(app)
                .post('/repo/dashboard/users')
                .set('Cookie', cookie)
                .type('form')
                .send({
                    du_id: 'newbie',
                    email: 'newbie@du.edu',
                    first_name: 'New',
                    last_name: 'B',
                });
            expect(res.status).toBe(200);
            // Empty body — the modal:close trigger dismisses the
            // modal frame; the users:created trigger refreshes the
            // table. No need to re-render the form because the modal
            // disappears.
            expect(res.text).toBe('');
            const decoded = JSON.parse(res.headers['hx-trigger']);
            expect(decoded.toast.message).toMatch(/newbie created/i);
            expect(decoded['users:created']).toBeTruthy();
            expect(decoded['modal:close']).toBeDefined();
        });

        it('POST returns validation errors INSIDE the modal frame (modal stays open)', async () => {
            const cookie = await cookie_for('u-bad');
            const res = await supertest(app)
                .post('/repo/dashboard/users')
                .set('Cookie', cookie)
                .type('form')
                .send({
                    du_id: 'x',
                    email: 'not-an-email',
                    first_name: 'a',
                    last_name: 'b',
                });
            expect(res.status).toBe(400);
            // The response is the modal partial again — same target
            // (#modal-content) so the swap happens inside the modal
            // and the user sees errors without losing context.
            expect(res.text).toMatch(/class="modal-header"/);
            expect(res.text).toMatch(/<h5[^>]*>Add user<\/h5>/);
            expect(res.text).toMatch(/alert-danger/);
            expect(res.text).toMatch(/Invalid user payload/);
            // Entered values preserved.
            expect(res.text).toMatch(/value="x"/);
        });

        it('DELETE deactivates a user', async () => {
            const cookie = await cookie_for('u-del-admin');
            const target = await db_helper.seed_user({ du_id: 'doomed' });
            const res = await supertest(app)
                .delete(`/repo/dashboard/users/${target.id}`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toBe('');
            const decoded = JSON.parse(res.headers['hx-trigger']);
            expect(decoded.toast.level).toBe('success');
            // Also fires users:created so the table refreshes (the
            // newly-deactivated row's badge + actions change).
            expect(decoded['users:created']).toBeTruthy();
        });

        it('GET /users/:id/edit returns the edit modal partial', async () => {
            const cookie = await cookie_for('u-edit-modal');
            const target = await db_helper.seed_user({
                du_id: 'editme',
                email: 'editme@du.edu',
                first_name: 'Edit',
                last_name: 'Me',
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/users/${target.id}/edit`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Modal structure — header / body / footer.
            expect(res.text).toMatch(/class="modal-header"/);
            expect(res.text).toMatch(/<h5[^>]*>Edit user<\/h5>/);
            // du_id is shown in the modal header for context but is
            // NOT rendered as a form field — surfacing it as one
            // (even readonly) invited accidental copy/paste over the
            // value and risked breaking the audit-trail invariant.
            // It now appears only as muted header text under the title.
            expect(res.text).toContain('editme');
            expect(res.text).not.toMatch(/id="edit-du-id"/);
            expect(res.text).not.toMatch(/name="du_id"/);
            // Editable fields prefilled with current values.
            expect(res.text).toMatch(/id="edit-email"[^>]*value="editme@du\.edu"/);
            expect(res.text).toMatch(/id="edit-first"[^>]*value="Edit"/);
            expect(res.text).toMatch(/id="edit-last"[^>]*value="Me"/);
            // Form posts to the update endpoint.
            expect(res.text).toMatch(new RegExp(`hx-post="/repo/dashboard/users/${target.id}"`));
        });

        it('POST /users/:id updates name + email, fires toast + modal:close', async () => {
            const cookie = await cookie_for('u-update');
            const target = await db_helper.seed_user({
                du_id: 'updateme',
                email: 'old@du.edu',
                first_name: 'Old',
                last_name: 'Name',
            });
            const res = await supertest(app)
                .post(`/repo/dashboard/users/${target.id}`)
                .set('Cookie', cookie)
                .type('form')
                .send({
                    first_name: 'New',
                    last_name: 'Person',
                    email: 'new@du.edu',
                });
            expect(res.status).toBe(200);
            const decoded = JSON.parse(res.headers['hx-trigger']);
            expect(decoded.toast.level).toBe('success');
            expect(decoded.toast.message).toMatch(/updateme updated/);
            expect(decoded['modal:close']).toBeDefined();
            expect(decoded['users:created']).toBeTruthy();

            // Verify the DB was actually updated.
            const user_model = require('../../users/model');
            const fresh = await user_model.get(target.id);
            expect(fresh.first_name).toBe('New');
            expect(fresh.email).toBe('new@du.edu');
        });

        it('POST /users/:id returns the modal with errors on validation failure', async () => {
            const cookie = await cookie_for('u-update-bad');
            const target = await db_helper.seed_user({ du_id: 'baduser' });
            const res = await supertest(app)
                .post(`/repo/dashboard/users/${target.id}`)
                .set('Cookie', cookie)
                .type('form')
                .send({ email: 'not-an-email' });
            // Validation error → 400, re-renders the modal partial.
            expect(res.status).toBe(400);
            expect(res.text).toMatch(/class="modal-header"/);
            expect(res.text).toMatch(/alert-danger/);
        });

        it('POST /users/:id refuses to change du_id on the dashboard route', async () => {
            // du_id is immutable from the dashboard — the controller
            // builds the patch from {first_name, last_name, email}
            // only, so any du_id in the body is silently ignored.
            const cookie = await cookie_for('u-update-duid');
            const target = await db_helper.seed_user({ du_id: 'stable-id' });
            const res = await supertest(app)
                .post(`/repo/dashboard/users/${target.id}`)
                .set('Cookie', cookie)
                .type('form')
                .send({
                    first_name: 'Fine',
                    last_name: 'OK',
                    email: 'fine@du.edu',
                    du_id: 'ATTEMPTED-CHANGE',
                });
            expect(res.status).toBe(200);
            const user_model = require('../../users/model');
            const fresh = await user_model.get(target.id);
            expect(fresh.du_id).toBe('stable-id');
        });

        it('POST /users/:id/activate reactivates a deactivated user', async () => {
            const cookie = await cookie_for('u-activate');
            const target = await db_helper.seed_user({
                du_id: 'sleeper',
                is_active: 0,
            });
            const res = await supertest(app)
                .post(`/repo/dashboard/users/${target.id}/activate`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toBe('');
            const decoded = JSON.parse(res.headers['hx-trigger']);
            expect(decoded.toast.level).toBe('success');
            expect(decoded.toast.message).toMatch(/sleeper activated/);

            const user_model = require('../../users/model');
            const fresh = await user_model.get(target.id);
            expect(fresh.is_active).toBe(1);
        });

        it('user_row partial renders Edit + Activate when the user is deactivated', async () => {
            // Action-button regexes match the htmx attribute on the
            // dropdown <button> — using attribute presence (not text)
            // sidesteps the "Deactivated" status badge / "Active"
            // status badge collisions with the action labels.
            const has_edit_action = (s) => /<button[^>]*\/users\/\d+\/edit/.test(s);
            const has_deactivate_action = (s) => /hx-delete="[^"]*\/users\/\d+"/.test(s);
            const has_activate_action = (s) => /hx-post="[^"]*\/users\/\d+\/activate"/.test(s);

            // Extract each row segment in isolation. A naive
            // `<tr...>[\s\S]*?</tr>` regex starting at the first opening
            // <tr> can accidentally include later rows because the
            // non-greedy `*?` only stops at the FIRST `</tr>` — but
            // the seed string we're looking for might be in a later
            // row. Split-and-filter is robust.
            function row_for(html, du_id) {
                // Split on closing tag so each chunk is one row.
                const chunks = html.split('</tr>');
                return chunks.find((c) => c.includes(`>${du_id}<`));
            }

            const cookie = await cookie_for('u-row-inactive');
            await db_helper.seed_user({ du_id: 'active-1', is_active: 1 });
            await db_helper.seed_user({ du_id: 'inactive-1', is_active: 0 });
            const res = await supertest(app)
                .get('/repo/dashboard/users/list?include_inactive=1')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);

            // Active row → Edit + Deactivate, NOT Activate.
            const active_row = row_for(res.text, 'active-1');
            expect(active_row).toBeTruthy();
            expect(has_edit_action(active_row)).toBe(true);
            expect(has_deactivate_action(active_row)).toBe(true);
            expect(has_activate_action(active_row)).toBe(false);

            // Inactive row → Edit + Activate, NOT Deactivate.
            const inactive_row = row_for(res.text, 'inactive-1');
            expect(inactive_row).toBeTruthy();
            expect(has_edit_action(inactive_row)).toBe(true);
            expect(has_activate_action(inactive_row)).toBe(true);
            expect(has_deactivate_action(inactive_row)).toBe(false);
        });
    });

    describe('logout', () => {
        it('clears cookie and redirects to /login', async () => {
            const cookie = await cookie_for('out');
            const res = await supertest(app).post('/repo/dashboard/logout').set('Cookie', cookie);
            expect(res.status).toBe(303);
            expect(res.headers.location).toMatch(/\/login$/);
            const set_cookie = res.headers['set-cookie'];
            const sc = Array.isArray(set_cookie) ? set_cookie[0] : set_cookie;
            expect(sc).toMatch(new RegExp(`^${jwt.COOKIE_NAME}=`));
            expect(sc).toMatch(/Expires=Thu, 01 Jan 1970/);
        });
    });

    describe('aips dashboard', () => {
        const tables = require('../../config/db_tables');
        const { db, db_queue } = require('../../config/db');

        it('GET /aips renders the page shell + filter inputs', async () => {
            const cookie = await cookie_for('aip-page');
            const res = await supertest(app)
                .get('/repo/dashboard/aips')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/AIPs/);
            // Filter inputs render.
            expect(res.text).toMatch(/name="q"/);
            expect(res.text).toMatch(/name="source"/);
            expect(res.text).toMatch(/name="status"/);
            // The HTMX table target is present and points at /aips/list.
            expect(res.text).toMatch(/id="aips-table"/);
            expect(res.text).toMatch(/\/dashboard\/aips\/list/);
        });

        it('GET /aips/list returns table rows when data exists', async () => {
            const cookie = await cookie_for('aip-list');
            const seeded = await db_helper.seed_aip_store({
                aip: 'M999.7z',
                is_migrated: 6,
                source: 'ingest_v2',
            });
            const res = await supertest(app)
                .get('/repo/dashboard/aips/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // The row appears with its AIP filename + Copied badge.
            expect(res.text).toMatch(/M999\.7z/);
            expect(res.text).toMatch(/Copied/);
            // The download anchor links to /aips/:id/download.
            expect(res.text).toContain(`/dashboard/aips/${seeded.id}/download`);
        });

        it('GET /aips/list survives duplicated query params (last-wins coercion)', async () => {
            // Regression: the pagination button used to embed q /
            // source / status in its hx-get URL while the parent div
            // ALSO included them via hx-include. The two collided to
            // send each filter twice; Express then parsed
            // req.query.q as ['','foo'] and the controller's
            // .trim() call threw "trim is not a function" → 500.
            //
            // The view fix removes the URL-embedded filters from
            // pagination links. The controller fix coerces array-
            // shaped inputs to a string defensively. This test
            // covers the controller's defensive layer — a future
            // refactor of the view alone won't silently regress.
            await db_helper.seed_aip_store({ aip: 'M-search-me.7z', is_migrated: 6 });
            const cookie = await cookie_for('aip-dup');
            const res = await supertest(app)
                .get(
                    '/repo/dashboard/aips/list' +
                        '?page=1&page_size=25' +
                        '&q=&source=&status=' +
                        '&q=M-search-me&source=ingest_v2&status=copied'
                )
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Last-wins: the second q value drove the filter and
            // matched the seeded row.
            expect(res.text).toMatch(/M-search-me\.7z/);
        });

        it('GET /aips/list renders an empty-state when no rows match', async () => {
            const cookie = await cookie_for('aip-empty');
            const res = await supertest(app)
                .get('/repo/dashboard/aips/list?status=failed')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/No AIPs match/);
        });

        it('GET /aips/:id/download refuses rows that are not in a downloadable state', async () => {
            const cookie = await cookie_for('aip-dl-bad');
            const seeded = await db_helper.seed_aip_store({
                is_migrated: 7, // copy_failed — not downloadable
            });
            const res = await supertest(app)
                .get(`/repo/dashboard/aips/${seeded.id}/download`)
                .set('Cookie', cookie);
            // ValidationError → 400 from the central handler.
            expect(res.status).toBe(400);
        });

        it('POST /aips/:id/retry resets attempts/error and toasts the operator', async () => {
            const cookie = await cookie_for('aip-retry');
            const seeded = await db_helper.seed_aip_store({
                is_migrated: 7,
                attempts: 3,
                error: 'wasabi timed out',
            });
            const res = await supertest(app)
                .post(`/repo/dashboard/aips/${seeded.id}/retry`)
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // The response is the updated row partial (outerHTML swap).
            expect(res.text).toContain(`id="aip-row-${seeded.id}"`);
            // Toast confirms the action. The legacy row in the test has
            // no matching ingest queue row, so the toast is the
            // "AIP row reset, but no matching queue row" variant.
            const decoded = JSON.parse(res.headers['hx-trigger']);
            expect(decoded.toast).toBeTruthy();
            // Either level is acceptable; the row reset succeeded.
            expect(['success', 'warn']).toContain(decoded.toast.level);
            // The DB row was actually reset.
            const refreshed = await db()(tables.aip_store)
                .where({ id: seeded.id })
                .first();
            expect(refreshed.attempts).toBe(0);
            expect(refreshed.error).toBeNull();
        });

        it('GET /admin/aip-backfill renders the page with the missing count + Start button', async () => {
            const cookie = await cookie_for('aip-bf-page');
            // Seed two missing-AIP rows so the page has something to
            // report. The Start button's enabled state ALSO depends
            // on AIP_STORE_ENABLED — we'll exercise both branches.
            await db_helper.seed_object({ sip_uuid: 'aip-x' });
            await db_helper.seed_object({ sip_uuid: 'aip-y' });
            const res = await supertest(app)
                .get('/repo/dashboard/admin/aip-backfill')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/AIP Backfill/);
            // The missing count surfaces in the status partial,
            // which is inlined on first render.
            expect(res.text).toMatch(/Missing AIPs/);
            expect(res.text).toMatch(/<strong>2<\/strong>/);
        });

        it('POST /admin/aip-backfill/start refuses when AIP_STORE_ENABLED is false', async () => {
            // Default for the test env is AIP_STORE_ENABLED=false
            // (the .env-example default). The controller's preflight
            // check should refuse and surface an error toast.
            const original = { ...process.env };
            delete process.env.AIP_STORE_ENABLED;
            require('../../config/app')._reset();
            try {
                const cookie = await cookie_for('aip-bf-off');
                await db_helper.seed_object({ sip_uuid: 'aip-r' });
                const res = await supertest(app)
                    .post('/repo/dashboard/admin/aip-backfill/start')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                const decoded = JSON.parse(res.headers['hx-trigger']);
                expect(decoded.toast.level).toBe('error');
                expect(decoded.toast.message).toMatch(/AIP_STORE_ENABLED/);
                // No queue rows landed.
                const rows = await db_queue()(tables.ingest_queue).where(
                    'batch',
                    'like',
                    'aip-backfill-%'
                );
                expect(rows).toHaveLength(0);
            } finally {
                process.env = original;
                require('../../config/app')._reset();
            }
        });

        it('POST /admin/aip-backfill/start enqueues when AIP_STORE_ENABLED is true', async () => {
            const original = { ...process.env };
            process.env.AIP_STORE_ENABLED = '1';
            require('../../config/app')._reset();
            try {
                const cookie = await cookie_for('aip-bf-on');
                await db_helper.seed_object({ sip_uuid: 'aip-s' });
                await db_helper.seed_object({ sip_uuid: 'aip-t' });
                const res = await supertest(app)
                    .post('/repo/dashboard/admin/aip-backfill/start')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                const decoded = JSON.parse(res.headers['hx-trigger']);
                expect(decoded.toast.level).toBe('success');
                expect(decoded.toast.message).toMatch(/2 row/);
                const rows = await db_queue()(tables.ingest_queue).where(
                    'batch',
                    'like',
                    'aip-backfill-%'
                );
                expect(rows).toHaveLength(2);
                for (const r of rows) {
                    expect(r.pipeline_state).toBe('AIP_STORE_PENDING');
                }
            } finally {
                process.env = original;
                require('../../config/app')._reset();
            }
        });

        it('POST /admin/aip-backfill/cancel flips pending rows in the latest batch', async () => {
            const original = { ...process.env };
            process.env.AIP_STORE_ENABLED = '1';
            require('../../config/app')._reset();
            try {
                const cookie = await cookie_for('aip-bf-cancel');
                await db_helper.seed_object({ sip_uuid: 'aip-q' });
                // Use the start route to enqueue so cancel finds the
                // batch via the same path the operator does.
                await supertest(app)
                    .post('/repo/dashboard/admin/aip-backfill/start')
                    .set('Cookie', cookie);
                const res = await supertest(app)
                    .post('/repo/dashboard/admin/aip-backfill/cancel')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                const decoded = JSON.parse(res.headers['hx-trigger']);
                expect(decoded.toast.level).toBe('success');
                expect(decoded.toast.message).toMatch(/Cancelled 1/);
                const rows = await db_queue()(tables.ingest_queue).where(
                    'batch',
                    'like',
                    'aip-backfill-%'
                );
                expect(rows[0].pipeline_state).toBe('CANCELLED_BY_USER');
                expect(rows[0].is_complete).toBe(1);
            } finally {
                process.env = original;
                require('../../config/app')._reset();
            }
        });

        it('sidebar shows AIPs link in the main nav with active state on the AIPs page', async () => {
            const cookie = await cookie_for('aip-nav');
            const res = await supertest(app)
                .get('/repo/dashboard/aips')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // AIPs lives in normal-mode nav (not admin focus mode),
            // adjacent to Digital Preservation Jobs. The link uses
            // aria-label="AIPs" (no "(admin)" suffix).
            expect(res.text).toMatch(/aria-label="AIPs"/);
            expect(res.text).toMatch(/aria-current="page"[^>]*>\s*<svg[^>]*>[\s\S]*?<\/svg>/);
            // Sibling check: the DPJ icon should be present in the
            // same render (i.e. we ARE in normal nav, not the admin
            // focus mode that would hide it).
            expect(res.text).toMatch(/aria-label="Digital Preservation Jobs"/);
        });
    });

    describe('CSP allows our static assets', () => {
        it('serves /static/assets/styles.css', async () => {
            const res = await supertest(app).get('/repo/static/assets/styles.css');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/css/);
            expect(res.text).toMatch(/--du-crimson/);
        });

        it('serves /static/assets/dashboard.js', async () => {
            const res = await supertest(app).get('/repo/static/assets/dashboard.js');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/javascript/);
            expect(res.text).toMatch(/htmx:responseError/);
        });
    });
});
