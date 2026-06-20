'use strict';

// e2e for RBAC Phase 1 — admin routes are gated by role (manage_users /
// manage_index / manage_metadata_refresh / manage_convert), while staff
// curation stays open. Role is resolved DB-fresh from the seeded user, so
// these tests exercise the real require_permission → users/model lookup.

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');

let app;

async function cookie_for(du_id, role) {
    const u = await db_helper.seed_user({ du_id, role });
    return `${jwt.COOKIE_NAME}=${jwt.sign({ sub: String(u.id), du_id })}`;
}
async function bearer_for(du_id, role) {
    const u = await db_helper.seed_user({ du_id, role });
    return `Bearer ${jwt.sign({ sub: String(u.id), du_id })}`;
}

describe('RBAC e2e — admin surfaces gated by role', () => {
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

    describe('indexer (manage_index)', () => {
        it('admin can load the indexer admin page', async () => {
            const cookie = await cookie_for('rbac-idx-admin', 'admin');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/indexer')
                .set('Cookie', cookie);
            expect(res.status).not.toBe(403);
        });

        it('staff is forbidden (403) from the indexer admin page', async () => {
            const cookie = await cookie_for('rbac-idx-staff', 'staff');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/indexer')
                .set('Cookie', cookie);
            expect(res.status).toBe(403);
        });

        it('HTMX admin action by staff → 403 + toast (not a redirect/blob)', async () => {
            const cookie = await cookie_for('rbac-idx-staff2', 'staff');
            const res = await supertest(app)
                .post('/repo/dashboard/admin/indexer/reindex-all')
                .set('Cookie', cookie)
                .set('HX-Request', 'true')
                .type('form')
                .send({});
            expect(res.status).toBe(403);
            expect(res.headers['hx-trigger']).toMatch(/toast/);
            // The fallback body is an alert region (announced even if it
            // swaps into the page rather than the toast stack).
            expect(res.text).toMatch(/role="alert"/);
        });
    });

    describe('metadata-refresh (manage_metadata_refresh)', () => {
        it('viewer is forbidden from the system-refresh admin page', async () => {
            const cookie = await cookie_for('rbac-mref-viewer', 'viewer');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/metadata-refresh')
                .set('Cookie', cookie);
            expect(res.status).toBe(403);
        });

        it('admin can load it', async () => {
            const cookie = await cookie_for('rbac-mref-admin', 'admin');
            const res = await supertest(app)
                .get('/repo/dashboard/admin/metadata-refresh')
                .set('Cookie', cookie);
            expect(res.status).not.toBe(403);
        });
    });

    describe('user management (manage_users)', () => {
        it('staff is forbidden from the dashboard users page', async () => {
            const cookie = await cookie_for('rbac-usr-staff', 'staff');
            const res = await supertest(app).get('/repo/dashboard/users').set('Cookie', cookie);
            expect(res.status).toBe(403);
        });

        it('admin can load the dashboard users page', async () => {
            const cookie = await cookie_for('rbac-usr-admin', 'admin');
            const res = await supertest(app).get('/repo/dashboard/users').set('Cookie', cookie);
            expect(res.status).not.toBe(403);
        });

        it('API: staff cannot create a user (403); admin can (201)', async () => {
            const staff = await bearer_for('rbac-api-staff', 'staff');
            const r1 = await supertest(app)
                .post('/repo/users')
                .set('Authorization', staff)
                .type('form')
                .send({ du_id: 'newbie', email: 'n@du.edu', first_name: 'New', last_name: 'Bie', role: 'staff' });
            expect(r1.status).toBe(403);

            const admin = await bearer_for('rbac-api-admin', 'admin');
            const r2 = await supertest(app)
                .post('/repo/users')
                .set('Authorization', admin)
                .type('form')
                .send({ du_id: 'newbie2', email: 'n2@du.edu', first_name: 'New', last_name: 'Bie', role: 'staff' });
            expect(r2.status).toBe(201);
        });
    });

    describe('staff curation stays open (read + curation)', () => {
        it('staff can still load the dashboard home (reads not gated)', async () => {
            const cookie = await cookie_for('rbac-home-staff', 'staff');
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            expect(res.status).toBe(200);
        });
    });

    describe('Phase 2 — staff-route enforcement (publish / delete / ingest)', () => {
        const SOME_PID = '00000000-0000-4000-8000-000000000000';

        it('viewer cannot publish (403); staff can (passes the gate)', async () => {
            const viewer = await cookie_for('rbac-pub-viewer', 'viewer');
            const r1 = await supertest(app)
                .post(`/repo/dashboard/objects/${SOME_PID}/publish`)
                .set('Cookie', viewer)
                .set('HX-Request', 'true')
                .type('form')
                .send({});
            expect(r1.status).toBe(403);

            // staff clears the permission gate → NOT a 403 (the controller
            // may then 404/409 on the nonexistent pid; the point is the
            // RBAC gate let it through).
            const staff = await cookie_for('rbac-pub-staff', 'staff');
            const r2 = await supertest(app)
                .post(`/repo/dashboard/objects/${SOME_PID}/publish`)
                .set('Cookie', staff)
                .set('HX-Request', 'true')
                .type('form')
                .send({});
            expect(r2.status).not.toBe(403);
        });

        it('viewer cannot delete via the API (403); staff can (passes the gate)', async () => {
            const viewer = await bearer_for('rbac-del-viewer', 'viewer');
            const r1 = await supertest(app)
                .delete(`/repo/objects/${SOME_PID}`)
                .set('Authorization', viewer)
                .type('form')
                .send({ delete_reason: 'x' });
            expect(r1.status).toBe(403);

            const staff = await bearer_for('rbac-del-staff', 'staff');
            const r2 = await supertest(app)
                .delete(`/repo/objects/${SOME_PID}`)
                .set('Authorization', staff)
                .type('form')
                .send({ delete_reason: 'x' });
            expect(r2.status).not.toBe(403);
        });

        it('viewer cannot enqueue ingest (403); staff can (passes the gate)', async () => {
            const viewer = await bearer_for('rbac-ing-viewer', 'viewer');
            const r1 = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', viewer)
                .type('json')
                .send({});
            expect(r1.status).toBe(403);

            const staff = await bearer_for('rbac-ing-staff', 'staff');
            const r2 = await supertest(app)
                .post('/repo/api/ingest/queue')
                .set('Authorization', staff)
                .type('json')
                .send({});
            expect(r2.status).not.toBe(403);
        });
    });

    describe('Phase 2 — sidebar nav-gating', () => {
        async function home_html(role) {
            const cookie = await cookie_for(`rbac-nav-${role}`, role);
            const res = await supertest(app).get('/repo/dashboard/').set('Cookie', cookie);
            expect(res.status).toBe(200);
            return res.text;
        }

        it('admin sees Users + Admin Utils + DPJ links', async () => {
            const html = await home_html('admin');
            expect(html).toMatch(/aria-label="Users"/);
            expect(html).toMatch(/aria-label="Admin Utils"/);
            expect(html).toMatch(/aria-label="Digital Preservation Jobs"/);
        });

        it('staff sees DPJ but NOT Users or Admin Utils', async () => {
            const html = await home_html('staff');
            expect(html).toMatch(/aria-label="Digital Preservation Jobs"/);
            expect(html).not.toMatch(/aria-label="Users"/);
            expect(html).not.toMatch(/aria-label="Admin Utils"/);
        });

        it('viewer sees none of the privileged nav links', async () => {
            const html = await home_html('viewer');
            expect(html).not.toMatch(/aria-label="Digital Preservation Jobs"/);
            expect(html).not.toMatch(/aria-label="Users"/);
            expect(html).not.toMatch(/aria-label="Admin Utils"/);
        });
    });
});
