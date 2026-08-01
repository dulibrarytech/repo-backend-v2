'use strict';

const astools_module = require('../../../ingester/libs/astools');
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

describe('ingester/libs/astools', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        /*
         * Wipe legacy overlap names so a polluted shell can't poison
         * the fallback chain mid-test.
         */
        delete process.env.QA_SERVICE;
        delete process.env.QA_SERVICE_API_KEY;
        delete process.env.ASTOOLS_SERVICE;
        delete process.env.ASTOOLS_API_KEY;
        delete process.env.ASTOOLS_TIMEOUT_MS;
        delete process.env.ASTOOLS_MDO_TIMEOUT_MS;
        process.env.CURATION_API = 'https://curation.example.com';
        process.env.CURATION_API_KEY = 'astools-key';
        process.env.CURATION_API_TIMEOUT_MS = '5000';
        process.env.CURATION_API_MDO_TIMEOUT_MS = '60000';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('is_configured', () => {
        it('returns true when url + api_key are set', () => {
            expect(astools_module.is_configured()).toBe(true);
        });

        it('returns false when api_key is missing', () => {
            delete process.env.CURATION_API_KEY;
            app_config._reset();
            expect(astools_module.is_configured()).toBe(false);
        });

        it('falls back to legacy QA_SERVICE env vars when CURATION_API_* unset', () => {
            delete process.env.CURATION_API;
            delete process.env.CURATION_API_KEY;
            process.env.QA_SERVICE = 'https://qa.example';
            process.env.QA_SERVICE_API_KEY = 'qa-key';
            app_config._reset();
            expect(astools_module.is_configured()).toBe(true);
        });

        it('falls back to legacy ASTOOLS_SERVICE env vars when CURATION_API_* unset', () => {
            delete process.env.CURATION_API;
            delete process.env.CURATION_API_KEY;
            process.env.ASTOOLS_SERVICE = 'https://astools.example';
            process.env.ASTOOLS_API_KEY = 'astools-key';
            app_config._reset();
            expect(astools_module.is_configured()).toBe(true);
        });
    });

    describe('list_workspace', () => {
        it('GETs the workspace endpoint with X-API-Key', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { folders: ['a', 'b'] } });
            const client = astools_module.create_client(http);
            const res = await client.list_workspace();
            expect(res.status).toBe(200);
            const call = http.calls.get[0];
            expect(call.url).toBe('https://curation.example.com/api/v1/astools/workspace');
            expect(call.opts.headers['X-API-Key']).toBe('astools-key');
        });

        it('passes the response through unchanged', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: { error: 'no such folder' } });
            const client = astools_module.create_client(http);
            const res = await client.list_workspace();
            expect(res.status).toBe(404);
            expect(res.data.error).toBe('no such folder');
        });
    });

    describe('URL normalization', () => {
        it('strips a trailing `/api/v1/astools/` from the base URL', async () => {
            /*
             * The legacy ingest-service .env stored CURATION_API
             * (formerly ASTOOLS_SERVICE) with the path tail included;
             * without normalization the client would double-append.
             */
            delete process.env.CURATION_API;
            process.env.CURATION_API = 'http://curation.example.com:8185/api/v1/astools/';
            app_config._reset();
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = astools_module.create_client(http);
            await client.list_workspace();
            expect(http.calls.get[0].url).toBe(
                'http://curation.example.com:8185/api/v1/astools/workspace'
            );
        });

        it('also tolerates the base URL without the path tail', async () => {
            delete process.env.CURATION_API;
            process.env.CURATION_API = 'http://curation.example.com:8185';
            app_config._reset();
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = astools_module.create_client(http);
            await client.list_workspace();
            expect(http.calls.get[0].url).toBe(
                'http://curation.example.com:8185/api/v1/astools/workspace'
            );
        });
    });

    describe('list_processed', () => {
        it('GETs the processed endpoint (separate from /workspace)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { result: ['col-a'] } });
            const client = astools_module.create_client(http);
            const res = await client.list_processed();
            expect(res.status).toBe(200);
            expect(http.calls.get[0].url).toBe(
                'https://curation.example.com/api/v1/astools/processed'
            );
        });
    });

    describe('list_packages', () => {
        it('uses `batch=` (NOT `folder=`) — matches curation-service param name', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { result: [] } });
            const client = astools_module.create_client(http);
            await client.list_packages('weird folder/name');
            expect(http.calls.get[0].url).toContain(
                'workspace/packages?batch=weird%20folder%2Fname'
            );
            // Belt-and-braces — make sure we did NOT use the wrong key.
            expect(http.calls.get[0].url).not.toMatch(/[?&]folder=/);
        });
    });

    describe('get_uri', () => {
        it('passes folder + package params', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { result: { uris: ['/x'], files: [] } } });
            const client = astools_module.create_client(http);
            await client.get_uri('col-A', 'pkg-001');
            const url = http.calls.get[0].url;
            expect(url).toContain('workspace/uri');
            expect(url).toContain('folder=col-A');
            expect(url).toContain('package=pkg-001');
        });
    });

    describe('make_digital_objects', () => {
        it('POSTs a `{ data: { folder } }` envelope (NOT a flat body, NOT a query string)', async () => {
            /*
             * Matches _validate_make_digital_objects_request in the
             * curation-service: the validator pulls folder out of
             * `data.data.folder` and rejects unwrapped bodies with
             * "Invalid request format: missing or invalid data object".
             */
            const http = make_fake_http();
            http.set_response({ status: 200, data: { result: { success: true } } });
            const client = astools_module.create_client(http);
            await client.make_digital_objects('col-A');
            const call = http.calls.post[0];
            expect(call.url).toBe(
                'https://curation.example.com/api/v1/astools/make-digital-objects'
            );
            expect(call.body).toEqual({ data: { folder: 'col-A' } });
            // mdo_timeout_ms env override is 60000, not the default 30000.
            expect(call.opts.timeout).toBe(60000);
        });

        it('merges additional opts into the nested data object', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = astools_module.create_client(http);
            await client.make_digital_objects('col-A', { is_kaltura: 1, verbose: true });
            expect(http.calls.post[0].body).toEqual({
                data: { folder: 'col-A', is_kaltura: 1, verbose: true },
            });
        });
    });

    describe('revert_to_mdo', () => {
        it('POSTs a JSON body { folder } to the revert endpoint', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { result: { removed: ['a', 'b'] } } });
            const client = astools_module.create_client(http);
            const res = await client.revert_to_mdo('col-A');
            expect(res.status).toBe(200);
            const call = http.calls.post[0];
            expect(call.url).toBe(
                'https://curation.example.com/api/v1/astools/revert-to-make-digital-objects'
            );
            expect(call.body).toEqual({ folder: 'col-A' });
        });
    });

    describe('error handling', () => {
        it('throws UpstreamError on transport failure', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNRESET') });
            const client = astools_module.create_client(http);
            await expect(client.list_workspace()).rejects.toBeInstanceOf(UpstreamError);
        });
    });
});
