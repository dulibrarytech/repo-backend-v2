'use strict';

const qa_module = require('../../../ingester/libs/qa_service');
const app_config = require('../../../config/app');
const { UpstreamError } = require('../../../libs/errors');

function make_fake_http() {
    const calls = { get: [] };
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
    };
}

describe('ingester/libs/qa_service', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        // Wipe every overlapping name so legacy fallbacks from a
        // host shell can't pollute the tests.
        delete process.env.QA_SERVICE;
        delete process.env.QA_SERVICE_API_KEY;
        delete process.env.QA_SERVICE_TIMEOUT_MS;
        delete process.env.QA_SERVICE_MOVE_TIMEOUT_MS;
        delete process.env.ASTOOLS_SERVICE;
        delete process.env.ASTOOLS_API_KEY;
        process.env.CURATION_API = 'https://qa.example.com';
        process.env.CURATION_API_KEY = 'qa-key';
        process.env.CURATION_API_TIMEOUT_MS = '5000';
        process.env.CURATION_API_MOVE_TIMEOUT_MS = '60000';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('is_configured', () => {
        it('returns true when url + api_key are set', () => {
            expect(qa_module.is_configured()).toBe(true);
        });

        it('returns false when api_key is missing', () => {
            delete process.env.CURATION_API_KEY;
            app_config._reset();
            expect(qa_module.is_configured()).toBe(false);
        });

        it('falls back to QA_SERVICE / QA_SERVICE_API_KEY (back-compat)', () => {
            delete process.env.CURATION_API;
            delete process.env.CURATION_API_KEY;
            process.env.QA_SERVICE = 'https://legacy-qa.example.com';
            process.env.QA_SERVICE_API_KEY = 'legacy-key';
            app_config._reset();
            expect(qa_module.is_configured()).toBe(true);
        });
    });

    describe('endpoint construction', () => {
        it('builds the /api/v2/qa/ prefix and sends X-API-Key header', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: ['folder-a'] });
            const client = qa_module.create_client(http);
            await client.list_ready_folders();
            const call = http.calls.get[0];
            expect(call.url).toBe('https://qa.example.com/api/v2/qa/list-ready-folders');
            expect(call.opts.headers['X-API-Key']).toBe('qa-key');
            expect(call.opts.headers['Content-Type']).toBe('application/json');
        });

        it('encodes query params for set_folder_name', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { is_set: true } });
            const client = qa_module.create_client(http);
            await client.set_folder_name('weird folder/name');
            expect(http.calls.get[0].url).toContain(
                'set-collection-folder?folder=weird%20folder%2Fname'
            );
        });

        it('skips empty / null query values', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = qa_module.create_client(http);
            await client.get_item_packages('');
            // Empty folder param should be dropped, not surface as `?folder=`.
            const url = http.calls.get[0].url;
            expect(url).toBe('https://qa.example.com/api/v2/qa/package-names');
        });
    });

    describe('sftp_upload_status (worker poll target)', () => {
        it('returns { status, data } for the poll loop', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { uploaded: 42 } });
            const client = qa_module.create_client(http);
            const res = await client.sftp_upload_status('uuid-1', 100);
            expect(res).toEqual({ status: 200, data: { uploaded: 42 } });
            expect(http.calls.get[0].url).toContain('upload-status?uuid=uuid-1');
            expect(http.calls.get[0].url).toContain('total_batch_file_count=100');
        });
    });

    describe('move_to_ingest / move_to_sftp', () => {
        it('move_to_ingest uses the default timeout', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { ok: true } });
            const client = qa_module.create_client(http);
            await client.move_to_ingest('uuid-1', 'col-A', 'pkg-001');
            const call = http.calls.get[0];
            expect(call.opts.timeout).toBe(5000);
            expect(call.url).toContain('move-to-ingest?uuid=uuid-1');
            expect(call.url).toContain('folder=col-A');
            expect(call.url).toContain('package=pkg-001');
        });

        it('move_to_sftp uses the long move_timeout_ms', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = qa_module.create_client(http);
            await client.move_to_sftp('uuid-1');
            expect(http.calls.get[0].opts.timeout).toBe(60000);
        });
    });

    describe('move_from_ingest_to_ready (rollback / cancel cleanup)', () => {
        // Regression guard for a real production bug: the v2 client
        // originally passed only `uuid` to a curation-API endpoint
        // that requires uuid + folder + package. The curation service
        // returned HTTP 400 and the folder was never moved back —
        // queue rows lied about state. These tests pin all three
        // params (and the optional actor) into the URL.
        it('passes uuid + folder + package in the URL', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { result: 'ok' } });
            const client = qa_module.create_client(http);
            await client.move_from_ingest_to_ready('uuid-1', 'col-A', 'pkg-001');
            const call = http.calls.get[0];
            expect(call.url).toContain('move-from-ingest-to-ready?');
            expect(call.url).toContain('uuid=uuid-1');
            expect(call.url).toContain('folder=col-A');
            expect(call.url).toContain('package=pkg-001');
        });

        it('uses the long move_timeout_ms (shutil.move is slow on big packages)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = qa_module.create_client(http);
            await client.move_from_ingest_to_ready('uuid-1', 'col-A', 'pkg-001');
            expect(http.calls.get[0].opts.timeout).toBe(60000);
        });

        it('threads the optional actor into the URL for the audit log', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = qa_module.create_client(http);
            await client.move_from_ingest_to_ready('uuid-1', 'col-A', 'pkg-001', {
                actor: 'jdoe@du.edu',
            });
            const call = http.calls.get[0];
            expect(call.url).toContain('actor=jdoe%40du.edu');
        });

        it('omits actor from the URL when not provided', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = qa_module.create_client(http);
            await client.move_from_ingest_to_ready('uuid-1', 'col-A', 'pkg-001');
            expect(http.calls.get[0].url).not.toContain('actor=');
        });

        it('encodes special characters in folder + package names', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = qa_module.create_client(http);
            await client.move_from_ingest_to_ready('uuid-1', 'col A/with slash', 'pkg 001');
            const url = http.calls.get[0].url;
            expect(url).toContain('folder=col%20A%2Fwith%20slash');
            expect(url).toContain('package=pkg%20001');
        });
    });

    describe('error handling', () => {
        it('throws UpstreamError on transport failure', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNRESET') });
            const client = qa_module.create_client(http);
            await expect(client.list_ready_folders()).rejects.toBeInstanceOf(UpstreamError);
        });

        it('passes through 4xx/5xx in the response shape (no throw)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 500, data: 'kaboom' });
            const client = qa_module.create_client(http);
            const res = await client.list_ready_folders();
            expect(res.status).toBe(500);
            expect(res.data).toBe('kaboom');
        });
    });

    describe('health_wasabi', () => {
        // The /health/wasabi endpoint lives at the app root, not
        // under /api/v2/qa/. Confirm the URL is built correctly and
        // the X-API-Key header is set.
        it('hits /health/wasabi with X-API-Key', async () => {
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: { ok: true, bucket: 'b', error: null, elapsed_ms: 100 },
            });
            const client = qa_module.create_client(http);
            const res = await client.health_wasabi();
            expect(res.status).toBe(200);
            expect(res.data.ok).toBe(true);
            const call = http.calls.get[0];
            expect(call.url).toBe('https://qa.example.com/health/wasabi');
            expect(call.opts.headers['X-API-Key']).toBe('qa-key');
        });

        it('passes through 200-with-body.ok=false (Wasabi probe failed server-side)', async () => {
            // The curation route always returns 200; the body's `ok`
            // field is the actual signal. Client should not throw —
            // dashboard renders based on body.ok.
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: {
                    ok: false,
                    bucket: 'b',
                    error: 'head_bucket failed (403): Forbidden',
                    elapsed_ms: 87,
                },
            });
            const client = qa_module.create_client(http);
            const res = await client.health_wasabi();
            expect(res.status).toBe(200);
            expect(res.data.ok).toBe(false);
            expect(res.data.error).toMatch(/403/);
        });

        it('throws UpstreamError on transport failure (curation unreachable)', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNREFUSED') });
            const client = qa_module.create_client(http);
            await expect(client.health_wasabi()).rejects.toBeInstanceOf(UpstreamError);
        });
    });
});
