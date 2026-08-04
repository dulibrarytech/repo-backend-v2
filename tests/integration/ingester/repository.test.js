'use strict';

// Stage 5 (repository build) integration tests.

const { randomUUID } = require('node:crypto');

const db_helper = require('../../helpers/db');
const { db, db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const model = require('../../../ingester/model');
const stage = require('../../../ingester/stages/repository');
const repository_model = require('../../../repository/model');

function make_duracloud({ mets_xml = null, status = 200 } = {}) {
    const calls = [];
    return {
        mets_path: (sip, dip) => `${dip}/METS.${sip}.xml`,
        async fetch_text(path) {
            calls.push({ path });
            if (mets_xml === null) return { status, data: null };
            return { status: 200, data: mets_xml };
        },
        _calls: calls,
    };
}

function make_handles({ configured = true, throws = false, status = 201 } = {}) {
    const calls = [];
    return {
        is_configured: () => configured,
        async create_handle(uuid) {
            calls.push({ uuid });
            if (throws) throw new Error('handle service down');
            if (status === 201) {
                return { status, handle: `https://hdl.example/${uuid}` };
            }
            return { status, handle: null };
        },
        _calls: calls,
    };
}

function make_qa({
    configured = true,
    throws = false,
    status = 200,
    move_to_ingested_result = { status: 200, data: { result: 'packages_moved_to_ingested_folder', errors: [] } },
    move_to_ingested_throws = false,
} = {}) {
    const calls = { cleanup_sftp: [], move_to_ingested: [] };
    return {
        is_configured: () => configured,
        async cleanup_sftp(uuid, archival_package) {
            calls.cleanup_sftp.push({ uuid, archival_package });
            if (throws) throw new Error('sftp host down');
            return { status, data: 'collection folder removed' };
        },
        async move_to_ingested(uuid, folder) {
            calls.move_to_ingested.push({ uuid, folder });
            if (move_to_ingested_throws) throw new Error('curation host down');
            return move_to_ingested_result;
        },
        _calls: calls,
    };
}

// Tiny METS XML — one amdSec (RDF mime) + one fileSec with one file.
function happy_mets() {
    return `<?xml version="1.0"?>
<mets:mets xmlns:mets="http://www.loc.gov/METS/"
           xmlns:premis="info:lc/xmlns/premis-v2"
           xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns:File="https://example.com/file-ns"
           xmlns:xlink="http://www.w3.org/1999/xlink">
  <mets:amdSec>
    <mets:techMD><mets:mdWrap><mets:xmlData>
      <premis:object><premis:objectCharacteristics>
        <premis:objectCharacteristicsExtension>
          <rdf:RDF><rdf:Description>
            <File:MIMEType>image/tiff</File:MIMEType>
          </rdf:Description></rdf:RDF>
        </premis:objectCharacteristicsExtension>
      </premis:objectCharacteristics></premis:object>
    </mets:xmlData></mets:mdWrap></mets:techMD>
  </mets:amdSec>
  <mets:fileSec><mets:fileGrp>
    <mets:file ID="file-aaa-111">
      <mets:FLocat xlink:href="objects/thing.tif" />
    </mets:file>
  </mets:fileGrp></mets:fileSec>
</mets:mets>`;
}

async function seed_row(overrides = {}) {
    const sip = overrides.sip_uuid || randomUUID();
    const [id] = await model.queue_packages([
        {
            batch: 'batch-A',
            package: 'pkg-001',
            collection_uuid: 'codu:parent',
            job_uuid: 'job-1',
            metadata_uri: '/repositories/2/resources/1',
            status: 'METADATA_PROCESSED',
            sip_uuid: sip,
            dip_path: 'aabb/folder-A',
            metadata: JSON.stringify({
                title: 'A Title',
                notes: [
                    { type: 'abstract', content: 'an abstract' },
                    { type: 'userestrict', content: 'restrictions' },
                ],
                parts: [{ type: 'image/tiff' }],
            }),
            ...overrides,
        },
    ]);
    return db_queue()(tables.ingest_queue).where({ id }).first();
}

describe('ingester/stages/repository', () => {
    let saved_env;
    beforeAll(async () => {
        saved_env = { ...process.env };
        /*
         * Stage 5's post-success "Ingest Complete" hold is staff UX
         * (4s in prod); tests want it as close to zero as possible
         * so the suite doesn't pay the wall-clock cost per case.
         */
        process.env.INGEST_COMPLETE_HOLD_MS = '1';
        const app_config = require('../../../config/app');
        app_config._reset();
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        process.env = saved_env;
        const app_config = require('../../../config/app');
        app_config._reset();
        await db_helper.teardown();
    });

    it('happy path: METADATA_PROCESSED → COMPLETE with tbl_objects row + handle', async () => {
        const row = await seed_row();
        const duracloud = make_duracloud({ mets_xml: happy_mets() });
        const handles = make_handles();
        const out = await stage.run(row, { duracloud, handles, model });
        expect(out.ok).toBe(true);
        expect(out.pid).toBe(row.sip_uuid);
        expect(out.handle).toBe(`https://hdl.example/${row.sip_uuid}`);
        expect(out.parts_count).toBe(1);

        // Queue row should be COMPLETE + is_complete=1.
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
        expect(fresh.is_complete).toBe(1);
        expect(fresh.handle).toBe(`https://hdl.example/${row.sip_uuid}`);

        // tbl_objects row should exist with the expected shape.
        const obj = await db()(tables.objects).where({ pid: row.sip_uuid }).first();
        expect(obj).toBeTruthy();
        expect(obj.is_member_of_collection).toBe('codu:parent');
        expect(obj.object_type).toBe('object');
        expect(obj.handle).toBe(`https://hdl.example/${row.sip_uuid}`);
        expect(obj.thumbnail).toBe('aabb/folder-A/thumbnails/aaa-111.jpg');
        // file_name = the master's FULL uuid-prefixed dip-store path (v1 convention).
        expect(obj.file_name).toBe('aabb/folder-A/objects/aaa-111-thing.tif');
        expect(obj.is_updated).toBe(1);
        expect(obj.is_indexed).toBe(0);
        expect(obj.is_published).toBe(0);
    });

    it('writes a CREATING_REPOSITORY_RECORD audit event before the build', async () => {
        const row = await seed_row();
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(true);
        const events = await db_queue()(tables.ingest_events)
            .where({ queue_id: row.id })
            .orderBy('id', 'asc');
        const states = events.map((e) => e.to_state);
        expect(states).toEqual(expect.arrayContaining(['CREATING_REPOSITORY_RECORD', 'COMPLETE']));
    });

    it('finalize: COMPLETE writes the Ingest Complete suggested_action and emits only one COMPLETE event', async () => {
        /*
         * Two-phase finalize (status=COMPLETE+is_complete=0 then a
         * bare is_complete=1 update) must NOT produce a duplicate
         * COMPLETE event, and the suggested_action must come from
         * state_metadata so the dashboard renders the message.
         */
        const row = await seed_row();
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(true);

        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
        expect(fresh.is_complete).toBe(1);
        expect(fresh.suggested_action).toBe('Ingest Complete');

        const complete_events = await db_queue()(tables.ingest_events)
            .where({ queue_id: row.id, to_state: 'COMPLETE' });
        expect(complete_events).toHaveLength(1);
    });

    it('sftp cleanup: calls cleanup_sftp(collection_uuid, package) before COMPLETE flip and records outcome', async () => {
        const row = await seed_row();
        const qa = make_qa();
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            qa,
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.sftp_cleanup).toEqual({ ok: true, status: 200 });

        /*
         * cleanup_sftp must use the collection_uuid (qa_uuid) and the
         * package name — matches the curation-API contract.
         */
        expect(qa._calls.cleanup_sftp).toHaveLength(1);
        expect(qa._calls.cleanup_sftp[0]).toEqual({
            uuid: 'codu:parent',
            archival_package: 'pkg-001',
        });

        /*
         * The outcome is captured in the COMPLETE event's payload so
         * the timeline shows what happened.
         */
        const events = await db_queue()(tables.ingest_events)
            .where({ queue_id: row.id, to_state: 'COMPLETE' });
        expect(events).toHaveLength(1);
        const payload = JSON.parse(events[0].payload);
        expect(payload.sftp_cleanup).toEqual({ ok: true, status: 200 });
    });

    it('sftp cleanup: skipped (not configured) does not unwind COMPLETE', async () => {
        const row = await seed_row();
        const qa = make_qa({ configured: false });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            qa,
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.sftp_cleanup).toEqual({ ok: false, skipped: 'qa_not_configured' });
        expect(qa._calls.cleanup_sftp).toHaveLength(0);
        expect(qa._calls.move_to_ingested).toHaveLength(0);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
        expect(fresh.is_complete).toBe(1);
    });

    it('sftp cleanup: non-2xx response is recorded but does not unwind COMPLETE', async () => {
        const row = await seed_row();
        const qa = make_qa({ status: 502 });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            qa,
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.sftp_cleanup).toEqual({ ok: false, status: 502 });
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
        expect(fresh.is_complete).toBe(1);
    });

    it('sftp cleanup: transport throw is captured as error and does not unwind COMPLETE', async () => {
        const row = await seed_row();
        const qa = make_qa({ throws: true });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            qa,
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.sftp_cleanup.ok).toBe(false);
        expect(out.sftp_cleanup.error).toMatch(/sftp host down/);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
        expect(fresh.is_complete).toBe(1);
    });

    it('move_to_ingested: calls (collection_uuid, batch) on success and records ok in COMPLETE payload', async () => {
        const row = await seed_row();
        const qa = make_qa();
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            qa,
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.move_to_ingested).toEqual({
            ok: true,
            status: 200,
            result: 'packages_moved_to_ingested_folder',
        });
        /*
         * Wire matches the curation route contract: uuid + folder
         * (folder = row.batch — the curation route strips `new_`
         * when placing into 003-ingested).
         */
        expect(qa._calls.move_to_ingested).toHaveLength(1);
        expect(qa._calls.move_to_ingested[0]).toEqual({
            uuid: 'codu:parent',
            folder: 'batch-A',
        });
        const events = await db_queue()(tables.ingest_events)
            .where({ queue_id: row.id, to_state: 'COMPLETE' });
        expect(events).toHaveLength(1);
        const payload = JSON.parse(events[0].payload);
        expect(payload.move_to_ingested.ok).toBe(true);
        expect(payload.move_to_ingested.result).toBe('packages_moved_to_ingested_folder');
    });

    it('move_to_ingested: partial failure (Wasabi error in 200 body) is recorded but does not unwind COMPLETE', async () => {
        /*
         * Curation route always returns 200, even when move_to_s3
         * fails. Errors land in data.errors. Stage 5 has to inspect
         * the body — a bare 200 isn't proof Wasabi worked.
         */
        const row = await seed_row();
        const qa = make_qa({
            move_to_ingested_result: {
                status: 200,
                data: {
                    result: 'packages_not_moved_to_ingested_folder',
                    errors: ['ERROR: Unable to move packages to wasabi s3'],
                },
            },
        });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            qa,
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.move_to_ingested.ok).toBe(false);
        expect(out.move_to_ingested.status).toBe(200);
        expect(out.move_to_ingested.errors).toEqual([
            'ERROR: Unable to move packages to wasabi s3',
        ]);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
        expect(fresh.is_complete).toBe(1);
    });

    it('move_to_ingested: transport throw is captured and does not unwind COMPLETE', async () => {
        const row = await seed_row();
        const qa = make_qa({ move_to_ingested_throws: true });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            qa,
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.move_to_ingested.ok).toBe(false);
        expect(out.move_to_ingested.error).toMatch(/curation host down/);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
        expect(fresh.is_complete).toBe(1);
    });

    it('move_to_ingested: non-2xx response is recorded but does not unwind COMPLETE', async () => {
        const row = await seed_row();
        const qa = make_qa({
            move_to_ingested_result: { status: 500, data: null },
        });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            qa,
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.move_to_ingested).toEqual({ ok: false, status: 500 });
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
        expect(fresh.is_complete).toBe(1);
    });

    it('finalize: aborted signal during the hold leaves is_complete=0 for boot-time finalize', async () => {
        /*
         * Graceful shutdown mid-hold: Stage 5 returns ok but
         * is_complete stays 0. The worker boot sweep
         * (model.finalize_pending_completes) catches it on restart.
         */
        const row = await seed_row();
        const controller = new AbortController();
        controller.abort();
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
            signal: controller.signal,
        });
        expect(out.ok).toBe(true);

        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
        expect(fresh.is_complete).toBe(0);

        const swept = await model.finalize_pending_completes();
        expect(swept.affected).toBe(1);
        const after = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(after.is_complete).toBe(1);
    });

    it('halts when row has no sip_uuid', async () => {
        const row = await seed_row({ sip_uuid: 'PENDING' });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('missing_sip_uuid');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
    });

    it('halts when row has no dip_path', async () => {
        const row = await seed_row({ dip_path: 'PENDING' });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('missing_dip_path');
    });

    it('halts when row has no cached metadata snapshot', async () => {
        const row = await seed_row({ metadata: null });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('missing_metadata_snapshot');
    });

    it('halts when DuraCloud returns no METS', async () => {
        const row = await seed_row();
        const out = await stage.run(row, {
            duracloud: make_duracloud({ status: 404 }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('mets_unavailable');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
    });

    it('halts when METS parse returns no files', async () => {
        const row = await seed_row();
        // Valid XML but no fileSec.
        const empty = `<?xml version="1.0"?>
<mets:mets xmlns:mets="http://www.loc.gov/METS/"></mets:mets>`;
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: empty }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('mets_no_files');
    });

    it('succeeds without a handle when Handle service is not configured', async () => {
        const row = await seed_row();
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles({ configured: false }),
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.handle).toBeNull();
        const obj = await db()(tables.objects).where({ pid: row.sip_uuid }).first();
        expect(obj.handle).toBe('');
    });

    it('succeeds when Handle service throws (handle minting is best-effort)', async () => {
        const row = await seed_row();
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles({ throws: true }),
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.handle).toBeNull();
    });

    it('succeeds when Handle service returns non-201 (no halt)', async () => {
        const row = await seed_row();
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles({ status: 500 }),
            model,
        });
        expect(out.ok).toBe(true);
        expect(out.handle).toBeNull();
    });

    it('resumes cleanly from CREATING_REPOSITORY_RECORD', async () => {
        const row = await seed_row({ status: 'CREATING_REPOSITORY_RECORD' });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(true);
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('COMPLETE');
    });

    it('halts cleanly when tbl_objects insert fails', async () => {
        const row = await seed_row({ sip_uuid: 'not-a-uuid' });
        // The repository model's _insert requires a UUID-shaped pid.
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
            repository_model,
        });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe('tbl_objects_insert_failed');
        const fresh = await db_queue()(tables.ingest_queue).where({ id: row.id }).first();
        expect(fresh.pipeline_state).toBe('INGEST_HALTED');
    });

    /*
     * --- Kaltura entry_id attachment -----------------------------------
     * 
     * Stage 5 calls kaltura_model.get_entry_id_for_file(package, file)
     * for each part before building the object row. A populated
     * tbl_kaltura_ids row should produce a `kaltura_id` field on the
     * matching part in the saved display_record envelope — which since
     * the display_envelope consolidation lives at the merged manifest,
     * display_record.display_record.parts (plus a top-level entry_id).
     */

    it('attaches kaltura_id to parts when tbl_kaltura_ids has a match', async () => {
        const row = await seed_row({ package: 'D047.02.0001.0020.00001' });
        /*
         * Pre-populate tbl_kaltura_ids — the row's METS fileSec will
         * yield a part with file='thing.tif' (per happy_mets above).
         * We seed the lookup so attach_kaltura_ids stamps the id.
         */
        await db_queue()(tables.kaltura_ids).insert({
            package: 'D047.02.0001.0020.00001',
            file: 'thing.tif',
            entry_id: '1_kaltura_abc',
            status: 1,
            message: 'Success.',
        });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(true);
        const obj = await db()(tables.objects).where({ pid: row.sip_uuid }).first();
        const envelope = JSON.parse(obj.display_record);
        expect(envelope.display_record.parts).toHaveLength(1);
        expect(envelope.display_record.parts[0].kaltura_id).toBe('1_kaltura_abc');
        expect(envelope.entry_id).toBe('1_kaltura_abc');
    });

    it('leaves kaltura_id absent when no tbl_kaltura_ids row exists', async () => {
        const row = await seed_row({ package: 'D000.no.kaltura' });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(true);
        const obj = await db()(tables.objects).where({ pid: row.sip_uuid }).first();
        const envelope = JSON.parse(obj.display_record);
        /*
         * The part exists, but no kaltura_id key was added — the lookup
         * just returned null and the part passed through unchanged.
         */
        expect(envelope.display_record.parts[0].kaltura_id).toBeUndefined();
        expect(envelope.display_record.parts[0].title).toBe('thing.tif');
    });

    it('skips status=0 (not-found) rows even when they exist in tbl_kaltura_ids', async () => {
        const row = await seed_row({ package: 'D999.zero.status' });
        /*
         * tbl_kaltura_ids may carry placeholder rows for files that
         * were searched but not found (entry_id='0_0', status=0).
         * model.get_entry_id_for_file's WHERE status=1 filter excludes
         * these — so the part should NOT pick up the '0_0' value.
         */
        await db_queue()(tables.kaltura_ids).insert({
            package: 'D999.zero.status',
            file: 'thing.tif',
            entry_id: '0_0',
            status: 0,
            message: 'Not found.',
        });
        const out = await stage.run(row, {
            duracloud: make_duracloud({ mets_xml: happy_mets() }),
            handles: make_handles(),
            model,
        });
        expect(out.ok).toBe(true);
        const obj = await db()(tables.objects).where({ pid: row.sip_uuid }).first();
        const envelope = JSON.parse(obj.display_record);
        expect(envelope.display_record.parts[0].kaltura_id).toBeUndefined();
    });

    /*
     * --- archive_to_wasabi failure job (003-ingested retirement, ---
     * --- phase 1) — loud surfacing in Job History                 ---
     */
    describe('archive_to_wasabi failure job', () => {
        function make_jobs() {
            const calls = [];
            return {
                async record_job(args) {
                    calls.push(args);
                    return 'job-uuid-test';
                },
                _calls: calls,
            };
        }

        it('records a FAILED job when the Wasabi copy fails (200 body errors)', async () => {
            const row = await seed_row();
            const jobs = make_jobs();
            const out = await stage.run(row, {
                duracloud: make_duracloud({ mets_xml: happy_mets() }),
                handles: make_handles(),
                qa: make_qa({
                    move_to_ingested_result: {
                        status: 200,
                        data: {
                            result: 'packages_not_moved_to_ingested_folder',
                            errors: ['ERROR: Unable to move packages to wasabi s3'],
                        },
                    },
                }),
                model,
                jobs,
            });
            // The ingest itself still completes — the job row is the alarm.
            expect(out.ok).toBe(true);
            expect(jobs._calls).toHaveLength(1);
            expect(jobs._calls[0].job_type).toBe('archive_to_wasabi');
            expect(jobs._calls[0].status).toBe('FAILED');
            expect(jobs._calls[0].collection_folder).toBe('batch-A');
            expect(jobs._calls[0].packages).toEqual(['pkg-001']);
            expect(jobs._calls[0].error).toContain('wasabi s3');
        });

        it('records a FAILED job on transport-level failure', async () => {
            const row = await seed_row();
            const jobs = make_jobs();
            const out = await stage.run(row, {
                duracloud: make_duracloud({ mets_xml: happy_mets() }),
                handles: make_handles(),
                qa: make_qa({ move_to_ingested_throws: true }),
                model,
                jobs,
            });
            expect(out.ok).toBe(true);
            expect(jobs._calls).toHaveLength(1);
            expect(jobs._calls[0].error).toContain('curation host down');
        });

        it('records a FAILED job when the curation service is not configured', async () => {
            /*
             * Unconfigured curation = the batch was NOT archived. With
             * the local 003-ingested copy retired this must be visible,
             * not a silent skip.
             */
            const row = await seed_row();
            const jobs = make_jobs();
            const out = await stage.run(row, {
                duracloud: make_duracloud({ mets_xml: happy_mets() }),
                handles: make_handles(),
                qa: make_qa({ configured: false }),
                model,
                jobs,
            });
            expect(out.ok).toBe(true);
            expect(jobs._calls).toHaveLength(1);
            expect(jobs._calls[0].error).toContain('not configured');
        });

        it('records nothing on success', async () => {
            const row = await seed_row();
            const jobs = make_jobs();
            const out = await stage.run(row, {
                duracloud: make_duracloud({ mets_xml: happy_mets() }),
                handles: make_handles(),
                qa: make_qa(),
                model,
                jobs,
            });
            expect(out.ok).toBe(true);
            expect(jobs._calls).toHaveLength(0);
        });

        it('a job-record failure never unwinds the completed ingest', async () => {
            const row = await seed_row();
            const jobs = {
                async record_job() {
                    throw new Error('jobs table unavailable');
                },
            };
            const out = await stage.run(row, {
                duracloud: make_duracloud({ mets_xml: happy_mets() }),
                handles: make_handles(),
                qa: make_qa({ move_to_ingested_throws: true }),
                model,
                jobs,
            });
            expect(out.ok).toBe(true);
        });
    });
});
