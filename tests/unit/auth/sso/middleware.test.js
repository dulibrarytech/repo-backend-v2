'use strict';

const middleware = require('../../../../auth/sso/middleware');
const app_config = require('../../../../config/app');
const { ForbiddenError } = require('../../../../libs/errors');

// IMPORTANT: must be async with `return await fn()`. With the sync form
// `try { return fn(); }`, the finally block fires synchronously the
// moment fn returns its Promise — before any await inside fn resolves.
// The first run inside the test sees the env; everything after sees
// the restored env. Quietly produces false-pass results.
async function with_env(overrides, fn) {
    const saved = {};
    for (const k of Object.keys(overrides)) {
        saved[k] = process.env[k];
        if (overrides[k] === null) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    app_config._reset();
    middleware._reset();
    try {
        return await fn();
    } finally {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        app_config._reset();
        middleware._reset();
    }
}

function run(req) {
    return new Promise((resolve) => {
        middleware.require_trusted_source(req, {}, (err) => resolve(err));
    });
}

describe('auth/sso/middleware — IP allowlist (Layer 1)', () => {
    describe('disabled (empty allowlist)', () => {
        it('passes any source through', async () => {
            await with_env({ SSO_TRUSTED_IPS: '' }, async () => {
                expect(await run({ id: 'r1', ip: '203.0.113.5' })).toBeUndefined();
                expect(await run({ id: 'r2', ip: '198.51.100.99' })).toBeUndefined();
            });
        });
    });

    describe('exact-IP allowlist', () => {
        it('accepts a listed IP', async () => {
            await with_env({ SSO_TRUSTED_IPS: '10.0.0.5' }, async () => {
                expect(await run({ id: 'r3', ip: '10.0.0.5' })).toBeUndefined();
            });
        });

        it('rejects an unlisted IP', async () => {
            await with_env({ SSO_TRUSTED_IPS: '10.0.0.5' }, async () => {
                const err = await run({ id: 'r4', ip: '10.0.0.6' });
                expect(err).toBeInstanceOf(ForbiddenError);
            });
        });

        it('strips IPv4-mapped-IPv6 prefix before matching', async () => {
            await with_env({ SSO_TRUSTED_IPS: '127.0.0.1' }, async () => {
                expect(await run({ id: 'r5', ip: '::ffff:127.0.0.1' })).toBeUndefined();
            });
        });
    });

    describe('CIDR allowlist', () => {
        it('accepts an IP inside the subnet', async () => {
            await with_env({ SSO_TRUSTED_IPS: '10.0.0.0/24' }, async () => {
                expect(await run({ id: 'r6', ip: '10.0.0.50' })).toBeUndefined();
            });
        });

        it('rejects an IP outside the subnet', async () => {
            await with_env({ SSO_TRUSTED_IPS: '10.0.0.0/24' }, async () => {
                const err = await run({ id: 'r7', ip: '10.0.1.50' });
                expect(err).toBeInstanceOf(ForbiddenError);
            });
        });

        it('accepts an IP matched by any of multiple subnets', async () => {
            await with_env(
                { SSO_TRUSTED_IPS: '10.0.0.0/8,192.168.1.0/24,203.0.113.7' },
                async () => {
                    expect(await run({ id: 'r8', ip: '10.99.99.99' })).toBeUndefined();
                    expect(await run({ id: 'r9', ip: '192.168.1.42' })).toBeUndefined();
                    expect(await run({ id: 'r10', ip: '203.0.113.7' })).toBeUndefined();
                    const err = await run({ id: 'r11', ip: '8.8.8.8' });
                    expect(err).toBeInstanceOf(ForbiddenError);
                }
            );
        });
    });

    describe('malformed allowlist entries', () => {
        it('skips bad entries and still enforces the rest', async () => {
            await with_env({ SSO_TRUSTED_IPS: 'not-an-ip,10.0.0.5' }, async () => {
                expect(await run({ id: 'r12', ip: '10.0.0.5' })).toBeUndefined();
                const err = await run({ id: 'r13', ip: '203.0.113.10' });
                expect(err).toBeInstanceOf(ForbiddenError);
            });
        });
    });

    describe('missing source IP', () => {
        it('rejects when req.ip is empty and allowlist is non-empty', async () => {
            await with_env({ SSO_TRUSTED_IPS: '10.0.0.5' }, async () => {
                const err = await run({ id: 'r14', ip: '' });
                expect(err).toBeInstanceOf(ForbiddenError);
            });
        });
    });
});
