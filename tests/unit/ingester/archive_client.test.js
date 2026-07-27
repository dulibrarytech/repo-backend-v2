'use strict';

/*
 * Unit tests for ingester/libs/archive_client.js — URL construction,
 * header auth, token passthrough, and the transport-failure →
 * UpstreamError contract. HTTP is faked; config comes from env vars
 * (same harness pattern as astools.test.js).
 */

const archive_module = require('../../../ingester/libs/archive_client');
const app_config = require('../../../config/app');
const { UpstreamError } = require('../../../libs/errors');

function make_fake_http() {
    const calls = { get: [], post: [] };
    let next = { status: 200, data: {} };
    return {
        calls,
        set_response(res) {
            next = res;
        },
        async get(url, opts) {
            calls.get.push({ url, opts });
            if (next.throw) throw next.throw;
            return next;
        },
        async post(url, body, opts) {
            calls.post.push({ url, body, opts });
            if (next.throw) throw next.throw;
            return next;
        },
    };
}

describe('ingester/libs/archive_client', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.CURATION_API = 'https://curation.example.com';
        process.env.CURATION_API_KEY = 'archive-key';
        process.env.CURATION_API_TIMEOUT_MS = '5000';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    it('is_configured reflects url + api_key presence', () => {
        expect(archive_module.is_configured()).toBe(true);
        delete process.env.CURATION_API_KEY;
        app_config._reset();
        expect(archive_module.is_configured()).toBe(false);
    });

    it('list_collections hits the collections endpoint with the API key', async () => {
        const http = make_fake_http();
        http.set_response({ status: 200, data: { result: { collections: ['a'] }, errors: [] } });
        const client = archive_module.create_client(http);

        const res = await client.list_collections();

        expect(res.status).toBe(200);
        expect(http.calls.get[0].url).toBe(
            'https://curation.example.com/api/v2/archive/collections'
        );
        expect(http.calls.get[0].opts.headers['X-API-Key']).toBe('archive-key');
    });

    it('list_packages URL-encodes the collection and passes the token', async () => {
        const http = make_fake_http();
        http.set_response({ status: 200, data: {} });
        const client = archive_module.create_client(http);

        await client.list_packages('B463 Alan Gass', { token: 'tok/+1' });

        expect(http.calls.get[0].url).toBe(
            'https://curation.example.com/api/v2/archive/collections/' +
                'B463%20Alan%20Gass/packages?token=tok%2F%2B1'
        );
    });

    it('list_files builds the two-level path', async () => {
        const http = make_fake_http();
        http.set_response({ status: 200, data: {} });
        const client = archive_module.create_client(http);

        await client.list_files('coll', 'pkg.01');

        expect(http.calls.get[0].url).toBe(
            'https://curation.example.com/api/v2/archive/collections/coll/packages/pkg.01/files'
        );
    });

    it('download_url POSTs the key (and only sends ttl when given)', async () => {
        const http = make_fake_http();
        http.set_response({ status: 200, data: { ok: true, url: 'https://signed' } });
        const client = archive_module.create_client(http);

        await client.download_url('c/p/f.tif');
        expect(http.calls.post[0].url).toBe(
            'https://curation.example.com/api/v2/archive/download-url'
        );
        expect(http.calls.post[0].body).toEqual({ key: 'c/p/f.tif' });

        await client.download_url('c/p/f.tif', { ttl_seconds: 120 });
        expect(http.calls.post[1].body).toEqual({ key: 'c/p/f.tif', ttl_seconds: 120 });
    });

    it('transport failures raise UpstreamError', async () => {
        const http = make_fake_http();
        http.set_response({ throw: new Error('ECONNREFUSED') });
        const client = archive_module.create_client(http);

        await expect(client.list_collections()).rejects.toThrow(UpstreamError);
        await expect(client.download_url('c/p/f')).rejects.toThrow(UpstreamError);
    });

    it('non-2xx statuses pass through for the caller to branch on', async () => {
        const http = make_fake_http();
        http.set_response({ status: 502, data: { result: null, errors: ['down'] } });
        const client = archive_module.create_client(http);

        const res = await client.list_collections();
        expect(res.status).toBe(502);
        expect(res.data.errors).toEqual(['down']);
    });
});
