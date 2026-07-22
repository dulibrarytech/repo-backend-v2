'use strict';

/*
 * Stage 1 (process_metadata) integration tests. Uses the real model
 * against in-memory sqlite + fake aspace + fake validator so we can
 * assert end-to-end state transitions + audit events.
 */

const stage = require('../../../ingester/stages/process_metadata');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const model = require('../../../ingester/model');

function make_aspace({ token = 'tok-1', records = {} } = {}) {
    return {
        is_configured: () => true,
        async get_session_token() {
            return token;
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

async function seed_row(overrides = {}) {
    const [id] = await model.queue_packages([
        {
            batch: 'batch-A',
            package: 'pkg-001',
            collection_uuid: 'codu:test',
            job_uuid: 'job-1',
            metadata_uri: '/repositories/2/resources/1',
            ...overrides,
        },
    ]);
    return db_queue()(tables.ingest_queue).where({ id }).first();
}

async function events_for(id) {
    return db_queue()(tables.ingest_events).where({ queue_id: id }).orderBy('id', 'asc');
}

describe('ingester/stages/process_metadata', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('advances PENDING → QA_COMPLETE on validator success', async () => {
        const row = await seed_row();
        const aspace = make_aspace({
            records: {
                '/repositories/2/resources/1': {
                    status: 200,
                    data: { title: 'A Title', uri: '/x' },
                },
            },
        });
        const out = await stage.run(row, {
            aspace,
            validator: make_validator([]),
            model,
        });
        expect(out.ok).toBe(true);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('QA_COMPLETE');
        expect(typeof fresh.metadata).toBe('string');
        expect(JSON.parse(fresh.metadata).title).toBe('A Title');
    });

    it('writes a PROCESSING_METADATA + QA_COMPLETE pair to the timeline', async () => {
        const row = await seed_row();
        const aspace = make_aspace({
            records: { '/repositories/2/resources/1': { status: 200, data: { title: 'T' } } },
        });
        await stage.run(row, { aspace, validator: make_validator([]), model });
        const events = await events_for(row.id);
        const states = events.map((e) => e.to_state);
        expect(states).toEqual(
            expect.arrayContaining(['PENDING', 'PROCESSING_METADATA', 'QA_COMPLETE'])
        );
    });

    it('halts with AS_METADATA_INVALID when the validator returns errors', async () => {
        const row = await seed_row();
        const aspace = make_aspace({
            records: {
                '/repositories/2/resources/1': { status: 200, data: { title: '' } },
            },
        });
        const out = await stage.run(row, {
            aspace,
            validator: make_validator(['Title field is missing', 'Parts is missing']),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('validation_failed');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('AS_METADATA_INVALID');
        expect(fresh.error).toContain('Title field is missing');
        /*
         * Severity should auto-populate as ERROR (set by the model
         * from state_metadata).
         */
        expect(fresh.severity).toBe('ERROR');
    });

    it('halts with INGEST_HALTED when ArchivesSpace is unreachable and no cached snapshot', async () => {
        const row = await seed_row();
        const aspace = {
            is_configured: () => true,
            async get_session_token() {
                throw new Error('ECONNREFUSED');
            },
            async get_record() {
                return { status: 500, data: null };
            },
            async destroy_session_token() {},
        };
        const out = await stage.run(row, {
            aspace,
            validator: make_validator([]),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('aspace_unreachable');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
    });

    it('falls back to the cached metadata snapshot when AS is down', async () => {
        const cached = {
            title: 'Cached',
            uri: '/x',
            identifiers: ['1'],
            notes: [],
            parts: [{ type: 'image/tiff' }],
        };
        const row = await seed_row({ metadata: JSON.stringify(cached) });
        const aspace = {
            is_configured: () => true,
            async get_session_token() {
                throw new Error('boom');
            },
            async get_record() {
                return { status: 500 };
            },
            async destroy_session_token() {},
        };
        const out = await stage.run(row, {
            aspace,
            validator: make_validator([]),
            model,
        });
        expect(out.ok).toBe(true);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('QA_COMPLETE');
    });

    it('halts with INGEST_HALTED when the row has no metadata_uri', async () => {
        const row = await seed_row({ metadata_uri: '' });
        const aspace = make_aspace();
        const out = await stage.run(row, {
            aspace,
            validator: make_validator([]),
            model,
        });
        expect(out.ok).toBe(false);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
    });

    it('distinguishes a 404 in the audit payload', async () => {
        const row = await seed_row({ metadata_uri: '/repositories/2/resources/missing' });
        const aspace = make_aspace({ records: {} });
        await stage.run(row, { aspace, validator: make_validator([]), model });
        const events = await events_for(row.id);
        const last = events[events.length - 1];
        const payload = JSON.parse(last.payload);
        expect(payload.reason).toBe('aspace_unreachable');
        expect(payload.error).toContain('not found');
    });
});
