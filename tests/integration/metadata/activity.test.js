'use strict';

// Activity snapshot + progress computation for the admin status panel.
// Separate file from batches.test.js so the new UX-oriented assertions
// (in-flight + recent + rate/ETA) live next to each other.

const batches = require('../../../metadata/batches');
const model = require('../../../metadata/model');
const admin_controller = require('../../../metadata/admin_controller');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');

const BATCHES = tables.metadata_refresh_batches;

describe('metadata/batches — get_activity_snapshot', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('returns IN_PROGRESS rows for the batch as in_flight', async () => {
        const batch_uuid = await batches.create_batch();
        const a = await db_helper.seed_object({ uri: '/a' });
        const b = await db_helper.seed_object({ uri: '/b' });
        const c = await db_helper.seed_object({ uri: '/c' });
        await model.enqueue_chunk_for_batch({
            batch_uuid,
            rows: [
                { uuid: a.pid, uri: a.uri, update_type: 'system' },
                { uuid: b.pid, uri: b.uri, update_type: 'system' },
                { uuid: c.pid, uri: c.uri, update_type: 'system' },
            ],
            priority: 5,
        });
        // Claim 2 — those become IN_PROGRESS.
        await model.claim_pending(2);

        const snap = await batches.get_activity_snapshot(batch_uuid);
        expect(snap.in_flight).toHaveLength(2);
        expect(snap.in_flight.map((r) => r.uri).sort()).toEqual(['/a', '/b']);
        // Third row never claimed → not in flight, not in recent.
        expect(snap.recently_completed).toHaveLength(0);
    });

    it('returns terminal rows for the batch as recently_completed, newest first', async () => {
        const batch_uuid = await batches.create_batch();
        const a = await db_helper.seed_object({ uri: '/a' });
        const b = await db_helper.seed_object({ uri: '/b' });
        await model.enqueue_chunk_for_batch({
            batch_uuid,
            rows: [
                { uuid: a.pid, uri: a.uri, update_type: 'system' },
                { uuid: b.pid, uri: b.uri, update_type: 'system' },
            ],
            priority: 5,
        });
        const claimed = await model.claim_pending(2);
        // /a completes first → lower id, then /b.
        await model.mark_complete(claimed[0].id);
        await model.mark_complete(claimed[1].id);

        const snap = await batches.get_activity_snapshot(batch_uuid);
        // Newest first by id DESC → /b before /a.
        expect(snap.recently_completed.map((r) => r.uri)).toEqual(['/b', '/a']);
        expect(snap.in_flight).toHaveLength(0);
    });

    it('shows DEAD_LETTERED rows with last_error populated', async () => {
        // Force single-shot terminal so we get a clean dead-letter
        // without juggling retry state.
        const saved = process.env.METADATA_MAX_ATTEMPTS;
        process.env.METADATA_MAX_ATTEMPTS = '1';
        require('../../../config/app')._reset();
        try {
            const batch_uuid = await batches.create_batch();
            const a = await db_helper.seed_object({ uri: '/dead' });
            await model.enqueue_chunk_for_batch({
                batch_uuid,
                rows: [{ uuid: a.pid, uri: a.uri, update_type: 'system' }],
                priority: 5,
            });
            const [claimed] = await model.claim_pending(1);
            await model.mark_failed(claimed.id, 'AS 503 service unavailable');

            const snap = await batches.get_activity_snapshot(batch_uuid);
            expect(snap.recently_completed).toHaveLength(1);
            const row = snap.recently_completed[0];
            expect(row.status).toBe('DEAD_LETTERED');
            expect(row.last_error).toBe('AS 503 service unavailable');
        } finally {
            if (saved === undefined) delete process.env.METADATA_MAX_ATTEMPTS;
            else process.env.METADATA_MAX_ATTEMPTS = saved;
            require('../../../config/app')._reset();
        }
    });

    it('isolates by batch_uuid (does not bleed rows from a sibling batch)', async () => {
        const batch_a = await batches.create_batch();
        await db_queue()(BATCHES).where({ batch_uuid: batch_a }).update({ status: 'completed' });
        const obj_a = await db_helper.seed_object({ uri: '/in-a' });
        await model.enqueue_chunk_for_batch({
            batch_uuid: batch_a,
            rows: [{ uuid: obj_a.pid, uri: obj_a.uri, update_type: 'system' }],
            priority: 5,
        });
        const [c] = await model.claim_pending(1);
        await model.mark_complete(c.id);

        const batch_b = await batches.create_batch();
        const snap_b = await batches.get_activity_snapshot(batch_b);
        expect(snap_b.in_flight).toEqual([]);
        expect(snap_b.recently_completed).toEqual([]);
    });

    it('caps results at the requested limits', async () => {
        const batch_uuid = await batches.create_batch();
        const rows = [];
        for (let i = 0; i < 12; i++) {
            const o = await db_helper.seed_object({ uri: `/r/${i}` });
            rows.push({ uuid: o.pid, uri: o.uri, update_type: 'system' });
        }
        await model.enqueue_chunk_for_batch({ batch_uuid, rows, priority: 5 });
        const claimed = await model.claim_pending(12);
        for (const c of claimed) await model.mark_complete(c.id);

        const snap = await batches.get_activity_snapshot(batch_uuid, {
            in_flight_limit: 3,
            recent_limit: 5,
        });
        expect(snap.in_flight).toHaveLength(0);
        expect(snap.recently_completed).toHaveLength(5);
    });
});

describe('metadata/admin_controller — _compute_progress', () => {
    const _compute_progress = admin_controller._compute_progress;

    it('returns the safe zero shape on null/undefined input', () => {
        expect(_compute_progress(null).rate_per_min).toBe(0);
        expect(_compute_progress(undefined).percent).toBe(0);
        expect(_compute_progress({}).eta_seconds).toBe(null);
    });

    it('computes rate from succeeded+failed+dead_lettered over elapsed time', () => {
        const started = Date.now() - 60_000; // 60s ago
        const p = _compute_progress({
            started_at: new Date(started).toISOString(),
            succeeded: 6,
            failed: 0,
            dead_lettered: 0,
            total: 100,
            enqueue_complete: 1,
        });
        // 6 rows in 1 minute → 6 rows/min.
        expect(p.rate_per_min).toBeCloseTo(6, 1);
        // (100 - 6) / 6 ~= 15.67 min ~= 940s
        expect(p.eta_seconds).toBeGreaterThan(900);
        expect(p.eta_seconds).toBeLessThan(1000);
        expect(p.elapsed_seconds).toBeGreaterThanOrEqual(60);
    });

    it('eta is null until enqueue_complete (avoids a false ETA mid-enqueue)', () => {
        const p = _compute_progress({
            started_at: new Date(Date.now() - 60_000).toISOString(),
            succeeded: 10,
            failed: 0,
            dead_lettered: 0,
            total: 50, // still growing
            enqueue_complete: 0,
        });
        expect(p.eta_seconds).toBe(null);
        // percent also stays 0 until enqueue_complete.
        expect(p.percent).toBe(0);
    });

    it('eta is 0 when sum has caught up to total', () => {
        const p = _compute_progress({
            started_at: new Date(Date.now() - 60_000).toISOString(),
            succeeded: 50,
            failed: 0,
            dead_lettered: 0,
            total: 50,
            enqueue_complete: 1,
        });
        expect(p.eta_seconds).toBe(0);
        expect(p.percent).toBe(100);
    });

    it('eta is null when rate is 0 (avoids Infinity)', () => {
        const p = _compute_progress({
            started_at: new Date(Date.now() - 60_000).toISOString(),
            succeeded: 0,
            failed: 0,
            dead_lettered: 0,
            total: 100,
            enqueue_complete: 1,
        });
        expect(p.eta_seconds).toBe(null);
    });

    it('elapsed_seconds floors negative clock skew at 0', () => {
        // started_at in the future → elapsed should clamp.
        const p = _compute_progress({
            started_at: new Date(Date.now() + 60_000).toISOString(),
            succeeded: 0,
            failed: 0,
            dead_lettered: 0,
            total: 1,
            enqueue_complete: 0,
        });
        expect(p.elapsed_seconds).toBe(0);
    });
});

describe('metadata/admin_controller — _build_status (integration)', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('returns activity + progress + worker_health for an active batch', async () => {
        const batch_uuid = await batches.create_batch({ actor: 'tester' });
        const a = await db_helper.seed_object({ uri: '/r/a' });
        await model.enqueue_chunk_for_batch({
            batch_uuid,
            rows: [{ uuid: a.pid, uri: a.uri, update_type: 'system' }],
            priority: 5,
        });
        await model.claim_pending(1);

        const status = await admin_controller._build_status();
        expect(status.active.batch_uuid).toBe(batch_uuid);
        expect(status.activity.in_flight).toHaveLength(1);
        expect(status.activity.in_flight[0].uri).toBe('/r/a');
        expect(status.activity.recently_completed).toEqual([]);
        expect(status.progress).toHaveProperty('elapsed_seconds');
        expect(status.progress).toHaveProperty('rate_per_min');
        // Worker health surfaces concurrency + max_attempts so the
        // partial can render "X of Y worker slots in use" and the
        // retry budget.
        expect(status.worker_health).toMatchObject({
            enabled: true,
            concurrency: expect.any(Number),
            max_attempts: expect.any(Number),
        });
    });

    it('returns empty activity + progress shape when idle (no active batch)', async () => {
        const status = await admin_controller._build_status();
        expect(status.active).toBeUndefined();
        expect(status.activity).toEqual({ in_flight: [], recently_completed: [] });
        expect(status.progress).toEqual({
            elapsed_seconds: 0,
            rate_per_min: 0,
            eta_seconds: null,
            percent: 0,
        });
    });
});
