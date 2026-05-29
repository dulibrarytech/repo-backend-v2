'use strict';

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');

let app;
let agent;
let bearer;

async function bearer_for(du_id) {
    const u = await db_helper.seed_user({ du_id });
    const token = jwt.sign({ sub: String(u.id), du_id });
    return `Bearer ${token}`;
}

describe('users — e2e', () => {
    beforeAll(async () => {
        app = make_app();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        agent = supertest(app);
        bearer = await bearer_for('admin');
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('rejects unauthenticated GET with 401', async () => {
        const res = await agent.get('/repo/users');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('lists users when authenticated', async () => {
        await db_helper.seed_user({ du_id: 'staff' });
        const res = await agent.get('/repo/users').set('Authorization', bearer);
        expect(res.status).toBe(200);
        // admin + staff
        expect(res.body.data.length).toBe(2);
    });

    it('creates a user and returns 201 with the row', async () => {
        const res = await agent.post('/repo/users').set('Authorization', bearer).send({
            du_id: 'new-staff',
            email: 'NEW@du.edu',
            first_name: 'New',
            last_name: 'Staff',
        });
        expect(res.status).toBe(201);
        expect(res.body.data.du_id).toBe('new-staff');
        expect(res.body.data.email).toBe('new@du.edu');
        expect(res.body.data.id).toBeGreaterThan(0);
    });

    it('rejects malformed email on create with 400 / VALIDATION_ERROR', async () => {
        const res = await agent.post('/repo/users').set('Authorization', bearer).send({
            du_id: 'x',
            email: 'not-an-email',
            first_name: 'a',
            last_name: 'b',
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects duplicate du_id with 409 / CONFLICT', async () => {
        await db_helper.seed_user({ du_id: 'dup' });
        const res = await agent.post('/repo/users').set('Authorization', bearer).send({
            du_id: 'dup',
            email: 'a@b.com',
            first_name: 'a',
            last_name: 'b',
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CONFLICT');
    });

    it('updates a user via PUT /:id', async () => {
        const u = await db_helper.seed_user({ du_id: 'upd', last_name: 'old' });
        const res = await agent
            .put(`/repo/users/${u.id}`)
            .set('Authorization', bearer)
            .send({ last_name: 'new' });
        expect(res.status).toBe(200);
        expect(res.body.data.last_name).toBe('new');
    });

    it('returns 404 when updating an unknown user', async () => {
        const res = await agent
            .put('/repo/users/9999')
            .set('Authorization', bearer)
            .send({ last_name: 'x' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
    });

    it('soft-deletes via DELETE /:id', async () => {
        const u = await db_helper.seed_user({ du_id: 'goodbye' });
        const del = await agent.delete(`/repo/users/${u.id}`).set('Authorization', bearer);
        expect(del.status).toBe(204);
        // No longer in default listing
        const list = await agent.get('/repo/users').set('Authorization', bearer);
        expect(list.body.data.find((x) => x.id === u.id)).toBeUndefined();
        // But surfaces with include_inactive
        const all = await agent.get('/repo/users?include_inactive=1').set('Authorization', bearer);
        const inactive = all.body.data.find((x) => x.id === u.id);
        expect(inactive).toBeDefined();
        expect(inactive.is_active).toBe(0);
    });

    it('XSS payload in last_name is sanitized before reaching the model', async () => {
        const res = await agent.post('/repo/users').set('Authorization', bearer).send({
            du_id: 'xss',
            email: 'x@b.com',
            first_name: 'a',
            last_name: '<script>alert(1)</script>Smith',
        });
        expect(res.status).toBe(201);
        expect(res.body.data.last_name).not.toContain('<');
        expect(res.body.data.last_name).toContain('Smith');
    });
});
