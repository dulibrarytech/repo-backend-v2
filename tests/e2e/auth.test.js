'use strict';

const supertest = require('supertest');
const express = require('express');
const cookie_parser = require('cookie-parser');

const { require_auth, optional_auth } = require('../../auth/middleware');
const jwt = require('../../libs/jwt');

// We don't have any protected app routes yet — those land in Phase 3.
// For Phase 1, prove the middleware behaves correctly in a real Express
// pipeline by mounting it on a test-only echo route.

function build_app() {
    const app = express();
    app.use(express.json());
    app.use(cookie_parser());
    app.get('/public', (_req, res) => res.json({ public: true }));
    app.get('/protected', require_auth, (req, res) => res.json({ user: req.user }));
    app.get('/optional', optional_auth, (req, res) =>
        res.json({ authenticated: Boolean(req.user), user: req.user || null })
    );
    // Centralized error handler (same shape as config/express.js)
    app.use((err, _req, res, _next) => {
        res.status(err.status || 500).json({ error: err.message, code: err.code });
    });
    return app;
}

describe('auth — protected routes end-to-end', () => {
    const app = build_app();

    it('public route is reachable without a token', async () => {
        const res = await supertest(app).get('/public');
        expect(res.status).toBe(200);
        expect(res.body.public).toBe(true);
    });

    it('protected route returns 401 without a token', async () => {
        const res = await supertest(app).get('/protected').expect(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('protected route accepts a valid bearer token', async () => {
        const token = jwt.sign({ sub: 'user-a', role: 'staff' });
        const res = await supertest(app)
            .get('/protected')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);
        expect(res.body.user.sub).toBe('user-a');
        expect(res.body.user.role).toBe('staff');
    });

    it('protected route accepts a valid cookie', async () => {
        const token = jwt.sign({ sub: 'user-c' });
        const res = await supertest(app)
            .get('/protected')
            .set('Cookie', `${jwt.COOKIE_NAME}=${token}`)
            .expect(200);
        expect(res.body.user.sub).toBe('user-c');
    });

    it('protected route rejects an expired token with 401', async () => {
        const token = jwt.sign({ sub: 'x' }, { expiresIn: '-1s' });
        const res = await supertest(app)
            .get('/protected')
            .set('Authorization', `Bearer ${token}`)
            .expect(401);
        expect(res.body.error).toMatch(/expired/i);
    });

    it('optional_auth route returns authenticated:false anonymously', async () => {
        const res = await supertest(app).get('/optional').expect(200);
        expect(res.body.authenticated).toBe(false);
    });

    it('optional_auth route returns user when token is valid', async () => {
        const token = jwt.sign({ sub: 'opt-u' });
        const res = await supertest(app)
            .get('/optional')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);
        expect(res.body.authenticated).toBe(true);
        expect(res.body.user.sub).toBe('opt-u');
    });

    it('optional_auth route silently ignores an invalid token', async () => {
        const res = await supertest(app)
            .get('/optional')
            .set('Authorization', 'Bearer garbage')
            .expect(200);
        expect(res.body.authenticated).toBe(false);
    });
});

describe('JWT cookie issuance through Express', () => {
    function build_issue_app() {
        const app = express();
        app.post('/login', (req, res) => {
            jwt.issue_cookie(res, { sub: 'staff-1' });
            res.status(204).end();
        });
        app.post('/logout', (_req, res) => {
            jwt.clear_cookie(res);
            res.status(204).end();
        });
        return app;
    }

    it('sets a HttpOnly cookie with the configured name on login', async () => {
        const res = await supertest(build_issue_app()).post('/login').expect(204);
        const set_cookie = res.headers['set-cookie'];
        expect(set_cookie).toBeDefined();
        const cookie = Array.isArray(set_cookie) ? set_cookie[0] : set_cookie;
        expect(cookie).toMatch(new RegExp(`^${jwt.COOKIE_NAME}=`));
        expect(cookie).toMatch(/HttpOnly/);
        expect(cookie).toMatch(/SameSite=Lax/);
    });

    it('clears the cookie on logout', async () => {
        const res = await supertest(build_issue_app()).post('/logout').expect(204);
        const set_cookie = res.headers['set-cookie'];
        const cookie = Array.isArray(set_cookie) ? set_cookie[0] : set_cookie;
        expect(cookie).toMatch(new RegExp(`^${jwt.COOKIE_NAME}=`));
        // clearCookie sets Expires to epoch
        expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
    });
});
