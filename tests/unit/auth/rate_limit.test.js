'use strict';

const express = require('express');
const supertest = require('supertest');

const { login_limiter, write_limiter, api_limiter } = require('../../../auth/rate_limit');

function make_app(limiter) {
    const app = express();
    app.use((req, _res, next) => {
        req.id = 'test-req-id';
        next();
    });
    app.use(limiter);
    app.get('/x', (_req, res) => res.json({ ok: true }));
    return app;
}

describe('auth/rate_limit', () => {
    it('login_limiter returns 429 after threshold', async () => {
        const app = make_app(login_limiter({ windowMs: 60_000, limit: 3 }));
        const agent = supertest.agent(app);
        for (let i = 0; i < 3; i++) {
            await agent.get('/x').expect(200);
        }
        const blocked = await agent.get('/x');
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe('RATE_LIMITED');
        expect(blocked.body.request_id).toBe('test-req-id');
    });

    it('429 response includes RateLimit-* headers (draft-7)', async () => {
        const app = make_app(login_limiter({ windowMs: 60_000, limit: 1 }));
        const agent = supertest.agent(app);
        await agent.get('/x').expect(200);
        const blocked = await agent.get('/x').expect(429);
        // draft-7 uses the RateLimit header
        expect(blocked.headers).toHaveProperty('ratelimit');
    });

    it('write_limiter has its own clock independent of login_limiter', async () => {
        const app = express();
        app.use((req, _res, next) => {
            req.id = 'rid';
            next();
        });
        app.post('/login', login_limiter({ windowMs: 60_000, limit: 1 }), (_req, res) =>
            res.sendStatus(200)
        );
        app.post('/write', write_limiter({ windowMs: 60_000, limit: 1 }), (_req, res) =>
            res.sendStatus(200)
        );
        const agent = supertest.agent(app);

        expect((await agent.post('/login')).status).toBe(200);
        expect((await agent.post('/login')).status).toBe(429);
        // /write counter is independent, first call still passes
        expect((await agent.post('/write')).status).toBe(200);
        expect((await agent.post('/write')).status).toBe(429);
    });

    it('api_limiter exposes a working factory at default-ish limits', () => {
        const mw = api_limiter({ limit: 1 });
        expect(typeof mw).toBe('function');
        expect(mw.length).toBe(3); // (req, res, next)
    });
});
