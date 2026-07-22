'use strict';

const supertest = require('supertest');
const express = require('express');
const sanitize = require('../../libs/sanitize');

/*
 * Builds a minimal app that exercises the same body+query sanitize
 * middleware the real factory installs, then echoes whatever survived.
 */
function build_echo_app() {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(sanitize.req_body);
    app.use(sanitize.req_query);
    app.post('/echo', (req, res) => res.json({ body: req.body, query: req.query }));
    app.get('/echo', (req, res) => res.json({ query: req.query }));
    return app;
}

describe('XSS sanitization', () => {
    const app = build_echo_app();

    it('encodes angle brackets in body strings', async () => {
        const res = await supertest(app)
            .post('/echo')
            .send({ title: '<script>alert(1)</script>safe' })
            .expect(200);
        expect(res.body.body.title).not.toContain('<');
        expect(res.body.body.title).not.toContain('>');
        expect(res.body.body.title).toContain('safe');
    });

    it('walks nested arrays + objects', async () => {
        const res = await supertest(app)
            .post('/echo')
            .send({
                a: { b: ['<x>', { c: '<svg onload=alert(1)>' }] },
            })
            .expect(200);
        expect(res.body.body.a.b[0]).not.toContain('<');
        expect(res.body.body.a.b[1].c).not.toContain('<');
    });

    it('strips prototype-pollution keys at the boundary', async () => {
        const res = await supertest(app)
            .post('/echo')
            .send({ ok: 'value', constructor: { x: 1 } })
            .expect(200);
        /*
         * The literal `constructor` own-property must be dropped from
         * the parsed body. Reading `.constructor` always returns the
         * inherited Object constructor — use hasOwnProperty for the
         * real test.
         */
        expect(res.body.body.ok).toBe('value');
        expect(Object.prototype.hasOwnProperty.call(res.body.body, 'constructor')).toBe(false);
    });

    it('encodes angle brackets in query strings', async () => {
        const res = await supertest(app)
            .get('/echo')
            .query({ q: '<img src=x onerror=alert(1)>' })
            .expect(200);
        expect(res.body.query.q).not.toContain('<');
        expect(res.body.query.q).not.toContain('>');
    });

    it('preserves non-string fields as-is', async () => {
        const res = await supertest(app)
            .post('/echo')
            .send({ n: 42, flag: true, none: null, list: [1, 2, 3] })
            .expect(200);
        expect(res.body.body.n).toBe(42);
        expect(res.body.body.flag).toBe(true);
        expect(res.body.body.none).toBe(null);
        expect(res.body.body.list).toEqual([1, 2, 3]);
    });
});
