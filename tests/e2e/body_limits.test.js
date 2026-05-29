'use strict';

const supertest = require('supertest');
const express = require('express');
const { make_app } = require('../helpers/app');

describe('body parser limits', () => {
    let app;
    beforeAll(() => {
        app = make_app();
    });

    it('rejects oversize JSON bodies with 413 / PAYLOAD_TOO_LARGE', async () => {
        // Build a body > 1mb. `huge` is ~2mb of plain text inside one
        // JSON string — bypasses gzip and tests the raw limit.
        const huge = 'A'.repeat(2 * 1024 * 1024);
        const res = await supertest(app)
            .post('/repo/health')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify({ blob: huge }));
        expect(res.status).toBe(413);
        expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('accepts a small JSON body and surfaces it to the route', async () => {
        // The Phase 1 app has no POST routes yet — verify by spinning up
        // a minimal app that reuses the same JSON parser config.
        const inner = express();
        inner.use(express.json({ limit: '1mb', strict: true }));
        inner.post('/echo', (req, res) => res.json(req.body));
        const res = await supertest(inner)
            .post('/echo')
            .set('Content-Type', 'application/json')
            .send({ ok: true })
            .expect(200);
        expect(res.body).toEqual({ ok: true });
    });

    it('JSON parser is strict (rejects bare top-level values)', async () => {
        const inner = express();
        inner.use(express.json({ limit: '1mb', strict: true }));
        inner.post('/echo', (req, res) => res.json(req.body));
        const res = await supertest(inner)
            .post('/echo')
            .set('Content-Type', 'application/json')
            .send('"a bare string"');
        // strict mode: only arrays/objects accepted at the top level
        expect(res.status).toBe(400);
    });
});
