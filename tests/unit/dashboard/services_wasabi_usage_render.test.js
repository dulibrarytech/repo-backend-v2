'use strict';

/*
 * Render services_wasabi.ejs and pin the storage-utilization section:
 * both buckets with human-readable sizes, the computing / as-of
 * states, per-bucket listing errors, and graceful absence when the
 * curation API doesn't provide usage (older build / unreachable).
 */

const path = require('node:path');
const ejs = require('ejs');

const PARTIAL = path.resolve(
    __dirname,
    '../../../views/dashboard/partials/services_wasabi.ejs'
);

function render(over = {}) {
    return ejs.renderFile(PARTIAL, {
        reachable: true,
        body: { ok: true, bucket: 'library-special-collections', elapsed_ms: 700 },
        transport_error: null,
        checked_at: new Date().toISOString(),
        dashboard_base: '/repo/dashboard',
        usage: null,
        usage_computing: false,
        ...over,
    });
}

function usage_fixture() {
    return {
        computed_at: Math.floor(Date.now() / 1000) - 300, // 5 minutes ago
        buckets: {
            aip_store: {
                bucket: 'library-repository',
                prefix: 'aip-store/',
                objects: 21051,
                bytes: 9_345_678_901_234, // ~8.5 TB
                duration_ms: 21000,
            },
            batch_backups: {
                bucket: 'library-special-collections',
                prefix: '',
                objects: 412345,
                bytes: 7_200_000_000_000, // ~6.55 TB
                duration_ms: 240000,
            },
        },
    };
}

describe('services_wasabi storage-utilization section', () => {
    it('renders both buckets with counts and human sizes', async () => {
        const html = await render({ usage: usage_fixture() });
        expect(html).toContain('Storage utilization');
        expect(html).toContain('AIP store');
        expect(html).toContain('Batch backups');
        expect(html).toContain('21,051');
        expect(html).toContain('412,345');
        expect(html).toContain('8.50 TB');
        expect(html).toContain('6.55 TB');
        expect(html).toMatch(/as of \d+m ago/);
        expect(html).toContain('usage-refresh');
    });

    it('shows the recalculating state and disables the button', async () => {
        const html = await render({
            usage: usage_fixture(),
            usage_computing: true,
        });
        expect(html).toContain('recalculating');
        expect(html).toMatch(/usage-refresh[\s\S]*?disabled/);
    });

    it('surfaces a per-bucket listing error without hiding the other bucket', async () => {
        const usage = usage_fixture();
        usage.buckets.batch_backups = { error: 'AccessDenied on list' };
        const html = await render({ usage });
        expect(html).toContain('8.50 TB');
        expect(html).toContain('listing failed:');
        expect(html).toContain('AccessDenied on list');
    });

    it('degrades gracefully when usage is unavailable', async () => {
        const html = await render({ usage: null });
        expect(html).toContain('Storage utilization');
        expect(html).toContain('Not available');
    });

    it('explains the first-run computing state', async () => {
        const html = await render({ usage: null, usage_computing: true });
        expect(html).toContain('First calculation in progress');
    });
});
