'use strict';

// Stage 2 (upload) integration tests. Fake QA client + fast poll
// cadence (overridden via env) so the long-poll tests run in
// hundreds of milliseconds.

const app_config = require('../../../config/app');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const model = require('../../../ingester/model');
const stage = require('../../../ingester/stages/upload');

function make_qa(script) {
    // `script` is an object mapping endpoint name → array of responses
    // (or a function returning a response). Each call shifts one off.
    const calls = {
        get_package_file_count: [],
        move_to_ingest: [],
        move_to_sftp: [],
        sftp_upload_status: [],
    };
    function next(name) {
        const entry = script[name];
        if (typeof entry === 'function') return entry;
        if (Array.isArray(entry)) {
            return () => (entry.length > 1 ? entry.shift() : entry[0]);
        }
        return () => entry;
    }
    return {
        is_configured: () => true,
        async get_package_file_count(folder, pkg) {
            calls.get_package_file_count.push({ folder, pkg });
            return next('get_package_file_count')();
        },
        async move_to_ingest(uuid, folder, pkg) {
            calls.move_to_ingest.push({ uuid, folder, pkg });
            return next('move_to_ingest')();
        },
        async move_to_sftp(uuid) {
            calls.move_to_sftp.push({ uuid });
            return next('move_to_sftp')();
        },
        async sftp_upload_status(uuid, expected) {
            calls.sftp_upload_status.push({ uuid, expected });
            return next('sftp_upload_status')();
        },
        _calls: calls,
    };
}

async function seed_row(overrides = {}) {
    const [id] = await model.queue_packages([
        {
            batch: 'batch-A',
            package: 'pkg-001',
            collection_uuid: 'codu:test',
            job_uuid: 'q-uuid-1',
            metadata_uri: '/repositories/2/resources/1',
            status: 'QA_COMPLETE',
            ...overrides,
        },
    ]);
    return db_queue()(tables.ingest_queue).where({ id }).first();
}

describe('ingester/stages/upload', () => {
    let saved_env;
    beforeAll(async () => {
        saved_env = { ...process.env };
        // Override stage 2's poll cadences so the test runs quickly.
        process.env.INGEST_UPLOAD_POLL_MS = '20';
        process.env.INGEST_UPLOAD_TIMEOUT_MS = '500';
        app_config._reset();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        process.env = saved_env;
        app_config._reset();
        await db_helper.teardown();
    });

    it('uses row.collection_uuid as the qa_uuid (the curation-API SFTP namespace, shared by collection)', async () => {
        // Matches v1's ingest_service.js:508 — the SFTP folder is
        // named after the collection PID; all packages in the same
        // collection share that folder. The pre-flight gate sets
        // collection_uuid on every row in a submit batch to the
        // same PID, so this lookup yields the shared namespace.
        const row = await seed_row({ collection_uuid: 'collection-pid-abc' });
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 1 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: { status: 200, data: { uploaded: 1 } },
        });
        await stage.run(row, { qa, model });
        expect(qa._calls.move_to_ingest[0].uuid).toBe('collection-pid-abc');
        expect(qa._calls.move_to_sftp[0].uuid).toBe('collection-pid-abc');
    });

    it("treats the legacy collection_uuid='PENDING' default as missing — falls through to q-<id>", async () => {
        // Defensive: tbl_ingest_queue.collection_uuid defaults to
        // 'PENDING' in the schema. Rows that bypass the pre-flight
        // gate may land with that placeholder. Fallback below must
        // skip it so the SFTP namespace stays per-row unique.
        const row = await seed_row({ collection_uuid: 'PENDING' });
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 1 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: { status: 200, data: { uploaded: 1 } },
        });
        await stage.run(row, { qa, model });
        expect(qa._calls.move_to_ingest[0].uuid).toBe(`q-${row.id}`);
        expect(qa._calls.move_to_ingest[0].uuid).not.toBe('PENDING');
        expect(qa._calls.move_to_sftp[0].uuid).not.toBe('PENDING');
    });

    it("advances on the curation-API's actual response shape: {message:'upload_complete', data:[...]}", async () => {
        // Regression for the live bug: pick_uploaded didn't recognize
        // the production curation-API's response shape, so the poll
        // returned null on every tick and the row sat in UPLOADING
        // until the 4h timeout. Pin both shapes here:
        //   in_progress  -> { message:'in_progress', remote_file_count: N }
        //   complete     -> { message:'upload_complete', data:[files, N] }
        const row = await seed_row();
        let n = 0;
        const responses = [
            // In progress: 0 files arrived. remote_file_count drives
            // the count comparison.
            {
                status: 200,
                data: {
                    message: 'in_progress',
                    file_names: [],
                    remote_file_count: 0,
                    local_file_count: 10,
                    remote_package_size: '0',
                },
            },
            // In progress: 5/10.
            {
                status: 200,
                data: {
                    message: 'in_progress',
                    file_names: ['a', 'b', 'c', 'd', 'e'],
                    remote_file_count: 5,
                    local_file_count: 10,
                    remote_package_size: '2.5M',
                },
            },
            // Done — curation-API's terminal shape.
            {
                status: 200,
                data: {
                    message: 'upload_complete',
                    data: [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], 10],
                },
            },
        ];
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 10 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: () => responses[Math.min(n++, responses.length - 1)],
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(true);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('UPLOAD_COMPLETE');
    });

    it('persists byte progress (bytes_uploaded / total_bytes) from check_sftp', async () => {
        // Tier 2 upload progress: the curation API's in_progress polls carry
        // remote_package_size_bytes (uploaded) + local_package_size_bytes
        // (total). The stage persists them so the dashboard can render a live
        // %. The row should end with the LAST in_progress values (the
        // terminal upload_complete shape carries no bytes, so it's ignored).
        const row = await seed_row();
        let n = 0;
        const responses = [
            {
                status: 200,
                data: {
                    message: 'in_progress',
                    remote_file_count: 1,
                    local_file_count: 2,
                    remote_package_size_bytes: 13_207_024_435,
                    local_package_size_bytes: 37_580_963_840,
                },
            },
            {
                status: 200,
                data: {
                    message: 'in_progress',
                    remote_file_count: 1,
                    local_file_count: 2,
                    remote_package_size_bytes: 26_414_048_870,
                    local_package_size_bytes: 37_580_963_840,
                },
            },
            { status: 200, data: { message: 'upload_complete', data: [['a', 'b'], 2] } },
        ];
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 2 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: () => responses[Math.min(n++, responses.length - 1)],
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(true);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        // bigInteger may surface as a string depending on the driver — coerce.
        expect(Number(fresh.bytes_uploaded)).toBe(26_414_048_870);
        expect(Number(fresh.total_bytes)).toBe(37_580_963_840);
    });

    it("advances on remote_file_count >= expected even without 'upload_complete' marker", async () => {
        // Some curation-API builds may not emit the terminal
        // 'upload_complete' marker; the count alone should be enough.
        const row = await seed_row();
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 3 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: {
                status: 200,
                data: {
                    message: 'in_progress',
                    remote_file_count: 3,
                    local_file_count: 3,
                },
            },
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(true);
    });

    it('advances QA_COMPLETE → UPLOADING → UPLOAD_COMPLETE on a normal upload', async () => {
        const row = await seed_row();
        // Tick the upload status: 0 → 5 → 10 → 10 (done at 10).
        let n = 0;
        const responses = [
            { status: 200, data: { uploaded: 0 } },
            { status: 200, data: { uploaded: 5 } },
            { status: 200, data: { uploaded: 10 } },
        ];
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 10 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: () => responses[Math.min(n++, responses.length - 1)],
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(true);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('UPLOAD_COMPLETE');
        expect(fresh.file_count).toBe(10);
        expect(qa._calls.move_to_ingest).toHaveLength(1);
        expect(qa._calls.move_to_sftp).toHaveLength(1);
        expect(qa._calls.sftp_upload_status.length).toBeGreaterThanOrEqual(1);
    });

    it('accepts QA is_complete=true as terminal success', async () => {
        const row = await seed_row();
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 3 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: { status: 200, data: { uploaded: 0, is_complete: true } },
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(true);
    });

    it('halts with UPLOAD_TIMEOUT when upload never finishes', async () => {
        const row = await seed_row();
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 100 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: { status: 200, data: { uploaded: 0 } },
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('upload_timeout');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('UPLOAD_TIMEOUT');
        expect(fresh.severity).toBe('WARN');
        // The audit payload should record the attempt count + last
        // uploaded value so staff can see how stuck the upload got.
        const events = await db_queue()(tables.ingest_events)
            .where({ queue_id: row.id })
            .orderBy('id', 'desc');
        const payload = JSON.parse(events[0].payload);
        expect(payload.last_uploaded).toBe(0);
        expect(payload.expected_count).toBe(100);
    });

    it('halts with INGEST_HALTED when get_package_file_count returns no usable count', async () => {
        const row = await seed_row();
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { errors: 'something bad' } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: { status: 200, data: { uploaded: 0 } },
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('package_file_count_failed');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
        // QA should never have been told to move the folder.
        expect(qa._calls.move_to_ingest).toHaveLength(0);
    });

    it('halts with INGEST_HALTED when move_to_ingest throws', async () => {
        const row = await seed_row();
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 5 } },
            move_to_ingest: () => {
                throw new Error('QA down');
            },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: { status: 200, data: { uploaded: 0 } },
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('qa_move_failed');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
    });

    it("halts with INGEST_HALTED when check_sftp reports upload_failed (background put died)", async () => {
        // move_to_sftp now runs the SFTP put in a background thread on the
        // curation side and returns immediately; if that put dies it drops
        // an error marker that check_sftp surfaces as `upload_failed`. The
        // poll must stop and halt the row (terminal) rather than spinning to
        // the timeout — preserving the failure surfacing the old blocking
        // move_to_sftp throw used to give us.
        const row = await seed_row();
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 5 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: { message: 'upload_started' } },
            sftp_upload_status: {
                status: 200,
                data: { message: 'upload_failed', error: 'sftp connection refused' },
            },
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('sftp_upload_failed');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
        // The poll should have bailed on the first failed status, not run
        // out the clock.
        expect(qa._calls.sftp_upload_status).toHaveLength(1);
        // The curation error text is recorded for staff.
        const events = await db_queue()(tables.ingest_events)
            .where({ queue_id: row.id })
            .orderBy('id', 'desc');
        const payload = JSON.parse(events[0].payload);
        expect(payload.reason).toBe('sftp_upload_failed');
        expect(payload.error).toMatch(/refused/);
    });

    it('aborts the poll when the signal fires and leaves the row in UPLOADING for resume', async () => {
        const row = await seed_row();
        const controller = new AbortController();
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 50 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: async () => {
                // Trigger the abort during the very first probe.
                controller.abort();
                return { status: 200, data: { uploaded: 0 } };
            },
        });
        const out = await stage.run(row, { qa, model, signal: controller.signal });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('aborted');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('UPLOADING');
    });

    it('tolerates a transient QA hiccup mid-poll and continues', async () => {
        const row = await seed_row();
        let n = 0;
        const qa = make_qa({
            get_package_file_count: { status: 200, data: { package_file_count: 2 } },
            move_to_ingest: { status: 200, data: {} },
            move_to_sftp: { status: 200, data: {} },
            sftp_upload_status: () => {
                n += 1;
                if (n === 1) return { status: 503, data: null };
                return { status: 200, data: { uploaded: 2 } };
            },
        });
        const out = await stage.run(row, { qa, model });
        expect(out.ok).toBe(true);
    });
});
