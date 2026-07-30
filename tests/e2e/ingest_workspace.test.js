'use strict';

/*
 * E2E tests for the three pre-ingest workspace pages (MDO, ASpace QA,
 * Packaging). Most assertions target page chrome + sidebar active
 * state + presence of workspace controls — the deeper behavior is
 * covered by the workspace integration tests.
 * 
 * We don't have a live curation-API in tests, so the workspace list
 * renders the "not configured" error envelope inline (CURATION_API +
 * CURATION_API_KEY are absent). That's actually useful: lets us
 * assert the dashboard handles the error gracefully.
 */

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');
const { db_queue } = require('../../config/db');
const tables = require('../../config/db_tables');

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
            /*
             * Sidebar's Make Digital Objects item is the active one
             * (both .active class and SR-perceivable aria-current).
             */
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
            /*
             * In focus mode the sidebar shows Home + the four workflow
             * icons + History. Collections, Objects, Users, Indexer,
             * and Metadata Refresh stay hidden so the sidebar reads as
             * a focused pipeline. Home is the escape hatch — it gives
             * a one-click jump to the dashboard root from any workflow
             * view (the "← Collection Management" page-header
             * back-links were removed 2026-07-27).
             */
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
                expect(res.text).not.toContain('title="Manage Collections"');
                expect(res.text).not.toContain('title="Objects"');
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
                /*
                 * The Home <a> in the workflow sidebar points at
                 * /repo/dashboard/ (the dashboard root), giving a
                 * one-click exit from focus mode.
                 */
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

        it('does NOT render the "← Collection Management" back-link on any workflow page', async () => {
            /*
             * The back-link was removed from every workflow view by
             * request (2026-07-27). The Home sidebar icon is now the
             * exit from focus mode.
             */
            const cookie = await cookie_for('back-link');
            for (const path of [
                '/repo/dashboard/ingest/workspace',
                '/repo/dashboard/ingest/aspace-qa',
                '/repo/dashboard/ingest/packaging',
                '/repo/dashboard/ingest',
                '/repo/dashboard/ingest/history',
                '/repo/dashboard/ingest/recent',
            ]) {
                const res = await supertest(app).get(path).set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).not.toContain('← Collection Management');
            }
        });

        it('home page (out of workflow) keeps the standard sidebar items', async () => {
            const cookie = await cookie_for('side-standard');
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('title="Home"');
            expect(res.text).toContain('title="Manage Collections"');
            expect(res.text).toContain('title="Objects"');
            expect(res.text).toContain('title="Users"');
            expect(res.text).toContain('title="Digital Preservation Jobs"');
            /*
             * Admin Utils is the single entry icon for the admin tools
             * (Indexer / Metadata Refresh / Services Health). Restored
             * 2026-07-29 (admin-only via allow('manage_index'); the
             * default test user is admin). The per-tool icons still
             * only render inside the admin focus mode.
             */
            expect(res.text).toContain('title="Admin Utils"');
            expect(res.text).not.toContain('title="Indexer (admin)"');
            expect(res.text).not.toContain('title="Metadata Refresh (admin)"');
            expect(res.text).not.toContain('title="Services Health (admin)"');
        });

        it('out-of-workflow sidebar order is Home → Collections → Objects → DPJ → Users → Admin Utils', async () => {
            const cookie = await cookie_for('side-order');
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            /*
             * TEMPORARY (2026-07-24) v1-familiar nav: Stats / AIPs /
             * Admin Utils are hidden and Collections reads "Manage
             * Collections" — restore them to this order list when the
             * nav_show flags in sidebar.ejs are flipped back on.
             */
            const expected = [
                'title="Home"',
                'title="Manage Collections"',
                'title="Objects"',
                'title="Digital Preservation Jobs"',
                'title="Users"',
            ];
            /*
             * Each title appears later in the HTML than the previous
             * one. Capture any missing titles up-front so the failure
             * message points at WHICH item is absent.
             */
            const positions = expected.map((needle) => res.text.indexOf(needle));
            const missing = expected.filter((_, i) => positions[i] === -1);
            expect(missing).toEqual([]);
            const sorted = [...positions].sort((a, b) => a - b);
            expect(positions).toEqual(sorted);
        });

        it('Admin Utils icon is back on the rail and points at /admin/services', async () => {
            /*
             * Restored 2026-07-29 (nav_show.admin_utils back on).
             * Entry point is the Services Health page; the icon is
             * admin-only via allow('manage_index') — rbac.test.js pins
             * the staff/viewer absence.
             */
            const cookie = await cookie_for('side-admin-link');
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            expect(res.text).toMatch(
                /href="[^"]*\/dashboard\/admin\/services"[^>]*title="Admin Utils"/
            );
        });
    });

    describe('admin focus mode (in_admin sidebar)', () => {
        /*
         * In admin context the sidebar mirrors workflow mode: Home
         * escape at top, then the admin tool icons (Indexer / Metadata
         * Refresh / Services Health). Collections / Objects / Users /
         * DPJ stay hidden to preserve focus.
         */

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
                expect(res.text).not.toContain('title="Manage Collections"');
                expect(res.text).not.toContain('title="Objects"');
                expect(res.text).not.toContain('title="Users"');
                expect(res.text).not.toContain('title="Digital Preservation Jobs"');
                // Admin Utils single icon is replaced by the three tool icons.
                expect(res.text).not.toContain('title="Admin Utils"');
                /*
                 * Active marker on the current tool. Anchor on the
                 * aria-label since attribute order in the EJS template
                 * is no longer adjacent (aria-current + aria-label sit
                 * between class and title).
                 */
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
            /*
             * Not pre-checked on a default page load — the default
             * is to HIDE already-passed folders.
             */
            expect(res.text).not.toMatch(/id="qa-show-passed-input"[^>]*checked/);
            /*
             * The polled content div pulls both the search input
             * and the toggle into its requests via hx-include.
             */
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
            /*
             * Without ASTOOLS_* / QA_SERVICE_* env vars, the workspace
             * module returns the "not configured" error envelope. The
             * partial renders this as a small alert card above an
             * empty table — exactly the behavior staff see in a dev
             * env that's not pointed at libsftp01.
             */
            const cookie = await cookie_for('list-1');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/workspace/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            /*
             * Error text from workspace.list_workspace surfaces in the
             * partial.
             */
            expect(res.text).toMatch(/not configured/i);
            // Empty state copy is the MDO-flavored message.
            expect(res.text).toContain('No folders are awaiting Make Digital Objects');
        });

        it('shows batch size and flags large batches; dashes when size unknown', async () => {
            const cookie = await cookie_for('list-sizes');
            const workspace = require('../../ingester/workspace');
            const orig = workspace.list_workspace;
            workspace.list_workspace = async () => ({
                folders: [
                    {
                        name: 'new_huge-resources_1',
                        packages: ['p1'],
                        structure_notices: [],
                        blocked: false,
                        total_bytes: 47 * 1024 * 1024 * 1024, // 47 GB
                    },
                    {
                        name: 'new_small-resources_2',
                        packages: ['p2'],
                        structure_notices: [],
                        blocked: false,
                        total_bytes: 2 * 1024 * 1024, // 2 MB
                    },
                    {
                        name: 'new_unknown-resources_3',
                        packages: ['p3'],
                        structure_notices: [],
                        blocked: false,
                        total_bytes: null, // unreadable / legacy scan
                    },
                ],
                total_folders: 3,
                total_packages: 3,
                q: '',
            });
            try {
                const res = await supertest(app)
                    .get('/repo/dashboard/ingest/workspace/list')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).toContain('>Size<');
                expect(res.text).toContain('47.0 GB');
                expect(res.text).toContain('Large batch');
                expect(res.text).toContain('2.0 MB');
                /*
                 * Only the >10 GB folder carries the advisory badge —
                 * match the badge's text node exactly (the tooltip
                 * text also contains the words "Large batches").
                 */
                expect(res.text.match(/>Large batch</g)).toHaveLength(1);
            } finally {
                workspace.list_workspace = orig;
            }
        });

        it('collapses long package lists behind a native <details> disclosure', async () => {
            /*
             * A 95-package batch used to stretch its row across
             * several screens. >8 packages: first 5 stay visible,
             * the rest collapse behind a keyboard-accessible native
             * details/summary with the real count. ≤8 render fully.
             */
            const cookie = await cookie_for('list-collapse');
            const workspace = require('../../ingester/workspace');
            const orig = workspace.list_workspace;
            const many = Array.from(
                { length: 20 },
                (_, i) => `B002.01.0103.${String(100 + i).padStart(4, '0')}`
            );
            workspace.list_workspace = async () => ({
                folders: [
                    {
                        name: 'new_big-resources_1',
                        packages: many,
                        structure_notices: [],
                        blocked: false,
                    },
                    {
                        name: 'new_small-resources_2',
                        packages: many.slice(0, 4),
                        structure_notices: [],
                        blocked: false,
                    },
                ],
                total_folders: 2,
                total_packages: 24,
                q: '',
            });
            try {
                const res = await supertest(app)
                    .get('/repo/dashboard/ingest/workspace/list')
                    .set('Cookie', cookie);
                expect(res.status).toBe(200);
                // First 5 of the big batch visible, 6th only inside details.
                expect(res.text).toContain('B002.01.0103.0104');
                expect(res.text).toContain(
                    'Show 15 more archival object folders'
                );
                expect(res.text).toContain('B002.01.0103.0119');
                // Exactly ONE details block — the ≤8 folder renders flat.
                expect(res.text.match(/<details/g)).toHaveLength(1);
                const details_at = res.text.indexOf('<details');
                // The 6th package sits after the disclosure opens…
                expect(res.text.indexOf('B002.01.0103.0105')).toBeGreaterThan(details_at);
                // …while the 5th is before it (visible without expanding).
                expect(res.text.indexOf('B002.01.0103.0104')).toBeLessThan(details_at);
            } finally {
                workspace.list_workspace = orig;
            }
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
            /*
             * No real curation-service in test land, so we can't
             * assert folder rows shape — but we can confirm the
             * controller plumbs the query param through to
             * list_workspace by spying on workspace.list_workspace
             * via a fresh require + replace.
             */
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

                /*
                 * show_passed=0 (or any non-"1" value) → still filtered.
                 * Keeps the contract tight: only the literal "1" opts
                 * out; everything else preserves the safe default.
                 */
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

    describe('GET /dashboard/ingest/recent (Recent Ingests)', () => {
        it('redirects unauthed users to login', async () => {
            const res = await supertest(app).get('/repo/dashboard/ingest/recent');
            expect(res.status).toBe(302);
        });

        it('renders a shell wired to the objects table, workflow sidebar marking it active', async () => {
            const cookie = await cookie_for('recent-1');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/recent')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Recent Ingests');
            expect(res.text).toContain('Objects ingested in the last 30 days');
            // Reuses the Objects table, filtered to the recent window.
            expect(res.text).toMatch(/id="objects-table"/);
            expect(res.text).toMatch(/\/objects\/list\?recent_days=30/);
            // Workflow focus mode: the Recent Ingests sidebar item is active…
            expect(res.text).toMatch(
                /<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="Recent Ingests"/
            );
            // …and the normal nav is hidden (focus mode).
            expect(res.text).toContain('title="Make Digital Objects"');
            expect(res.text).not.toContain('title="Manage Collections"');
        });

        it('the objects table, scoped by recent_days, shows in-window objects with row actions', async () => {
            await db_helper.seed_object({
                pid: 'codu:recent-fresh',
                display_record: JSON.stringify({ title: 'Carnival of the Animals' }),
            });
            await db_helper.seed_object({
                pid: 'codu:recent-old',
                created: '2020-01-01 00:00:00',
                display_record: JSON.stringify({ title: 'Ancient Reel' }),
            });
            const cookie = await cookie_for('recent-2');
            const res = await supertest(app)
                .get('/repo/dashboard/objects/list?recent_days=30')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            // Fresh object is in the window; the old one is filtered out.
            expect(res.text).toContain('Carnival of the Animals');
            expect(res.text).not.toContain('Ancient Reel');
            /*
             * The row carries the Objects actions (so metadata/publish work
             * here) — the Metadata action endpoint is rendered for the row.
             */
            expect(res.text).toMatch(/\/objects\/codu:recent-fresh\/metadata/);
        });

        it('the Recent Ingests view stays reachable while the stats view serves as home', async () => {
            /*
             * TEMPORARY (2026-07-24) v1-familiar nav: the home page
             * renders the STATS view, so the old home's "Recent
             * ingests → Browse all" card isn't rendered. The
             * standalone view stays reachable via the DPJ workflow
             * sidebar — restore the original home-card assertion (git
             * history) when home_page renders dashboard/home again.
             */
            const cookie = await cookie_for('recent-home');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/recent')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/aria-label="Recent Ingests"/);
        });
    });

    describe('ingest-in-progress gate (packaging view)', () => {
        /*
         * An ingest is "in progress" when any row sits in a worker-claimable
         * state (STAGE_BY_STATE). Such a row → "Ingest in progress" banner on
         * the packaging list + submit blocked. Halted/terminal rows are NOT
         * claimable, so they don't gate (staff can still submit when a prior
         * ingest has halted awaiting action).
         */
        async function seed_active_row(pipeline_state) {
            await db_queue()(tables.ingest_queue).insert({
                package: 'busy-pkg',
                batch: 'busy-batch',
                collection_uuid: 'c-busy',
                status: pipeline_state,
                pipeline_state,
                is_complete: 0,
            });
        }

        it('shows the "Ingest in progress" banner on /packaging/list while a claimable row exists', async () => {
            await seed_active_row('TRANSFER_IN_PROGRESS');
            const cookie = await cookie_for('gate-banner');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/packaging/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Ingest in progress');
        });

        it('does NOT show the banner when the only active row is halted (not claimable)', async () => {
            await seed_active_row('INGEST_HALTED');
            const cookie = await cookie_for('gate-halted');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/packaging/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).not.toContain('Ingest in progress');
        });

        it('rejects a second submit while an ingest is in progress (does not run submit_to_ingest)', async () => {
            await seed_active_row('UPLOADING');
            const cookie = await cookie_for('gate-submit');
            const res = await supertest(app)
                .post('/repo/dashboard/ingest/workspace/col-a/submit-ingest')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toMatch(/already in progress/i);
            /*
             * The guard short-circuits before workspace.submit_to_ingest, so we
             * DON'T see the curation-unconfigured "failed for" envelope that an
             * actual submit attempt produces.
             */
            expect(res.text).not.toContain('failed for col-a');
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

    describe('GET /dashboard/ingest/help (Workflow Guide)', () => {
        it('redirects unauthed users to login', async () => {
            const res = await supertest(app).get('/repo/dashboard/ingest/help');
            expect(res.status).toBe(302);
        });

        it('renders the guide with the overview, each step anchor, and the glossary', async () => {
            const cookie = await cookie_for('help-view');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/help')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Workflow Guide');
            // Section anchors the per-step deep-links target.
            expect(res.text).toContain('id="overview"');
            expect(res.text).toContain('id="make-digital-objects"');
            expect(res.text).toContain('id="aspace-qa"');
            expect(res.text).toContain('id="packaging-and-ingesting"');
            expect(res.text).toContain('id="queue"');
            expect(res.text).toContain('id="glossary"');
            // Links out to the actual step pages.
            expect(res.text).toContain('/repo/dashboard/ingest/workspace');
            expect(res.text).toContain('/repo/dashboard/ingest/packaging');
        });

        it('keeps the DPJ workflow sidebar (with a Help entry) active on the guide', async () => {
            const cookie = await cookie_for('help-sidebar');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/help')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            /*
             * Workflow-focus mode: the step icons + the Help entry are present,
             * and the normal-mode DPJ entry icon is not.
             */
            expect(res.text).toContain('title="Make Digital Objects"');
            expect(res.text).toContain('title="Help — Workflow Guide"');
            expect(res.text).not.toContain('title="Digital Preservation Jobs"');
        });

        it('each step page links into the matching guide section', async () => {
            const cookie = await cookie_for('help-deeplinks');
            const cases = [
                ['/repo/dashboard/ingest/workspace', '/ingest/help#make-digital-objects'],
                ['/repo/dashboard/ingest/aspace-qa', '/ingest/help#aspace-qa'],
                ['/repo/dashboard/ingest/packaging', '/ingest/help#packaging-and-ingesting'],
                ['/repo/dashboard/ingest', '/ingest/help#queue'],
            ];
            for (const [path, anchor] of cases) {
                const res = await supertest(app).get(path).set('Cookie', cookie);
                expect(res.status).toBe(200);
                expect(res.text).toContain(anchor);
            }
        });
    });
});
