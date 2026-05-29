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
        // We don't read stdout here — just confirm the level isn't
        // accidentally noisy. Setup.js sets LOG_LEVEL=off and the
        // logger module forces .level='off' when NODE_ENV=test.
        expect(log.level.levelStr).toBe('OFF');
    });

    it('calls do not throw', () => {
        expect(() => log.info({ msg: 'unit test' })).not.toThrow();
        expect(() => log.error({ err: new Error('x') })).not.toThrow();
    });
});
