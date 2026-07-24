'use strict';

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');
const jobs = require('../../ingester/jobs');

let app;

async function cookie_for(du_id, overrides = {}) {
    const u = await db_helper.seed_user({ du_id, ...overrides });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
}

describe('ingest Job History — e2e', () => {
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

    describe('GET /dashboard/ingest/history', () => {
        it('redirects unauthed users to login', async () => {
            const res = await supertest(app).get('/repo/dashboard/ingest/history');
            expect(res.status).toBe(302);
        });

        it('renders the page chrome (title, filters, search) for authed users', async () => {
            const cookie = await cookie_for('staff-h1');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/history')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Job History');
            expect(res.text).toContain('← Collection Management');
            // Filter chrome
            expect(res.text).toContain('Make Digital Objects');
            expect(res.text).toContain('ArchivesSpace Description QA');
            expect(res.text).toContain('Packaging and Ingesting');
            expect(res.text).toContain('SUCCESSFUL');
            expect(res.text).toContain('FAILED');
        });

        it('sidebar stays in workflow focus mode + marks History active', async () => {
            const cookie = await cookie_for('staff-h2');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/history')
                .set('Cookie', cookie);
            /*
             * History icon is rendered + flagged active (both the
             * visual .active class and SR-perceivable aria-current).
             */
            expect(res.text).toMatch(
                /<a[^>]*class="active"[^>]*aria-current="page"[^>]*aria-label="Job History"/
            );
            /*
             * Focus mode: non-workflow items hidden — Collections,
             * Objects, Users, Indexer, Metadata Refresh all gone.
             * Home stays visible as the workflow's escape hatch (see
             * task #114).
             */
            expect(res.text).not.toContain('title="Manage Collections"');
            expect(res.text).not.toContain('title="Objects"');
            expect(res.text).not.toContain('title="Users"');
            expect(res.text).toContain('title="Home"');
            // All four other workflow icons render alongside History.
            expect(res.text).toContain('title="Make Digital Objects"');
            expect(res.text).toContain('title="ASpace Description QA"');
            expect(res.text).toContain('title="Packaging and Ingesting"');
            expect(res.text).toContain('title="Queue (ingest in progress)"');
        });
    });

    describe('GET /dashboard/ingest/history/list (HTMX partial)', () => {
        it('renders the empty-state when no jobs have been recorded', async () => {
            const cookie = await cookie_for('staff-h3');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/history/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('No jobs match your filters.');
        });

        it('renders one row per job with all 7 columns', async () => {
            await db_helper.seed_user({
                du_id: 'eferguson',
                first_name: 'Elizabeth',
                last_name: 'Ferguson',
            });
            await jobs.record_job({
                job_type: 'packaging_and_ingesting',
                status: 'SUCCESSFUL',
                collection_folder: 'new_B463_Alan_Golin_Gass-resources_1373',
                packages: ['B463.01.0005.0003.0003', 'B463.01.0005.0003.0004'],
                actor: 'eferguson',
            });
            const cookie = await cookie_for('viewer-1');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/history/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            /*
             * Columns. No standalone Job ID header — the UUID renders
             * under Job Type as a muted line with a visually-hidden
             * "Job ID:" label for screen readers (2026-07-24 merge).
             */
            expect(res.text).not.toMatch(/<th>Job ID<\/th>/);
            expect(res.text).toMatch(/<span class="visually-hidden">Job ID: <\/span>/);
            expect(res.text).toContain('Job Type');
            expect(res.text).toContain('Status');
            expect(res.text).toContain('Collection Folder');
            expect(res.text).toContain('Packages');
            expect(res.text).toContain('Job Run By');
            expect(res.text).toContain('Date');
            // Row data
            expect(res.text).toContain('packaging_and_ingesting');
            expect(res.text).toContain('SUCCESSFUL');
            expect(res.text).toContain('new_B463_Alan_Golin_Gass-resources_1373');
            expect(res.text).toContain('B463.01.0005.0003.0003');
            expect(res.text).toContain('Elizabeth Ferguson');
        });

        it('applies the job_type filter', async () => {
            await db_helper.seed_user({ du_id: 'svc', first_name: 'Svc', last_name: 'Account' });
            for (const t of [
                'make_digital_objects',
                'archivesspace_description_qa',
                'packaging_and_ingesting',
            ]) {
                await jobs.record_job({
                    job_type: t,
                    status: 'SUCCESSFUL',
                    collection_folder: `col-${t}`,
                    packages: [],
                    actor: 'svc',
                });
            }
            const cookie = await cookie_for('viewer-2');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/history/list?job_type=make_digital_objects')
                .set('Cookie', cookie);
            expect(res.text).toContain('col-make_digital_objects');
            expect(res.text).not.toContain('col-archivesspace_description_qa');
            expect(res.text).not.toContain('col-packaging_and_ingesting');
        });

        it('shows a collapsible error on FAILED rows', async () => {
            await jobs.record_job({
                job_type: 'make_digital_objects',
                status: 'FAILED',
                collection_folder: 'broken-col',
                packages: [],
                actor: 'svc',
                error: 'curation-api returned HTTP 500',
            });
            const cookie = await cookie_for('viewer-3');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/history/list')
                .set('Cookie', cookie);
            expect(res.text).toContain('sev-error');
            expect(res.text).toContain('<details');
            expect(res.text).toContain('curation-api returned HTTP 500');
        });

        it('sidebar History icon is rendered alongside the four workflow icons', async () => {
            /*
             * Sanity check via the history page (the partial doesn't
             * include the sidebar; the page wrapper does).
             */
            const cookie = await cookie_for('viewer-4');
            const res = await supertest(app)
                .get('/repo/dashboard/ingest/history')
                .set('Cookie', cookie);
            expect(res.text).toContain('title="Job History"');
            expect(res.text).toMatch(
                /href="[^"]*\/dashboard\/ingest\/history"[^>]*title="Job History"/
            );
        });
    });
});
