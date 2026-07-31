'use strict';

/*
 * libs/handles now speaks the Handle HTTP JSON API directly rather than
 * proxying through the retired Python handles-service, so these exercise
 * the wire shape the handle server actually expects: PUT /api/handles/
 * <prefix>/<uuid> with a single index-2 URL value, overwrite=false on
 * create, and session re-auth on a 401.
 */

const handles_module = require('../../../libs/handles');
const app_config = require('../../../config/app');
const { UpstreamError } = require('../../../libs/errors');

const UUID = '2d569507-de89-41eb-9bb6-6be0d12b5eb8';
const HANDLE_URL = `https://hdl.example.com/20.500.12345/${UUID}`;

function make_fake_http() {
    const calls = { request: [], get: [], post: [] };
    let queue = [];
    let next = { status: 201, data: '' };

    function take() {
        const r = queue.length ? queue.shift() : next;
        if (r.throw) throw r.throw;
        return r;
    }

    return {
        calls,
        set_response(r) { next = r; queue = []; },
        /* consumed in order, for multi-call flows like 401-then-retry */
        set_responses(list) { queue = [...list]; },
        async request(opts) { calls.request.push(opts); return take(); },
        async get(url, opts) { calls.get.push({ url, opts }); return take(); },
        async post(url, body, opts) { calls.post.push({ url, body, opts }); return take(); },
    };
}

function make_fake_auth() {
    const state = { resets: 0, authorizations: 0 };
    return {
        state,
        async authorization() {
            state.authorizations += 1;
            return 'Handle version="0", sessionId="test-session"';
        },
        reset_session() { state.resets += 1; },
    };
}

function client_with(http, auth = make_fake_auth()) {
    return handles_module.create_client(http, auth);
}

describe('libs/handles', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.HANDLE_ADMIN_URL = 'http://handle.example.edu:8000';
        process.env.HANDLE_ADMIN_ID = '300:0.NA/20.500.12345';
        process.env.HANDLE_ADMIN_KEY_PATH = '/etc/repov2/handle_admin.pem';
        process.env.HANDLE_ADMIN_PASSPHRASE = 'secret';
        process.env.HANDLE_TARGET = 'https://example.edu/object/';
        process.env.HANDLE_PREFIX = '20.500.12345';
        process.env.HANDLE_SERVER = 'https://hdl.example.com/';
        process.env.HANDLE_TTL = '86400';
        process.env.HANDLE_TIMEOUT_MS = '5000';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('is_configured', () => {
        it('returns true when the admin credentials and target are set', () => {
            expect(handles_module.is_configured()).toBe(true);
        });

        it.each([
            'HANDLE_ADMIN_URL',
            'HANDLE_ADMIN_ID',
            'HANDLE_ADMIN_KEY_PATH',
            'HANDLE_TARGET',
            'HANDLE_PREFIX',
            'HANDLE_SERVER',
        ])('returns false when %s is missing', (name) => {
            delete process.env[name];
            app_config._reset();
            expect(handles_module.is_configured()).toBe(false);
        });

        it('does not require a passphrase (an unencrypted PEM is valid)', () => {
            delete process.env.HANDLE_ADMIN_PASSPHRASE;
            app_config._reset();
            expect(handles_module.is_configured()).toBe(true);
        });
    });

    describe('build_handle_url', () => {
        it('joins server + prefix + uuid with a single slash between each', () => {
            expect(handles_module.build_handle_url(UUID)).toBe(HANDLE_URL);
        });

        it('tolerates a server without trailing slash', () => {
            process.env.HANDLE_SERVER = 'https://hdl.example.com';
            app_config._reset();
            expect(handles_module.build_handle_url(UUID)).toBe(HANDLE_URL);
        });

        it('strips leading/trailing slashes from the prefix', () => {
            process.env.HANDLE_PREFIX = '/20.500.12345/';
            app_config._reset();
            expect(handles_module.build_handle_url(UUID)).toBe(HANDLE_URL);
        });

        it('is independent of HANDLE_TARGET, so a target migration needs no DB change', () => {
            process.env.HANDLE_TARGET = 'https://somewhere-else.edu/object/';
            app_config._reset();
            expect(handles_module.build_handle_url(UUID)).toBe(HANDLE_URL);
        });
    });

    /*
     * The retired service interpolated uuid into a shell string and a
     * handle batch file. Nothing here reaches a shell, but malformed
     * identifiers still must not enter the handle namespace — 10176/0 and
     * 10176/du-test-handle04 exist in production because nothing checked.
     */
    describe('identifier validation', () => {
        it.each([
            ['a legacy non-uuid name', 'uuid-1'],
            ['a shell metacharacter', 'x;curl http://attacker/'],
            ['an embedded newline (batch injection)', 'x\nDELETE 20.500.12345/other'],
            ['a path traversal', '../../../etc/passwd'],
            ['an empty string', ''],
            ['a non-string', 42],
        ])('rejects %s without issuing a request', async (_label, bad) => {
            const http = make_fake_http();
            const client = client_with(http);
            await expect(client.create_handle(bad)).rejects.toBeInstanceOf(UpstreamError);
            expect(http.calls.request).toHaveLength(0);
        });
    });

    describe('create_handle', () => {
        it('PUTs a single index-2 URL value with overwrite=false', async () => {
            const http = make_fake_http();
            http.set_response({ status: 201, data: { responseCode: 1 } });
            const res = await client_with(http).create_handle(UUID);

            expect(res).toEqual({ status: 201, handle: HANDLE_URL });

            const call = http.calls.request[0];
            expect(call.method).toBe('put');
            expect(call.url).toBe(
                `http://handle.example.edu:8000/api/handles/20.500.12345/${UUID}`
            );
            expect(call.params).toEqual({ overwrite: false });
            expect(call.timeout).toBe(5000);
            expect(call.headers.Authorization).toContain('sessionId="test-session"');
            expect(call.data).toEqual({
                values: [{
                    index: 2,
                    type: 'URL',
                    data: { format: 'string', value: `https://example.edu/object/${UUID}` },
                    ttl: 86400,
                    permissions: '1110',
                }],
            });
        });

        /*
         * The handle exists and points where it should, so the ingest should
         * proceed. Failing an otherwise-good ingest because a previous run
         * already minted the handle would be wrong.
         */
        it('treats HTTP 409 as success and returns the handle URL', async () => {
            const http = make_fake_http();
            http.set_response({ status: 409, data: { responseCode: 101 } });
            const res = await client_with(http).create_handle(UUID);
            expect(res).toEqual({ status: 201, handle: HANDLE_URL });
        });

        it('treats responseCode 101 as success even on another status', async () => {
            const http = make_fake_http();
            http.set_response({ status: 500, data: { responseCode: 101 } });
            const res = await client_with(http).create_handle(UUID);
            expect(res).toEqual({ status: 201, handle: HANDLE_URL });
        });

        it('returns { handle: null } on an unexpected status', async () => {
            const http = make_fake_http();
            http.set_response({ status: 500, data: { responseCode: 2 } });
            const res = await client_with(http).create_handle(UUID);
            expect(res).toEqual({ status: 500, handle: null });
        });

        it('throws UpstreamError on transport failure', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNRESET') });
            await expect(client_with(http).create_handle(UUID))
                .rejects.toBeInstanceOf(UpstreamError);
        });

        it('re-authenticates once and retries after a 401', async () => {
            const http = make_fake_http();
            const auth = make_fake_auth();
            http.set_responses([
                { status: 401, data: '' },
                { status: 201, data: { responseCode: 1 } },
            ]);
            const res = await handles_module.create_client(http, auth).create_handle(UUID);

            expect(res).toEqual({ status: 201, handle: HANDLE_URL });
            expect(auth.state.resets).toBe(1);
            expect(http.calls.request).toHaveLength(2);
        });

        it('gives up after a second rejection rather than looping', async () => {
            const http = make_fake_http();
            const auth = make_fake_auth();
            http.set_responses([
                { status: 403, data: '' },
                { status: 403, data: '' },
            ]);
            const res = await handles_module.create_client(http, auth).create_handle(UUID);

            expect(res).toEqual({ status: 403, handle: null });
            expect(auth.state.resets).toBe(1);
            expect(http.calls.request).toHaveLength(2);
        });
    });

    describe('update_handle', () => {
        it('PUTs scoped to index 2 so other values on the handle survive', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { responseCode: 1 } });
            const res = await client_with(http).update_handle(UUID);

            expect(res).toEqual({ status: 201, handle: HANDLE_URL });
            const call = http.calls.request[0];
            expect(call.method).toBe('put');
            expect(call.params).toEqual({ index: 2 });
        });

        it('re-points at the current HANDLE_TARGET', async () => {
            process.env.HANDLE_TARGET = 'https://digitalarchives.example.edu/object/';
            app_config._reset();
            const http = make_fake_http();
            http.set_response({ status: 200, data: { responseCode: 1 } });
            await client_with(http).update_handle(UUID);

            expect(http.calls.request[0].data.values[0].data.value)
                .toBe(`https://digitalarchives.example.edu/object/${UUID}`);
        });

        it('returns { handle: null } on an unexpected status', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: { responseCode: 100 } });
            const res = await client_with(http).update_handle(UUID);
            expect(res.handle).toBeNull();
        });
    });

    describe('get_handle', () => {
        it('resolves without authenticating — resolution is public', async () => {
            const http = make_fake_http();
            const auth = make_fake_auth();
            http.set_response({ status: 200, data: { responseCode: 1, values: [] } });
            const out = await handles_module.create_client(http, auth).get_handle(UUID);

            expect(out).toEqual({ responseCode: 1, values: [] });
            expect(auth.state.authorizations).toBe(0);
            expect(http.calls.get[0].url).toBe(
                `http://handle.example.edu:8000/api/handles/20.500.12345/${UUID}`
            );
        });

        it('returns null for a handle that does not exist', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: { responseCode: 100 } });
            expect(await client_with(http).get_handle(UUID)).toBeNull();
        });

        it('throws on an unexpected status rather than reporting absence', async () => {
            const http = make_fake_http();
            http.set_response({ status: 503, data: '' });
            await expect(client_with(http).get_handle(UUID))
                .rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('delete_handle', () => {
        it('reports deletion on 200', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { responseCode: 1 } });
            expect(await client_with(http).delete_handle(UUID))
                .toEqual({ status: 200, deleted: true });
        });

        it('reports not-found rather than throwing', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: { responseCode: 100 } });
            expect(await client_with(http).delete_handle(UUID))
                .toEqual({ status: 404, deleted: false });
        });
    });
});
