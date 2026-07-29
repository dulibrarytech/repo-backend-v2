'use strict';

/*
 * E2E for the Batch Backups (Wasabi) browser
 * (/dashboard/admin/archive/* — repo/WASABI_ARCHIVE_BROWSER_PLAN.md).
 *
 * The curation API is unconfigured in test land (CURATION_API absent),
 * so listing renders the friendly error envelope — which is itself the
 * behavior under test for that path. RBAC: routes are gated on
 * manage_ingest (staff + admin yes; viewer no).
 */

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');

let app;

async function cookie_for(du_id, role) {
    const u = await db_helper.seed_user({ du_id, role });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
}

describe('admin archive browser — e2e', () => {
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

    describe('GET /dashboard/admin/archive (page)', () => {
        it('redirects unauthed users to login', async () => {
            const res = await supertest(app).get('/repo/dashboard/admin/archive');
            expect(res.status).toBe(302);
        });

        it('renders for an admin with the read-only wording', async () => {
            const cookie = await cookie_for('arch-admin-1', 'admin');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Batch Backups');
            expect(res.text).toContain('Non-preservation snapshots');
            expect(res.text).toContain('Preservation copies live in the AIP store (Wasabi)');
            /* HTMX container that loads the collections level. */
            expect(res.text).toContain('id="archive-level"');
            expect(res.text).toContain('/dashboard/admin/archive/list');
        });

        it('renders for staff (manage_ingest)', async () => {
            const cookie = await cookie_for('arch-staff-1', 'staff');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
        });

        it('is forbidden for viewers', async () => {
            const cookie = await cookie_for('arch-viewer-1', 'viewer');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive')
                .set('Cookie', cookie);
            expect(res.status).toBe(403);
        });

        it('marks the sidebar Admin Utils focus mode active', async () => {
            const cookie = await cookie_for('arch-admin-2', 'admin');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive')
                .set('Cookie', cookie);
            expect(res.text).toMatch(
                /aria-current="page"[^>]*aria-label="Batch Backups \(admin\)"/
            );
        });
    });

    describe('GET /dashboard/admin/archive/list (level partial)', () => {
        it('renders the not-configured error envelope without a curation API', async () => {
            const cookie = await cookie_for('arch-admin-3', 'admin');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(200);
            expect(res.text).toContain('Curation API is not configured');
        });

        it('rejects traversal in level params', async () => {
            const cookie = await cookie_for('arch-admin-4', 'admin');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive/list?collection=..')
                .set('Cookie', cookie);
            expect(res.status).toBe(400);
        });

        it('rejects package without collection', async () => {
            const cookie = await cookie_for('arch-admin-5', 'admin');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive/list?package=pkg-only')
                .set('Cookie', cookie);
            expect(res.status).toBe(400);
        });

        it('is forbidden for viewers', async () => {
            const cookie = await cookie_for('arch-viewer-2', 'viewer');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive/list')
                .set('Cookie', cookie);
            expect(res.status).toBe(403);
        });
    });

    describe('GET /dashboard/admin/archive/download/*key', () => {
        /*
         * The key travels as a wildcard PATH (the query sanitizer
         * entity-encodes `/` in query values, so ?key= can't carry an
         * object key). Bad shapes must 400 in the controller.
         */
        it('rejects traversal / single-segment / empty-segment keys', async () => {
            const cookie = await cookie_for('arch-admin-6', 'admin');
            const bad = [
                'single-segment',
                'a/../b.tif',
                'a/./b.tif',
            ];
            for (const key of bad) {
                const res = await supertest(app)
                    .get(`/repo/dashboard/admin/archive/download/${key}`)
                    .set('Cookie', cookie);
                expect([400, 404]).toContain(res.status);
            }
        });

        it('reports the unconfigured curation API as a 400 with a clear message', async () => {
            const cookie = await cookie_for('arch-admin-7', 'admin');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive/download/coll/pkg/file.tif')
                .set('Cookie', cookie);
            expect(res.status).toBe(400);
            expect(res.text).toContain('Curation API not configured');
        });

        it('is forbidden for viewers', async () => {
            const cookie = await cookie_for('arch-viewer-3', 'viewer');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/archive/download/c/p/f.tif')
                .set('Cookie', cookie);
            expect(res.status).toBe(403);
        });
    });
});
