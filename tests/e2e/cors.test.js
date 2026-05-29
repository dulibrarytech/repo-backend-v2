'use strict';

const supertest = require('supertest');
const { make_app } = require('../helpers/app');

describe('CORS allowlist', () => {
    let app;
    beforeAll(() => {
        // Override the allowlist for this suite.
        app = make_app({
            env: {
                CORS_ALLOWED_ORIGINS: 'http://allowed.example,http://also-allowed.example',
            },
        });
    });

    it('allows requests from an allowlisted origin', async () => {
        const res = await supertest(app)
            .get('/repo/health')
            .set('Origin', 'http://allowed.example')
            .expect(200);
        expect(res.headers['access-control-allow-origin']).toBe('http://allowed.example');
        expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does NOT add CORS headers for a disallowed origin', async () => {
        const res = await supertest(app)
            .get('/repo/health')
            .set('Origin', 'http://evil.example')
            .expect(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('handles preflight OPTIONS for allowed origin', async () => {
        const res = await supertest(app)
            .options('/repo/health')
            .set('Origin', 'http://also-allowed.example')
            .set('Access-Control-Request-Method', 'GET')
            .set('Access-Control-Request-Headers', 'X-Request-Id');
        expect([200, 204]).toContain(res.status);
        expect(res.headers['access-control-allow-origin']).toBe('http://also-allowed.example');
        expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
    });

    it('responds normally when no Origin header is sent (server-to-server)', async () => {
        const res = await supertest(app).get('/repo/health').expect(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
});
