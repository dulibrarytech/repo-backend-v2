'use strict';

// E2E tests for the three pre-ingest workspace pages (MDO, ASpace QA,
// Packaging). Most assertions target page chrome + sidebar active
// state + presence of workspace controls — the deeper behavior is
// covered by the workspace integration tests.
//
// We don't have a live curation-API in tests, so the workspace list
// renders the "not configured" error envelope inline (CURATION_API +
// CURATION_API_KEY are absent). That's actually useful: lets us
// assert the dashboard handles the error gracefully.

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');

let app;

async function cookie_for(du_id) {
    const u = await db_helper.seed_user({ du_id });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
}

describe('ingest workspace pages — e2e', () => {
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

    describe('GET /dashboard/ingest/workspace (Make Digital Objects)', () => {
        it('redirects unauthed users to login', async () => {
            const res = await supertest(app).get('/repo/dashboard/ingest/workspace');
            expect(res.status).toBe(302);
        });

        it('renders the MDO page with sidebar marking MDO active', async () => {
            const cookie = await cookie_for('mdo-1');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/workspace')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Make Digital Objects');
            expect(res.text).toContain('workspace-action-spinner');
            // Sidebar's Make Digital Objects item is the active one
            // (both .active class and SR-perceivable aria-current).
            expect(res.text).toMatch(
                /<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="Make Digital Objects"/
            );
        });

        it('sidebar expands to show all four workflow icons when in MDO', async () => {
            // In-workflow: MDO entry expands to MDO + QA + Packaging + Queue.
            const cookie = await cookie_for('mdo-sidebar');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/workspace')
                .set('Cookie', cookie);
            expect(res.text).toContain('title="Make Digital Objects"');
            expect(res.text).toContain('title="ASpace Description QA"');
            expect(res.text).toContain('title="Packaging and Ingesting"');
            expect(res.text).toContain('title="Queue (ingest in progress)"');
            // Collapsed entry icon should be replaced by the full set.
            expect(res.text).not.toContain('title="Digital Preservation Jobs"');
        });
    });

    describe('sidebar context-awareness', () => {
        it('shows only the "Digital Preservation Jobs" entry icon when outside the workflow', async () => {
            // /dashboard/ home has active='home' — not in the workflow.
            const cookie = await cookie_for('side-collapsed');
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Entry icon present and points to the MDO landing page.
            expect(res.text).toContain('title="Digital Preservation Jobs"');
            expect(res.text).toMatch(
                /href="[^"]*\/dashboard\/ingest\/workspace"[^>]*title="Digital Preservation Jobs"/
            );
            // None of the four workflow icons should render here.
            expect(res.text).not.toContain('title="Make Digital Objects"');
            expect(res.text).not.toContain('title="ASpace Description QA"');
            expect(res.text).not.toContain('title="Packaging and Ingesting"');
            expect(res.text).not.toContain('title="Queue (ingest in progress)"');
        });

        it('expands the workflow on ASpace QA + Packaging + Queue too', async () => {
            const cookie = await cookie_for('side-expanded');
            for (const path of [
                '/repo/dashboard/ingest/aspace-qa',
                '/repo/dashboard/ingest/packaging',
                '/repo/dashboard/ingest',
            ]) {
                const res = await supertest(app).get(path).set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).toContain('title="Make Digital Objects"');
                expect(res.text).toContain('title="ASpace Description QA"');
                expect(res.text).toContain('title="Packaging and Ingesting"');
                expect(res.text).toContain('title="Queue (ingest in progress)"');
                expect(res.text).not.toContain('title="Digital Preservation Jobs"');
            }
        });

        it('hides non-workflow nav items in focus mode (keeps Home + workflow icons only)', async () => {
            // In focus mode the sidebar shows Home + the four workflow
            // icons + History. Collections, Objects, Users, Indexer,
            // and Metadata Refresh stay hidden so the sidebar reads as
            // a focused pipeline. Home is kept as an escape hatch
            // alongside the "← Collection Management" page-header
            // back-link (added in task #114 — Home gives a one-click
            // jump to the dashboard root from any workflow view).
            const cookie = await cookie_for('side-focus');
            for (const path of [
                '/repo/dashboard/ingest/workspace',
                '/repo/dashboard/ingest/aspace-qa',
                '/repo/dashboard/ingest/packaging',
                '/repo/dashboard/ingest',
            ]) {
                const res = await supertest(app).get(path).set('Cookie', cookie);
                expect(res.status).toBe(200);
                // Hidden in focus mode.
                expect(res.text).not.toContain('title="Collections"');
                expect(res.text).not.toContain('title="Objects (flat browse)"');
                expect(res.text).not.toContain('title="Users"');
                expect(res.text).not.toContain('title="Admin Utils"');
                expect(res.text).not.toContain('title="Indexer (admin)"');
                expect(res.text).not.toContain('title="Metadata Refresh (admin)"');
                expect(res.text).not.toContain('title="Services Health (admin)"');
                // Home stays visible as the escape hatch.
                expect(res.text).toContain('title="Home"');
            }
        });

        it('Home icon links to /dashboard/ root from every workflow view', async () => {
            const cookie = await cookie_for('side-home-link');
            for (const path of [
                '/repo/dashboard/ingest/workspace',
                '/repo/dashboard/ingest/aspace-qa',
                '/repo/dashboard/ingest/packaging',
                '/repo/dashboard/ingest',
                '/repo/dashboard/ingest/history',
            ]) {
                const res = await supertest(app).get(path).set('Cookie', cookie);
                expect(res.status).toBe(200);
                // The Home <a> in the workflow sidebar points at
                // /repo/dashboard/ (the dashboard root), giving a
                // one-click exit from focus mode.
                expect(res.text).toMatch(/<a href="\/repo\/dashboard\/"[^>]*title="Home"/);
            }
        });

        it('Home icon precedes the workflow icons (positioned above in the sidebar)', async () => {
            const cookie = await cookie_for('side-home-order');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/workspace')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            const home_pos = res.text.indexOf('title="Home"');
            const mdo_pos = res.text.indexOf('title="Make Digital Objects"');
            expect(home_pos).toBeGreaterThan(-1);
            expect(mdo_pos).toBeGreaterThan(-1);
            // Home renders BEFORE the workspace icons.
            expect(home_pos).toBeLessThan(mdo_pos);
        });

        it('renders "← Collection Management" back-link on every workflow page', async () => {
            // Matches the pattern from views/dashboard/collection_detail.ejs
            // ("← All collections"). The link is the only way OUT of
            // the workflow when focus mode is active.
            const cookie = await cookie_for('back-link');
            for (const path of [
                '/repo/dashboard/ingest/workspace',
                '/repo/dashboard/ingest/aspace-qa',
                '/repo/dashboard/ingest/packaging',
                '/repo/dashboard/ingest',
            ]) {
                const res = await supertest(app).get(path).set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).toMatch(
                    /<a href="[^"]*\/dashboard\/collections"[^>]*>← Collection Management<\/a>/
                );
            }
        });

        it('home page (out of workflow) keeps the standard sidebar items', async () => {
            const cookie = await cookie_for('side-standard');
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('title="Home"');
            expect(res.text).toContain('title="Collections"');
            expect(res.text).toContain('title="Objects (flat browse)"');
            expect(res.text).toContain('title="Users"');
            expect(res.text).toContain('title="Digital Preservation Jobs"');
            // Admin Utils is the single entry icon for the admin tools
            // (Indexer / Metadata Refresh / Services Health). The three
            // tool icons themselves are only visible IN admin focus mode.
            expect(res.text).toContain('title="Admin Utils"');
            expect(res.text).not.toContain('title="Indexer (admin)"');
            expect(res.text).not.toContain('title="Metadata Refresh (admin)"');
            expect(res.text).not.toContain('title="Services Health (admin)"');
        });

        it('out-of-workflow sidebar order is Home → Collections → Objects → DPJ → Users → Admin Utils', async () => {
            const cookie = await cookie_for('side-order');
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            const expected = [
                'title="Home"',
                'title="Collections"',
                'title="Objects (flat browse)"',
                'title="Digital Preservation Jobs"',
                'title="Users"',
                'title="Admin Utils"',
            ];
            // Each title appears later in the HTML than the previous
            // one. Capture any missing titles up-front so the failure
            // message points at WHICH item is absent.
            const positions = expected.map((needle) => res.text.indexOf(needle));
            const missing = expected.filter((_, i) => positions[i] === -1);
            expect(missing).toEqual([]);
            const sorted = [...positions].sort((a, b) => a - b);
            expect(positions).toEqual(sorted);
        });

        it('Admin Utils icon points at /admin/indexer (first tool, same shape as DPJ → workspace)', async () => {
            const cookie = await cookie_for('side-admin-link');
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            expect(res.text).toMatch(
                /href="[^"]*\/dashboard\/admin\/indexer"[^>]*title="Admin Utils"/
            );
        });
    });

    describe('admin focus mode (in_admin sidebar)', () => {
        // In admin context the sidebar mirrors workflow mode: Home
        // escape at top, then the admin tool icons (Indexer / Metadata
        // Refresh / Services Health). Collections / Objects / Users /
        // DPJ stay hidden to preserve focus.

        for (const [adminPath, activePage] of [
            ['/repo/dashboard/admin/indexer', 'Indexer (admin)'],
            ['/repo/dashboard/admin/services', 'Services Health (admin)'],
        ]) {
            it(`renders the 3-tool admin sidebar on ${adminPath} and hides standard nav`, async () => {
                const cookie = await cookie_for('admin-side-' + activePage);
                const res = await supertest(app).get(adminPath).set('Cookie', cookie);
                expect(res.status).toBe(200);
                // The 3 admin icons appear.
                expect(res.text).toContain('title="Indexer (admin)"');
                expect(res.text).toContain('title="Metadata Refresh (admin)"');
                expect(res.text).toContain('title="Services Health (admin)"');
                // Home escape stays.
                expect(res.text).toContain('title="Home"');
                // Standard nav items are hidden (focus mode).
                expect(res.text).not.toContain('title="Collections"');
                expect(res.text).not.toContain('title="Objects (flat browse)"');
                expect(res.text).not.toContain('title="Users"');
                expect(res.text).not.toContain('title="Digital Preservation Jobs"');
                // Admin Utils single icon is replaced by the three tool icons.
                expect(res.text).not.toContain('title="Admin Utils"');
                // Active marker on the current tool. Anchor on the
                // aria-label since attribute order in the EJS template
                // is no longer adjacent (aria-current + aria-label sit
                // between class and title).
                const escaped = activePage.replace(/[()]/g, '\\$&');
                expect(res.text).toMatch(
                    new RegExp(`<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="${escaped}"`)
                );
            });
        }
    });

    describe('GET /dashboard/ingest/aspace-qa', () => {
        it('renders the ASpace QA page with sidebar marking it active', async () => {
            const cookie = await cookie_for('qa-1');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/aspace-qa')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('ASpace Description QA');
            expect(res.text).toContain('qa-action-spinner');
            expect(res.text).toMatch(
                /<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="ASpace Description QA"/
            );
        });

        it('includes a "Show QA-passed" toggle (unchecked by default)', async () => {
            const cookie = await cookie_for('qa-toggle');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/aspace-qa')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/id="qa-show-passed-input"/);
            expect(res.text).toMatch(/Show QA-passed/);
            // Not pre-checked on a default page load — the default
            // is to HIDE already-passed folders.
            expect(res.text).not.toMatch(/id="qa-show-passed-input"[^>]*checked/);
            // The polled content div pulls both the search input
            // and the toggle into its requests via hx-include.
            expect(res.text).toMatch(/hx-include="#qa-search-input, #qa-show-passed-input"/);
        });
    });

    describe('GET /dashboard/ingest/packaging', () => {
        it('renders the Packaging page with sidebar marking it active', async () => {
            const cookie = await cookie_for('pkg-1');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/packaging')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Packaging and Ingesting');
            expect(res.text).toContain('workspace-action-spinner');
            expect(res.text).toMatch(
                /<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="Packaging and Ingesting"/
            );
        });
    });

    describe('GET /dashboard/ingest/workspace/list (HTMX partial)', () => {
        it('renders an error envelope when curation-API is unconfigured', async () => {
            // Without ASTOOLS_* / QA_SERVICE_* env vars, the workspace
            // module returns the "not configured" error envelope. The
            // partial renders this as a small alert card above an
            // empty table — exactly the behavior staff see in a dev
            // env that's not pointed at libsftp01.
            const cookie = await cookie_for('list-1');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/workspace/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Error text from workspace.list_workspace surfaces in the
            // partial.
            expect(res.text).toMatch(/not configured/i);
            // Empty state copy is the MDO-flavored message.
            expect(res.text).toContain('No folders are awaiting Make Digital Objects');
        });
    });

    describe('GET /dashboard/ingest/aspace-qa/list (HTMX partial)', () => {
        it('renders the QA-flavored empty-state copy', async () => {
            const cookie = await cookie_for('list-2');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/aspace-qa/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('No folders have completed Make Digital Objects yet');
        });

        it('honors show_passed=1 — toggles the qa-passed filter off via the controller', async () => {
            // No real curation-service in test land, so we can't
            // assert folder rows shape — but we can confirm the
            // controller plumbs the query param through to
            // list_workspace by spying on workspace.list_workspace
            // via a fresh require + replace.
            const cookie = await cookie_for('list-toggle');
            const workspace = require('../../ingester/workspace');
            const orig = workspace.list_workspace;
            const calls = [];
            workspace.list_workspace = async (opts) => {
                calls.push(opts);
                return { folders: [], total_folders: 0, total_packages: 0, q: '' };
            };
            try {
                // show_passed unset → exclude_qa_passed=true (default behavior)
                await supertest(app)
                    .get('/repo/dashboard/ingest/aspace-qa/list')
                    .set('Cookie', cookie);
                expect(calls.at(-1).exclude_qa_passed).toBe(true);

                // show_passed=1 → exclude_qa_passed=false (show everything)
                await supertest(app)
                    .get('/repo/dashboard/ingest/aspace-qa/list?show_passed=1')
                    .set('Cookie', cookie);
                expect(calls.at(-1).exclude_qa_passed).toBe(false);

                // show_passed=0 (or any non-"1" value) → still filtered.
                // Keeps the contract tight: only the literal "1" opts
                // out; everything else preserves the safe default.
                await supertest(app)
                    .get('/repo/dashboard/ingest/aspace-qa/list?show_passed=0')
                    .set('Cookie', cookie);
                expect(calls.at(-1).exclude_qa_passed).toBe(true);
            } finally {
                workspace.list_workspace = orig;
            }
        });
    });

    describe('GET /dashboard/ingest/packaging/list (HTMX partial)', () => {
        it('renders the Packaging-flavored empty-state copy', async () => {
            const cookie = await cookie_for('list-3');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/packaging/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('No folders are ready to submit to the ingest pipeline');
        });
    });

    describe('POST /dashboard/ingest/workspace/:folder/make-digital-objects', () => {
        it('redirects unauthed users', async () => {
            const res = await supertest(app).post(
                '/repo/dashboard/ingest/workspace/col-a/make-digital-objects'
            );
            // Without auth, dashboard middleware redirects to login.
            expect(res.status).toBe(302);
        });

        it('renders an error action-result when curation-API is unconfigured', async () => {
            const cookie = await cookie_for('mdo-action');
            const res = await supertest(app)
                .post('/repo/dashboard/ingest/workspace/col-a/make-digital-objects')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Make Digital Objects failed for col-a');
            expect(res.text).toMatch(/not configured/i);
            // No HX-Trigger because the action failed.
            expect(res.headers['hx-trigger']).toBeUndefined();
        });
    });

    describe('POST /dashboard/ingest/workspace/:folder/check-metadata', () => {
        it('renders a qa-check-result error card when curation-API is down', async () => {
            const cookie = await cookie_for('qa-action');
            const res = await supertest(app)
                .post('/repo/dashboard/ingest/workspace/col-a/check-metadata')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/Check Metadata failed for col-a/);
        });
    });

    describe('POST /dashboard/ingest/workspace/:folder/submit-ingest', () => {
        it('renders an error action-result when curation-API is unconfigured', async () => {
            const cookie = await cookie_for('submit-action');
            const res = await supertest(app)
                .post('/repo/dashboard/ingest/workspace/col-a/submit-ingest')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Submit to Ingest failed for col-a');
        });
    });

    describe('POST /dashboard/ingest/workspace/:folder/revert-to-mdo', () => {
        it('renders an error action-result when curation-API is unconfigured', async () => {
            const cookie = await cookie_for('revert-action');
            const res = await supertest(app)
                .post('/repo/dashboard/ingest/workspace/col-a/revert-to-mdo')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Revert failed for col-a');
        });
    });
});
