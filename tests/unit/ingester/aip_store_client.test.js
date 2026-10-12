'use strict';

/*
 * Unit tests for the curation client's copy_dip (Stage 4's DIP copy): the
 * URL, the body, the auth header, the timeout and the abort signal, and a
 * transport failure as UpstreamError. A fake axios; no network.
 */

const app_config = require('../../../config/app');
const client_module = require('../../../ingester/libs/aip_store_client');
const { UpstreamError } = require('../../../libs/errors');

function make_fake_http(response) {
    const calls = [];
    return {
        calls,
        async post(url, body, opts) {
            calls.push({ url, body, opts });
            if (response instanceof Error) throw response;
            return response;
        },
    };
}

describe('ingester/libs/aip_store_client copy_dip', () => {
    let saved_env;
    beforeEach(() => {
        saved_env = { ...process.env };
        process.env.CURATION_API = 'https://curation.example.com/';
        process.env.CURATION_API_KEY = 'curation-key';
        app_config._reset();
    });
    afterEach(() => {
        process.env = saved_env;
        app_config._reset();
    });

    it('POSTs the DIP to /api/v2/dip/copy-to-wasabi with the key in a header', async () => {
        const http = make_fake_http({ status: 200, data: { ok: true, status: 'copied' } });
        const signal = new AbortController().signal;
        const res = await client_module
            .create_client(http)
            .copy_dip('sip-1', 'aaaa/bbbb/folder', 6000, { timeout_ms: 1234, signal });
        expect(res).toEqual({ status: 200, data: { ok: true, status: 'copied' } });
        const [call] = http.calls;
        expect(call.url).toBe('https://curation.example.com/api/v2/dip/copy-to-wasabi');
        expect(call.body).toEqual({
            sip_uuid: 'sip-1',
            dip_path: 'aaaa/bbbb/folder',
            expected_size: 6000,
        });
        expect(call.opts.headers['X-API-Key']).toBe('curation-key');
        expect(call.url).not.toContain('curation-key');
        expect(call.opts.timeout).toBe(1234);
        expect(call.opts.signal).toBe(signal);
        expect(call.opts.validateStatus(500)).toBe(true);
    });

    it('throws UpstreamError on a transport failure', async () => {
        const http = make_fake_http(new Error('socket hang up'));
        const client = client_module.create_client(http);
        await expect(client.copy_dip('sip-1', 'p', 1)).rejects.toThrow(UpstreamError);
    });
});
