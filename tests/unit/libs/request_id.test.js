'use strict';

const request_id = require('../../../libs/request_id');

function fake_req(headers = {}) {
    return {
        get(name) {
            return headers[name.toLowerCase()];
        },
    };
}

function fake_res() {
    const set_headers = {};
    return {
        set(name, value) {
            set_headers[name.toLowerCase()] = value;
        },
        headers: set_headers,
    };
}

describe('libs/request_id', () => {
    it('honors inbound X-Request-Id', () => {
        const req = fake_req({ 'x-request-id': 'inbound-abc' });
        const res = fake_res();
        let called = false;
        request_id(req, res, () => {
            called = true;
        });
        expect(called).toBe(true);
        expect(req.id).toBe('inbound-abc');
        expect(res.headers['x-request-id']).toBe('inbound-abc');
    });

    it('generates a UUID when no inbound id', () => {
        const req = fake_req();
        const res = fake_res();
        request_id(req, res, () => {});
        expect(req.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(res.headers['x-request-id']).toBe(req.id);
    });

    it('rejects oversized inbound id and mints fresh', () => {
        const huge = 'x'.repeat(200);
        const req = fake_req({ 'x-request-id': huge });
        const res = fake_res();
        request_id(req, res, () => {});
        expect(req.id).not.toBe(huge);
        expect(req.id).toMatch(/-/);
    });

    it('mints fresh when inbound is empty string', () => {
        const req = fake_req({ 'x-request-id': '' });
        const res = fake_res();
        request_id(req, res, () => {});
        expect(req.id.length).toBeGreaterThan(0);
    });
});
