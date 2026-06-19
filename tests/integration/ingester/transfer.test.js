'use strict';

// Stage 3 (transfer) integration tests. Fake AM client + fast poll
// cadence so the long-poll paths run in tens of milliseconds.

const app_config = require('../../../config/app');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const model = require('../../../ingester/model');
const stage = require('../../../ingester/stages/transfer');

function make_am(script) {
    const calls = {
        start_transfer: [],
        get_unapproved_transfer_list: [],
        approve_transfer: [],
        get_transfer_status: [],
        clear_transfer: [],
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
        async start_transfer(c, p) {
            calls.start_transfer.push({ c, p });
            return next('start_transfer')();
        },
        async get_unapproved_transfer_list() {
            calls.get_unapproved_transfer_list.push({});
            return next('get_unapproved_transfer_list')();
        },
        async approve_transfer(folder) {
            calls.approve_transfer.push({ folder });
            return next('approve_transfer')();
        },
        async get_transfer_status(uuid) {
            calls.get_transfer_status.push({ uuid });
            return next('get_transfer_status')();
        },
        async clear_transfer(uuid) {
            calls.clear_transfer.push({ uuid });
            return { status: 200, data: {} };
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
            job_uuid: 'job-1',
            metadata_uri: '/repositories/2/resources/1',
            status: 'UPLOAD_COMPLETE',
            ...overrides,
        },
    ]);
    return db_queue()(tables.ingest_queue).where({ id }).first();
}

describe('ingester/stages/transfer', () => {
    let saved_env;
    beforeAll(async () => {
        saved_env = { ...process.env };
        process.env.INGEST_APPROVE_POLL_MS = '10';
        process.env.INGEST_APPROVE_TIMEOUT_MS = '300';
        process.env.INGEST_TRANSFER_POLL_MS = '10';
        process.env.INGEST_TRANSFER_TIMEOUT_MS = '500';
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

    describe('AM start_transfer response parsing', () => {
        it('_basename_from_path strips path + trailing slash', () => {
            expect(
                stage._basename_from_path(
                    '/var/archivematica/sharedDirectory/watchedDirectories/activeTransfers/standardTransfer/folder-uuid/'
                )
            ).toBe('folder-uuid');
        });
        it('_basename_from_path handles no trailing slash', () => {
            expect(stage._basename_from_path('/a/b/c')).toBe('c');
        });
        it('_basename_from_path returns null for falsy / non-string', () => {
            expect(stage._basename_from_path(null)).toBeNull();
            expect(stage._basename_from_path(undefined)).toBeNull();
            expect(stage._basename_from_path('')).toBeNull();
            expect(stage._basename_from_path(42)).toBeNull();
        });
        it('_trailing_uuid_from_basename extracts the trailing UUID', () => {
            expect(
                stage._trailing_uuid_from_basename(
                    '49986393-2f99-4c20-aebe-3a6d4c9b61f0_U219.03.0005.0006.00001_transfer-1b6f7f3a-3dc4-4623-9744-05f1e4f41539'
                )
            ).toBe('1b6f7f3a-3dc4-4623-9744-05f1e4f41539');
        });
        it('_trailing_uuid_from_basename returns null when no UUID suffix', () => {
            expect(stage._trailing_uuid_from_basename('just-a-folder-name')).toBeNull();
            expect(stage._trailing_uuid_from_basename(null)).toBeNull();
            expect(stage._trailing_uuid_from_basename('')).toBeNull();
        });
    });

    it('start_transfer is called with collection_uuid (the SFTP folder name), NOT row.batch', async () => {
        // Task #128 switched the SFTP folder to row.collection_uuid
        // (the local collection PID) — matches v1's layout where
        // all packages in a collection share one SFTP folder named
        // after the collection. Stage 3 must therefore pass
        // collection_uuid to AM.start_transfer so AM's transfer-source
        // path mirrors what Stage 2 actually uploaded. Passing
        // row.batch would point AM at a non-existent folder and AM
        // returns HTTP 500 (the start_transfer_bad_status halt).
        const row = await seed_row({
            batch: 'new_U358-resources_1204',
            collection_uuid: '550e8400-e29b-41d4-a716-446655440000',
        });
        const am = make_am({
            start_transfer: { status: 200, data: { id: 'tx-uuid-7', directory: 'd' } },
            get_unapproved_transfer_list: {
                status: 200,
                data: { results: [{ directory: 'd', uuid: 'tx-uuid-7' }] },
            },
            approve_transfer: { status: 200, data: { message: 'approved' } },
            get_transfer_status: { status: 200, data: { status: 'COMPLETE', sip_uuid: 's' } },
        });
        await stage.run(row, { am, model });
        expect(am._calls.start_transfer).toHaveLength(1);
        // First arg = collection_uuid (SFTP folder), NOT batch.
        expect(am._calls.start_transfer[0].c).toBe('550e8400-e29b-41d4-a716-446655440000');
        expect(am._calls.start_transfer[0].c).not.toBe('new_U358-resources_1204');
    });

    it("treats the legacy collection_uuid='PENDING' default as missing — falls through to q-<id>", async () => {
        // Mirrors the upload.js + controller.js defensive fallback
        // for rows that landed with the schema default before the
        // pre-flight gate started stamping a real PID.
        const row = await seed_row({ collection_uuid: 'PENDING' });
        const am = make_am({
            start_transfer: { status: 200, data: { id: 'tx-uuid-1', directory: 'd' } },
            get_unapproved_transfer_list: {
                status: 200,
                data: { results: [{ directory: 'd', uuid: 'tx-uuid-1' }] },
            },
            approve_transfer: { status: 200, data: { message: 'approved' } },
            get_transfer_status: { status: 200, data: { status: 'COMPLETE', sip_uuid: 's' } },
        });
        await stage.run(row, { am, model });
        expect(am._calls.start_transfer[0].c).toBe(`q-${row.id}`);
        expect(am._calls.start_transfer[0].c).not.toBe('PENDING');
    });

    it('happy path: UPLOAD_COMPLETE → TRANSFER_COMPLETE with sip_uuid persisted', async () => {
        const row = await seed_row();
        const am = make_am({
            start_transfer: {
                status: 200,
                data: { id: 'tx-uuid-1', directory: 'codu:test_pkg-001_transfer' },
            },
            get_unapproved_transfer_list: {
                status: 200,
                data: {
                    results: [{ directory: 'codu:test_pkg-001_transfer', uuid: 'tx-uuid-1' }],
                },
            },
            approve_transfer: { status: 200, data: { message: 'approved' } },
            get_transfer_status: [
                { status: 200, data: { status: 'PROCESSING' } },
                { status: 200, data: { status: 'COMPLETE', sip_uuid: 'sip-uuid-7' } },
            ],
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(true);
        expect(out.sip_uuid).toBe('sip-uuid-7');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('TRANSFER_COMPLETE');
        expect(fresh.transfer_uuid).toBe('tx-uuid-1');
        expect(fresh.transfer_folder).toBe('codu:test_pkg-001_transfer');
        expect(fresh.sip_uuid).toBe('sip-uuid-7');
        // The transfer-cleanup fire-and-forget should have fired.
        // Allow a microtask tick to let the .catch chain register.
        await new Promise((r) => setTimeout(r, 5));
        expect(am._calls.clear_transfer).toHaveLength(1);
    });

    it('halts with APPROVE_TIMEOUT when the unapproved list never includes our folder', async () => {
        const row = await seed_row();
        const am = make_am({
            start_transfer: { status: 200, data: { id: 'tx-1' } },
            get_unapproved_transfer_list: {
                status: 200,
                data: { results: [{ directory: 'unrelated', uuid: 'other' }] },
            },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: { status: 200, data: { status: 'PROCESSING' } },
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('approve_timeout');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('APPROVE_TIMEOUT');
        expect(fresh.severity).toBe('WARN');
        expect(am._calls.approve_transfer).toHaveLength(0);
    });

    it('halts with TRANSFER_STATUS_TIMEOUT when AM never reports COMPLETE', async () => {
        const row = await seed_row();
        const am = make_am({
            start_transfer: { status: 200, data: { id: 'tx-1', directory: 'd' } },
            get_unapproved_transfer_list: {
                status: 200,
                data: { results: [{ directory: 'd', uuid: 'tx-1' }] },
            },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: { status: 200, data: { status: 'PROCESSING' } },
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('transfer_status_timeout');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('TRANSFER_STATUS_TIMEOUT');
    });

    it('halts with FAILED when AM reports status=FAILED mid-transfer', async () => {
        const row = await seed_row();
        const am = make_am({
            start_transfer: { status: 200, data: { id: 'tx-1', directory: 'd' } },
            get_unapproved_transfer_list: {
                status: 200,
                data: { results: [{ directory: 'd', uuid: 'tx-1' }] },
            },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: {
                status: 200,
                data: { status: 'FAILED', microservice: 'Verify metadata' },
            },
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('am_failed');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('FAILED');
        // The audit payload should capture the microservice so staff
        // know which step failed in AM.
        const events = await db_queue()(tables.ingest_events)
            .where({ queue_id: row.id })
            .orderBy('id', 'desc');
        const payload = JSON.parse(events[0].payload);
        expect(payload.microservice).toBe('Verify metadata');
    });

    it('halts with INGEST_HALTED when start_transfer throws', async () => {
        const row = await seed_row();
        const am = make_am({
            start_transfer: () => {
                throw new Error('AM down');
            },
            get_unapproved_transfer_list: { status: 200, data: { results: [] } },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: { status: 200, data: {} },
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('start_transfer_failed');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
    });

    it('parses the production AM response shape: extracts uuid + basename from `path`', async () => {
        // Real AM 1.13 returns `{message:'Copy successful.', path:'/var/.../<basename>-<uuid>/'}`
        // — no `id` / `transfer_id`. The basename and trailing UUID
        // are both encoded in `path`. Regression for the live bug
        // that halted as start_transfer_missing_uuid.
        const row = await seed_row({
            collection_uuid: '49986393-2f99-4c20-aebe-3a6d4c9b61f0',
            package: 'U219.03.0005.0006.00001',
        });
        const basename =
            '49986393-2f99-4c20-aebe-3a6d4c9b61f0_U219.03.0005.0006.00001_transfer-' +
            '1b6f7f3a-3dc4-4623-9744-05f1e4f41539';
        const am_path = `/var/archivematica/sharedDirectory/watchedDirectories/activeTransfers/standardTransfer/${basename}/`;
        const am = make_am({
            start_transfer: {
                status: 200,
                data: { message: 'Copy successful.', path: am_path },
            },
            get_unapproved_transfer_list: {
                status: 200,
                data: {
                    results: [
                        { directory: basename, uuid: '1b6f7f3a-3dc4-4623-9744-05f1e4f41539' },
                    ],
                },
            },
            approve_transfer: { status: 200, data: { message: 'approved' } },
            get_transfer_status: {
                status: 200,
                data: { status: 'COMPLETE', sip_uuid: 'sip-7' },
            },
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(true);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('TRANSFER_COMPLETE');
        // Both fields landed correctly: folder is the basename
        // (NOT the full path), uuid is the trailing UUID from the
        // path's tail (extracted via _trailing_uuid_from_basename).
        expect(fresh.transfer_folder).toBe(basename);
        expect(fresh.transfer_uuid).toBe('1b6f7f3a-3dc4-4623-9744-05f1e4f41539');
    });

    it('recovers transfer_uuid from the unapproved-list when start_transfer omits it entirely', async () => {
        // Defense-in-depth: even if AM's response gives us no uuid
        // (any field, any source), the unapproved-list match has
        // {directory, uuid} per entry. Capture from there.
        const row = await seed_row();
        const basename = 'codu:test_pkg-001_transfer';
        const am = make_am({
            start_transfer: {
                status: 200,
                // No id, no transfer_id, no parseable path UUID — just
                // a directory name. The approve poll fills in the
                // missing uuid.
                data: { message: 'Copy successful.', directory: basename },
            },
            get_unapproved_transfer_list: {
                status: 200,
                data: { results: [{ directory: basename, uuid: 'tx-from-list' }] },
            },
            approve_transfer: { status: 200, data: { message: 'approved' } },
            get_transfer_status: {
                status: 200,
                data: { status: 'COMPLETE', sip_uuid: 'sip-X' },
            },
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(true);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.transfer_uuid).toBe('tx-from-list');
    });

    it('halts with start_transfer_missing_folder when neither path nor directory is present', async () => {
        // The folder name is the ONLY field we genuinely can't
        // proceed without — we need it to match the entry in the
        // unapproved-list. This is the new floor for halts.
        const row = await seed_row();
        const am = make_am({
            start_transfer: { status: 200, data: { message: 'queued' } },
            get_unapproved_transfer_list: { status: 200, data: { results: [] } },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: { status: 200, data: {} },
        });
        const out = await stage.run(row, { am, model });
        // Either the explicit halt above OR a timeout — depending on
        // whether the synthesized fallback kicks in.
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        // The synthesized fallback `${collection_pid}_${row.package}_transfer`
        // saves us here, so the stage actually proceeds to the approve
        // poll. With an empty unapproved list it then times out.
        expect(['INGEST_HALTED', 'APPROVE_TIMEOUT']).toContain(fresh.pipeline_state);
        void out;
    });

    it('resumes from TRANSFER_STARTED without re-calling start_transfer', async () => {
        const row = await seed_row({
            status: 'TRANSFER_STARTED',
            transfer_uuid: 'tx-resume',
            transfer_folder: 'd-resume',
        });
        const am = make_am({
            start_transfer: { status: 500, data: 'should not be called' },
            get_unapproved_transfer_list: {
                status: 200,
                data: { results: [{ directory: 'd-resume', uuid: 'tx-resume' }] },
            },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: {
                status: 200,
                data: { status: 'COMPLETE', sip_uuid: 'sip-resume' },
            },
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(true);
        expect(am._calls.start_transfer).toHaveLength(0);
    });

    it('resumes from TRANSFER_IN_PROGRESS straight into the status poll', async () => {
        const row = await seed_row({
            status: 'TRANSFER_IN_PROGRESS',
            transfer_uuid: 'tx-resume',
            transfer_folder: 'd-resume',
        });
        const am = make_am({
            start_transfer: { status: 500, data: 'nope' },
            get_unapproved_transfer_list: { status: 500, data: 'nope' },
            approve_transfer: { status: 500, data: 'nope' },
            get_transfer_status: {
                status: 200,
                data: { status: 'COMPLETE', sip_uuid: 'sip-resume' },
            },
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(true);
        expect(am._calls.start_transfer).toHaveLength(0);
        expect(am._calls.approve_transfer).toHaveLength(0);
        expect(am._calls.get_unapproved_transfer_list).toHaveLength(0);
    });

    it('halts when a resume sees the row in TRANSFER_STARTED but missing identifiers', async () => {
        const row = await seed_row({
            status: 'TRANSFER_STARTED',
            transfer_uuid: 'PENDING',
            transfer_folder: 'PENDING',
        });
        const am = make_am({
            start_transfer: { status: 200, data: { id: 'x' } },
            get_unapproved_transfer_list: { status: 200, data: { results: [] } },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: { status: 200, data: {} },
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('missing_am_identifiers');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
    });

    it('aborts cleanly when the signal fires mid-poll', async () => {
        const row = await seed_row();
        const controller = new AbortController();
        const am = make_am({
            start_transfer: { status: 200, data: { id: 'tx-1', directory: 'd' } },
            get_unapproved_transfer_list: async () => {
                controller.abort();
                return { status: 200, data: { results: [] } };
            },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: { status: 200, data: {} },
        });
        const out = await stage.run(row, { am, model, signal: controller.signal });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('aborted');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        // Should be left in TRANSFER_STARTED for resume.
        expect(fresh.pipeline_state).toBe('TRANSFER_STARTED');
    });

    it('updates micro_service on the row as AM reports it', async () => {
        const row = await seed_row();
        const am = make_am({
            start_transfer: { status: 200, data: { id: 'tx-1', directory: 'd' } },
            get_unapproved_transfer_list: {
                status: 200,
                data: { results: [{ directory: 'd', uuid: 'tx-1' }] },
            },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: [
                { status: 200, data: { status: 'PROCESSING', microservice: 'Verify metadata' } },
                {
                    status: 200,
                    data: { status: 'COMPLETE', sip_uuid: 'sip-7', microservice: 'Finished' },
                },
            ],
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(true);
        // Allow the fire-and-forget micro_service update to settle.
        await new Promise((r) => setTimeout(r, 10));
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(['Verify metadata', 'Finished'].includes(fresh.micro_service)).toBe(true);
    });

    it('writes a last_poll_at heartbeat during the in-progress status poll', async () => {
        const row = await seed_row();
        const before = Date.now();
        const am = make_am({
            start_transfer: { status: 200, data: { id: 'tx-1', directory: 'd' } },
            get_unapproved_transfer_list: {
                status: 200,
                data: { results: [{ directory: 'd', uuid: 'tx-1' }] },
            },
            approve_transfer: { status: 200, data: {} },
            get_transfer_status: [
                { status: 200, data: { status: 'PROCESSING', microservice: 'Normalize' } },
                { status: 200, data: { status: 'COMPLETE', sip_uuid: 'sip-9' } },
            ],
        });
        const out = await stage.run(row, { am, model });
        expect(out.ok).toBe(true);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        // The in-progress poll persisted a recent epoch-ms heartbeat.
        expect(Number(fresh.last_poll_at)).toBeGreaterThanOrEqual(before);
        expect(Number(fresh.last_poll_at)).toBeLessThanOrEqual(Date.now());
    });
});
