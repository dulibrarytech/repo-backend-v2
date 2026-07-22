'use strict';

/*
 * Unit tests for libs/archivesspace. The default export is a real
 * client bound to axios; we test via the create_client factory so we
 * can pass in a fake HTTP that captures requests + scripts responses.
 */

const aspace_module = require('../../../libs/archivesspace');
const app_config = require('../../../config/app');
const { UpstreamError, UnauthorizedError } = require('../../../libs/errors');

/*
 * Tiny axios-shaped fake. Each method records its calls and returns
 * whatever the test sets next via `set_response`.
 */
function make_fake_http() {
    const calls = { get: [], post: [] };
    let next = { status: 200, data: {}, headers: {} };
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

describe('libs/archivesspace', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.ARCHIVESPACE_HOST = 'https://aspace.example/api';
        process.env.ARCHIVESPACE_USER = 'svc';
        process.env.ARCHIVESPACE_PASSWORD = 's3cret';
        process.env.ARCHIVESPACE_TIMEOUT_MS = '5000';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('is_configured', () => {
        it('returns true when host + user + password are set', () => {
            expect(aspace_module.is_configured()).toBe(true);
        });

        it('returns false when any one is missing', () => {
            delete process.env.ARCHIVESPACE_PASSWORD;
            app_config._reset();
            expect(aspace_module.is_configured()).toBe(false);
        });
    });

    describe('get_session_token', () => {
        it('POSTs to /users/<user>/login with expiring=false', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { session: 'tok-abc' } });
            const client = aspace_module.create_client(http);
            const tok = await client.get_session_token();
            expect(tok).toBe('tok-abc');
            expect(http.calls.post).toHaveLength(1);
            const call = http.calls.post[0];
            expect(call.url).toBe('https://aspace.example/api/users/svc/login');
            expect(call.opts.params).toEqual({ password: 's3cret', expiring: false });
        });

        it('escapes special characters in the username', async () => {
            process.env.ARCHIVESPACE_USER = 'a/b@c';
            app_config._reset();
            const http = make_fake_http();
            http.set_response({ status: 200, data: { session: 'tok' } });
            const client = aspace_module.create_client(http);
            await client.get_session_token();
            expect(http.calls.post[0].url).toBe('https://aspace.example/api/users/a%2Fb%40c/login');
        });

        it('throws UnauthorizedError on 401', async () => {
            const http = make_fake_http();
            http.set_response({ status: 401, data: { error: 'bad creds' } });
            const client = aspace_module.create_client(http);
            await expect(client.get_session_token()).rejects.toBeInstanceOf(UnauthorizedError);
        });

        it('throws UpstreamError on non-200 unexpected response', async () => {
            const http = make_fake_http();
            http.set_response({ status: 500, data: null });
            const client = aspace_module.create_client(http);
            await expect(client.get_session_token()).rejects.toBeInstanceOf(UpstreamError);
        });

        it('throws UpstreamError on transport failure (timeout)', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ETIMEDOUT') });
            const client = aspace_module.create_client(http);
            await expect(client.get_session_token()).rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('get_record (default — plugin path, use_transformer=false)', () => {
        it('GETs <base>/<uri>/repository (DU plugin endpoint) with the session header', async () => {
            /*
             * The `/repository` suffix is a DU custom AS plugin
             * endpoint — see libs/archivesspace.js for context. The
             * bare native AS endpoint returns a shape missing
             * `identifiers`, `parts`, and `is_compound`, which would
             * make the QA validator flag every record as broken.
             */
            const http = make_fake_http();
            http.set_response({ status: 200, data: { title: 'rec' } });
            const client = aspace_module.create_client(http);
            const res = await client.get_record('/repositories/2/resources/12', 'tok');
            expect(res.status).toBe(200);
            expect(res.data.title).toBe('rec');
            const call = http.calls.get[0];
            expect(call.url).toBe(
                'https://aspace.example/api/repositories/2/resources/12/repository'
            );
            expect(call.opts.headers['X-ArchivesSpace-Session']).toBe('tok');
            expect(call.opts.timeout).toBe(5000);
            /*
             * Plugin path doesn't send resolve params (the plugin does
             * resolve internally and pre-transforms the result).
             */
            expect(call.opts.params).toBeUndefined();
        });

        it('rejects URIs that do not start with /', async () => {
            const client = aspace_module.create_client(make_fake_http());
            await expect(client.get_record('repositories/2/resources/12', 'tok')).rejects.toThrow(
                /Invalid ArchivesSpace URI/
            );
        });

        it('returns status + data for 4xx without throwing', async () => {
            /*
             * The worker needs to see the 4xx status so it can decide
             * whether to refresh the token (401/403) or mark the row
             * failed permanently (404).
             */
            const http = make_fake_http();
            http.set_response({ status: 404, data: { error: 'not found' } });
            const client = aspace_module.create_client(http);
            const res = await client.get_record('/foo', 'tok');
            expect(res.status).toBe(404);
        });

        it('throws UpstreamError on transport failure', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNRESET') });
            const client = aspace_module.create_client(http);
            await expect(client.get_record('/foo', 'tok')).rejects.toBeInstanceOf(UpstreamError);
        });

        it('does NOT pipe the response through the transformer (plugin already pre-transformed)', async () => {
            /*
             * Plugin endpoint returns the flat shape directly. We
             * pass it through unchanged — running transform() on it
             * would double-transform.
             */
            const http = make_fake_http();
            const raw = { title: 'already-flat', identifiers: [{ type: 'local', identifier: 'X' }] };
            http.set_response({ status: 200, data: raw });
            const client = aspace_module.create_client(http);
            const res = await client.get_record('/r/1', 'tok');
            expect(res.data).toBe(raw);
            /*
             * No version stamp on the plugin path (the plugin owns
             * the shape).
             */
            expect(res.data._transformer_version).toBeUndefined();
        });
    });

    describe('get_record (transformer path, use_transformer=true)', () => {
        beforeEach(() => {
            process.env.ASPACE_USE_TRANSFORMER = '1';
            process.env.ASPACE_TRANSFORMER_VERSION = '1';
            app_config._reset();
        });

        it('GETs the native <base><uri> (NO /repository suffix) with resolve[]= params', async () => {
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: {
                    jsonmodel_type: 'archival_object',
                    uri: '/repositories/2/archival_objects/12',
                    title: 'Item',
                    component_id: 'X-1',
                },
            });
            const client = aspace_module.create_client(http);
            const res = await client.get_record('/repositories/2/archival_objects/12', 'tok');
            expect(res.status).toBe(200);
            const call = http.calls.get[0];
            expect(call.url).toBe('https://aspace.example/api/repositories/2/archival_objects/12');
            expect(call.opts.params).toEqual({
                'resolve[]': [
                    'subjects',
                    'linked_agents',
                    'instances::digital_object',
                    'instances::digital_object::tree',
                ],
            });
        });

        it('exposes RESOLVE_PARAMS so callers / tests can reference the canonical list', () => {
            expect(aspace_module.RESOLVE_PARAMS).toEqual([
                'subjects',
                'linked_agents',
                'instances::digital_object',
                'instances::digital_object::tree',
            ]);
        });

        it('pipes the raw AS response through transform() before returning', async () => {
            /*
             * The transformer is its own well-tested module. Here we
             * just confirm the wiring — the response we hand back has
             * the FLAT shape (identifiers/notes/etc), not the raw AS
             * record shape (id_0/component_id/jsonmodel_type/etc).
             */
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: {
                    jsonmodel_type: 'archival_object',
                    uri: '/r/1',
                    title: 'Item',
                    component_id: 'X-1',
                },
            });
            const client = aspace_module.create_client(http);
            const res = await client.get_record('/r/1', 'tok');
            /*
             * Flat shape — identifier array present, jsonmodel_type
             * stripped out.
             */
            expect(res.data.identifiers).toEqual([{ type: 'local', identifier: 'X-1' }]);
            expect(res.data.title).toBe('Item');
            expect(res.data.jsonmodel_type).toBeUndefined();
            expect(res.data.is_compound).toBe(false);
        });

        it('stamps _transformer_version into the returned data', async () => {
            const http = make_fake_http();
            http.set_response({
                status: 200,
                data: { jsonmodel_type: 'resource', uri: '/r/1', title: 'Coll', id_0: 'M' },
            });
            const client = aspace_module.create_client(http);
            const res = await client.get_record('/r/1', 'tok');
            // Picks up ASPACE_TRANSFORMER_VERSION env value.
            expect(res.data._transformer_version).toBe('1');
        });

        it('passes 4xx responses through unchanged (no transform attempt)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: { error: 'not found' } });
            const client = aspace_module.create_client(http);
            const res = await client.get_record('/r/1', 'tok');
            expect(res.status).toBe(404);
            // Error body left intact — no transformer pass on non-200.
            expect(res.data).toEqual({ error: 'not found' });
        });

        it('passes 200 with empty body through unchanged (defensive — no transform on null)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: null });
            const client = aspace_module.create_client(http);
            const res = await client.get_record('/r/1', 'tok');
            expect(res.data).toBe(null);
        });
    });

    describe('destroy_session_token', () => {
        it('is a no-op when token is null', async () => {
            const http = make_fake_http();
            const client = aspace_module.create_client(http);
            await client.destroy_session_token(null);
            expect(http.calls.post).toHaveLength(0);
        });

        it('swallows transport errors during logout', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('boom') });
            const client = aspace_module.create_client(http);
            // Should not throw — logout is best-effort.
            await expect(client.destroy_session_token('tok')).resolves.toBeUndefined();
        });
    });

    describe('ping (Services Health probe)', () => {
        it('returns true when login returns 200 + a session', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: { session: 'tok-123' } });
            const client = aspace_module.create_client(http);
            await expect(client.ping()).resolves.toBe(true);
            // Hit the login endpoint…
            expect(http.calls.post[0].url).toMatch(/\/users\/svc\/login$/);
            /*
             * …with an EXPIRING session (no expiring:false) so the probe
             * doesn't accumulate permanent sessions.
             */
            expect(http.calls.post[0].opts.params).toEqual({ password: 's3cret' });
        });

        it('returns false on a 401 (auth rejected)', async () => {
            const http = make_fake_http();
            http.set_response({ status: 401, data: {} });
            const client = aspace_module.create_client(http);
            await expect(client.ping()).resolves.toBe(false);
        });

        it('returns false on 200 without a session token', async () => {
            const http = make_fake_http();
            http.set_response({ status: 200, data: {} });
            const client = aspace_module.create_client(http);
            await expect(client.ping()).resolves.toBe(false);
        });

        it('returns false (never throws) on a transport error', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNREFUSED') });
            const client = aspace_module.create_client(http);
            await expect(client.ping()).resolves.toBe(false);
        });

        it('returns false when ASpace is not configured', async () => {
            delete process.env.ARCHIVESPACE_HOST;
            app_config._reset();
            const http = make_fake_http();
            const client = aspace_module.create_client(http);
            await expect(client.ping()).resolves.toBe(false);
            // No HTTP attempted when unconfigured.
            expect(http.calls.post).toHaveLength(0);
        });
    });
});
