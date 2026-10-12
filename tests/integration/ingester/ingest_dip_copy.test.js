'use strict';

/*
 * Stage 4 with DIP_COPY_ENABLED (DuraCloud Preserve): wait for the DIP
 * link, for the DIP package to be UPLOADED, and for curation to report the
 * DIP complete, then copy it. Fake Archivematica, ASpace and curation; the
 * DuraCloud client must never be called. Every halt is DURACLOUD_TIMEOUT.
 */

const app_config = require('../../../config/app');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const model = require('../../../ingester/model');
const stage = require('../../../ingester/stages/ingest');
const { available_actions } = require('../../../ingester/state_metadata');
const { UpstreamError } = require('../../../libs/errors');

const SIP = '2259082c-f0b1-407f-880c-73ef9f9ea200';
const DIP_UUID = '0000f75f-3cf8-4b3d-b494-e0ec20172508';
const DIP_PATH = '0000/f75f/3cf8/4b3d/b494/e0ec/2017/2508/pkg_U158.03.0157.00096';
const SIZE = 500;

const COPIED = {
    status: 200,
    data: {
        ok: true,
        status: 'copied',
        files: { total: 4, copied: 4, skipped: 0, failed: 0 },
        bytes: { total: 300, copied: 300 },
        verified: { md5: 3, parts: 1, size: 0 },
    },
};
const INCOMPLETE = {
    status: 200,
    data: {
        ok: false,
        status: 'incomplete',
        dcp_bytes: 100,
        expected_bytes: SIZE,
        mets: true,
        error: `DCP holds 100 of ${SIZE} bytes`,
    },
};
const LINKED = { status: 200, data: {}, dip_path: DIP_PATH, dip_uuid: DIP_UUID };
const UPLOADED = {
    status: 200,
    data: {},
    package_type: 'DIP',
    package_status: 'UPLOADED',
    size: SIZE,
    current_path: DIP_PATH,
};

/*
 * A scripted answer: an array is consumed in order and its last entry
 * repeats; an Error is thrown; a function is called.
 */
function scripted(entries) {
    const queue = Array.isArray(entries) ? [...entries] : [entries];
    return async () => {
        const entry = queue.length > 1 ? queue.shift() : queue[0];
        if (entry instanceof Error) throw entry;
        return typeof entry === 'function' ? entry() : entry;
    };
}

function make_am({ get_dip_path = LINKED, get_dip_package = UPLOADED } = {}) {
    const calls = { get_dip_path: [], get_dip_package: [] };
    const dip_path = scripted(get_dip_path);
    const dip_package = scripted(get_dip_package);
    return {
        async get_ingest_status() {
            return { status: 200, data: { status: 'COMPLETE' } };
        },
        async get_dip_path(uuid) {
            calls.get_dip_path.push(uuid);
            return dip_path();
        },
        async get_dip_package(uuid) {
            calls.get_dip_package.push(uuid);
            return dip_package();
        },
        async clear_ingest() {
            return { status: 200, data: {} };
        },
        _calls: calls,
    };
}

function make_curation(answers = COPIED, { configured = true } = {}) {
    const calls = [];
    const answer = scripted(answers);
    return {
        is_configured: () => configured,
        async copy_dip(sip_uuid, dip_path, expected_size, opts) {
            calls.push({ sip_uuid, dip_path, expected_size, opts });
            return answer();
        },
        _calls: calls,
    };
}

const UNUSED_DURACLOUD = {
    mets_path() {
        throw new Error('the DuraCloud wait ran with DIP_COPY_ENABLED on');
    },
    async fetch_text() {
        throw new Error('the DuraCloud wait ran with DIP_COPY_ENABLED on');
    },
};

const ASPACE = {
    async get_session_token() {
        return 'tok';
    },
    async get_record() {
        return { status: 200, data: { title: 'OK' } };
    },
    async destroy_session_token() {},
};

async function seed_row(overrides = {}) {
    const [id] = await model.queue_packages([
        {
            batch: 'batch-A',
            package: 'pkg-001',
            collection_uuid: 'codu:test',
            job_uuid: 'job-1',
            metadata_uri: '/repositories/2/resources/1',
            status: 'INGEST_COMPLETE',
            sip_uuid: SIP,
            ...overrides,
        },
    ]);
    return db_queue()(tables.ingest_queue).where({ id }).first();
}

function run(
    row,
    {
        am = make_am(),
        curation = make_curation(),
        dip_store_configured = true,
        model: model_in = model,
        signal,
    } = {}
) {
    return stage.run(row, {
        am,
        aspace: ASPACE,
        validator: { validate_record: () => [] },
        duracloud: UNUSED_DURACLOUD,
        curation,
        dip_store: { is_configured: () => dip_store_configured },
        model: model_in,
        signal,
    });
}

async function fresh(row) {
    return db_queue()(tables.ingest_queue).where({ id: row.id }).first();
}

async function last_event(row) {
    const event = await db_queue()(tables.ingest_events)
        .where({ queue_id: row.id })
        .orderBy('id', 'desc')
        .first();
    return { ...event, payload: JSON.parse(event.payload) };
}

describe('ingester/stages/ingest with DIP_COPY_ENABLED', () => {
    let saved_env;
    beforeAll(async () => {
        saved_env = { ...process.env };
        process.env.INGEST_INGEST_POLL_MS = '10';
        process.env.INGEST_INGEST_TIMEOUT_MS = '300';
        process.env.INGEST_DURACLOUD_POLL_MS = '10';
        process.env.INGEST_DURACLOUD_TIMEOUT_MS = '300';
        process.env.DIP_COPY_ENABLED = 'true';
        process.env.DIP_COPY_TIMEOUT_MS = '5000';
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

    it('waits for the link, UPLOADED and a complete DIP, then copies it', async () => {
        const row = await seed_row({ status: 'TRANSFER_COMPLETE' });
        const am = make_am({
            get_dip_path: [{ status: 200, data: { related_packages: [] }, dip_path: null }, LINKED],
            get_dip_package: [
                { status: 200, data: {}, package_status: 'STAGING', size: SIZE },
                UPLOADED,
            ],
        });
        const curation = make_curation([INCOMPLETE, { status: 503, data: null }, COPIED]);
        const out = await run(row, { am, curation });

        expect(out).toEqual({ ok: true, sip_uuid: SIP, dip_path: DIP_PATH });
        const row_now = await fresh(row);
        expect(row_now.pipeline_state).toBe('METADATA_PROCESSED');
        expect(row_now.dip_path).toBe(DIP_PATH);
        expect(am._calls.get_dip_path).toHaveLength(2);
        expect(am._calls.get_dip_package.every((uuid) => uuid === DIP_UUID)).toBe(true);
        expect(curation._calls).toHaveLength(3);
        expect(curation._calls[0]).toEqual({
            sip_uuid: SIP,
            dip_path: DIP_PATH,
            expected_size: SIZE,
            opts: expect.objectContaining({ timeout_ms: 5000 }),
        });
        expect(curation._calls[0].opts.timeout_ms).toBe(5000);

        const event = await last_event(row);
        expect(event.to_state).toBe('METADATA_PROCESSED');
        expect(event.payload).toMatchObject({
            stage: 'ingest',
            step: 'dip_copied',
            dip_uuid: DIP_UUID,
            dip_path: DIP_PATH,
            files: COPIED.data.files,
            bytes: COPIED.data.bytes,
            dip_current_path: DIP_PATH,
        });
    });

    it('resumes from WAITING_FOR_DURACLOUD by asking for the DIP link once, then copies', async () => {
        const row = await seed_row({ status: 'WAITING_FOR_DURACLOUD', dip_path: DIP_PATH });
        const am = make_am();
        const out = await run(row, { am });
        expect(out.ok).toBe(true);
        expect(am._calls.get_dip_path).toEqual([SIP]);
        expect(am._calls.get_dip_package).toEqual([DIP_UUID]);
        expect((await fresh(row)).dip_path).toBe(DIP_PATH);
        const events = await db_queue()(tables.ingest_events).where({ queue_id: row.id });
        expect(events.map((e) => JSON.parse(e.payload).step)).not.toContain('dip_wait_started');
    });

    it('halts at once when the related package is not a DIP', async () => {
        const row = await seed_row();
        const curation = make_curation();
        const am = make_am({ get_dip_package: { ...UPLOADED, package_type: 'AIC' } });
        const out = await run(row, { am, curation });
        expect(out.reason).toBe('not_a_dip');
        const row_now = await fresh(row);
        expect(row_now.pipeline_state).toBe('DURACLOUD_TIMEOUT');
        expect(row_now.error).toContain('is not a DIP (package type AIC)');
        expect(am._calls.get_dip_package).toHaveLength(1);
        expect(curation._calls).toHaveLength(0);
    });

    it('retries a transport error from the copy, with a heartbeat', async () => {
        const row = await seed_row();
        expect(row.last_poll_at).toBeNull();
        const curation = make_curation([
            new UpstreamError('curation /dip/copy-to-wasabi failed: ECONNRESET'),
            COPIED,
        ]);
        const out = await run(row, { curation });
        expect(out.ok).toBe(true);
        expect(curation._calls).toHaveLength(2);
        expect((await fresh(row)).last_poll_at).not.toBeNull();
    });

    it('waits through a 429 from curation', async () => {
        const row = await seed_row();
        const curation = make_curation([{ status: 429, data: 'slow down' }, COPIED]);
        const out = await run(row, { curation });
        expect(out.ok).toBe(true);
        expect(curation._calls).toHaveLength(2);
    });

    it('retries a dip_path write that fails, and stores the path before finishing', async () => {
        const row = await seed_row();
        let failed = false;
        const flaky = {
            ...model,
            async update_queue(where, data, opts) {
                if (data.dip_path !== undefined && !failed) {
                    failed = true;
                    const err = new Error('Deadlock found when trying to get lock');
                    err.code = 'ER_LOCK_DEADLOCK';
                    throw err;
                }
                return model.update_queue(where, data, opts);
            },
        };
        const am = make_am();
        const out = await run(row, { am, model: flaky });
        expect(out.ok).toBe(true);
        expect(failed).toBe(true);
        expect(am._calls.get_dip_path).toHaveLength(2);
        expect((await fresh(row)).dip_path).toBe(DIP_PATH);
    });

    it('an error that is not a transport error halts at once instead of being retried', async () => {
        const row = await seed_row();
        const curation = make_curation();
        const am = make_am({ get_dip_package: () => null });
        const out = await run(row, { am, curation });
        expect(out.reason).toBe('unexpected_error');
        expect(am._calls.get_dip_package).toHaveLength(1);
        expect(curation._calls).toHaveLength(0);
        const row_now = await fresh(row);
        expect(row_now.pipeline_state).toBe('DURACLOUD_TIMEOUT');
        expect(row_now.error).toMatch(/^The access-copy wait failed: /);
        expect(row_now.dip_path).toBe(DIP_PATH);
        expect((await last_event(row)).payload.reason).toBe('unexpected_error');
    });

    it('a staff Stop during the copy leaves the row waiting, with no halt written', async () => {
        const row = await seed_row();
        const controller = new AbortController();
        const curation = {
            is_configured: () => true,
            copy_dip(sip_uuid, dip_path, expected_size, { signal }) {
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () =>
                        reject(new UpstreamError('curation /dip/copy-to-wasabi failed: canceled'))
                    );
                    setTimeout(() => controller.abort(), 20);
                });
            },
        };
        const out = await run(row, { curation, signal: controller.signal });
        expect(out).toEqual({ ok: false, reason: 'aborted' });
        const row_now = await fresh(row);
        expect(row_now.pipeline_state).toBe('WAITING_FOR_DURACLOUD');
        expect(row_now.error).toBeNull();
        expect((await last_event(row)).payload.step).toBe('dip_wait_started');
    });

    it('a failed copy halts at DURACLOUD_TIMEOUT, whose kebab offers Retry', async () => {
        const row = await seed_row();
        const curation = make_curation({
            status: 200,
            data: {
                ok: false,
                status: 'failed',
                error: '1 of 4 files failed; first: x/objects/a.pdf: md5 mismatch',
                failures: [{ key: 'x/objects/a.pdf', error: 'md5 mismatch' }],
            },
        });
        const out = await run(row, { curation });
        expect(out).toEqual({ ok: false, reason: 'dip_copy_failed' });
        const row_now = await fresh(row);
        expect(row_now.pipeline_state).toBe('DURACLOUD_TIMEOUT');
        expect(row_now.error).toContain('1 of 4 files failed');
        const event = await last_event(row);
        expect(event.payload).toMatchObject({ step: 'dip_copy', reason: 'dip_copy_failed' });
        expect(event.payload.failures).toHaveLength(1);
        expect(available_actions(row_now.pipeline_state)).toEqual([
            'timeline',
            'retry_access_copy',
            'rollback_archivematica',
        ]);
    });

    it('a DELETED, DEL_REQ, DEL_FAIL or FAIL DIP halts at DURACLOUD_TIMEOUT at once, without a copy', async () => {
        const expected = {
            DELETED: 'dip_deleted',
            DEL_REQ: 'dip_deletion_requested',
            DEL_FAIL: 'dip_deletion_failed',
            FAIL: 'dip_failed',
        };
        for (const [status, reason] of Object.entries(expected)) {
            const row = await seed_row({ package: `pkg-${status}` });
            const curation = make_curation();
            const am = make_am({
                get_dip_package: { status: 200, data: {}, package_status: status, size: SIZE },
            });
            const out = await run(row, { am, curation });
            expect(out.reason).toBe(reason);
            const row_now = await fresh(row);
            expect(row_now.pipeline_state).toBe('DURACLOUD_TIMEOUT');
            expect(row_now.error).toBe(`Archivematica reports the DIP as ${status}`);
            expect(am._calls.get_dip_package).toHaveLength(1);
            expect(curation._calls).toHaveLength(0);
        }
    });

    it("halts at once when the DIP record's folder is not the one worked out from the AIP's name", async () => {
        const row = await seed_row();
        const curation = make_curation();
        const am = make_am({
            get_dip_package: {
                ...UPLOADED,
                current_path: '/dip-store/0000/f75f/3cf8/4b3d/b494/e0ec/2017/2508/pkg_other',
            },
        });
        const out = await run(row, { am, curation });
        expect(out.reason).toBe('dip_path_mismatch');
        const row_now = await fresh(row);
        expect(row_now.pipeline_state).toBe('DURACLOUD_TIMEOUT');
        expect(row_now.error).toContain('(pkg_other)');
        expect(row_now.error).toContain('(pkg_U158.03.0157.00096)');
        expect(curation._calls).toHaveLength(0);

        // A record path with a location prefix, a trailing slash or a .7z suffix still matches.
        for (const current_path of [`/dip-store/${DIP_PATH}/`, `${DIP_PATH}.7z`, null]) {
            const ok_row = await seed_row({ package: `pkg-${String(current_path).length}` });
            const ok_curation = make_curation();
            const out_ok = await run(ok_row, {
                am: make_am({ get_dip_package: { ...UPLOADED, current_path } }),
                curation: ok_curation,
            });
            expect(out_ok.ok).toBe(true);
            expect(ok_curation._calls).toHaveLength(1);
        }
    });

    it('a request curation refuses (4xx) halts at once', async () => {
        const row = await seed_row();
        const curation = make_curation({
            status: 400,
            data: { ok: false, error: 'dip_path must be ...' },
        });
        const out = await run(row, { curation });
        expect(out.reason).toBe('dip_copy_rejected');
        expect((await fresh(row)).error).toContain('HTTP 400');
        expect(curation._calls).toHaveLength(1);
    });

    it("names curation's answer when it refuses the copy with its auth failure", async () => {
        const row = await seed_row();
        const out = await run(row, {
            curation: make_curation({ status: 403, data: ['Access denied.'] }),
        });
        expect(out.reason).toBe('dip_copy_rejected');
        expect((await fresh(row)).error).toBe(
            'The curation API refused the copy (HTTP 403): Access denied.'
        );
    });

    it('a 200 without a JSON object body halts as a failed copy', async () => {
        const row = await seed_row();
        const out = await run(row, { curation: make_curation({ status: 200, data: '<html>' }) });
        expect(out.reason).toBe('dip_copy_failed');
        expect((await fresh(row)).error).toBe('The DIP copy failed');
    });

    it('a DIP still incomplete on the second check halts at once, with the counts', async () => {
        /*
         * The package is UPLOADED, so the folder in DCP is final: a second
         * shortfall is a wrong path or size, not a slow upload.
         */
        const row = await seed_row();
        const curation = make_curation(INCOMPLETE);
        const out = await run(row, { curation });
        expect(out.reason).toBe('dip_incomplete');
        expect(curation._calls).toHaveLength(2);
        const row_now = await fresh(row);
        expect(row_now.pipeline_state).toBe('DURACLOUD_TIMEOUT');
        expect(row_now.dip_path).toBe(DIP_PATH);
        expect(row_now.error).toBe(
            `Archivematica reports the DIP as stored, but DCP holds 100 of ${SIZE} bytes`
        );
        const event = await last_event(row);
        expect(event.payload).toMatchObject({
            step: 'dip_copy',
            reason: 'dip_incomplete',
            dcp_bytes: 100,
            expected_bytes: SIZE,
            mets: true,
        });
    });

    it('never copies before the DIP package is UPLOADED', async () => {
        const row = await seed_row();
        const curation = make_curation();
        const am = make_am({
            get_dip_package: { status: 200, data: {}, package_status: 'STAGING', size: SIZE },
        });
        const out = await run(row, { am, curation });
        expect(out.reason).toBe('duracloud_timeout');
        expect(curation._calls).toHaveLength(0);
        const event = await last_event(row);
        expect(event.payload).toMatchObject({
            reason: 'dip_not_uploaded',
            package_status: 'STAGING',
        });
        expect((await fresh(row)).error).toContain('reports the DIP as STAGING, not UPLOADED');
    });

    it('never copies a DIP whose package reports no size', async () => {
        const row = await seed_row();
        const curation = make_curation();
        const am = make_am({
            get_dip_package: { status: 200, data: {}, package_status: 'UPLOADED', size: null },
        });
        const out = await run(row, { am, curation });
        expect(out.reason).toBe('duracloud_timeout');
        expect((await last_event(row)).payload.reason).toBe('dip_size_missing');
        expect(curation._calls).toHaveLength(0);
    });

    it('keeps waiting while the AIP has no DIP link (the old wait halted at once)', async () => {
        const row = await seed_row();
        const am = make_am({
            get_dip_path: { status: 200, data: { related_packages: [] }, dip_path: null },
        });
        const out = await run(row, { am });
        expect(out.reason).toBe('duracloud_timeout');
        expect(am._calls.get_dip_path.length).toBeGreaterThan(1);
        expect((await last_event(row)).payload.reason).toBe('dip_not_linked');
    });

    it('halts at once, naming the setting, when the copy is not configured', async () => {
        const row = await seed_row();
        const am = make_am();
        const out = await run(row, { am, curation: make_curation(COPIED, { configured: false }) });
        expect(out.reason).toBe('dip_copy_not_configured');
        const row_now = await fresh(row);
        expect(row_now.pipeline_state).toBe('DURACLOUD_TIMEOUT');
        expect(row_now.error).toContain(
            'the curation API (CURATION_API, CURATION_API_KEY) is not configured'
        );
        expect(am._calls.get_dip_path).toHaveLength(0);
    });
});
