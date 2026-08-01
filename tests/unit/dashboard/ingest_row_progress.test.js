'use strict';

/*
 * Render ingest_row.ejs and verify the Tier 2 upload progress bar: an
 * UPLOADING row with a byte total shows a crimson bar + "X / Y (Z%)";
 * rows without a total, or in any other state, fall back to the plain
 * suggested_action text.
 */

const path = require('node:path');
const ejs = require('ejs');

const PARTIAL = path.resolve(__dirname, '../../../views/dashboard/partials/ingest_row.ejs');

function base_row(over) {
    return {
        id: 1,
        package: 'D009.22.0007.0041.00001',
        batch: 'new_U358_LDT',
        sip_uuid: 'PENDING',
        pipeline_state: 'UPLOADING',
        severity: 'INFO',
        suggested_action: 'Wait — packages uploading to Archivematica SFTP.',
        created: '2026-06-18T12:29:35Z',
        actions: [],
        bytes_uploaded: 0,
        total_bytes: 0,
        ...over,
    };
}

function render(over) {
    return ejs.renderFile(PARTIAL, { dashboard_base: '/repo/dashboard', row: base_row(over) });
}

describe('ingest_row upload progress bar', () => {
    it('renders a progress bar + byte readout for an UPLOADING row with a total', async () => {
        const html = await render({ bytes_uploaded: 13_207_024_435, total_bytes: 37_580_963_840 });
        expect(html).toMatch(/class="progress"/);
        expect(html).toContain('12.3 GB'); // uploaded
        expect(html).toContain('35.0 GB'); // total
        expect(html).toContain('(35%)');
        expect(html).toMatch(/width: 35%/);
    });

    it('shows the suggested_action (no bar) when the total is unknown (0)', async () => {
        const html = await render({ bytes_uploaded: 0, total_bytes: 0 });
        expect(html).not.toMatch(/class="progress"/);
        expect(html).toContain('Wait — packages uploading');
    });

    it('shows no bar for a non-UPLOADING row even if bytes are set', async () => {
        const html = await render({
            pipeline_state: 'TRANSFER_STARTED',
            bytes_uploaded: 5,
            total_bytes: 10,
        });
        expect(html).not.toMatch(/class="progress"/);
    });

    it('renders the AIP-copy bar + heartbeat for AIP_STORE_IN_PROGRESS with totals', async () => {
        const html = await render({
            pipeline_state: 'AIP_STORE_IN_PROGRESS',
            bytes_uploaded: 21_474_836_480,   // 20 GB
            total_bytes: 70_866_960_384,      // 66 GB
            micro_service: 'PENDING',
            last_poll_at: Date.now() - 30_000,
        });
        expect(html).toMatch(/class="progress"/);
        expect(html).toContain('Copying preservation package (AIP) to cloud storage');
        expect(html).toContain('20.0 GB');
        expect(html).toContain('66.0 GB');
        expect(html).toContain('(30%)');
        expect(html).toMatch(/checked \d+s ago/);
    });

    it('falls back to suggested_action + heartbeat for AIP_STORE_IN_PROGRESS without totals', async () => {
        /*
         * No totals = the curation side predates the copy-progress
         * endpoint, or the copy hasn't streamed its first byte. The
         * heartbeat still proves liveness; no stale AM microservice
         * may leak in (Stage 6 resets it to the PENDING sentinel).
         */
        const html = await render({
            pipeline_state: 'AIP_STORE_IN_PROGRESS',
            suggested_action: 'Wait — copying AIP to Wasabi S3.',
            bytes_uploaded: 0,
            total_bytes: 0,
            micro_service: 'PENDING',
            last_poll_at: Date.now() - 45_000,
        });
        expect(html).not.toMatch(/class="progress"/);
        expect(html).toContain('copying AIP to Wasabi');
        expect(html).not.toContain('PENDING');
        expect(html).toMatch(/checked \d+s ago/);
    });

    it('shows the AM hand-off explanation for an UPLOAD_COMPLETE row', async () => {
        /*
         * While start_transfer's copy runs, the row rests at
         * UPLOAD_COMPLETE with no progress bar or heartbeat — the
         * Details column must carry the state's suggested_action so
         * a long silent window reads as normal, not stuck. The text
         * itself lives in state_metadata (persisted to the row by the
         * model); this pins the render path.
         */
        const { get_status_metadata } = require('../../../ingester/state_metadata');
        const html = await render({
            pipeline_state: 'UPLOAD_COMPLETE',
            suggested_action: get_status_metadata('UPLOAD_COMPLETE').suggested_action,
        });
        expect(html).not.toMatch(/class="progress"/);
        expect(html).toContain('handing off to Archivematica');
        expect(html).toContain('This is normal');
    });

    // Tier A + B: Archivematica step name + liveness heartbeat.
    it('shows the AM microservice + heartbeat for a TRANSFER_IN_PROGRESS row', async () => {
        const html = await render({
            pipeline_state: 'TRANSFER_IN_PROGRESS',
            micro_service: 'Scan for viruses',
            last_poll_at: Date.now() - 15_000, // 15s ago
        });
        expect(html).not.toMatch(/class="progress"/); // not a byte bar
        expect(html).toContain('Archivematica');
        expect(html).toContain('Scan for viruses');
        expect(html).toMatch(/checked \d+s ago/);
    });

    it('shows the heartbeat for INGEST_IN_PROGRESS', async () => {
        const html = await render({
            pipeline_state: 'INGEST_IN_PROGRESS',
            micro_service: 'Normalize',
            last_poll_at: Date.now() - 300_000, // 5m ago
        });
        expect(html).toContain('Normalize');
        expect(html).toMatch(/checked \d+m ago/);
    });

    it('falls back to suggested_action + heartbeat for WAITING_FOR_DURACLOUD (no microservice)', async () => {
        const html = await render({
            pipeline_state: 'WAITING_FOR_DURACLOUD',
            suggested_action: 'Wait — waiting for AIP to propagate to DuraCloud.',
            micro_service: 'PENDING', // sentinel → treated as no microservice
            last_poll_at: Date.now() - 30_000,
        });
        expect(html).toContain('propagate to DuraCloud');
        expect(html).not.toContain('PENDING');
        expect(html).toMatch(/checked \d+s ago/);
    });
});
