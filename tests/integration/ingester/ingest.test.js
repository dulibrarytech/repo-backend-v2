'use strict';

/*
 * Stage 4 (ingest + DC wait) integration tests. Fake AM + ASpace +
 * validator + DuraCloud clients.
 */

const app_config = require('../../../config/app');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const model = require('../../../ingester/model');
const stage = require('../../../ingester/stages/ingest');

function make_am(script) {
    const calls = { get_ingest_status: [], get_dip_path: [], clear_ingest: [] };
    function next(name) {
        const entry = script[name];
        if (typeof entry === 'function') return entry;
        if (Array.isArray(entry)) {
            return () => (entry.length > 1 ? entry.shift() : entry[0]);
        }
        return () => entry;
    }
    return {
        async get_ingest_status(uuid) {
            calls.get_ingest_status.push({ uuid });
            return next('get_ingest_status')();
        },
        async get_dip_path(uuid) {
            calls.get_dip_path.push({ uuid });
            return next('get_dip_path')();
        },
        async clear_ingest(uuid) {
            calls.clear_ingest.push({ uuid });
            return { status: 200, data: {} };
        },
        _calls: calls,
    };
}

/*
 * Accepts a flat URI → response map (matches the call shape used
 * throughout these tests).
 */
function make_aspace(records = {}) {
    return {
        async get_session_token() {
            return 'tok';
        },
        async get_record(uri) {
            if (uri in records) return records[uri];
            return { status: 404, data: null };
        },
        async destroy_session_token() {},
    };
}

function make_validator(errors = []) {
    return { validate_record: () => errors };
}

function make_duracloud(script) {
    const calls = { fetch_text: [] };
    function next() {
        const entry = script.fetch_text;
        if (typeof entry === 'function') return entry;
        if (Array.isArray(entry)) return () => (entry.length > 1 ? entry.shift() : entry[0]);
        return () => entry;
    }
    return {
        mets_path: (sip, dip) => `${dip}/METS.${sip}.xml`,
        async fetch_text(path) {
            calls.fetch_text.push({ path });
            return next()();
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
            status: 'TRANSFER_COMPLETE',
            sip_uuid: 'sip-7',
            ...overrides,
        },
    ]);
    return db_queue()(tables.ingest_queue).where({ id }).first();
}

describe('ingester/stages/ingest', () => {
    let saved_env;
    beforeAll(async () => {
        saved_env = { ...process.env };
        process.env.INGEST_INGEST_POLL_MS = '10';
        process.env.INGEST_INGEST_TIMEOUT_MS = '300';
        process.env.INGEST_DURACLOUD_POLL_MS = '10';
        process.env.INGEST_DURACLOUD_TIMEOUT_MS = '300';
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

    it('halts immediately when the row has no sip_uuid', async () => {
        const row = await seed_row({ sip_uuid: 'PENDING' });
        const am = make_am({ get_ingest_status: { status: 500, data: {} } });
        const out = await stage.run(row, {
            am,
            aspace: make_aspace(),
            validator: make_validator(),
            duracloud: make_duracloud({ fetch_text: { status: 404 } }),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('missing_sip_uuid');
        expect(am._calls.get_ingest_status).toHaveLength(0);
    });

    it('happy path: TRANSFER_COMPLETE → INGEST_COMPLETE → WAITING_FOR_DURACLOUD → METADATA_PROCESSED', async () => {
        const row = await seed_row();
        const am = make_am({
            get_ingest_status: [
                { status: 200, data: { status: 'PROCESSING' } },
                { status: 200, data: { status: 'COMPLETE' } },
            ],
            get_dip_path: {
                status: 200,
                data: { related_packages: [], current_path: 'x.7z' },
                dip_path: 'aabb/ccdd/folder-A',
            },
        });
        const aspace = make_aspace({
            '/repositories/2/resources/1': { status: 200, data: { title: 'OK' } },
        });
        const validator = make_validator([]);
        const duracloud = make_duracloud({
            fetch_text: [
                { status: 404, data: null },
                { status: 200, data: '<METS></METS>' },
            ],
        });
        const out = await stage.run(row, { am, aspace, validator, duracloud, model });
        expect(out.ok).toBe(true);
        expect(out.dip_path).toBe('aabb/ccdd/folder-A');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('METADATA_PROCESSED');
        expect(fresh.dip_path).toBe('aabb/ccdd/folder-A');
        // The DC probe should have hit METS path conventionally.
        expect(duracloud._calls.fetch_text[0].path).toContain('METS.sip-7.xml');
    });

    it('halts with INGEST_STATUS_TIMEOUT when AM never reports COMPLETE', async () => {
        const row = await seed_row();
        const am = make_am({
            get_ingest_status: { status: 200, data: { status: 'PROCESSING' } },
            get_dip_path: { dip_path: 'x', status: 200, data: {} },
        });
        const out = await stage.run(row, {
            am,
            aspace: make_aspace(),
            validator: make_validator(),
            duracloud: make_duracloud({ fetch_text: { status: 404 } }),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('ingest_status_timeout');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_STATUS_TIMEOUT');
    });

    it('halts with FAILED when AM reports status=FAILED mid-ingest', async () => {
        const row = await seed_row();
        const am = make_am({
            get_ingest_status: { status: 200, data: { status: 'FAILED', microservice: 'Bag it' } },
            get_dip_path: { dip_path: 'x', status: 200, data: {} },
        });
        const out = await stage.run(row, {
            am,
            aspace: make_aspace(),
            validator: make_validator(),
            duracloud: make_duracloud({ fetch_text: { status: 404 } }),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('am_failed');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('FAILED');
    });

    it('halts with AS_METADATA_DRIFT when re-validation finds new errors', async () => {
        const row = await seed_row();
        const am = make_am({
            get_ingest_status: { status: 200, data: { status: 'COMPLETE' } },
            get_dip_path: { dip_path: 'x', status: 200, data: {} },
        });
        const aspace = make_aspace({
            '/repositories/2/resources/1': { status: 200, data: { title: '' } },
        });
        const validator = make_validator(['Title field is missing']);
        const out = await stage.run(row, {
            am,
            aspace,
            validator,
            duracloud: make_duracloud({ fetch_text: { status: 200, data: '<m/>' } }),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('as_metadata_drift');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('AS_METADATA_DRIFT');
        expect(fresh.error).toContain('Title field is missing');
    });

    it('halts with AS_METADATA_DRIFT when AS becomes unreachable post-ingest', async () => {
        const row = await seed_row();
        const am = make_am({
            get_ingest_status: { status: 200, data: { status: 'COMPLETE' } },
            get_dip_path: { dip_path: 'x', status: 200, data: {} },
        });
        // No matching record → 404 path.
        const aspace = make_aspace({});
        const out = await stage.run(row, {
            am,
            aspace,
            validator: make_validator([]),
            duracloud: make_duracloud({ fetch_text: { status: 200, data: '<m/>' } }),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('as_metadata_drift');
    });

    it('halts with INGEST_HALTED when get_dip_path returns no path', async () => {
        const row = await seed_row();
        const am = make_am({
            get_ingest_status: { status: 200, data: { status: 'COMPLETE' } },
            get_dip_path: { status: 200, data: { related_packages: [] }, dip_path: null },
        });
        const out = await stage.run(row, {
            am,
            aspace: make_aspace({
                '/repositories/2/resources/1': { status: 200, data: { title: 'OK' } },
            }),
            validator: make_validator([]),
            duracloud: make_duracloud({ fetch_text: { status: 404 } }),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('no_dip_path');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
    });

    it('halts with DURACLOUD_TIMEOUT when METS never appears', async () => {
        const row = await seed_row();
        const am = make_am({
            get_ingest_status: { status: 200, data: { status: 'COMPLETE' } },
            get_dip_path: { dip_path: 'aabb/ccdd/folder', status: 200, data: {} },
        });
        const out = await stage.run(row, {
            am,
            aspace: make_aspace({
                '/repositories/2/resources/1': { status: 200, data: { title: 'OK' } },
            }),
            validator: make_validator([]),
            duracloud: make_duracloud({ fetch_text: { status: 404 } }),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('duracloud_timeout');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('DURACLOUD_TIMEOUT');
    });

    it('resumes from INGEST_COMPLETE directly into drift + DC probe', async () => {
        const row = await seed_row({ status: 'INGEST_COMPLETE' });
        const am = make_am({
            get_ingest_status: { status: 500, data: 'should not be called' },
            get_dip_path: { dip_path: 'x', status: 200, data: {} },
        });
        const out = await stage.run(row, {
            am,
            aspace: make_aspace({
                '/repositories/2/resources/1': { status: 200, data: { title: 'OK' } },
            }),
            validator: make_validator([]),
            duracloud: make_duracloud({ fetch_text: { status: 200, data: '<m/>' } }),
            model,
        });
        expect(out.ok).toBe(true);
        expect(am._calls.get_ingest_status).toHaveLength(0);
    });

    it('resumes from WAITING_FOR_DURACLOUD straight into the DC probe', async () => {
        const row = await seed_row({
            status: 'WAITING_FOR_DURACLOUD',
            dip_path: 'aabb/ccdd/folder',
        });
        const am = make_am({
            get_ingest_status: { status: 500, data: 'nope' },
            get_dip_path: { status: 500, data: 'nope' },
        });
        const out = await stage.run(row, {
            am,
            aspace: make_aspace(),
            validator: make_validator([]),
            duracloud: make_duracloud({ fetch_text: { status: 200, data: '<m/>' } }),
            model,
        });
        expect(out.ok).toBe(true);
        expect(am._calls.get_ingest_status).toHaveLength(0);
        expect(am._calls.get_dip_path).toHaveLength(0);
    });

    it('aborts cleanly when the signal fires during the ingest poll', async () => {
        const row = await seed_row();
        const controller = new AbortController();
        const am = make_am({
            get_ingest_status: async () => {
                controller.abort();
                return { status: 200, data: { status: 'PROCESSING' } };
            },
            get_dip_path: { dip_path: 'x', status: 200, data: {} },
        });
        const out = await stage.run(row, {
            am,
            aspace: make_aspace(),
            validator: make_validator([]),
            duracloud: make_duracloud({ fetch_text: { status: 404 } }),
            model,
            signal: controller.signal,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('aborted');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        // Left in INGEST_IN_PROGRESS for resume.
        expect(fresh.pipeline_state).toBe('INGEST_IN_PROGRESS');
    });
});
