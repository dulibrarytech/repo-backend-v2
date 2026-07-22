'use strict';

const log = require('../../../libs/log');

describe('libs/log', () => {
    it('exports a usable logger with the standard methods', () => {
        expect(typeof log.trace).toBe('function');
        expect(typeof log.debug).toBe('function');
        expect(typeof log.info).toBe('function');
        expect(typeof log.warn).toBe('function');
        expect(typeof log.error).toBe('function');
        expect(typeof log.fatal).toBe('function');
    });

    it('is silent in tests by default', () => {
        /*
         * We don't read stdout here — just confirm the level isn't
         * accidentally noisy. Setup.js sets LOG_LEVEL=off and the
         * logger module forces .level='off' when NODE_ENV=test.
         */
        expect(log.level.levelStr).toBe('OFF');
    });

    it('calls do not throw', () => {
        expect(() => log.info({ msg: 'unit test' })).not.toThrow();
        expect(() => log.error({ err: new Error('x') })).not.toThrow();
    });
});

/*
 * Regression for the systemd-only crash: in production the appenders
 * reference a custom 'json' layout that must be registered via
 * addLayout() before configure(). When it wasn't, the FIRST log call
 * under NODE_ENV=production threw "TypeError: layout is not a function".
 * We load a fresh copy of the module with NODE_ENV=production and
 * confirm a log call survives.
 */
describe('libs/log — production json layout', () => {
    let saved_env;
    beforeEach(() => {
        saved_env = { ...process.env };
    });
    afterEach(() => {
        process.env = saved_env;
        vi.resetModules();
    });

    it('does not throw when logging under NODE_ENV=production', () => {
        process.env.NODE_ENV = 'production';
        /*
         * A real level so the appender's layout actually runs (an 'off'
         * logger would short-circuit before formatting and hide the bug).
         */
        process.env.LOG_LEVEL = 'info';
        /*
         * Fresh module instance so log4js.configure() re-runs with the
         * production appenders + our addLayout('json') registration.
         */
        vi.resetModules();
        const prod_log = require('../../../libs/log');
        expect(() => prod_log.info({ msg: 'prod layout smoke test' })).not.toThrow();
        expect(() => prod_log.error({ err: { message: 'boom' } })).not.toThrow();
    });

    it('registers the json layout so production logging survives repeated calls', () => {
        process.env.NODE_ENV = 'production';
        process.env.LOG_LEVEL = 'info';
        vi.resetModules();
        const prod_log = require('../../../libs/log');
        /*
         * The pre-fix bug threw on the FIRST call. Fire several at
         * different levels to be sure the json layout is wired for
         * every appender path (stdout + dateFile both reference it).
         */
        expect(() => {
            prod_log.debug({ msg: 'd' }); // below level — filtered, no layout run
            prod_log.info({ msg: 'i', request_id: 'r1' });
            prod_log.warn({ msg: 'w' });
            prod_log.error({ err: { message: 'e' } });
        }).not.toThrow();
    });

    /*
     * NOTE: the NDJSON output format (one standalone JSON object per
     * line, no trailing comma) is verified out-of-band — log4js writes
     * through process.stdout in a way vitest's pool isolation doesn't
     * reliably intercept after resetModules, so a capture-based
     * assertion here would be flaky. The format is pinned by the
     * addLayout('json') implementation in libs/log.js (separator
     * defaults to '' → no trailing comma).
     */
});
