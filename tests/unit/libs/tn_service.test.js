'use strict';

// Unit tests for libs/tn_service. Tested via create_client(http) with
// an injected fake HTTP so the full path (cache miss → fetch → cache
// → hit) runs without network. The disk cache uses a per-test temp
// directory so tests are isolated and parallel-safe.

const fs = require('node:fs');
const fs_async = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const tn_module = require('../../../libs/tn_service');
const app_config = require('../../../config/app');
const { UpstreamError } = require('../../../libs/errors');

function make_fake_http() {
    const calls = [];
    let next = { status: 200, data: Buffer.from('jpeg-bytes'), headers: {} };
    return {
        calls,
        set_response(res) {
            next = res;
        },
        async get(url, opts) {
            calls.push({ url, opts });
            if (next.throw) throw next.throw;
            return next;
        },
    };
}

describe('libs/tn_service', () => {
    let tempdir;
    let original_env;

    beforeEach(async () => {
        original_env = { ...process.env };
        tempdir = await fs_async.mkdtemp(path.join(os.tmpdir(), 'tn-test-'));
        process.env.TN_SERVICE = 'https://tn.example/svc';
        process.env.TN_SERVICE_API_KEY = 'sekret';
        process.env.TN_SERVICE_TIMEOUT_MS = '5000';
        process.env.TN_CACHE_PATH = tempdir;
        app_config._reset();
    });

    afterEach(async () => {
        process.env = original_env;
        app_config._reset();
        await fs_async.rm(tempdir, { recursive: true, force: true });
    });

    describe('is_configured', () => {
        it('returns true when url + api_key are both set', () => {
            expect(tn_module.is_configured()).toBe(true);
        });

        it('returns false when api_key is missing', () => {
            delete process.env.TN_SERVICE_API_KEY;
            app_config._reset();
            expect(tn_module.is_configured()).toBe(false);
        });

        it('returns false when url is missing', () => {
            delete process.env.TN_SERVICE;
            app_config._reset();
            expect(tn_module.is_configured()).toBe(false);
        });
    });

    describe('build_endpoint', () => {
        it('matches v1 wire format', () => {
            const url = tn_module.build_endpoint('abc-123');
            expect(url).toBe('https://tn.example/svc/datastream/abc-123/tn?key=sekret');
        });

        it('URL-encodes pid and api_key', () => {
            process.env.TN_SERVICE_API_KEY = 'a/b+c=d';
            app_config._reset();
            // weird chars in pid wouldn't normally happen (validator
            // gates UUIDs upstream), but defense-in-depth.
            const url = tn_module.build_endpoint('pid/with/slashes');
            expect(url).toBe(
                'https://tn.example/svc/datastream/pid%2Fwith%2Fslashes/tn?key=a%2Fb%2Bc%3Dd'
            );
        });

        it('strips trailing slashes from the base url', () => {
            process.env.TN_SERVICE = 'https://tn.example/svc////';
            app_config._reset();
            const url = tn_module.build_endpoint('p');
            expect(url).toBe('https://tn.example/svc/datastream/p/tn?key=sekret');
        });
    });

    describe('fetch_thumbnail', () => {
        it('returns the buffer on HTTP 200', async () => {
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
                headers: {},
            });
            const client = tn_module.create_client(http);
            const buf = await client.fetch_thumbnail('pid-1');
            expect(Buffer.isBuffer(buf)).toBe(true);
            expect(buf.length).toBe(4);
            expect(http.calls).toHaveLength(1);
            expect(http.calls[0].url).toMatch(/\/datastream\/pid-1\/tn\?key=/);
            // timeout from config
            expect(http.calls[0].opts.timeout).toBe(5000);
            expect(http.calls[0].opts.responseType).toBe('arraybuffer');
        });

        it('normalizes ArrayBuffer-typed responses to Buffer', async () => {
            const http = make_fake_http();
            // Some axios versions return a typed array; ensure we
            // convert to a Node Buffer regardless.
            const arr = new Uint8Array([1, 2, 3]).buffer;
            http.set_response({ status: 200, data: arr, headers: {} });
            const client = tn_module.create_client(http);
            const buf = await client.fetch_thumbnail('pid-1');
            expect(Buffer.isBuffer(buf)).toBe(true);
        });

        it('throws UpstreamError on HTTP 404', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: Buffer.alloc(0), headers: {} });
            const client = tn_module.create_client(http);
            await expect(client.fetch_thumbnail('pid-1')).rejects.toBeInstanceOf(UpstreamError);
        });

        it('throws UpstreamError on HTTP 500', async () => {
            const http = make_fake_http();
            http.set_response({ status: 500, data: Buffer.alloc(0), headers: {} });
            const client = tn_module.create_client(http);
            await expect(client.fetch_thumbnail('pid-1')).rejects.toThrow(/HTTP 500/);
        });

        it('throws UpstreamError on empty body', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: Buffer.alloc(0), headers: {} });
            const client = tn_module.create_client(http);
            await expect(client.fetch_thumbnail('pid-1')).rejects.toThrow(/empty/);
        });

        it('throws UpstreamError on transport failure', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ETIMEDOUT') });
            const client = tn_module.create_client(http);
            await expect(client.fetch_thumbnail('pid-1')).rejects.toBeInstanceOf(UpstreamError);
        });

        it('throws UpstreamError when service is not configured', async () => {
            delete process.env.TN_SERVICE;
            app_config._reset();
            const http = make_fake_http();
            const client = tn_module.create_client(http);
            await expect(client.fetch_thumbnail('pid-1')).rejects.toBeInstanceOf(UpstreamError);
            // Should not have made any HTTP call.
            expect(http.calls).toHaveLength(0);
        });
    });

    describe('get_thumbnail (cache-first)', () => {
        it('on first call: fetches, caches, returns buffer', async () => {
            const http = make_fake_http();
            const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
            http.set_response({ status: 200, data: payload, headers: {} });
            const client = tn_module.create_client(http);

            const buf = await client.get_thumbnail('pid-cache-1');
            expect(buf.equals(payload)).toBe(true);
            expect(http.calls).toHaveLength(1);
            // Cache file landed.
            const cached_path = path.join(tempdir, 'pid-cache-1.jpg');
            expect(fs.existsSync(cached_path)).toBe(true);
            const on_disk = await fs_async.readFile(cached_path);
            expect(on_disk.equals(payload)).toBe(true);
        });

        it('on second call: serves from disk cache, no HTTP', async () => {
            const http = make_fake_http();
            const payload = Buffer.from([0xff, 0xd8, 0xff, 1]);
            http.set_response({ status: 200, data: payload, headers: {} });
            const client = tn_module.create_client(http);

            await client.get_thumbnail('pid-cache-2');
            // Second call should skip the network.
            http.set_response({
                throw: new Error('should not be called'),
            });
            const buf = await client.get_thumbnail('pid-cache-2');
            expect(buf.equals(payload)).toBe(true);
            expect(http.calls).toHaveLength(1); // still just the first one
        });

        it('a fetch failure does not poison the cache (no file left behind)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 500, data: Buffer.alloc(0), headers: {} });
            const client = tn_module.create_client(http);
            await expect(client.get_thumbnail('pid-fail')).rejects.toBeInstanceOf(UpstreamError);
            const cached_path = path.join(tempdir, 'pid-fail.jpg');
            expect(fs.existsSync(cached_path)).toBe(false);
        });

        it('write-cache failures do not break the request', async () => {
            // Point the cache at a non-writable path (a regular file
            // we'll pretend is the cache dir — mkdir will fail).
            const blocked = path.join(tempdir, 'blocked');
            await fs_async.writeFile(blocked, 'not a directory');
            process.env.TN_CACHE_PATH = path.join(blocked, 'cant-go-here');
            app_config._reset();

            const http = make_fake_http();
            const payload = Buffer.from([0xff, 0xd8, 0xff]);
            http.set_response({ status: 200, data: payload, headers: {} });
            const client = tn_module.create_client(http);

            // Should still return the bytes; the cache write fails silently.
            const buf = await client.get_thumbnail('pid-blocked');
            expect(buf.equals(payload)).toBe(true);
        });
    });

    describe('invalidate_cache', () => {
        it('removes the cache file and reports invalidated:true', async () => {
            // Seed: pre-write a file directly, simulating a previous fetch.
            const cached_path = path.join(tempdir, 'pid-inv-1.jpg');
            await fs_async.writeFile(cached_path, Buffer.from([1, 2, 3]));
            expect(fs.existsSync(cached_path)).toBe(true);

            const result = await tn_module.invalidate_cache('pid-inv-1');
            expect(result.invalidated).toBe(true);
            expect(fs.existsSync(cached_path)).toBe(false);
        });

        it('returns invalidated:false when no cache file exists (ENOENT is not an error)', async () => {
            const result = await tn_module.invalidate_cache('pid-never-cached');
            expect(result.invalidated).toBe(false);
        });

        it('after invalidation, the next get_thumbnail call refetches', async () => {
            // First fetch → cache → invalidate → second fetch should
            // hit the network again, not the deleted cache file.
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: Buffer.from([0xff, 0xd8, 0xff, 1]),
                headers: {},
            });
            const client = tn_module.create_client(http);
            await client.get_thumbnail('pid-roundtrip');
            expect(http.calls).toHaveLength(1);

            await tn_module.invalidate_cache('pid-roundtrip');

            // Different bytes the second time so we can prove a real fetch.
            http.set_response({
                status: 200,
                data: Buffer.from([0xff, 0xd8, 0xff, 2]),
                headers: {},
            });
            const buf2 = await client.get_thumbnail('pid-roundtrip');
            expect(http.calls).toHaveLength(2);
            expect(buf2[3]).toBe(2);
        });

        it('returns invalidated:false when no cache_path is configured', async () => {
            delete process.env.TN_CACHE_PATH;
            // The default in config/app.js fills in a value, so to
            // actually drop the cache_path we need an explicit empty
            // string — that's what disables caching.
            process.env.TN_CACHE_PATH = '';
            app_config._reset();
            const result = await tn_module.invalidate_cache('pid-nocfg');
            expect(result.invalidated).toBe(false);
        });
    });

    describe('cached_exists', () => {
        it('returns true after a successful get_thumbnail call', async () => {
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: Buffer.from([0xff, 0xd8, 0xff]),
                headers: {},
            });
            const client = tn_module.create_client(http);
            await client.get_thumbnail('pid-check');
            expect(client.cached_exists('pid-check')).toBe(true);
        });

        it('returns false for an unknown pid', () => {
            expect(tn_module.cached_exists('pid-never-seen')).toBe(false);
        });
    });
});
