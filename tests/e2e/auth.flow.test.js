'use strict';

const supertest = require('supertest');
const { make_app } = require('../helpers/app');
const db_helper = require('../helpers/db');
const jwt = require('../../libs/jwt');

let app;
let agent;

describe('auth — full login → me → logout → refresh flow', () => {
    beforeAll(async () => {
        app = make_app();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        agent = supertest.agent(app); // agent retains cookies across requests
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('POST /auth/login issues a cookie + body token for an active user', async () => {
        await db_helper.seed_user({ du_id: 'alice', email: 'a@du.edu' });
        const res = await agent.post('/repo/auth/login').send({ du_id: 'alice' });
        expect(res.status).toBe(200);
        expect(res.body.user.du_id).toBe('alice');
        expect(res.body.token).toBeTruthy();
        expect(res.body.refresh_token).toMatch(/-/);
        const set_cookie = res.headers['set-cookie'];
        expect(Array.isArray(set_cookie) ? set_cookie[0] : set_cookie).toMatch(
            new RegExp(`^${jwt.COOKIE_NAME}=`)
        );
    });

    it('POST /auth/login returns 401 for unknown du_id', async () => {
        const res = await agent.post('/repo/auth/login').send({ du_id: 'nobody' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
        // The error message MUST NOT distinguish "no such user" from
        // "wrong password" — would leak existence of du_ids.
        expect(res.body.error).toBe('Invalid credentials');
    });

    it('POST /auth/login returns 401 for inactive user', async () => {
        await db_helper.seed_user({ du_id: 'inactive', is_active: 0 });
        const res = await agent.post('/repo/auth/login').send({ du_id: 'inactive' });
        expect(res.status).toBe(401);
    });

    it('POST /auth/login rejects missing du_id with 400 / VALIDATION_ERROR', async () => {
        const res = await agent.post('/repo/auth/login').send({});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('GET /auth/me returns the authenticated user after login (via cookie)', async () => {
        await db_helper.seed_user({ du_id: 'me', email: 'me@du.edu' });
        await agent.post('/repo/auth/login').send({ du_id: 'me' });
        const me = await agent.get('/repo/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.user.du_id).toBe('me');
    });

    it('GET /auth/me is 401 without auth', async () => {
        const res = await agent.get('/repo/auth/me');
        expect(res.status).toBe(401);
    });

    it('POST /auth/logout clears cookie and zeroes refresh token', async () => {
        const u = await db_helper.seed_user({ du_id: 'out' });
        await agent.post('/repo/auth/login').send({ du_id: 'out' });
        const out = await agent.post('/repo/auth/logout');
        expect(out.status).toBe(204);
        // Cookie cleared → subsequent /me is 401
        const me = await agent.get('/repo/auth/me');
        expect(me.status).toBe(401);
        // DB token zeroed
        const auth_model = require('../../auth/model');
        const fresh = await auth_model.find_by_id(u.id);
        expect(fresh.token).toBe('0');
    });

    it('POST /auth/refresh exchanges a valid refresh token for new credentials', async () => {
        await db_helper.seed_user({ du_id: 'ref' });
        const login = await agent.post('/repo/auth/login').send({ du_id: 'ref' });
        const refresh = await agent
            .post('/repo/auth/refresh')
            .send({ user_id: login.body.user.id, refresh_token: login.body.refresh_token });
        expect(refresh.status).toBe(200);
        expect(refresh.body.token).toBeTruthy();
        // Refresh tokens rotate — new value differs
        expect(refresh.body.refresh_token).not.toBe(login.body.refresh_token);
    });

    it('POST /auth/refresh rejects a stale refresh token', async () => {
        await db_helper.seed_user({ du_id: 'stale' });
        const login = await agent.post('/repo/auth/login').send({ du_id: 'stale' });
        const old_refresh = login.body.refresh_token;
        // Rotate via successful refresh — old token now stale
        await agent
            .post('/repo/auth/refresh')
            .send({ user_id: login.body.user.id, refresh_token: old_refresh });
        const replay = await agent
            .post('/repo/auth/refresh')
            .send({ user_id: login.body.user.id, refresh_token: old_refresh });
        expect(replay.status).toBe(401);
    });

    it('login_limiter caps brute-force attempts on /auth/login', async () => {
        await db_helper.seed_user({ du_id: 'limited' });
        // login_limiter defaults to 10/15min — first 10 should not 429
        for (let i = 0; i < 10; i++) {
            await agent.post('/repo/auth/login').send({ du_id: 'limited' });
        }
        const blocked = await agent.post('/repo/auth/login').send({ du_id: 'limited' });
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe('RATE_LIMITED');
    });
});
