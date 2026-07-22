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

    it('defaults APP_PORT to 8000', () => {
        with_env({ APP_PORT: null }, () => {
            expect(app_config().port).toBe(8000);
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
