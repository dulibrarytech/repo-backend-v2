'use strict';

const supertest = require('supertest');
const { randomUUID } = require('node:crypto');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');

let app;
let agent;
let bearer;

describe('repository — e2e', () => {
    beforeAll(async () => {
        app = make_app();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        agent = supertest(app);
        const u = await db_helper.seed_user({ du_id: 'admin' });
        bearer = `Bearer ${jwt.sign({ sub: String(u.id), du_id: 'admin' })}`;
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('GET /objects requires auth', async () => {
        const res = await agent.get('/repo/objects');
        expect(res.status).toBe(401);
    });

    it('lists objects with pagination metadata', async () => {
        for (let i = 0; i < 3; i++) await db_helper.seed_object();
        const res = await agent.get('/repo/objects').set('Authorization', bearer);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(3);
        expect(res.body.page).toBe(1);
        expect(res.body.items).toHaveLength(3);
    });

    it('filters by is_published=1', async () => {
        await db_helper.seed_object({ is_published: 1 });
        await db_helper.seed_object({ is_published: 0 });
        const res = await agent.get('/repo/objects?is_published=1').set('Authorization', bearer);
        expect(res.body.total).toBe(1);
    });

    it('GET /objects/:pid returns the public projection', async () => {
        const o = await db_helper.seed_object();
        const res = await agent.get(`/repo/objects/${o.pid}`).set('Authorization', bearer);
        expect(res.status).toBe(200);
        expect(res.body.data.pid).toBe(o.pid);
        // Sensitive long-text columns are NOT in the response
        expect(res.body.data.mods).toBeUndefined();
        expect(res.body.data.display_record).toBeUndefined();
    });

    it('GET /objects/:pid returns 404 for unknown pid', async () => {
        const res = await agent.get(`/repo/objects/${randomUUID()}`).set('Authorization', bearer);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
    });

    it('GET /objects/:pid returns 400 for malformed pid', async () => {
        const res = await agent.get('/repo/objects/not-a-uuid').set('Authorization', bearer);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('POST /objects/:pid/publish flips the published bit', async () => {
        const o = await db_helper.seed_object({ is_published: 0 });
        const res = await agent.post(`/repo/objects/${o.pid}/publish`).set('Authorization', bearer);
        expect(res.status).toBe(200);
        expect(res.body.data.is_published).toBe(1);
    });

    it('POST /objects/:pid/suppress flips it back', async () => {
        const o = await db_helper.seed_object({ is_published: 1 });
        const res = await agent
            .post(`/repo/objects/${o.pid}/suppress`)
            .set('Authorization', bearer);
        expect(res.status).toBe(200);
        expect(res.body.data.is_published).toBe(0);
    });

    it('DELETE /objects/:pid soft-deletes and stamps delete_id', async () => {
        /*
         * Must be unpublished — the model rejects published deletions
         * with 409 (v1 parity).
         */
        const o = await db_helper.seed_object({ is_active: 1, is_published: 0 });
        const res = await agent
            .delete(`/repo/objects/${o.pid}`)
            .set('Authorization', bearer)
            .send({ delete_reason: 'unit-test cleanup' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.delete_id).toMatch(/-/);
        // Repeat delete → 404 (already inactive)
        const repeat = await agent
            .delete(`/repo/objects/${o.pid}`)
            .set('Authorization', bearer)
            .send({ delete_reason: 'retry' });
        expect(repeat.status).toBe(404);
    });

    it('DELETE /objects/:pid 400s without delete_reason (v1 parity)', async () => {
        const o = await db_helper.seed_object({ is_active: 1, is_published: 0 });
        const res = await agent.delete(`/repo/objects/${o.pid}`).set('Authorization', bearer);
        expect(res.status).toBe(400);
    });

    it('DELETE /objects/:pid 409s on a published object (no force override)', async () => {
        const o = await db_helper.seed_object({ is_active: 1, is_published: 1 });
        const res = await agent
            .delete(`/repo/objects/${o.pid}`)
            .set('Authorization', bearer)
            .send({ delete_reason: 'will be refused' });
        expect(res.status).toBe(409);
    });
});
