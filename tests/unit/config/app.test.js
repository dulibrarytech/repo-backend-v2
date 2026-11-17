'use strict';

const app_config = require('../../../config/app');

/*
 * Synchronous callers are safe with this form; async callers should
 * switch to `return await fn()` (see the equivalent helper under
 * tests/unit/auth/sso for why).
 */
function with_env(overrides, fn) {
    const saved = {};
    for (const k of Object.keys(overrides)) {
        saved[k] = process.env[k];
        if (overrides[k] === null) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    try {
        app_config._reset();
        return fn();
    } finally {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        app_config._reset();
    }
}

describe('config/app', () => {
    afterEach(() => app_config._reset());

    it('returns a cached config object', () => {
        const a = app_config();
        const b = app_config();
        expect(a).toBe(b);
    });

    it('reload:true bypasses cache', () => {
        const a = app_config();
        const b = app_config({ reload: true });
        expect(a).not.toBe(b);
    });

    it('throws if TOKEN_SECRET is missing', () => {
        with_env({ TOKEN_SECRET: null }, () => {
            expect(() => app_config()).toThrow(/TOKEN_SECRET/);
        });
    });

    it('parses CORS_ALLOWED_ORIGINS as a list', () => {
        with_env(
            { CORS_ALLOWED_ORIGINS: 'http://a.example, http://b.example ,, http://c.example' },
            () => {
                const cfg = app_config();
                expect(cfg.cors_allowed_origins).toEqual([
                    'http://a.example',
                    'http://b.example',
                    'http://c.example',
                ]);
            }
        );
    });

    it('treats env=production correctly', () => {
        with_env({ NODE_ENV: 'production' }, () => {
            const cfg = app_config();
            expect(cfg.is_prod).toBe(true);
            expect(cfg.is_test).toBe(false);
            expect(cfg.is_dev).toBe(false);
        });
    });

    it('treats env=test correctly', () => {
        with_env({ NODE_ENV: 'test' }, () => {
            const cfg = app_config();
            expect(cfg.is_test).toBe(true);
        });
    });

    it('integer parser rejects non-numeric values', () => {
        with_env({ APP_PORT: 'abc' }, () => {
            expect(() => app_config()).toThrow(/APP_PORT/);
        });
    });

    it('DIP_STORE_TIMEOUT_MS must be a positive integer', () => {
        // 0 would switch the SDK timeouts off and make the probe fail at once.
        for (const bad of ['0', '-5', '2147483648']) {
            with_env({ DIP_STORE_TIMEOUT_MS: bad }, () => {
                expect(() => app_config(), bad).toThrow(/DIP_STORE_TIMEOUT_MS/);
            });
        }
        with_env({ DIP_STORE_TIMEOUT_MS: '2500' }, () => {
            expect(app_config().dip_store.timeout_ms).toBe(2500);
        });
        with_env({ DIP_STORE_TIMEOUT_MS: null }, () => {
            expect(app_config().dip_store.timeout_ms).toBe(15000);
        });
    });

    it('defaults APP_PORT to 8000', () => {
        with_env({ APP_PORT: null }, () => {
            expect(app_config().port).toBe(8000);
        });
    });

    describe('ArchivesSpace writes', () => {
        const REMOTE = 'https://archivesspace.example.edu/api';
        const switches = (env) =>
            with_env({ ASPACE_WRITES_ENABLED: null, ASPACE_WRITES_FROM_DEV: null, ...env }, () => {
                const { writes_requested, writes_enabled } = app_config().archivespace;
                return { writes_requested, writes_enabled };
            });

        it('stay off unless ASPACE_WRITES_ENABLED is on', () => {
            expect(switches({ NODE_ENV: 'production', ARCHIVESPACE_HOST: REMOTE })).toEqual({
                writes_requested: false,
                writes_enabled: false,
            });
        });

        it.each(['production', 'test'])('are allowed when NODE_ENV is %s', (env) => {
            expect(
                switches({ NODE_ENV: env, ASPACE_WRITES_ENABLED: '1', ARCHIVESPACE_HOST: REMOTE })
            ).toEqual({ writes_requested: true, writes_enabled: true });
        });

        it.each([['development'], [null]])(
            'are held back when NODE_ENV is %s and ArchivesSpace is on another machine',
            (env) => {
                expect(
                    switches({
                        NODE_ENV: env,
                        ASPACE_WRITES_ENABLED: '1',
                        ARCHIVESPACE_HOST: REMOTE,
                    })
                ).toEqual({ writes_requested: true, writes_enabled: false });
            }
        );

        it.each(['http://localhost:8089', 'http://127.0.0.1:8089/api', 'http://[::1]:8089'])(
            'are allowed from a development host to %s',
            (host) => {
                expect(
                    switches({
                        NODE_ENV: 'development',
                        ASPACE_WRITES_ENABLED: '1',
                        ARCHIVESPACE_HOST: host,
                    })
                ).toEqual({ writes_requested: true, writes_enabled: true });
            }
        );

        it.each(['http://localhost.example.edu', 'not a url', ''])(
            'treat %j as another machine',
            (host) => {
                expect(
                    switches({
                        NODE_ENV: 'development',
                        ASPACE_WRITES_ENABLED: '1',
                        ARCHIVESPACE_HOST: host,
                    }).writes_enabled
                ).toBe(false);
            }
        );

        it('are allowed from a development host when ASPACE_WRITES_FROM_DEV is on too', () => {
            expect(
                switches({
                    NODE_ENV: 'development',
                    ASPACE_WRITES_ENABLED: '1',
                    ASPACE_WRITES_FROM_DEV: '1',
                    ARCHIVESPACE_HOST: REMOTE,
                })
            ).toEqual({ writes_requested: true, writes_enabled: true });
            expect(
                switches({
                    NODE_ENV: 'development',
                    ASPACE_WRITES_FROM_DEV: '1',
                    ARCHIVESPACE_HOST: REMOTE,
                }).writes_enabled
            ).toBe(false);
        });
    });

    it('boolean flag parsing', () => {
        with_env({ INGEST_DISABLE_RESUME: '1' }, () => {
            expect(app_config().flags.ingest_disable_resume).toBe(true);
        });
        with_env({ INGEST_DISABLE_RESUME: 'true' }, () => {
            expect(app_config().flags.ingest_disable_resume).toBe(true);
        });
        with_env({ INGEST_DISABLE_RESUME: '0' }, () => {
            expect(app_config().flags.ingest_disable_resume).toBe(false);
        });
        with_env({ INGEST_DISABLE_RESUME: null }, () => {
            expect(app_config().flags.ingest_disable_resume).toBe(false);
        });
    });
});
