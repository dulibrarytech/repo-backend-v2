'use strict';

/*
 * The "DuraCloud Preserve" card on the Services Health page and in the
 * post-sign-in banner: repov2 holds no DCP key, so it asks curation's
 * GET /health/dcp. It replaced the old DuraCloud API card.
 */

const dashboard = require('../../../ingester/dashboard');
const qa_service = require('../../../ingester/libs/qa_service');

function location(name, prefix, ok, error = null) {
    return {
        name,
        setting: `DCP_${name.toUpperCase()}_LOCATION`,
        prefix,
        keys: ok ? 1 : 0,
        ok,
        error,
    };
}

describe('DuraCloud Preserve service probe', () => {
    beforeEach(() => {
        dashboard._reset_dcp_probe();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        dashboard._reset_dcp_probe();
    });

    it('takes the old DuraCloud card’s place, between Archivematica and the DIP store', () => {
        const keys = dashboard.SERVICE_PROBES.map((p) => p.key);
        expect(keys).not.toContain('duracloud');
        expect(keys.indexOf('dcp')).toBe(keys.indexOf('archivematica') + 1);
        expect(keys.indexOf('dip_store')).toBe(keys.indexOf('dcp') + 1);
        const card = dashboard.SERVICE_PROBES.find((p) => p.key === 'dcp');
        expect(card.label).toBe('DuraCloud Preserve');
    });

    it('reports "not configured" without calling curation when its URL or key is unset', async () => {
        vi.spyOn(qa_service, 'is_configured').mockReturnValue(false);
        const call = vi.spyOn(qa_service, 'health_dcp');
        expect(await dashboard._probe_dcp()).toEqual({ configured: false });
        expect(call).not.toHaveBeenCalled();
    });

    it('is OK when curation lists both locations', async () => {
        vi.spyOn(qa_service, 'is_configured').mockReturnValue(true);
        vi.spyOn(qa_service, 'health_dcp').mockResolvedValue({
            status: 200,
            data: {
                ok: true,
                configured: true,
                error: null,
                locations: [
                    location('dip', 'dip-store/', true),
                    location('aip', 'aip-store/', true),
                ],
            },
        });
        expect(await dashboard._probe_dcp()).toEqual({
            configured: true,
            reachable: true,
            detail: 'both DCP locations listed via curation',
        });
    });

    it('asks curation at most once a minute, sharing the answer', async () => {
        vi.spyOn(qa_service, 'is_configured').mockReturnValue(true);
        const call = vi
            .spyOn(qa_service, 'health_dcp')
            .mockResolvedValue({ status: 200, data: { ok: true, locations: [] } });
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        await Promise.all([dashboard._probe_dcp(), dashboard._probe_dcp()]);
        now.mockReturnValue(1_000_000 + 59_000);
        await dashboard._probe_dcp();
        expect(call).toHaveBeenCalledTimes(1);
        now.mockReturnValue(1_000_000 + 60_000);
        await dashboard._probe_dcp();
        expect(call).toHaveBeenCalledTimes(2);
    });

    it('fails with curation’s own reason when it has no DCP key', async () => {
        vi.spyOn(qa_service, 'is_configured').mockReturnValue(true);
        vi.spyOn(qa_service, 'health_dcp').mockResolvedValue({
            status: 200,
            data: {
                ok: false,
                configured: false,
                error: 'not configured (DCP_ACCESS_KEY_ID, DCP_SECRET_ACCESS_KEY, DCP_REGION)',
                locations: [],
            },
        });
        const res = await dashboard._probe_dcp();
        expect(res.reachable).toBe(false);
        expect(res.detail).toBe(
            'curation: not configured (DCP_ACCESS_KEY_ID, DCP_SECRET_ACCESS_KEY, DCP_REGION)'
        );
    });

    it('names the location that failed', async () => {
        vi.spyOn(qa_service, 'is_configured').mockReturnValue(true);
        vi.spyOn(qa_service, 'health_dcp').mockResolvedValue({
            status: 200,
            data: {
                ok: false,
                configured: true,
                error: null,
                locations: [
                    location('dip', 'dip-store/', true),
                    location('aip', 'aip-store/', false, 'ClientError: AccessDenied'),
                ],
            },
        });
        const res = await dashboard._probe_dcp();
        expect(res.reachable).toBe(false);
        expect(res.detail).toBe('curation: aip-store/: ClientError: AccessDenied');
    });

    it('fails on a non-200 answer', async () => {
        vi.spyOn(qa_service, 'is_configured').mockReturnValue(true);
        vi.spyOn(qa_service, 'health_dcp').mockResolvedValue({ status: 404, data: 'Not Found' });
        expect(await dashboard._probe_dcp()).toEqual({
            configured: true,
            reachable: false,
            detail: 'GET /health/dcp → 404',
        });
    });

    it('turns curation being unreachable into a red card, not a throw', async () => {
        vi.spyOn(qa_service, 'is_configured').mockReturnValue(true);
        vi.spyOn(qa_service, 'health_dcp').mockRejectedValue(
            new Error('QA service /health/dcp failed: connect ECONNREFUSED')
        );
        const card = await dashboard._run_probe('dcp', 'DuraCloud Preserve', dashboard._probe_dcp);
        expect(card).toMatchObject({ key: 'dcp', configured: true, reachable: false });
        expect(card.detail).toMatch(/ECONNREFUSED/);
    });
});

describe('services banner names', () => {
    const card = (key, label, reachable) => ({ key, label, configured: true, reachable });

    it('names DuraCloud Preserve as preservation storage when it alone is down', () => {
        const names = dashboard._banner_degraded([
            card('curation_api', 'Curation API', true),
            card('dcp', 'DuraCloud Preserve', false),
        ]);
        expect(names).toEqual([
            { label: 'DuraCloud Preserve', capability: 'preservation storage' },
        ]);
    });

    it('names only curation when curation is down, since DCP is checked through it', () => {
        const names = dashboard._banner_degraded([
            card('curation_api', 'Curation API', false),
            card('dcp', 'DuraCloud Preserve', false),
            card('elasticsearch', 'Elasticsearch', false),
        ]);
        expect(names.map((n) => n.label)).toEqual(['Curation API', 'Elasticsearch']);
    });
});
