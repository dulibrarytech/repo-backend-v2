'use strict';

const supertest = require('supertest');
const { make_app } = require('../helpers/app');

describe('helmet security headers', () => {
    let app;
    beforeAll(() => {
        app = make_app();
    });

    it('sets Content-Security-Policy', async () => {
        const res = await supertest(app).get('/repo/health');
        expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
        expect(res.headers['content-security-policy']).toMatch(/object-src 'none'/);
        expect(res.headers['content-security-policy']).toMatch(/cdn\.jsdelivr\.net/);
    });

    it('sets Referrer-Policy: no-referrer', async () => {
        const res = await supertest(app).get('/repo/health');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('sets X-Content-Type-Options: nosniff', async () => {
        const res = await supertest(app).get('/repo/health');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sets X-Frame-Options to DENY/SAMEORIGIN (frame-ancestors is the modern equivalent)', async () => {
        const res = await supertest(app).get('/repo/health');
        // helmet 8 still emits x-frame-options for legacy browsers
        expect(res.headers['x-frame-options']).toBeTruthy();
    });

    it('sets Strict-Transport-Security with one-year maxAge', async () => {
        const res = await supertest(app).get('/repo/health');
        expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    });

    it('does NOT advertise x-powered-by', async () => {
        const res = await supertest(app).get('/repo/health');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });
});
