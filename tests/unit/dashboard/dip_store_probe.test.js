'use strict';

/*
 * The "DIP store (Wasabi)" card on the Services Health page and in the
 * post-sign-in banner: its probe, and its place among SERVICE_PROBES.
 */

const dashboard = require('../../../ingester/dashboard');
const dip_store = require('../../../libs/dip_store');
const app_config = require('../../../config/app');

const ENV = {
    DIP_STORE_LOCATION: 's3://test-dip-store/dip-store/',
    DIP_STORE_ENDPOINT: 'https://s3.test.example',
    DIP_STORE_REGION: 'us-west-1',
    DIP_STORE_ACCESS_KEY_ID: 'test-key',
    DIP_STORE_SECRET_ACCESS_KEY: 'test-secret',
};

describe('DIP store service probe', () => {
    let original_env;

    beforeEach(() => {
        original_env = { ...process.env };
        app_config._reset();
        dip_store._reset();
    });

    afterEach(() => {
        process.env = original_env;
        app_config._reset();
        dip_store._reset();
    });

    it('reports "not configured" without touching Wasabi', async () => {
        for (const name of Object.keys(ENV)) delete process.env[name];
        app_config._reset();
        const send = vi.fn();
        dip_store._set_client({ send });
        expect(await dashboard._probe_dip_store()).toEqual({ configured: false });
        expect(send).not.toHaveBeenCalled();
    });

    it('is reachable when the dip-store/ listing succeeds', async () => {
        Object.assign(process.env, ENV);
        app_config._reset();
        dip_store._set_client({ send: vi.fn(async () => ({ KeyCount: 0 })) });
        expect(await dashboard._probe_dip_store()).toEqual({
            configured: true,
            reachable: true,
            detail: 'dip-store/ list and read OK',
        });
    });

    it('is unreachable when the listing is denied', async () => {
        Object.assign(process.env, ENV);
        app_config._reset();
        const denied = Object.assign(new Error('AccessDenied'), {
            $metadata: { httpStatusCode: 403 },
        });
        dip_store._set_client({
            send: vi.fn(async () => {
                throw denied;
            }),
        });
        const res = await dashboard._probe_dip_store();
        expect(res.configured).toBe(true);
        expect(res.reachable).toBe(false);
    });
});
