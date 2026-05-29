'use strict';

const handles_module = require('../../../libs/handles');
const app_config = require('../../../config/app');
const { UpstreamError } = require('../../../libs/errors');

function make_fake_http() {
    const calls = { post: [], put: [] };
    let next = { status: 201, data: '' };
    return {
        calls,
        set_response(res) {
            next = res;
        },
        async post(url, body, opts) {
            calls.post.push({ url, body, opts });
            if (next.throw) throw next.throw;
            return next;
        },
        async put(url, body, opts) {
            calls.put.push({ url, body, opts });
            if (next.throw) throw next.throw;
            return next;
        },
    };
}

describe('libs/handles', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.HANDLE_SERVICE = 'https://handles.example.com/api';
        process.env.HANDLE_PREFIX = '20.500.12345';
        process.env.HANDLE_SERVER = 'https://hdl.example.com/';
        process.env.HANDLE_API_KEY = 'handle-key';
        process.env.HANDLE_TIMEOUT_MS = '5000';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('is_configured', () => {
        it('returns true when all four env vars are set', () => {
            expect(handles_module.is_configured()).toBe(true);
        });

        it('returns false when any one is missing', () => {
            delete process.env.HANDLE_API_KEY;
            app_config._reset();
            expect(handles_module.is_configured()).toBe(false);
        });
    });

    describe('build_handle_url', () => {
        it('joins server + prefix + uuid with a single slash between each', () => {
            const u = handles_module.build_handle_url('uuid-1');
            expect(u).toBe('https://hdl.example.com/20.500.12345/uuid-1');
        });

        it('tolerates a server without trailing slash', () => {
            process.env.HANDLE_SERVER = 'https://hdl.example.com';
            app_config._reset();
            const u = handles_module.build_handle_url('uuid-1');
            expect(u).toBe('https://hdl.example.com/20.500.12345/uuid-1');
        });

        it('strips leading/trailing slashes from the prefix', () => {
            process.env.HANDLE_PREFIX = '/20.500.12345/';
            app_config._reset();
            const u = handles_module.build_handle_url('uuid-1');
            expect(u).toBe('https://hdl.example.com/20.500.12345/uuid-1');
        });
    });

    describe('create_handle', () => {
        it('POSTs to the service with uuid + api_key in the query string', async () => {
            const http = make_fake_http();
            http.set_response({ status: 201, data: '' });
            const client = handles_module.create_client(http);
            const res = await client.create_handle('uuid-1');
            expect(res.status).toBe(201);
            expect(res.handle).toBe('https://hdl.example.com/20.500.12345/uuid-1');
            const call = http.calls.post[0];
            expect(call.url).toContain('uuid=uuid-1');
            expect(call.url).toContain('api_key=handle-key');
            expect(call.opts.timeout).toBe(5000);
        });

        it('returns { handle: null } on a non-201 response', async () => {
            const http = make_fake_http();
            http.set_response({ status: 500, data: 'boom' });
            const client = handles_module.create_client(http);
            const res = await client.create_handle('uuid-1');
            expect(res.status).toBe(500);
            expect(res.handle).toBeNull();
        });

        it('throws UpstreamError on transport failure', async () => {
            const http = make_fake_http();
            http.set_response({ throw: new Error('ECONNRESET') });
            const client = handles_module.create_client(http);
            await expect(client.create_handle('uuid-1')).rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('update_handle', () => {
        it('uses PUT (idempotent refresh) and returns the same handle URL on 201', async () => {
            const http = make_fake_http();
            http.set_response({ status: 201, data: '' });
            const client = handles_module.create_client(http);
            const res = await client.update_handle('uuid-1');
            expect(res.status).toBe(201);
            expect(res.handle).toBe('https://hdl.example.com/20.500.12345/uuid-1');
            expect(http.calls.put).toHaveLength(1);
            expect(http.calls.post).toHaveLength(0);
        });

        it('returns { handle: null } on non-201', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: 'not found' });
            const client = handles_module.create_client(http);
            const res = await client.update_handle('uuid-1');
            expect(res.handle).toBeNull();
        });
    });
});
