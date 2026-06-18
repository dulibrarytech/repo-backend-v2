'use strict';

const app_config = require('../../../config/app');
const security = require('../../../config/security');

// async + `return await fn()` is load-bearing: without it the finally
// runs synchronously after fn returns its Promise, restoring env BEFORE
// awaits inside fn resolve. Silent false passes result.
async function with_env(overrides, fn) {
    const saved = {};
    for (const k of Object.keys(overrides)) {
        saved[k] = process.env[k];
        if (overrides[k] === null) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    try {
        app_config._reset();
        return await fn();
    } finally {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        app_config._reset();
    }
}

function call_cors(origin) {
    return new Promise((resolve) => {
        const fn = security.cors_options();
        fn({ headers: { origin } }, (_err, opts) => resolve(opts));
    });
}

describe('config/security', () => {
    afterEach(() => app_config._reset());

    describe('helmet_options', () => {
        it('enables CSP, self-hosted assets only (no third-party CDN)', () => {
            const csp = security.helmet_options().contentSecurityPolicy;
            expect(csp).toBeTruthy();
            expect(csp.directives['default-src']).toEqual(["'self'"]);
            // Bootstrap + HTMX are vendored under /static/assets/vendor, so no
            // CDN origin is allowed for scripts/styles/fonts.
            expect(csp.directives['script-src']).toEqual(["'self'"]);
            expect(csp.directives['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
            expect(csp.directives['font-src']).toEqual(["'self'"]);
            expect(JSON.stringify(csp.directives)).not.toContain('jsdelivr');
            expect(csp.directives['object-src']).toEqual(["'none'"]);
        });

        it('sets a no-referrer policy', () => {
            expect(security.helmet_options().referrerPolicy.policy).toBe('no-referrer');
        });

        it('sets HSTS for one year', () => {
            expect(security.helmet_options().hsts.maxAge).toBe(31536000);
        });

        it("connect-src is 'self'-only (vendored sourcemaps load same-origin)", () => {
            const directives = security.helmet_options().contentSecurityPolicy.directives;
            expect(directives['connect-src']).toEqual(["'self'"]);
        });

        it("form-action defaults to 'self' when SSO_LOGOUT_URL is unset", async () => {
            await with_env({ SSO_LOGOUT_URL: null }, () => {
                const directives = security.helmet_options().contentSecurityPolicy.directives;
                expect(directives['form-action']).toEqual(["'self'"]);
            });
        });

        it('form-action includes the SSO logout origin when SSO_LOGOUT_URL is set', async () => {
            await with_env({ SSO_LOGOUT_URL: 'https://idp.example.com/auth/logout?x=1' }, () => {
                const directives = security.helmet_options().contentSecurityPolicy.directives;
                expect(directives['form-action']).toEqual(["'self'", 'https://idp.example.com']);
            });
        });

        it('falls back gracefully when SSO_LOGOUT_URL is malformed', async () => {
            await with_env({ SSO_LOGOUT_URL: 'not a url' }, () => {
                const directives = security.helmet_options().contentSecurityPolicy.directives;
                expect(directives['form-action']).toEqual(["'self'"]);
            });
        });
    });

    describe('cors_options', () => {
        it('allows requests from an allowlisted origin with credentials', async () => {
            await with_env(
                { CORS_ALLOWED_ORIGINS: 'http://ok.example,http://also.example' },
                async () => {
                    const opts = await call_cors('http://ok.example');
                    expect(opts.origin).toBe(true);
                    expect(opts.credentials).toBe(true);
                }
            );
        });

        it('rejects an unknown origin', async () => {
            await with_env({ CORS_ALLOWED_ORIGINS: 'http://ok.example' }, async () => {
                const opts = await call_cors('http://evil.example');
                expect(opts.origin).toBe(false);
            });
        });

        it('treats missing Origin as no-CORS (origin:false)', async () => {
            await with_env({ CORS_ALLOWED_ORIGINS: 'http://ok.example' }, async () => {
                const opts = await call_cors(undefined);
                expect(opts.origin).toBe(false);
            });
        });

        it('exact-match only — no substring or wildcard', async () => {
            await with_env({ CORS_ALLOWED_ORIGINS: 'http://ok.example' }, async () => {
                expect((await call_cors('http://ok.example.evil.com')).origin).toBe(false);
                expect((await call_cors('http://OK.example')).origin).toBe(false);
            });
        });
    });

    describe('body_limits', () => {
        it('caps JSON and urlencoded at 1mb', () => {
            expect(security.body_limits.json.limit).toBe('1mb');
            expect(security.body_limits.urlencoded.limit).toBe('1mb');
        });
        it('urlencoded uses extended:false (no qs library)', () => {
            expect(security.body_limits.urlencoded.extended).toBe(false);
        });
        it('JSON parser is strict (top-level must be array/object)', () => {
            expect(security.body_limits.json.strict).toBe(true);
        });
    });
});
