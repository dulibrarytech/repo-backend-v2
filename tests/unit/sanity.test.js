'use strict';

// describe / it / expect are vitest globals (see vitest.config.js).

describe('test harness — unit tier', () => {
    it('runs', () => {
        expect(1 + 1).toBe(2);
    });

    it('sees NODE_ENV=test', () => {
        expect(process.env.NODE_ENV).toBe('test');
    });

    it('can require Node built-ins', () => {
        const path = require('node:path');
        expect(path.join('a', 'b')).toBe('a/b');
    });
});
