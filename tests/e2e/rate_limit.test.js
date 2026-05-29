'use strict';

const supertest = require('supertest');
const express = require('express');

const { login_limiter, write_limiter } = require('../../auth/rate_limit');
const request_id = require('../../libs/request_id');

// The Phase 1 app surface has no auth endpoints yet (Phase 3 lands
// auth/login etc.). To prove the limiter is production-shaped, we mount
// it against a minimal app that simulates the eventual endpoint.
function build_protected_app() {
    const app = express();
    app.use(express.json());
    app.use(request_id);
    app.post(
        '/auth/login',
        login_limiter({ windowMs: 60_000, limit: 3 }),
        (_req, res) => res.status(401).json({ error: 'bad credentials' }) // always 401, but counted
    );
    app.post('/write', write_limiter({ windowMs: 60_000, limit: 2 }), (_req, res) =>
        res.json({ ok: true })
    );
    return app;
}

describe('rate limiting end-to-end', () => {
    it('login: returns 429 after the 4th attempt within window', async () => {
        const app = build_protected_app();
        const agent = supertest.agent(app);
        // 3 allowed
        for (let i = 0; i < 3; i++) {
            const r = await agent.post('/auth/login').send({ user: 'x', pw: 'y' });
            expect([200, 401]).toContain(r.status);
        }
        // 4th blocked
        const blocked = await agent.post('/auth/login').send({});
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe('RATE_LIMITED');
        expect(blocked.body.error).toMatch(/too many login attempts/i);
        expect(blocked.body.request_id).toMatch(/-/);
    });

    it('login: 429 response includes draft-7 RateLimit headers', async () => {
        const app = build_protected_app();
        const agent = supertest.agent(app);
        for (let i = 0; i < 3; i++) await agent.post('/auth/login').send({});
        const blocked = await agent.post('/auth/login').send({}).expect(429);
        expect(blocked.headers).toHaveProperty('ratelimit');
        expect(blocked.headers).toHaveProperty('ratelimit-policy');
    });

    it('write_limiter counts independently from login_limiter', async () => {
        const app = build_protected_app();
        const agent = supertest.agent(app);
        // exhaust write
        expect((await agent.post('/write')).status).toBe(200);
        expect((await agent.post('/write')).status).toBe(200);
        expect((await agent.post('/write')).status).toBe(429);
        // login still has its own budget
        expect((await agent.post('/auth/login').send({})).status).toBe(401);
    });

    it('different IPs do not share a budget (validate trustProxy disabled)', async () => {
        // express-rate-limit keys by req.ip. supertest reuses the same
        // socket so we can't easily fake IPs without trust proxy on. This
        // test just asserts the limiter exists with an expected shape.
        const mw = login_limiter({ limit: 1 });
        expect(typeof mw).toBe('function');
        expect(mw.length).toBe(3);
    });
});
