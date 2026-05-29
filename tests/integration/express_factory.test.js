'use strict';

const supertest = require('supertest');
const { make_app } = require('../helpers/app');

describe('config/express factory — integration', () => {
    let app;
    beforeAll(() => {
        app = make_app();
    });

    it('boots and serves /health', async () => {
        const res = await supertest(app).get('/repo/health').expect(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.app).toBeTruthy();
        expect(res.body.version).toBeTruthy();
        expect(res.body.request_id).toMatch(/-/);
    });

    it('attaches X-Request-Id to every response', async () => {
        const res = await supertest(app).get('/repo/version').expect(200);
        expect(res.headers['x-request-id']).toMatch(/-/);
        expect(res.body.request_id).toBe(res.headers['x-request-id']);
    });

    it('honors inbound X-Request-Id', async () => {
        const inbound = '11111111-2222-3333-4444-555555555555';
        const res = await supertest(app)
            .get('/repo/version')
            .set('X-Request-Id', inbound)
            .expect(200);
        expect(res.headers['x-request-id']).toBe(inbound);
        expect(res.body.request_id).toBe(inbound);
    });

    it('404s unknown routes through the typed error handler', async () => {
        const res = await supertest(app).get('/repo/does-not-exist').expect(404);
        expect(res.body.code).toBe('NOT_FOUND');
        expect(res.body.error).toMatch(/not found/i);
        expect(res.body.request_id).toMatch(/-/);
    });

    it('does NOT advertise express via x-powered-by', async () => {
        const res = await supertest(app).get('/repo/health');
        expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('sanitize middleware runs before route handlers (body)', async () => {
        // Echo route added by spinning up a dedicated app instance.
        const express = require('express');
        const helmet = require('helmet');
        const sanitize = require('../../libs/sanitize');
        const tester = express();
        tester.use(express.json());
        tester.use(helmet());
        tester.use(sanitize.req_body);
        tester.post('/echo', (req, res) => res.json(req.body));
        const res = await supertest(tester)
            .post('/echo')
            .send({ title: '<script>x</script>hi' })
            .expect(200);
        expect(res.body.title).not.toContain('<script');
        expect(res.body.title).toContain('hi');
    });
});
