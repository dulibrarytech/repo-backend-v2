'use strict';

/*
 * Render aip_backfill_status.ejs and pin the failure-reasons
 * visibility rule: shown while there is something actionable, hidden
 * once the process is complete AND caught up (batch settled +
 * missing === 0) — at that point every remaining failure is
 * permanently decided (AM_DELETED / orphan), and a warning box under
 * "All caught up." reads as a false alarm (2026-08-13).
 */

const path = require('node:path');
const ejs = require('ejs');

const PARTIAL = path.resolve(
    __dirname,
    '../../../views/dashboard/partials/aip_backfill_status.ejs'
);

function base_status(over) {
    return {
        pending: 0,
        in_progress: 0,
        complete: 213,
        failed: 1,
        cancelled: 0,
        total_backfill_rows: 214,
        latest_batch_marker: 'backfill_by:test-3bee3fb3',
        latest_batch_started_at: '2026-08-13 10:12:38',
        top_failure_reasons: [
            { count: 1, reason: 'AM status is DELETED - skipping permanently' },
        ],
        ...over,
    };
}

function render({ missing, status_over }) {
    return ejs.renderFile(PARTIAL, {
        missing,
        status: base_status(status_over),
        dashboard_base: '/repo/dashboard',
        aip_store_enabled: true,
        chunk_size: 1000,
    });
}

describe('aip_backfill_status failure-reasons visibility', () => {
    it('hides the failure box when settled and all caught up', async () => {
        const html = await render({ missing: 0, status_over: {} });
        expect(html).toContain('All caught up.');
        expect(html).not.toContain('Top failure reasons');
    });

    it('shows the failure box while failures are still actionable (missing > 0)', async () => {
        const html = await render({ missing: 12, status_over: {} });
        expect(html).toContain('Top failure reasons');
        expect(html).toContain('AM status is DELETED');
    });

    it('shows the failure box mid-batch even at missing 0', async () => {
        /*
         * A draining batch excludes queued rows from `missing`, so
         * missing can read 0 while work (and fresh failures) are
         * still in flight — reasons must stay visible until settled.
         */
        const html = await render({
            missing: 0,
            status_over: { pending: 5, in_progress: 2 },
        });
        expect(html).toContain('Top failure reasons');
    });

    it('renders no failure box at all when there are no failures', async () => {
        const html = await render({
            missing: 0,
            status_over: { failed: 0, top_failure_reasons: [] },
        });
        expect(html).not.toContain('Top failure reasons');
    });
});
