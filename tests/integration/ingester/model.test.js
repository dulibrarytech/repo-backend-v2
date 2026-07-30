'use strict';

/*
 * Integration tests for ingester/model.js. Real sqlite-in-memory pool,
 * real migrations, exercising:
 * 
 *   - queue_packages: bulk insert + initial state_change event
 *   - update_queue: status→pipeline_state mirror; severity +
 *     suggested_action auto-population; event row written only when
 *     pipeline_state changes; explicit overrides honored; `updated`
 *     bumped; opts.event_type, opts.actor, opts.payload threaded through
 *   - get_queue_row / list_queue: simple reads and filters
 *   - get_timeline: returns events in insertion order with parsed payloads
 *   - reset_orphaned: ACTIVELY_RUNNING_STATES → PENDING; WAIT states
 *     and terminal states untouched
 *   - _purge_batch: wipes queue + event rows together
 */

const model = require('../../../ingester/model');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { ValidationError } = require('../../../libs/errors');

const QUEUE = tables.ingest_queue;
const EVENTS = tables.ingest_events;

function row_template(overrides = {}) {
    /*
     * tbl_ingest_queue has many notNullable-with-default columns; the
     * model only requires the few that callers actually set. Provide
     * a minimal happy-path template plus whatever the test wants.
     */
    return {
        batch: 'batch-A',
        package: 'pkg-001',
        collection_uuid: 'codu:test',
        job_uuid: 'job-1',
        metadata_uri: '/repositories/2/resources/1',
        ...overrides,
    };
}

describe('ingester/model — queue_packages', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('rejects an empty or non-array input', async () => {
        await expect(model.queue_packages([])).rejects.toBeInstanceOf(ValidationError);
        await expect(model.queue_packages(null)).rejects.toBeInstanceOf(ValidationError);
    });

    it('inserts one row per entry and returns ids in input order', async () => {
        const ids = await model.queue_packages([
            row_template({ package: 'pkg-001' }),
            row_template({ package: 'pkg-002' }),
            row_template({ package: 'pkg-003' }),
        ]);
        expect(ids).toHaveLength(3);
        ids.forEach((id) => expect(typeof id).toBe('number'));
        const rows = await db_queue()(QUEUE).select('id', 'package').orderBy('id', 'asc');
        expect(rows.map((r) => r.package)).toEqual(['pkg-001', 'pkg-002', 'pkg-003']);
        expect(rows.map((r) => r.id)).toEqual(ids);
    });

    it('defaults status/pipeline_state to PENDING with INFO severity', async () => {
        const [id] = await model.queue_packages([row_template()]);
        const row = await db_queue()(QUEUE).where({ id }).first();
        expect(row.status).toBe('PENDING');
        expect(row.pipeline_state).toBe('PENDING');
        expect(row.severity).toBe('INFO');
        expect(row.suggested_action).toBeNull();
    });

    it('honors an explicit status and mirrors it into pipeline_state', async () => {
        const [id] = await model.queue_packages([row_template({ status: 'STARTING' })]);
        const row = await db_queue()(QUEUE).where({ id }).first();
        expect(row.status).toBe('STARTING');
        expect(row.pipeline_state).toBe('STARTING');
        expect(row.severity).toBe('INFO');
    });

    it('writes one "state_change" event per inserted row', async () => {
        const ids = await model.queue_packages(
            [row_template({ package: 'pkg-001' }), row_template({ package: 'pkg-002' })],
            { actor: 'unit-test' }
        );
        const events = await db_queue()(EVENTS).orderBy('id', 'asc');
        expect(events).toHaveLength(2);
        expect(events.map((e) => e.queue_id).sort()).toEqual([...ids].sort());
        for (const ev of events) {
            expect(ev.from_state).toBeNull();
            expect(ev.to_state).toBe('PENDING');
            expect(ev.event_type).toBe('state_change');
            expect(ev.actor).toBe('unit-test');
            expect(typeof ev.payload).toBe('string');
            const parsed = JSON.parse(ev.payload);
            expect(parsed.note).toBe('row created');
            expect(parsed.batch).toBe('batch-A');
        }
    });

    it('defaults the event actor to "system"', async () => {
        await model.queue_packages([row_template()]);
        const ev = await db_queue()(EVENTS).first();
        expect(ev.actor).toBe('system');
    });
});

describe('ingester/model — update_queue', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('validates inputs', async () => {
        await expect(model.update_queue(null, { status: 'X' })).rejects.toBeInstanceOf(
            ValidationError
        );
        await expect(model.update_queue({ id: 1 }, null)).rejects.toBeInstanceOf(ValidationError);
    });

    it('returns affected=0 when no rows match', async () => {
        const result = await model.update_queue({ id: 999999 }, { status: 'STARTING' });
        expect(result).toEqual({ affected: 0, ids: [] });
        // No event log spam for no-op updates.
        const events = await db_queue()(EVENTS);
        expect(events).toHaveLength(0);
    });

    it("retries once on MariaDB 'Record has changed since last read' error", async () => {
        /*
         * Regression for the live production halt: Stage 3's
         * fire-and-forget micro_service update could be in-flight
         * when the final TRANSFER_COMPLETE write fired, and MariaDB
         * would throw "Record has changed since last read in table".
         * update_queue now does a one-shot retry on this specific
         * error message — Stage 3 has also been fixed to await its
         * micro_service writes, but the retry stays as defense-in-
         * depth.
         */
        const [id] = await model.queue_packages([row_template()]);
        const knex = db_queue();
        const original = knex.transaction.bind(knex);
        let throws_left = 1;
        const spy = vi.spyOn(knex, 'transaction').mockImplementation((cb) => {
            if (throws_left > 0) {
                throws_left -= 1;
                return Promise.reject(
                    new Error("Record has changed since last read in table 'tbl_ingest_queue'")
                );
            }
            return original(cb);
        });
        try {
            const r = await model.update_queue({ id }, { status: 'STARTING' });
            expect(r.affected).toBe(1);
            // Exactly 2 calls: 1 failed, 1 retry succeeded.
            expect(spy).toHaveBeenCalledTimes(2);
            const row = await db_queue()(QUEUE).where({ id }).first();
            expect(row.pipeline_state).toBe('STARTING');
        } finally {
            spy.mockRestore();
        }
    });

    it('does NOT retry on unrelated errors', async () => {
        /*
         * Defense-against-overreach: only the specific MariaDB
         * optimistic-concurrency message triggers a retry. Other
         * errors propagate immediately so callers see the real
         * failure rather than a phantom double-execution.
         */
        const [id] = await model.queue_packages([row_template()]);
        const knex = db_queue();
        const spy = vi
            .spyOn(knex, 'transaction')
            .mockImplementation(() => Promise.reject(new Error('some other DB error')));
        try {
            await expect(model.update_queue({ id }, { status: 'STARTING' })).rejects.toThrow(
                'some other DB error'
            );
            // Exactly 1 attempt — no retry on unrelated errors.
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
    });

    it('mirrors status → pipeline_state on update', async () => {
        const [id] = await model.queue_packages([row_template()]);
        await model.update_queue({ id }, { status: 'STARTING' });
        const row = await db_queue()(QUEUE).where({ id }).first();
        expect(row.status).toBe('STARTING');
        expect(row.pipeline_state).toBe('STARTING');
    });

    it('auto-populates severity + suggested_action from state_metadata', async () => {
        const [id] = await model.queue_packages([row_template()]);
        await model.update_queue({ id }, { status: 'FAILED' });
        const row = await db_queue()(QUEUE).where({ id }).first();
        expect(row.severity).toBe('ERROR');
        expect(row.suggested_action).toMatch(/roll\s?back/i);
    });

    it('lets the caller override severity and suggested_action explicitly', async () => {
        const [id] = await model.queue_packages([row_template()]);
        await model.update_queue(
            { id },
            {
                status: 'FAILED',
                severity: 'FATAL',
                suggested_action: 'Page IT immediately.',
            }
        );
        const row = await db_queue()(QUEUE).where({ id }).first();
        expect(row.severity).toBe('FATAL');
        expect(row.suggested_action).toBe('Page IT immediately.');
    });

    it('writes an event row when pipeline_state changes', async () => {
        const [id] = await model.queue_packages([row_template()]);
        // Drop the creation event so the assertion targets the update.
        await db_queue()(EVENTS).del();
        await model.update_queue(
            { id },
            { status: 'STARTING' },
            { actor: 'worker', payload: { stage: 'boot' } }
        );
        const events = await db_queue()(EVENTS).where({ queue_id: id }).orderBy('id', 'asc');
        expect(events).toHaveLength(1);
        const ev = events[0];
        expect(ev.from_state).toBe('PENDING');
        expect(ev.to_state).toBe('STARTING');
        expect(ev.event_type).toBe('state_change');
        expect(ev.actor).toBe('worker');
        expect(JSON.parse(ev.payload)).toEqual({ stage: 'boot' });
    });

    it('does NOT write an event when pipeline_state is the same', async () => {
        const [id] = await model.queue_packages([row_template({ status: 'STARTING' })]);
        await db_queue()(EVENTS).del();
        // Same state, just patching a different column.
        await model.update_queue({ id }, { status: 'STARTING', error: null });
        const events = await db_queue()(EVENTS).where({ queue_id: id });
        expect(events).toHaveLength(0);
    });

    it('does NOT write an event when no status/pipeline_state in the patch', async () => {
        const [id] = await model.queue_packages([row_template()]);
        await db_queue()(EVENTS).del();
        await model.update_queue({ id }, { error: 'something happened' });
        const events = await db_queue()(EVENTS).where({ queue_id: id });
        expect(events).toHaveLength(0);
    });

    it('respects opts.event_type', async () => {
        const [id] = await model.queue_packages([row_template()]);
        await db_queue()(EVENTS).del();
        await model.update_queue(
            { id },
            { status: 'ROLLED_BACK_TO_READY' },
            { actor: 'staff:du123', event_type: 'staff_action' }
        );
        const ev = await db_queue()(EVENTS).where({ queue_id: id }).first();
        expect(ev.event_type).toBe('staff_action');
        expect(ev.actor).toBe('staff:du123');
    });

    it('writes one event per affected row for batch updates', async () => {
        const ids = await model.queue_packages([
            row_template({ package: 'pkg-001' }),
            row_template({ package: 'pkg-002' }),
            row_template({ package: 'pkg-003' }),
        ]);
        await db_queue()(EVENTS).del();
        const result = await model.update_queue(
            { batch: 'batch-A' },
            { status: 'STARTING' },
            { actor: 'worker' }
        );
        expect(result.affected).toBe(3);
        expect(result.ids.sort()).toEqual([...ids].sort());
        const events = await db_queue()(EVENTS).orderBy('queue_id', 'asc');
        expect(events).toHaveLength(3);
        for (const ev of events) {
            expect(ev.from_state).toBe('PENDING');
            expect(ev.to_state).toBe('STARTING');
        }
    });

    it('skips event rows for ones whose state did not actually change', async () => {
        /*
         * Row A is PENDING, row B is STARTING. A batch update to
         * STARTING transitions A but is a no-op for B; only A should
         * get an event row.
         */
        const [a_id, b_id] = await model.queue_packages([
            row_template({ package: 'pkg-A', status: 'PENDING' }),
            row_template({ package: 'pkg-B', status: 'STARTING' }),
        ]);
        await db_queue()(EVENTS).del();
        await model.update_queue({ batch: 'batch-A' }, { status: 'STARTING' });
        const events = await db_queue()(EVENTS);
        expect(events).toHaveLength(1);
        expect(events[0].queue_id).toBe(a_id);
        // Sanity: B's row IS up-to-date in the queue table.
        const b_row = await db_queue()(QUEUE).where({ id: b_id }).first();
        expect(b_row.pipeline_state).toBe('STARTING');
    });

    it('bumps the `updated` timestamp on write', async () => {
        const [id] = await model.queue_packages([row_template()]);
        const before = await db_queue()(QUEUE).where({ id }).first();
        const before_ts = new Date(before.updated).getTime();
        // Sleep a hair so sqlite's second-resolution timestamp moves.
        await new Promise((r) => setTimeout(r, 1100));
        await model.update_queue({ id }, { status: 'STARTING' });
        const after = await db_queue()(QUEUE).where({ id }).first();
        const after_ts = new Date(after.updated).getTime();
        expect(after_ts).toBeGreaterThan(before_ts);
    });

    it('lets the caller override pipeline_state directly (status not required)', async () => {
        /*
         * Belt-and-braces: callers using only pipeline_state still get
         * event-log + severity behavior.
         */
        const [id] = await model.queue_packages([row_template()]);
        await db_queue()(EVENTS).del();
        await model.update_queue({ id }, { pipeline_state: 'STARTING' });
        const row = await db_queue()(QUEUE).where({ id }).first();
        expect(row.pipeline_state).toBe('STARTING');
        // status is NOT clobbered when only pipeline_state is given.
        expect(row.status).toBe('PENDING');
        const ev = await db_queue()(EVENTS).where({ queue_id: id }).first();
        expect(ev.to_state).toBe('STARTING');
    });
});

describe('ingester/model — insert_event', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('appends a timeline event without touching the queue row', async () => {
        const [id] = await model.queue_packages([row_template()]);
        const before = await db_queue()(QUEUE).where({ id }).first();
        await model.insert_event(id, {
            event_type: 'info',
            actor: 'worker',
            to_state: 'PENDING',
            payload: { step: 'marker' },
        });
        const after = await db_queue()(QUEUE).where({ id }).first();
        expect(after.pipeline_state).toBe(before.pipeline_state);
        expect(String(after.updated)).toBe(String(before.updated));
        const events = await db_queue()(EVENTS).where({ queue_id: id, event_type: 'info' });
        expect(events).toHaveLength(1);
        expect(events[0].from_state).toBeNull();
        expect(events[0].to_state).toBe('PENDING');
        expect(events[0].actor).toBe('worker');
        expect(JSON.parse(events[0].payload)).toEqual({ step: 'marker' });
    });

    it('requires queue_id and to_state', async () => {
        await expect(model.insert_event(null, { to_state: 'X' })).rejects.toBeInstanceOf(
            ValidationError
        );
        await expect(model.insert_event(1, {})).rejects.toBeInstanceOf(ValidationError);
    });
});

describe('ingester/model — get_queue_row / list_queue', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('get_queue_row fetches by id', async () => {
        const [id] = await model.queue_packages([row_template()]);
        const row = await model.get_queue_row({ id });
        expect(row.id).toBe(id);
        expect(row.package).toBe('pkg-001');
    });

    it('get_queue_row fetches by (batch, package)', async () => {
        await model.queue_packages([row_template({ package: 'alpha' })]);
        const row = await model.get_queue_row({ batch: 'batch-A', package: 'alpha' });
        expect(row.package).toBe('alpha');
    });

    it('get_queue_row returns undefined when nothing matches', async () => {
        const row = await model.get_queue_row({ id: 999999 });
        expect(row).toBeUndefined();
    });

    it('list_queue returns rows newest first', async () => {
        await model.queue_packages([
            row_template({ package: 'a' }),
            row_template({ package: 'b' }),
            row_template({ package: 'c' }),
        ]);
        const rows = await model.list_queue();
        expect(rows.map((r) => r.package)).toEqual(['c', 'b', 'a']);
    });

    it('list_queue applies status / batch / is_complete filters', async () => {
        await model.queue_packages([
            row_template({ batch: 'batch-A', package: 'a1', status: 'PENDING' }),
            row_template({ batch: 'batch-A', package: 'a2', status: 'COMPLETE' }),
            row_template({ batch: 'batch-B', package: 'b1', status: 'PENDING' }),
        ]);
        // Flip a2 to is_complete=1 to exercise the boolean filter.
        await db_queue()(QUEUE).where({ package: 'a2' }).update({ is_complete: 1 });

        const by_batch = await model.list_queue({ batch: 'batch-A' });
        expect(by_batch.map((r) => r.package).sort()).toEqual(['a1', 'a2']);

        const by_status = await model.list_queue({ status: 'PENDING' });
        expect(by_status.map((r) => r.package).sort()).toEqual(['a1', 'b1']);

        const completed = await model.list_queue({ is_complete: true });
        expect(completed.map((r) => r.package)).toEqual(['a2']);

        const not_completed = await model.list_queue({ is_complete: false });
        expect(not_completed.map((r) => r.package).sort()).toEqual(['a1', 'b1']);
    });

    it('list_queue paginates via limit + offset', async () => {
        await model.queue_packages([
            row_template({ package: 'p1' }),
            row_template({ package: 'p2' }),
            row_template({ package: 'p3' }),
        ]);
        const page1 = await model.list_queue({}, { limit: 2, offset: 0 });
        const page2 = await model.list_queue({}, { limit: 2, offset: 2 });
        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(1);
    });
});

describe('ingester/model — get_timeline', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('returns events in insertion (id) order with parsed JSON payloads', async () => {
        const [id] = await model.queue_packages([row_template()], { actor: 'creator' });
        await model.update_queue(
            { id },
            { status: 'STARTING' },
            { actor: 'worker', payload: { note: 'first transition' } }
        );
        await model.update_queue(
            { id },
            { status: 'UPLOADING' },
            { actor: 'worker', payload: { note: 'second transition' } }
        );
        const timeline = await model.get_timeline(id);
        expect(timeline).toHaveLength(3);
        expect(timeline.map((e) => e.to_state)).toEqual(['PENDING', 'STARTING', 'UPLOADING']);
        expect(timeline[0].payload.note).toBe('row created');
        expect(timeline[1].payload.note).toBe('first transition');
        expect(timeline[2].payload.note).toBe('second transition');
        // from_state on the very first event should be null.
        expect(timeline[0].from_state).toBeNull();
        expect(timeline[1].from_state).toBe('PENDING');
        expect(timeline[2].from_state).toBe('STARTING');
    });

    it('returns the raw string when payload is not JSON', async () => {
        const [id] = await model.queue_packages([row_template()]);
        await db_queue()(EVENTS).insert({
            queue_id: id,
            from_state: 'STARTING',
            to_state: 'FAILED',
            event_type: 'state_change',
            actor: 'worker',
            payload: 'plain string, not JSON',
        });
        const timeline = await model.get_timeline(id);
        const last = timeline[timeline.length - 1];
        expect(last.payload).toBe('plain string, not JSON');
    });

    it('handles null payloads', async () => {
        const [id] = await model.queue_packages([row_template()]);
        await db_queue()(EVENTS).insert({
            queue_id: id,
            from_state: 'PENDING',
            to_state: 'STARTING',
            event_type: 'state_change',
            actor: 'worker',
            payload: null,
        });
        const timeline = await model.get_timeline(id);
        const last = timeline[timeline.length - 1];
        expect(last.payload).toBeNull();
    });

    it('returns an empty array for an unknown queue_id', async () => {
        const timeline = await model.get_timeline(999999);
        expect(timeline).toEqual([]);
    });
});

describe('ingester/model — reset_orphaned', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('returns affected=0 when nothing is orphaned', async () => {
        await model.queue_packages([row_template()]);
        const result = await model.reset_orphaned();
        expect(result.affected).toBe(0);
    });

    it('moves every ACTIVELY_RUNNING state back to PENDING', async () => {
        // Seed one row per actively-running state.
        const states = [...model.ACTIVELY_RUNNING_STATES];
        await model.queue_packages(
            states.map((s, i) => row_template({ package: `pkg-${i}`, status: s }))
        );
        const result = await model.reset_orphaned({ actor: 'boot' });
        expect(result.affected).toBe(states.length);
        const rows = await db_queue()(QUEUE).select('package', 'pipeline_state');
        for (const row of rows) {
            expect(row.pipeline_state).toBe('PENDING');
        }
    });

    it('does NOT touch WAIT states (external systems)', async () => {
        await model.queue_packages([
            row_template({ package: 'wait-1', status: 'WAITING_FOR_DURACLOUD' }),
            row_template({ package: 'wait-2', status: 'TRANSFER_IN_PROGRESS' }),
        ]);
        const result = await model.reset_orphaned();
        expect(result.affected).toBe(0);
        const rows = await db_queue()(QUEUE).select('package', 'pipeline_state');
        const by_pkg = Object.fromEntries(rows.map((r) => [r.package, r.pipeline_state]));
        expect(by_pkg['wait-1']).toBe('WAITING_FOR_DURACLOUD');
        expect(by_pkg['wait-2']).toBe('TRANSFER_IN_PROGRESS');
    });

    it('does NOT touch completed rows even if their state is in the running set', async () => {
        /*
         * Edge case: a row that finished its stage cleanly but landed
         * on a state name overlapping with the running set is_complete=1
         * already, so it must stay out.
         */
        const [id] = await model.queue_packages([
            row_template({ package: 'done', status: 'STARTING' }),
        ]);
        await db_queue()(QUEUE).where({ id }).update({ is_complete: 1 });
        const result = await model.reset_orphaned();
        expect(result.affected).toBe(0);
        const row = await db_queue()(QUEUE).where({ id }).first();
        expect(row.pipeline_state).toBe('STARTING');
    });

    it('writes an orphan_reset event with the original state in the payload', async () => {
        await model.queue_packages([row_template({ status: 'UPLOADING' })]);
        await db_queue()(EVENTS).del();
        const result = await model.reset_orphaned({ actor: 'boot' });
        expect(result.affected).toBe(1);
        const ev = await db_queue()(EVENTS).first();
        expect(ev.event_type).toBe('orphan_reset');
        expect(ev.actor).toBe('boot');
        expect(ev.from_state).toBe('UPLOADING');
        expect(ev.to_state).toBe('PENDING');
        expect(JSON.parse(ev.payload)).toEqual({ from: 'UPLOADING' });
    });
});

describe('ingester/model — cancel / get_prev_state_for_cancel', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('throws NotFound when the id does not exist', async () => {
        await expect(model.cancel(9999, { actor: 'tester' })).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('flips the row to CANCELLED_BY_USER and records the prior state', async () => {
        const [id] = await model.queue_packages([
            row_template({ package: 'p1', status: 'UPLOADING' }),
        ]);
        const r = await model.cancel(id, { actor: 'tester', reason: 'oops' });
        expect(r).toEqual({ ok: true, affected: 1, prev_state: 'UPLOADING' });
        const fresh = await db_queue()(QUEUE).where({ id }).first();
        expect(fresh.pipeline_state).toBe('CANCELLED_BY_USER');
        expect(fresh.error).toBe('oops');

        // The audit event captures prior state for action lookup.
        const prev = await model.get_prev_state_for_cancel(id);
        expect(prev).toBe('UPLOADING');
    });

    it('refuses to flip a row that is already terminal', async () => {
        const [id] = await model.queue_packages([
            row_template({ package: 'p1', status: 'COMPLETE' }),
        ]);
        const r = await model.cancel(id, { actor: 'tester' });
        expect(r).toEqual({
            ok: false,
            reason: 'already_terminal',
            current_state: 'COMPLETE',
        });
        // The row is unchanged.
        const fresh = await db_queue()(QUEUE).where({ id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
    });

    it('refuses to flip a row that is already CANCELLED_BY_USER (idempotent)', async () => {
        const [id] = await model.queue_packages([
            row_template({ package: 'p1', status: 'UPLOADING' }),
        ]);
        await model.cancel(id, { actor: 'tester' });
        const r = await model.cancel(id, { actor: 'tester' });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('already_terminal');
        expect(r.current_state).toBe('CANCELLED_BY_USER');
    });

    it('writes a staff_action event with action=cancel and from=prior_state', async () => {
        const [id] = await model.queue_packages([
            row_template({ package: 'p1', status: 'TRANSFER_IN_PROGRESS' }),
        ]);
        await model.cancel(id, { actor: 'jdoe', reason: 'pipeline stuck' });
        const events = await model.get_timeline(id);
        const cancel_event = events.find(
            (e) => e.event_type === 'staff_action' && e.to_state === 'CANCELLED_BY_USER'
        );
        expect(cancel_event).toBeTruthy();
        expect(cancel_event.actor).toBe('jdoe');
        expect(cancel_event.payload).toMatchObject({
            action: 'cancel',
            from: 'TRANSFER_IN_PROGRESS',
            reason: 'pipeline stuck',
        });
    });

    it('get_prev_state_for_cancel returns null when no cancel event exists', async () => {
        const [id] = await model.queue_packages([row_template({ package: 'p1' })]);
        const prev = await model.get_prev_state_for_cancel(id);
        expect(prev).toBeNull();
    });
});

describe('ingester/model — _purge_batch', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('returns zeros when the batch does not exist', async () => {
        const r = await model._purge_batch('nope');
        expect(r).toEqual({ queue: 0, events: 0 });
    });

    it('deletes queue rows and their events together', async () => {
        await model.queue_packages([
            row_template({ batch: 'batch-A', package: 'a1' }),
            row_template({ batch: 'batch-A', package: 'a2' }),
            row_template({ batch: 'batch-B', package: 'b1' }),
        ]);
        const r = await model._purge_batch('batch-A');
        expect(r.queue).toBe(2);
        expect(r.events).toBeGreaterThanOrEqual(2); // at least 1 creation event per row

        const remaining_queue = await db_queue()(QUEUE);
        expect(remaining_queue.map((row) => row.batch)).toEqual(['batch-B']);
        const remaining_events = await db_queue()(EVENTS);
        // Only the surviving row's events remain.
        const surviving_queue_id = remaining_queue[0].id;
        for (const e of remaining_events) {
            expect(e.queue_id).toBe(surviving_queue_id);
        }
    });
});
