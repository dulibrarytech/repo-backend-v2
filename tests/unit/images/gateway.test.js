'use strict';

/*
 * Unit tests for the derivative-image gateway — a real express app with
 * an injected fake axios, driven by supertest. Pins the consumer-facing
 * contract: auth, filename validation, streaming + Range/header
 * passthrough, and the upstream status mapping (404/400-empty → 404,
 * 5xx/transport → 502, unconfigured → 503).
 */

const { Readable } = require('node:stream');
const express = require('express');
const supertest = require('supertest');

const { create_gateway, _key_matches, _FILENAME_RE } = require('../../../images/gateway');

const KEY = 'images-test-key';

function fake_http(responses) {
    const calls = [];
    return {
        calls,
        async get(url, opts) {
            calls.push({ url, opts });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return {
                status: next.status,
                headers: next.headers || {},
                data: Readable.from([next.body || Buffer.alloc(0)]),
            };
        },
    };
}

function make_app(http) {
    process.env.TOKEN_SECRET = process.env.TOKEN_SECRET || 'x';
    process.env.APP_PATH = process.env.APP_PATH || '/repo';
    process.env.IMAGES_API_KEY = KEY;
    process.env.CONVERT_SERVICE = 'https://curation.example/api/v1/convert/tiff';
    process.env.CONVERT_SERVICE_API_KEY = 'curation-key';
    require('../../../config/app')._reset();

    const app = express();
    const gateway = create_gateway({ http });
    app.get('/repo/api/v2/image/:filename', gateway.serve_image);
    return app;
}

afterEach(() => {
    delete process.env.IMAGES_API_KEY;
    delete process.env.CONVERT_SERVICE;
    delete process.env.CONVERT_SERVICE_API_KEY;
    require('../../../config/app')._reset();
});

describe('images/gateway — auth', () => {
    it('401s without a key and with a wrong key', async () => {
        const app = make_app(fake_http([]));
        const bare = await supertest(app).get('/repo/api/v2/image/x.jpg').expect(401);
        expect(bare.body.message).toBe('Unauthorized request');
        const wrong = await supertest(app)
            .get('/repo/api/v2/image/x.jpg')
            .set('X-API-Key', 'nope')
            .expect(401);
        expect(wrong.body.message).toBe('Unauthorized request');
    });

    it('accepts the key via header or query param', async () => {
        const http = fake_http([
            { status: 200, headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('a') },
            { status: 200, headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('b') },
        ]);
        const app = make_app(http);
        const via_header = await supertest(app)
            .get('/repo/api/v2/image/x.jpg')
            .set('X-API-Key', KEY)
            .expect(200);
        expect(via_header.body.toString()).toBe('a');
        const via_query = await supertest(app)
            .get(`/repo/api/v2/image/x.jpg?api_key=${KEY}`)
            .expect(200);
        expect(via_query.body.toString()).toBe('b');
    });

    it('503s (fail closed) when IMAGES_API_KEY is not configured', async () => {
        const app = make_app(fake_http([]));
        delete process.env.IMAGES_API_KEY;
        require('../../../config/app')._reset();
        const res = await supertest(app)
            .get('/repo/api/v2/image/x.jpg')
            .set('X-API-Key', KEY)
            .expect(503);
        expect(res.body.message).toBe('Image service is not configured');
    });

    it('key comparison is length-guarded and exact', () => {
        expect(_key_matches(KEY, KEY)).toBe(true);
        expect(_key_matches('', KEY)).toBe(false);
        expect(_key_matches(KEY + 'x', KEY)).toBe(false);
        expect(_key_matches('a'.repeat(300), KEY)).toBe(false);
    });
});

describe('images/gateway — filename validation', () => {
    it('accepts uuid-prefixed derivative names, rejects everything else', () => {
        expect(
            _FILENAME_RE.test('52aafea5-fbaf-4394-a2f6-67c3c0dd6ecb-B463.01.0007.00001.jpg')
        ).toBe(true);
        expect(_FILENAME_RE.test('thing.tif')).toBe(false);
        expect(_FILENAME_RE.test('..%2Fescape.jpg')).toBe(false);
        expect(_FILENAME_RE.test('.hidden.jpg')).toBe(false);
        expect(_FILENAME_RE.test('')).toBe(false);
    });

    it('400s a non-jpg request without calling upstream', async () => {
        const http = fake_http([]);
        const app = make_app(http);
        await supertest(app)
            .get('/repo/api/v2/image/thing.tif')
            .set('X-API-Key', KEY)
            .expect(400);
        expect(http.calls).toHaveLength(0);
    });
});

describe('images/gateway — streaming + passthrough', () => {
    it('streams a 200 with headers, hiding the curation key from consumers', async () => {
        const http = fake_http([
            {
                status: 200,
                headers: {
                    'content-type': 'image/jpeg',
                    'content-length': '9',
                    etag: 'W/"9-123"',
                    'cache-control': 'public, max-age=3600',
                },
                body: Buffer.from('JPEGBYTES'),
            },
        ]);
        const app = make_app(http);
        const res = await supertest(app)
            .get('/repo/api/v2/image/x.jpg')
            .set('X-API-Key', KEY)
            .expect(200);
        expect(res.headers['content-type']).toBe('image/jpeg');
        expect(res.headers.etag).toBe('W/"9-123"');
        expect(res.body.toString()).toBe('JPEGBYTES');
        // Upstream got the curation api key; the consumer never sees the URL.
        expect(http.calls[0].url).toMatch(/\/api\/v1\/image\?filename=x\.jpg/);
        expect(http.calls[0].url).toMatch(/api_key=curation-key/);
    });

    it('forwards Range and passes 206 + Content-Range back', async () => {
        const http = fake_http([
            {
                status: 206,
                headers: { 'content-range': 'bytes 0-0/12345', 'content-type': 'image/jpeg' },
                body: Buffer.from('J'),
            },
        ]);
        const app = make_app(http);
        const res = await supertest(app)
            .get('/repo/api/v2/image/x.jpg')
            .set('X-API-Key', KEY)
            .set('Range', 'bytes=0-0')
            .expect(206);
        expect(res.headers['content-range']).toBe('bytes 0-0/12345');
        expect(http.calls[0].opts.headers.Range).toBe('bytes=0-0');
    });

    it('maps upstream 404 AND 400 (empty derivative) to consumer 404', async () => {
        const http = fake_http([
            { status: 404, headers: {}, body: Buffer.from('{"error":true}') },
            { status: 400, headers: {}, body: Buffer.from('{"errors":["File is empty"]}') },
        ]);
        const app = make_app(http);
        const missing = await supertest(app)
            .get('/repo/api/v2/image/x.jpg')
            .set('X-API-Key', KEY)
            .expect(404);
        expect(missing.body.message).toBe('Resource not found');
        const empty = await supertest(app)
            .get('/repo/api/v2/image/x.jpg')
            .set('X-API-Key', KEY)
            .expect(404);
        expect(empty.body.message).toBe('Resource not found');
    });

    it('maps upstream 5xx and transport failures to 502', async () => {
        const http = fake_http([
            { status: 500, headers: {}, body: Buffer.from('boom') },
            new Error('ECONNREFUSED'),
        ]);
        const app = make_app(http);
        const upstream_5xx = await supertest(app)
            .get('/repo/api/v2/image/x.jpg')
            .set('X-API-Key', KEY)
            .expect(502);
        expect(upstream_5xx.body.message).toBe('Image source unavailable');
        const transport = await supertest(app)
            .get('/repo/api/v2/image/x.jpg')
            .set('X-API-Key', KEY)
            .expect(502);
        expect(transport.body.message).toBe('Image source unavailable');
    });
});
