'use strict';

// Unit tests for libs/archivematica. Covers URL composition, auth
// query-string assembly, request bodies for transfer/approve, and
// error mapping. Real network calls happen in Phase 3 integration
// tests against the live AM dev instance.

const am_module = require('../../../libs/archivematica');
const app_config = require('../../../config/app');
const { UpstreamError } = require('../../../libs/errors');

function make_fake_http() {
    const calls = { get: [], post: [], delete: [] };
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
        async delete(url, opts) {
            calls.delete.push({ url, opts });
            if (next.throw) throw next.throw;
            return next;
        },
    };
}

describe('libs/archivematica', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.ARCHIVEMATICA_API = 'https://am.example.com/api/';
        process.env.ARCHIVEMATICA_USERNAME = 'svc';
        process.env.ARCHIVEMATICA_API_KEY = 'main-key';
        process.env.ARCHIVEMATICA_STORAGE_API = 'https://am-storage.example.com/api/';
        process.env.ARCHIVEMATICA_STORAGE_USERNAME = 'storage-svc';
        process.env.ARCHIVEMATICA_STORAGE_API_KEY = 'storage-key';
        process.env.ARCHIVEMATICA_TRANSFER_SOURCE = 'src-uuid';
        process.env.SFTP_REMOTE_PATH = '/sftp/upload';
        process.env.ARCHIVEMATICA_PIPELINE = 'pipe-uuid';
        process.env.ARCHIVEMATICA_USERID = '42';
        process.env.ARCHIVEMATICA_USER_EMAIL = 'svc@example.com';
        process.env.ARCHIVEMATICA_TIMEOUT_MS = '5000';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('is_configured / is_storage_configured', () => {
        it('returns true when main + storage creds are set', () => {
            expect(am_module.is_configured()).toBe(true);
            expect(am_module.is_storage_configured()).toBe(true);
        });

        it('returns false for main when any of api/user/key is missing', () => {
            delete process.env.ARCHIVEMATICA_API_KEY;
            app_config._reset();
            expect(am_module.is_configured()).toBe(false);
        });

        it('returns false for storage independent of main', () => {
            delete process.env.ARCHIVEMATICA_STORAGE_API;
            app_config._reset();
            expect(am_module.is_configured()).toBe(true);
            expect(am_module.is_storage_configured()).toBe(false);
        });
    });

    describe('ping_api', () => {
        it('GETs administration/dips/atom/levels with auth in query string', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: [] });
            const client = am_module.create_client(http);
            const ok = await client.ping_api();
            expect(ok).toBe(true);
            const url = http.calls.get[0].url;
            expect(url).toContain('administration/dips/atom/levels/');
            expect(url).toContain('username=svc');
            expect(url).toContain('api_key=main-key');
        });

        it('returns false on non-200 (without throwing)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 503, data: '' });
            const client = am_module.create_client(http);
            expect(await client.ping_api()).toBe(false);
        });

        it('returns false on network error (without throwing)', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNREFUSED') });
            const client = am_module.create_client(http);
            expect(await client.ping_api()).toBe(false);
        });
    });

    describe('health_api (diagnostic probe for Services Health)', () => {
        it('probes transfer/unapproved/ with query-string auth and returns ok on 200', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { results: [] } });
            const client = am_module.create_client(http);
            const r = await client.health_api();
            expect(r).toEqual({ ok: true, status: 200, error: null });
            const url = http.calls.get[0].url;
            // Representative endpoint the pipeline actually uses — NOT
            // the fragile atom/levels one.
            expect(url).toContain('transfer/unapproved/');
            expect(url).not.toContain('atom/levels');
            expect(url).toContain('username=svc');
            expect(url).toContain('api_key=main-key');
        });

        it('reports the HTTP status on a non-200 response (e.g. 401 auth)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 401, data: '' });
            const client = am_module.create_client(http);
            const r = await client.health_api();
            expect(r).toEqual({ ok: false, status: 401, error: null });
        });

        it('reports the status on a 404 (wrong base URL)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: '' });
            const client = am_module.create_client(http);
            const r = await client.health_api();
            expect(r.ok).toBe(false);
            expect(r.status).toBe(404);
        });

        it('surfaces a transport/TLS error string with status=null', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('self-signed certificate in certificate chain') });
            const client = am_module.create_client(http);
            const r = await client.health_api();
            expect(r.ok).toBe(false);
            expect(r.status).toBeNull();
            expect(r.error).toMatch(/self-signed certificate/);
        });
    });

    describe('start_transfer', () => {
        it('builds the form-encoded body with base64 source location', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { transfer_id: 'tx-1' } });
            const client = am_module.create_client(http);
            const res = await client.start_transfer('codu:1', 'package-A');
            expect(res).toEqual({ status: 200, data: { transfer_id: 'tx-1' } });
            const call = http.calls.post[0];
            expect(call.url).toContain('transfer/start_transfer/');
            expect(call.opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
            expect(call.body).toContain('name=');
            expect(call.body).toContain('type=standard');
            expect(call.body).toContain('paths%5B%5D=');
            // The encoded location should be base64(src-uuid:/sftp/upload/codu:1/package-A).
            const expected_location = Buffer.from(
                'src-uuid:/sftp/upload/codu:1/package-A'
            ).toString('base64');
            expect(call.body).toContain(encodeURIComponent(expected_location));
        });

        it('returns the response status + data on non-200', async () => {
            const http = make_fake_http();
            http.set_response({ status: 500, data: 'bad' });
            const client = am_module.create_client(http);
            const res = await client.start_transfer('codu:1', 'package-A');
            expect(res.status).toBe(500);
        });

        it('throws UpstreamError on network error', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNRESET') });
            const client = am_module.create_client(http);
            await expect(client.start_transfer('codu:1', 'package-A')).rejects.toBeInstanceOf(
                UpstreamError
            );
        });

        it('uses the longer start_transfer_timeout_ms when set', async () => {
            // Default for start_transfer_timeout_ms is 10 min; with
            // the general timeout_ms at 5s, the call should send the
            // 10-min budget to axios. This is the fix for the 60s
            // timeout that bit large-media transfers in production.
            const http = make_fake_http();
            http.set_response({ status: 200, data: { transfer_id: 'tx-1' } });
            const client = am_module.create_client(http);
            await client.start_transfer('codu:1', 'package-A');
            const call = http.calls.post[0];
            // ARCHIVEMATICA_TIMEOUT_MS=5000 (general), and the default
            // start_transfer_timeout_ms=10*60*1000=600000 should win.
            expect(call.opts.timeout).toBe(600000);
        });

        it('falls back to timeout_ms when start_transfer_timeout_ms is shorter', async () => {
            // Defensive: if someone explicitly sets the start budget
            // BELOW the general one (misconfiguration), the call
            // should still use whichever is larger. Belt-and-braces
            // so a typo can't shorten the budget by accident.
            process.env.ARCHIVEMATICA_TIMEOUT_MS = '120000';
            process.env.ARCHIVEMATICA_START_TRANSFER_TIMEOUT_MS = '5000';
            app_config._reset();
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = am_module.create_client(http);
            await client.start_transfer('codu:1', 'package-A');
            expect(http.calls.post[0].opts.timeout).toBe(120000);
        });

        it('honors a custom start_transfer_timeout_ms larger than the general one', async () => {
            // The intended use: a 30-min budget for an environment
            // with 100GB+ media. start_transfer should send 30 min
            // to axios; the general timeout_ms (60s default) is
            // unchanged for the other AM calls.
            process.env.ARCHIVEMATICA_TIMEOUT_MS = '60000';
            process.env.ARCHIVEMATICA_START_TRANSFER_TIMEOUT_MS = String(30 * 60 * 1000);
            app_config._reset();
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = am_module.create_client(http);
            await client.start_transfer('codu:1', 'package-A');
            expect(http.calls.post[0].opts.timeout).toBe(30 * 60 * 1000);
        });

        it('keeps the short timeout for other AM calls', async () => {
            // Confirm we didn't accidentally bump every call to the
            // long budget — only start_transfer should change.
            process.env.ARCHIVEMATICA_TIMEOUT_MS = '5000';
            app_config._reset();
            const http = make_fake_http();
            http.set_response({ status: 200, data: [] });
            const client = am_module.create_client(http);
            await client.get_unapproved_transfer_list();
            expect(http.calls.get[0].opts.timeout).toBe(5000);
            await client.approve_transfer('folder-X');
            expect(http.calls.post[0].opts.timeout).toBe(5000);
        });
    });

    describe('approve_transfer', () => {
        it('POSTs form-encoded directory + type', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { message: 'approved' } });
            const client = am_module.create_client(http);
            const res = await client.approve_transfer('codu:1-package-A');
            expect(res.status).toBe(200);
            const call = http.calls.post[0];
            expect(call.url).toContain('transfer/approve');
            expect(call.body).toContain('type=standard');
            expect(call.body).toContain('directory=codu%3A1-package-A');
        });
    });

    describe('get_transfer_status / get_ingest_status', () => {
        it('builds URLs with the UUID embedded and auth in query string', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { status: 'COMPLETE' } });
            const client = am_module.create_client(http);
            await client.get_transfer_status('uuid-1');
            await client.get_ingest_status('uuid-2');
            expect(http.calls.get[0].url).toContain('transfer/status/uuid-1/');
            expect(http.calls.get[1].url).toContain('ingest/status/uuid-2/');
        });

        it('passes the response shape through (status + data)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { status: 'PROCESSING' } });
            const client = am_module.create_client(http);
            const res = await client.get_transfer_status('uuid-1');
            expect(res).toEqual({ status: 200, data: { status: 'PROCESSING' } });
        });
    });

    describe('get_dip_path', () => {
        it('parses the v2/file response into a slash-chunked path', async () => {
            // Storage API returns a related_packages array whose last
            // path segment is the DIP UUID; v1 chunks it into 4-char
            // groups joined by '/' and appends the folder (sans .7z).
            const dip_uuid = 'aaaa-bbbb-cccc-dddd-eeeeffff0000';
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: {
                    related_packages: [`/api/v2/file/${dip_uuid}/`],
                    current_path: '/some/where/package-A.7z',
                },
            });
            const client = am_module.create_client(http);
            const res = await client.get_dip_path('sip-1');
            expect(res.status).toBe(200);
            // The dip_uuid above has 28 hex chars after stripping
            // dashes; chunked by 4 that's 7 groups, plus the folder
            // name = 8 path segments.
            const chunks = res.dip_path.split('/');
            expect(chunks).toHaveLength(8);
            expect(chunks[chunks.length - 1]).toBe('package-A');
        });

        it('returns dip_path: null when related_packages is empty', async () => {
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: { related_packages: [], current_path: '/x.7z' },
            });
            const client = am_module.create_client(http);
            const res = await client.get_dip_path('sip-1');
            expect(res.dip_path).toBeNull();
        });

        it('returns dip_path: null on non-200', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: null });
            const client = am_module.create_client(http);
            const res = await client.get_dip_path('sip-1');
            expect(res.dip_path).toBeNull();
        });
    });

    describe('delete_aip_request', () => {
        it('POSTs JSON body with pipeline + user identifiers', async () => {
            const http = make_fake_http();
            http.set_response({ status: 202, data: { id: 99 } });
            const client = am_module.create_client(http);
            const res = await client.delete_aip_request({
                uuid: 'aip-1',
                delete_reason: 'rollback per staff request',
            });
            expect(res.status).toBe(202);
            const call = http.calls.post[0];
            expect(call.url).toContain('v2/file/aip-1/delete_aip/');
            expect(call.body).toEqual({
                event_reason: 'rollback per staff request',
                pipeline: 'pipe-uuid',
                user_id: '42',
                user_email: 'svc@example.com',
            });
            expect(call.opts.headers['Content-Type']).toBe('application/json');
        });

        it('throws UpstreamError on transport failure', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('socket hang up') });
            const client = am_module.create_client(http);
            await expect(
                client.delete_aip_request({ uuid: 'aip-1', delete_reason: 'x' })
            ).rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('clear_transfer / clear_ingest', () => {
        it('issues DELETE requests against the per-uuid path', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { ok: true } });
            const client = am_module.create_client(http);
            await client.clear_transfer('uuid-x');
            await client.clear_ingest('uuid-y');
            expect(http.calls.delete[0].url).toContain('transfer/uuid-x/delete/');
            expect(http.calls.delete[1].url).toContain('ingest/uuid-y/delete/');
        });
    });

    describe('list_packages', () => {
        it('GETs v2/file/ with package_type/limit/offset + storage auth, parses meta+objects', async () => {
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: {
                    meta: { total_count: 2, limit: 100, offset: 0 },
                    objects: [{ uuid: 'a' }, { uuid: 'b' }],
                },
            });
            const client = am_module.create_client(http);
            const res = await client.list_packages({ package_type: 'AIP', limit: 100, offset: 0 });
            expect(res.status).toBe(200);
            expect(res.meta.total_count).toBe(2);
            expect(res.objects.map((o) => o.uuid)).toEqual(['a', 'b']);
            const url = http.calls.get[0].url;
            expect(url).toContain('v2/file/');
            expect(url).toContain('package_type=AIP');
            expect(url).toContain('limit=100');
            expect(url).toContain('offset=0');
            // storage_url appends the storage credentials as query string
            expect(url).toContain('username=storage-svc');
            expect(url).toContain('api_key=storage-key');
        });

        it('includes a status filter when provided', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { meta: {}, objects: [] } });
            const client = am_module.create_client(http);
            await client.list_packages({ package_type: 'AIP', status: 'UPLOADED' });
            expect(http.calls.get[0].url).toContain('status=UPLOADED');
        });

        it('returns empty objects + null meta on a non-200', async () => {
            const http = make_fake_http();
            http.set_response({ status: 503, data: null });
            const client = am_module.create_client(http);
            const res = await client.list_packages({ package_type: 'AIP' });
            expect(res.status).toBe(503);
            expect(res.meta).toBeNull();
            expect(res.objects).toEqual([]);
        });

        it('tolerates a response missing the objects array', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { meta: { total_count: 0 } } });
            const client = am_module.create_client(http);
            const res = await client.list_packages({ package_type: 'AIP' });
            expect(res.objects).toEqual([]);
        });

        it('throws UpstreamError on a transport error (so the caller can retry the page)', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNREFUSED') });
            const client = am_module.create_client(http);
            await expect(client.list_packages({ package_type: 'AIP' })).rejects.toBeInstanceOf(
                UpstreamError
            );
        });
    });

    describe('get_pointer_file', () => {
        it('GETs v2/file/<uuid>/pointer_file/ and returns the XML body on 200', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: '<mets:mets>…</mets:mets>' });
            const client = am_module.create_client(http);
            const res = await client.get_pointer_file('uuid-1');
            expect(res.status).toBe(200);
            expect(res.xml).toContain('mets:mets');
            const call = http.calls.get[0];
            expect(call.url).toContain('v2/file/uuid-1/pointer_file/');
            expect(call.url).toContain('username=storage-svc');
            expect(call.opts.responseType).toBe('text');
        });

        it('returns empty xml on a non-200', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: 'not found' });
            const client = am_module.create_client(http);
            const res = await client.get_pointer_file('missing');
            expect(res.status).toBe(404);
            expect(res.xml).toBe('');
        });

        it('throws UpstreamError on a transport error', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ETIMEDOUT') });
            const client = am_module.create_client(http);
            await expect(client.get_pointer_file('u')).rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('default export', () => {
        it('exposes the factory + helpers alongside the bound client', () => {
            expect(typeof am_module.create_client).toBe('function');
            expect(typeof am_module.is_configured).toBe('function');
            expect(typeof am_module.is_storage_configured).toBe('function');
            expect(typeof am_module.start_transfer).toBe('function');
            expect(typeof am_module.get_transfer_status).toBe('function');
        });
    });
});
