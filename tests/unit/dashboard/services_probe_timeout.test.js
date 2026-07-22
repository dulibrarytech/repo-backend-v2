'use strict';

/*
 * The post-sign-in services banner must resolve fast even when a service
 * hangs on a long client timeout (ES's connect timeout is ~10s). These pin
 * the deadline mechanism in ingester/dashboard.js: a hung probe becomes a
 * normal "unreachable" result within the deadline, not a hang or a throw.
 */

const dashboard = require('../../../ingester/dashboard');
const app_config = require('../../../config/app');

describe('service probe deadline (banner snappiness)', () => {
    it('_with_deadline resolves a fast probe to its value', async () => {
        const out = await dashboard._with_deadline(() => Promise.resolve({ ok: 1 }), 1000);
        expect(out).toEqual({ ok: 1 });
    });

    it('_with_deadline resolves a hung probe to a timeout sentinel', async () => {
        const started = Date.now();
        const out = await dashboard._with_deadline(() => new Promise(() => {}), 40);
        expect(out).toEqual({ __timed_out: true });
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it('_run_probe reports a hung probe as unreachable (configured, not a throw)', async () => {
        const res = await dashboard._run_probe(
            'elasticsearch',
            'Elasticsearch',
            () => new Promise(() => {}),
            40
        );
        expect(res.configured).toBe(true);
        expect(res.reachable).toBe(false);
        expect(res.detail).toMatch(/timed out/i);
    });

    it('_run_probe swallows a probe that rejects after the deadline', async () => {
        const res = await dashboard._run_probe(
            'x',
            'X',
            () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20)),
            5
        );
        expect(res.reachable).toBe(false);
        expect(res.detail).toMatch(/timed out/i);
        /*
         * Give the late rejection time to fire; the internal p.catch() must
         * swallow it (no unhandledRejection crashing the run).
         */
        await new Promise((r) => setTimeout(r, 40));
    });

    it('_run_probe with no deadline preserves the probe result (admin grid path)', async () => {
        const res = await dashboard._run_probe('curation_api', 'Curation API', async () => ({
            configured: true,
            reachable: true,
            detail: 'ok',
        }));
        expect(res.reachable).toBe(true);
        expect(res.detail).toBe('ok');
    });

    /*
     * Regression guard for the false-positive banner: the per-probe deadline
     * must give the slowest *interactive* probe its full client budget, or a
     * healthy-but-slow service is wrongly reported down. ArchivesSpace's probe
     * is a login round-trip (15s), DuraCloud's is 15s, Elasticsearch's is 10s.
     * (Archivematica/curation have longer budgets but lightweight liveness, so
     * they're intentionally capped by the banner deadline.) The original 3s
     * value violated this and false-flagged ArchivesSpace.
     */
    it('banner deadline clears the slowest interactive probe (no false "down")', () => {
        const cfg = app_config();
        expect(dashboard.BANNER_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(cfg.archivespace.timeout_ms);
        expect(dashboard.BANNER_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(cfg.duracloud.timeout_ms);
        expect(dashboard.BANNER_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(cfg.elasticsearch.timeout_ms);
    });
});
