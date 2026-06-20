'use strict';

// Integration tests for ingester/stages/aip_store.js (Stage 6).
//
// Real sqlite DB + real ingester model + real aip_store model. The
// curation-API client is stubbed via the `deps.client` injection
// point; we script per-test response sequences (success, ok=false,
// 5xx, transport throw).

const aip_store_stage = require('../../../ingester/stages/aip_store');
const aip_store_model = require('../../../repository/aip_store_model');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { UpstreamError } = require('../../../libs/errors');

const QUEUE = tables.ingest_queue;

// Build a minimal queue row + matching tbl_objects row so Stage 6's
// repo-PID resolution finds the link. Returns the queue row id +
// the repo pid.
async function seed_pipeline_at_stage_6({ sip_uuid = 'aip-uuid-abc' } = {}) {
    const obj = await db_helper.seed_object({ sip_uuid });
    const [queue_id] = await db_queue()(QUEUE).insert({
        package: 'pkg.7z',
        batch: 'b',
        collection_uuid: 'c-folder',
        sip_uuid,
        status: 'AIP_STORE_PENDING',
        pipeline_state: 'AIP_STORE_PENDING',
        is_complete: 0,
    });
    return { queue_id, pid: obj.pid, sip_uuid };
}

function make_fake_client({ copy_to_wasabi } = {}) {
    return {
        is_configured: () => true,
        copy_to_wasabi: copy_to_wasabi || (async () => ({
            status: 200,
            data: {
                ok: true,
                bucket: 'library-repository',
                key: 'aip-store/pkg-abc.7z',
                bytes: 4096,
                elapsed_ms: 100,
            },
        })),
    };
}

describe('ingester/stages/aip_store — Stage 6', () => {
    let original_env;
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        original_env = { ...process.env };
        process.env.AIP_STORE_ENABLED = '1';
        require('../../../config/app')._reset();
    });
    afterEach(() => {
        process.env = original_env;
        require('../../../config/app')._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('happy path — copies the AIP and transitions to AIP_STORE_COMPLETE', async () => {
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();
        // Normalize to the field name the stage reads. Stage 6 uses
        // row.pipeline_state OR row.status (DB has them aliased on the
        // legacy schema). Pass through whichever column the row has.

        const client = make_fake_client();
        const result = await aip_store_stage.run(row, { client });

        expect(result.ok).toBe(true);
        expect(result.pid).toBe(pid);
        expect(result.key).toBe('aip-store/pkg-abc.7z');

        // tbl_aip_store row landed with the right shape.
        const stored = await aip_store_model.get_by_uuid(pid);
        expect(stored).toBeTruthy();
        expect(stored.source).toBe('ingest_v2');
        expect(stored.is_migrated).toBe(aip_store_model.STATUS.INGEST_COPIED_OK);
        expect(stored.wasabi_key).toBe('aip-store/pkg-abc.7z');
        expect(stored.bytes).toBe(4096);
        expect(stored.attempts).toBe(0);

        // Queue row reached the terminal state.
        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('AIP_STORE_COMPLETE');
        expect(after.is_complete).toBe(1);
    });

    it('skipped when AIP_STORE_ENABLED=false', async () => {
        process.env.AIP_STORE_ENABLED = '0';
        require('../../../config/app')._reset();
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();

        // Client should never be called.
        let called = false;
        const client = make_fake_client({
            copy_to_wasabi: async () => {
                called = true;
                return { status: 200, data: { ok: true } };
            },
        });

        const result = await aip_store_stage.run(row, { client });
        expect(result.skipped).toBe('aip_store_disabled');
        expect(called).toBe(false);
        // No aip_store row was created.
        const stored = await aip_store_model.get_by_uuid(pid);
        expect(stored).toBeNull();
        // Queue row drained to COMPLETE + is_complete=1 (matches the
        // pre-Stage-6 finalize semantics so the row exits the view).
        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('COMPLETE');
        expect(after.is_complete).toBe(1);
    });

    it('idempotent — short-circuits when a successful row already exists', async () => {
        const { queue_id, pid, sip_uuid } = await seed_pipeline_at_stage_6();
        // Pretend a previous Stage 6 run already copied this AIP.
        await db_helper.seed_aip_store({
            uuid: pid,
            aip: 'already.7z',
            wasabi_key: 'aip-store/already.7z',
            is_migrated: aip_store_model.STATUS.INGEST_COPIED_OK,
            source: 'ingest_v2',
            aip_uuid: sip_uuid,
        });

        let upload_called = false;
        const client = make_fake_client({
            copy_to_wasabi: async () => {
                upload_called = true;
                return { status: 200, data: { ok: true } };
            },
        });

        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();
        const result = await aip_store_stage.run(row, { client });
        expect(result.skipped).toBe('already_copied');
        expect(upload_called).toBe(false);
        // Queue row still advanced to COMPLETE — staff doesn't see it
        // stuck in pending.
        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('AIP_STORE_COMPLETE');
        expect(after.is_complete).toBe(1);
    });

    it('failure with retries left — writes failure row, queue back to PENDING with backoff', async () => {
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();

        const client = make_fake_client({
            copy_to_wasabi: async () => ({
                status: 200,
                data: { ok: false, error: 'wasabi creds expired' },
            }),
        });
        const result = await aip_store_stage.run(row, { client });
        expect(result.ok).toBe(false);
        expect(result.final_state).toBe('AIP_STORE_PENDING');
        expect(result.attempts).toBe(1);

        const stored = await aip_store_model.get_by_uuid(pid);
        expect(stored.is_migrated).toBe(aip_store_model.STATUS.INGEST_COPY_FAILED);
        expect(stored.attempts).toBe(1);
        expect(stored.error).toMatch(/creds expired/);
        expect(stored.next_attempt_at).toBeTruthy();

        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('AIP_STORE_PENDING');
        expect(after.is_complete).toBe(0);
    });

    it('failure with attempts exhausted — flips to AIP_STORE_FAILED (manual retry)', async () => {
        process.env.AIP_STORE_MAX_ATTEMPTS = '1';
        require('../../../config/app')._reset();
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();

        const client = make_fake_client({
            copy_to_wasabi: async () => ({
                status: 200,
                data: { ok: false, error: 'permanent: bucket missing' },
            }),
        });
        const result = await aip_store_stage.run(row, { client });
        expect(result.final_state).toBe('AIP_STORE_FAILED');
        expect(result.attempts).toBe(1);

        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        // is_complete stays 0 so the row stays in the default queue
        // view, surfacing the failure to staff for the dashboard
        // retry flow.
        expect(after.status).toBe('AIP_STORE_FAILED');
        expect(after.is_complete).toBe(0);

        const stored = await aip_store_model.get_by_uuid(pid);
        expect(stored.attempts).toBe(1);
        expect(stored.next_attempt_at).toBeNull();
    });

    it('transport throw — treated as retryable', async () => {
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();

        const client = {
            is_configured: () => true,
            copy_to_wasabi: async () => {
                throw new UpstreamError('curation timeout');
            },
        };
        const result = await aip_store_stage.run(row, { client });
        expect(result.ok).toBe(false);
        // First attempt, retries left → AIP_STORE_PENDING.
        expect(result.final_state).toBe('AIP_STORE_PENDING');

        const stored = await aip_store_model.get_by_uuid(pid);
        expect(stored.error).toMatch(/curation timeout/);
    });

    it('AM 404 with budget remaining — RETRIES (PENDING + backoff), not orphaned yet', async () => {
        // "Not found in AM Storage Service" is ambiguous: a large/slow AIP
        // may simply not be registered in AM yet when Stage 6 first queries.
        // So the first 404 is RETRIED, not instantly orphaned. The row stays
        // retry-eligible (INGEST_COPY_FAILED, not AM_NOT_FOUND) so the entry
        // orphan short-circuit doesn't fire on the next tick. (The instant-
        // orphan was a workaround for a since-fixed backoff-guard bug where
        // the worker raced through retries in ~20s — the guard now spaces
        // them by next_attempt_at, so retrying is safe again.)
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();

        const client = make_fake_client({
            copy_to_wasabi: async () => ({
                status: 200,
                data: {
                    ok: false,
                    error: 'AIP aip-uuid-abc not found in AM Storage Service',
                },
            }),
        });
        const result = await aip_store_stage.run(row, { client });
        expect(result.ok).toBe(false);
        expect(result.orphan).toBeUndefined();
        expect(result.final_state).toBe('AIP_STORE_PENDING');
        expect(result.attempts).toBe(1);

        const stored = await aip_store_model.get_by_uuid(pid);
        // Retry-eligible, NOT orphan — so a re-claim re-attempts the copy.
        expect(stored.is_migrated).toBe(aip_store_model.STATUS.INGEST_COPY_FAILED);
        expect(aip_store_model.is_orphan(stored)).toBe(false);
        expect(stored.message).toBe('AM_NOT_FOUND_RETRY');
        expect(stored.next_attempt_at).toBeTruthy();

        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('AIP_STORE_PENDING');
        expect(after.is_complete).toBe(0);
    });

    it('AM 404 persisting through the not-found budget — THEN orphaned', async () => {
        // Once a not-found has used up its (dedicated, generous) budget and
        // the AIP STILL isn't in AM, declare a terminal orphan — a real
        // large AIP would have landed by now. Set the budget to 1 so the
        // first 404 is the last attempt.
        process.env.AIP_STORE_NOT_FOUND_MAX_ATTEMPTS = '1';
        require('../../../config/app')._reset();
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();

        const client = make_fake_client({
            copy_to_wasabi: async () => ({
                status: 200,
                data: {
                    ok: false,
                    error: 'AIP aip-uuid-abc not found in AM Storage Service',
                },
            }),
        });
        const result = await aip_store_stage.run(row, { client });
        expect(result.ok).toBe(false);
        expect(result.orphan).toBe(true);
        expect(result.final_state).toBe('AIP_STORE_FAILED');

        const stored = await aip_store_model.get_by_uuid(pid);
        expect(stored.is_migrated).toBe(aip_store_model.STATUS.AM_NOT_FOUND);
        expect(stored.message).toBe('ORPHAN_AM_NOT_FOUND');
        expect(stored.next_attempt_at).toBeNull();

        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('AIP_STORE_FAILED');
        // Terminal give-up → is_complete=1 drops it from the default queue
        // view; it's recoverable from the AIPs page via "Re-check AM & retry"
        // if AM later registers it.
        expect(after.is_complete).toBe(1);
    });

    it('not-found retry then success — a late-registered AIP recovers on a later tick', async () => {
        // The whole point: a large AIP that wasn't in AM on the first poll
        // but IS by a later attempt should COPY successfully, not strand.
        const { queue_id, pid } = await seed_pipeline_at_stage_6();

        // Attempt 1 — not found → retry (PENDING, retry-eligible).
        let row = await db_queue()(QUEUE).where({ id: queue_id }).first();
        const not_found_client = make_fake_client({
            copy_to_wasabi: async () => ({
                status: 200,
                data: { ok: false, error: 'AIP aip-uuid-abc not found in AM Storage Service' },
            }),
        });
        await aip_store_stage.run(row, { client: not_found_client });
        const after_1 = await aip_store_model.get_by_uuid(pid);
        expect(after_1.is_migrated).toBe(aip_store_model.STATUS.INGEST_COPY_FAILED);

        // Clear the backoff so the next claim proceeds (the wait elapsing).
        await aip_store_model.upsert_by_uuid(pid, { next_attempt_at: null });

        // Attempt 2 — AM now has the AIP → success.
        row = await db_queue()(QUEUE).where({ id: queue_id }).first();
        const result = await aip_store_stage.run(row, { client: make_fake_client() });
        expect(result.ok).toBe(true);

        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('AIP_STORE_COMPLETE');
        const stored = await aip_store_model.get_by_uuid(pid);
        expect(stored.is_migrated).toBe(aip_store_model.STATUS.INGEST_COPIED_OK);
    });

    it('backoff guard — re-claim within next_attempt_at is a no-op (no curation call, no attempt burn)', async () => {
        // Regression: previously the worker re-claimed PENDING rows
        // every 5s without consulting next_attempt_at, so a row
        // with a configured 60s backoff still got hammered every
        // 5s and burned through all 5 attempts in 25s. The guard
        // at Stage 6 entry now exits early if next_attempt_at is
        // in the future.
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        // Pre-seed an aip_store row with a future next_attempt_at,
        // simulating a row that just failed and is waiting out the
        // configured backoff window.
        await db_helper.seed_aip_store({
            uuid: pid,
            aip_uuid: 'aip-uuid-abc',
            source: 'ingest_v2',
            is_migrated: aip_store_model.STATUS.INGEST_COPY_FAILED,
            attempts: 2,
            next_attempt_at: new Date(Date.now() + 60_000),
            error: 'wasabi timeout',
        });
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();

        let curation_called = false;
        const client = make_fake_client({
            copy_to_wasabi: async () => {
                curation_called = true;
                return { status: 200, data: { ok: true } };
            },
        });
        const result = await aip_store_stage.run(row, { client });

        expect(result.skipped).toBe('backoff');
        expect(curation_called).toBe(false);
        // attempts counter on aip_store row UNCHANGED (didn't burn one).
        const stored = await aip_store_model.get_by_uuid(pid);
        expect(stored.attempts).toBe(2);
        // Queue row state UNCHANGED — no event written.
        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('AIP_STORE_PENDING');
    });

    it('backoff guard — past-due next_attempt_at lets Stage 6 proceed normally', async () => {
        // Confirms the guard only fires on FUTURE next_attempt_at.
        // Past-due rows fall through to the real attempt.
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        await db_helper.seed_aip_store({
            uuid: pid,
            aip_uuid: 'aip-uuid-abc',
            source: 'ingest_v2',
            is_migrated: aip_store_model.STATUS.INGEST_COPY_FAILED,
            attempts: 1,
            next_attempt_at: new Date(Date.now() - 1000), // past
            error: 'transient timeout',
        });
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();

        const client = make_fake_client();
        const result = await aip_store_stage.run(row, { client });
        expect(result.ok).toBe(true);
        expect(result.skipped).toBeUndefined();
    });

    it('orphan short-circuit — pre-tagged AM_NOT_FOUND row dead-letters on claim without contacting curation', async () => {
        // A row that was previously tagged as an orphan (e.g. by a
        // prior Stage 6 run) shouldn't be re-attempted even if a
        // new queue row appears for the same PID. Confirms the
        // orphan-skip branch in Stage 6 entry.
        const { queue_id, pid } = await seed_pipeline_at_stage_6();
        await db_helper.seed_aip_store({
            uuid: pid,
            aip_uuid: 'aip-uuid-abc',
            source: 'ingest_v2',
            is_migrated: aip_store_model.STATUS.AM_NOT_FOUND,
            error: 'AIP aip-uuid-abc not found in AM Storage Service',
        });
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();

        let curation_called = false;
        const client = make_fake_client({
            copy_to_wasabi: async () => {
                curation_called = true;
                return { status: 200, data: { ok: true } };
            },
        });
        const result = await aip_store_stage.run(row, { client });

        expect(result.skipped).toBe('orphan');
        expect(curation_called).toBe(false);
        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('AIP_STORE_FAILED');
        expect(after.is_complete).toBe(1);
    });

    it('no sip_uuid on the queue row — skipped cleanly', async () => {
        const [queue_id] = await db_queue()(QUEUE).insert({
            package: 'pkg.7z',
            batch: 'b',
            collection_uuid: 'c-folder',
            sip_uuid: 'PENDING',
            status: 'AIP_STORE_PENDING',
            pipeline_state: 'AIP_STORE_PENDING',
            is_complete: 0,
        });
        const row = await db_queue()(QUEUE).where({ id: queue_id }).first();
        let called = false;
        const client = make_fake_client({
            copy_to_wasabi: async () => {
                called = true;
                return { status: 200, data: { ok: true } };
            },
        });
        const result = await aip_store_stage.run(row, { client });
        expect(result.skipped).toBe('no_sip_uuid');
        expect(called).toBe(false);
        const after = await db_queue()(QUEUE).where({ id: queue_id }).first();
        expect(after.status).toBe('COMPLETE');
        expect(after.is_complete).toBe(1);
    });
});
