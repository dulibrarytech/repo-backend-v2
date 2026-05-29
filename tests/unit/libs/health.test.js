'use strict';

const health = require('../../../libs/health');

describe('libs/health', () => {
    beforeEach(() => health.clear());
    afterAll(() => health.clear());

    it('report() with no checks is ok', async () => {
        const r = await health.report();
        expect(r.ok).toBe(true);
        expect(r.components).toEqual({});
    });

    it('aggregates passing checks', async () => {
        health.register('db', async () => ({ ok: true }));
        health.register('es', async () => ({ ok: true }));
        const r = await health.report();
        expect(r.ok).toBe(true);
        expect(r.components.db.ok).toBe(true);
        expect(r.components.es.ok).toBe(true);
    });

    it('flags a single failing check as not-ok overall', async () => {
        health.register('db', async () => ({ ok: true }));
        health.register('es', async () => ({ ok: false, error: 'connection refused' }));
        const r = await health.report();
        expect(r.ok).toBe(false);
        expect(r.components.es.error).toBe('connection refused');
    });

    it('captures thrown errors as not-ok', async () => {
        health.register('bad', async () => {
            throw new Error('boom');
        });
        const r = await health.report();
        expect(r.ok).toBe(false);
        expect(r.components.bad.error).toBe('boom');
    });

    it('unregister removes a check', async () => {
        health.register('temp', async () => ({ ok: true }));
        expect((await health.report()).components.temp).toBeDefined();
        health.unregister('temp');
        expect((await health.report()).components.temp).toBeUndefined();
    });

    it('register rejects non-functions', () => {
        expect(() => health.register('bad', 'not a function')).toThrow(TypeError);
    });
});
