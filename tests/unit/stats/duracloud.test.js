'use strict';

/*
 * The home page's storage cards follow Archivematica's storage: the
 * Storage Service's DuraCloud spaces until DIP_COPY_ENABLED, then
 * curation's measurement of DuraCloud Preserve.
 */

const app_config = require('../../../config/app');
const archivematica = require('../../../libs/archivematica');
const curation = require('../../../ingester/libs/aip_store_client');
const log = require('../../../libs/log');
const stats_duracloud = require('../../../stats/duracloud');

const SAVED_FLAG = process.env.DIP_COPY_ENABLED;

function set_flag(on) {
    process.env.DIP_COPY_ENABLED = on ? 'true' : 'false';
    app_config({ reload: true });
}

function curation_answer(buckets, { computing = false, cached = true } = {}) {
    return {
        status: 200,
        data: { ok: true, usage: cached ? { computed_at: 1, buckets } : null, computing },
    };
}

describe('stats/duracloud', () => {
    beforeEach(() => {
        stats_duracloud._reset();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        if (SAVED_FLAG === undefined) delete process.env.DIP_COPY_ENABLED;
        else process.env.DIP_COPY_ENABLED = SAVED_FLAG;
        app_config({ reload: true });
        stats_duracloud._reset();
    });

    describe('before the switch (DIP_COPY_ENABLED off)', () => {
        beforeEach(() => set_flag(false));

        it('reads the Storage Service and names DuraCloud', async () => {
            vi.spyOn(archivematica, 'is_storage_configured').mockReturnValue(true);
            vi.spyOn(archivematica, 'get_dip_storage_usage').mockResolvedValue(1000);
            vi.spyOn(archivematica, 'get_aip_storage_usage').mockResolvedValue('2000');
            const bucket_usage = vi.spyOn(curation, 'bucket_usage');

            expect(await stats_duracloud.usage()).toEqual({
                dip_bytes: 1000,
                aip_bytes: 2000,
                total_bytes: 3000,
                ok: true,
                error: null,
                computed_at: null,
                computing: false,
            });
            expect(bucket_usage).not.toHaveBeenCalled();
            expect(stats_duracloud.store_label()).toBe('DuraCloud');
        });

        it('keeps the old message when the Storage Service is not configured', async () => {
            vi.spyOn(archivematica, 'is_storage_configured').mockReturnValue(false);
            expect(await stats_duracloud.usage()).toEqual({
                dip_bytes: null,
                aip_bytes: null,
                total_bytes: null,
                ok: false,
                error: 'AM storage API not configured',
                computed_at: null,
                computing: false,
            });
        });
    });

    describe('after the switch (DIP_COPY_ENABLED on)', () => {
        beforeEach(() => {
            set_flag(true);
            vi.spyOn(curation, 'is_configured').mockReturnValue(true);
        });

        it("reads curation's measurement of DCP and names DuraCloud Preserve", async () => {
            vi.spyOn(curation, 'bucket_usage').mockResolvedValue(
                curation_answer({
                    aip_store: { bytes: 5 },
                    dcp_dip_store: {
                        bucket: 'dcp-dip',
                        prefix: 'dip-store/',
                        objects: 2,
                        bytes: 4000,
                    },
                    dcp_aip_store: {
                        bucket: 'dcp-aip',
                        prefix: 'aip-store/',
                        objects: 1,
                        bytes: 6000,
                    },
                })
            );
            const storage_service = vi.spyOn(archivematica, 'get_dip_storage_usage');

            expect(await stats_duracloud.usage()).toEqual({
                dip_bytes: 4000,
                aip_bytes: 6000,
                total_bytes: 10000,
                ok: true,
                error: null,
                computed_at: 1,
                computing: false,
            });
            expect(storage_service).not.toHaveBeenCalled();
            expect(stats_duracloud.store_label()).toBe('DuraCloud Preserve');
        });

        it('says DCP is not measured yet while curation is walking, or has never walked', async () => {
            vi.spyOn(curation, 'bucket_usage').mockResolvedValue(
                curation_answer({ aip_store: { bytes: 5 } }, { computing: true })
            );
            const walking = await stats_duracloud.usage();
            expect(walking).toMatchObject({
                dip_bytes: null,
                aip_bytes: null,
                total_bytes: null,
                ok: false,
                computed_at: 1,
                computing: true,
            });
            expect(walking.error).toBe('DuraCloud Preserve usage not measured yet');

            stats_duracloud._reset();
            curation.bucket_usage.mockResolvedValueOnce(
                curation_answer({}, { computing: true, cached: false })
            );
            const cold = await stats_duracloud.usage();
            expect(cold.error).toBe('DuraCloud Preserve usage not measured yet');
            expect(cold.computed_at).toBeNull();
        });

        it('says curation is not measuring DCP when a finished walk has no DCP entries', async () => {
            vi.spyOn(curation, 'bucket_usage').mockResolvedValue(
                curation_answer({ aip_store: { bytes: 5 }, batch_backups: { bytes: 1 } })
            );
            const u = await stats_duracloud.usage();
            expect(u.ok).toBe(false);
            expect(u.error).toMatch(/curation is not measuring DuraCloud Preserve/);
            expect(u.error).toMatch(/Recalculate/);
        });

        it("passes on curation's error for one location and keeps the other", async () => {
            vi.spyOn(curation, 'bucket_usage').mockResolvedValue(
                curation_answer({
                    dcp_dip_store: { error: 'AccessDenied' },
                    dcp_aip_store: { bytes: 6000 },
                })
            );
            expect(await stats_duracloud.usage()).toEqual({
                dip_bytes: null,
                aip_bytes: 6000,
                total_bytes: null,
                ok: false,
                error: 'AccessDenied',
                computed_at: 1,
                computing: false,
            });
        });

        it('shows dashes, and logs, when curation is unreachable or refuses', async () => {
            const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
            vi.spyOn(curation, 'bucket_usage').mockRejectedValueOnce(new Error('ECONNREFUSED'));
            const unreachable = await stats_duracloud.usage();
            expect(unreachable).toMatchObject({ dip_bytes: null, aip_bytes: null, ok: false });
            expect(unreachable.error).toBe('DuraCloud Preserve usage unavailable');
            expect(warn).toHaveBeenCalledWith(
                expect.objectContaining({ event: 'stats_dcp_usage_failed' })
            );

            stats_duracloud._reset();
            curation.bucket_usage.mockResolvedValueOnce({ status: 403, data: ['Access denied.'] });
            const refused = await stats_duracloud.usage();
            expect(refused.error).toBe('DuraCloud Preserve usage unavailable');
            expect(warn).toHaveBeenCalledWith(
                expect.objectContaining({ event: 'stats_dcp_usage_refused', status: 403 })
            );
        });

        it('needs the curation API configured', async () => {
            curation.is_configured.mockReturnValue(false);
            const bucket_usage = vi.spyOn(curation, 'bucket_usage');
            const u = await stats_duracloud.usage();
            expect(u.error).toBe('curation API not configured');
            expect(bucket_usage).not.toHaveBeenCalled();
        });
    });
});
