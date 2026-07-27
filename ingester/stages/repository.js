'use strict';

/*
 * Stage 5 — post-AM repository build.
 * 
 *   entry:  METADATA_PROCESSED         (success path, from stage 4)
 *         | CREATING_REPOSITORY_RECORD (resume mid-build)
 *   exit:   COMPLETE                   (success + is_complete=1)
 *         | INGEST_HALTED              (any failure)
 * 
 * What it does:
 *   1. Fetch the METS file from DuraCloud (using sip_uuid + dip_path
 *      both persisted on the queue row by stage 4).
 *   2. Parse the METS via ingester/libs/mets — yields per-file
 *      records (uuid, file path, mime type).
 *   3. Enrich the file list with DC object + thumbnail paths.
 *   4. Pick a "master" part (the first object-type part by stable
 *      filename order) — used to populate tbl_objects.mime_type +
 *      .file_name + .thumbnail on the parent row.
 *   5. Mint a Handle (or skip if Handle service isn't configured).
 *   6. Insert the tbl_objects row via repository/model._insert.
 *   7. Persist the handle on the queue row + flip to COMPLETE +
 *      is_complete=1.
 * 
 * Resume behavior:
 *   The whole stage is short-lived (no long polls — just fetch + parse
 *   + insert). On crash mid-stage:
 *     - Before tbl_objects.insert: row is in CREATING_REPOSITORY_RECORD,
 *       resume re-fetches METS + retries the insert. Idempotent so
 *       long as the insert doesn't partially succeed (it's wrapped in
 *       a single knex insert — atomic at the DB layer).
 *     - After tbl_objects.insert but before queue update: rare, but
 *       a re-run would create a duplicate row. We DON'T defensively
 *       check for an existing pid here — the unlikely-but-possible
 *       duplicate is preferable to silently no-op'ing a real second
 *       ingest attempt. Phase 4 will add a queue-side dedup.
 * 
 * No external polling. No bounded budget — the whole stage is a
 * handful of HTTP calls + a DB insert.
 */

const duracloud_default = require('../../libs/duracloud');
const handles_default = require('../../libs/handles');
const qa_service_default = require('../libs/qa_service');
const mets_module = require('../libs/mets');
const builder = require('../lib/repository_build');
const repository_model = require('../../repository/model');
const model_default = require('../model');
const jobs_default = require('../jobs');
const kaltura_model_default = require('../../kaltura/model');
const app_config = require('../../config/app');
const { sleep_or_abort } = require('../lib/polling');
const log = require('../../libs/log');

async function run(row, deps = {}) {
    const duracloud = deps.duracloud || duracloud_default;
    const handles = deps.handles || handles_default;
    const qa = deps.qa || deps.qa_service || qa_service_default;
    const parse_mets = (deps.mets && deps.mets.parse_mets) || mets_module.parse_mets;
    const repo = deps.repository_model || repository_model;
    const model = deps.model || model_default;
    const jobs = deps.jobs || jobs_default;
    const kaltura_model = deps.kaltura_model || kaltura_model_default;
    const signal = deps.signal;

    if (!row.sip_uuid || row.sip_uuid === 'PENDING') {
        await halt(model, row, { reason: 'missing_sip_uuid' });
        return { ok: false, reason: 'missing_sip_uuid' };
    }
    if (!row.dip_path || row.dip_path === 'PENDING') {
        await halt(model, row, { reason: 'missing_dip_path' });
        return { ok: false, reason: 'missing_dip_path' };
    }
    const metadata = parse_metadata(row.metadata);
    if (!metadata) {
        await halt(model, row, { reason: 'missing_metadata_snapshot' });
        return { ok: false, reason: 'missing_metadata_snapshot' };
    }

    /*
     * Move into CREATING_REPOSITORY_RECORD so the dashboard shows a
     * distinct phase and crash-resume lands here unambiguously.
     */
    if (row.pipeline_state !== 'CREATING_REPOSITORY_RECORD') {
        await model.update_queue(
            { id: row.id },
            { status: 'CREATING_REPOSITORY_RECORD' },
            {
                actor: 'worker',
                payload: {
                    stage: 'repository',
                    step: 'started',
                    sip_uuid: row.sip_uuid,
                    dip_path: row.dip_path,
                },
            }
        );
    }

    // --- Step 1: fetch METS from DuraCloud ---------------------------
    const mets_url = duracloud.mets_path(row.sip_uuid, row.dip_path);
    let mets_res;
    try {
        mets_res = await duracloud.fetch_text(mets_url, { signal });
    } catch (err) {
        await halt(model, row, {
            reason: 'mets_fetch_failed',
            error: err.message,
            mets_url,
        });
        return { ok: false, reason: 'mets_fetch_failed' };
    }
    if (
        mets_res.status !== 200 ||
        typeof mets_res.data !== 'string' ||
        mets_res.data.length === 0
    ) {
        await halt(model, row, {
            reason: 'mets_unavailable',
            status: mets_res.status,
            mets_url,
        });
        return { ok: false, reason: 'mets_unavailable' };
    }

    // --- Step 2: parse METS + enrich parts ---------------------------
    let files;
    try {
        files = await parse_mets(mets_res.data, {
            sip_uuid: row.sip_uuid,
            dip_path: row.dip_path,
        });
    } catch (err) {
        await halt(model, row, {
            reason: 'mets_parse_failed',
            error: err.message,
        });
        return { ok: false, reason: 'mets_parse_failed' };
    }
    if (!Array.isArray(files) || files.length === 0) {
        await halt(model, row, {
            reason: 'mets_no_files',
            note: 'parsed METS produced an empty file list',
        });
        return { ok: false, reason: 'mets_no_files' };
    }

    const parts_raw = builder.enrich_parts(files, { dip_path: row.dip_path });
    /*
     * Enrich parts with kaltura entry IDs by looking up
     * tbl_kaltura_ids by (package, file). Read-only side effect — a
     * failed lookup leaves the part's kaltura_id absent rather than
     * halting ingest. The kaltura subsystem (kaltura/*) populates this
     * table from staff batches; reading it here makes the entry IDs
     * available to the dashboard even when the legacy MDO process
     * didn't stamp them on the AS record.
     */
    const parts = await builder.attach_kaltura_ids(parts_raw, row.package, kaltura_model);
    const master = builder.pick_master(parts);

    /*
     * --- Step 3: mint a Handle (optional) ----------------------------
     * 
     * In dev environments without HANDLE_* set we skip this and
     * tbl_objects.handle ends up empty — the row is still useful and
     * staff can mint a handle manually later via an admin tool.
     */
    let handle_url = null;
    if (handles.is_configured && handles.is_configured()) {
        try {
            const h = await handles.create_handle(row.sip_uuid);
            if (h.status === 201 && h.handle) {
                handle_url = h.handle;
            } else {
                /*
                 * Non-201 — log + carry on without a handle. The row
                 * still ingests; staff can retry the mint via the
                 * dashboard. Halting here would be too brittle.
                 */
                log.warn({
                    event: 'handle_create_non_201',
                    queue_id: row.id,
                    status: h.status,
                });
            }
        } catch (err) {
            log.warn({
                event: 'handle_create_threw',
                queue_id: row.id,
                err: err.message,
            });
        }
    }

    /*
     * Resolve the local collection PID. Post-task-#119 the queue
     * row's `collection_uuid` IS the PID (the pre-flight gate
     * stamps the resolved value there at submit time). For legacy
     * rows or rows queued via the REST API without going through
     * the gate, the value might still be a folder-name string — we
     * detect that via UUID-shape and fall back to a URI-parse +
     * find-by-uri lookup. Either way the eventual is_member_of_
     * collection ends up as a real PID when one exists, '' when it
     * doesn't.
     */
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let collection_pid = '';
    if (typeof row.collection_uuid === 'string' && UUID_RE.test(row.collection_uuid)) {
        // Modern path — collection_uuid is already a PID. Trust it.
        collection_pid = row.collection_uuid;
    } else {
        /*
         * Legacy path — collection_uuid is a folder name. Re-parse
         * + look up. Same logic the pre-flight gate runs at submit
         * time; here it's a safety net for rows that bypassed it.
         */
        try {
            const collection_uri = _parse_collection_uri(row.collection_uuid);
            if (collection_uri) {
                const collection = await repo.find_collection_by_uri(collection_uri);
                if (collection) {
                    collection_pid = collection.pid;
                } else {
                    log.warn({
                        event: 'collection_lookup_missed',
                        queue_id: row.id,
                        collection_uuid: row.collection_uuid,
                        collection_uri,
                    });
                }
            }
        } catch {
            log.warn({
                event: 'collection_uri_parse_failed',
                queue_id: row.id,
                collection_uuid: row.collection_uuid,
            });
        }
    }

    // --- Step 4: insert tbl_objects row ------------------------------
    let object_row;
    try {
        object_row = builder.build_object_row({
            queue_row: row,
            metadata,
            parts,
            master,
            handle: handle_url,
            collection_pid,
        });
    } catch (err) {
        await halt(model, row, {
            reason: 'build_object_row_failed',
            error: err.message,
        });
        return { ok: false, reason: 'build_object_row_failed' };
    }

    try {
        await repo._insert(object_row);
    } catch (err) {
        await halt(model, row, {
            reason: 'tbl_objects_insert_failed',
            error: err.message,
            pid: object_row.pid,
        });
        return { ok: false, reason: 'tbl_objects_insert_failed' };
    }

    /*
     * --- Step 5: finalize queue row ----------------------------------
     * 
     * Two-phase finalize so staff sees the success state before the
     * row vanishes from the default "Open only" view:
     * 
     *   Phase A — flip to COMPLETE with is_complete=0. The
     *     suggested_action ("Ingest Complete", from state_metadata)
     *     renders on the row. The dashboard auto-refreshes every 5s,
     *     so staff catch the success state at least once.
     * 
     *   Phase B — after `complete_hold_ms`, flip is_complete=1 so
     *     the row drops out of the default view. We pass only
     *     is_complete here (no status), so the model writes no
     *     duplicate state-change event and the suggested_action
     *     stays intact for anyone viewing closed rows later.
     * 
     * If the worker is aborted (graceful shutdown) during the hold,
     * we leave the row in COMPLETE+is_complete=0. The boot-time
     * sweep in worker.js (finalize_pending_completes) catches it on
     * the next start.
     * 
     * The indexer worker will pick up tbl_objects.is_updated=1 on
     * its next tick and push the row into ES — that side effect runs
     * off the tbl_objects write above, not the queue finalize.
     * SFTP cleanup. AM now has the AIP and DuraCloud has the DIP, so
     * the SFTP staging copy is dead weight — without this it would
     * accumulate one `<uuid>/<package>/` directory per successful
     * ingest forever. Best-effort: run BEFORE the COMPLETE flip so
     * the outcome is captured in the COMPLETE event's payload (visible
     * in the timeline), but a failure here MUST NOT unwind the
     * completed ingest. Mirrors the rollback path, which gets
     * equivalent cleanup via the curation-API's
     * move_from_ingest_to_ready (see qa_service.cleanup_sftp comment).
     */
    const sftp_cleanup = await _cleanup_sftp_safely(qa, row);

    /*
     * Archive 002-ingest/<uuid>/ to 003-ingested/<folder>/ AND copy to
     * Wasabi S3 — the curation-API's move_to_ingested does both in one
     * call (see digitaldu-backend-curation-service: move_to_ingested
     * → move_to_s3). Without this, staff folders pile up in
     * 002-ingest forever and nothing reaches Wasabi.
     * 
     * v1 fired this at UPLOAD_COMPLETE; v2 fires it at Stage 5 COMPLETE
     * — the folder stays in the staff view until the row is actually
     * a finished repository record, not just "bytes safely on AM".
     * 
     * Best-effort: a non-2xx, a Wasabi failure in data.errors, or a
     * transport throw MUST NOT unwind the completed ingest. The
     * outcome lands in the COMPLETE event payload so staff can see
     * in the timeline whether the move + S3 copy actually succeeded
     * (the curation route always returns 200, even when move_to_s3
     * fails, so we have to inspect data.errors).
     */
    const archive_to_ingested = await _move_to_ingested_safely(qa, row);

    /*
     * LOUD failure surfacing (003-ingested retirement, phase 1).
     * The archive copy is best-effort for the INGEST (a Wasabi outage
     * must not unwind a completed repository record), but with the
     * local 003-ingested copy retired, the Wasabi copy is the batch
     * snapshot's only custodian — so a failure can no longer live
     * only inside the COMPLETE event payload. Record a FAILED
     * archive_to_wasabi row in tbl_ingest_jobs: it renders in the
     * staff Job History view with a FAILED badge and is filterable
     * by type. Success records nothing (history stays quiet unless
     * something needs attention). The batch source remains in
     * 002-ingest/<uuid> whenever the S3 upload fails (move_to_ingested
     * only deletes it after a verified upload), so the staff remedy
     * is: fix connectivity/creds, then re-run the archive.
     */
    await _record_archive_failure_safely(jobs, row, archive_to_ingested);

    const cfg = app_config().ingest_worker;
    await model.update_queue(
        { id: row.id },
        {
            status: 'COMPLETE',
            handle: handle_url || '',
            is_complete: 0,
        },
        {
            actor: 'worker',
            payload: {
                stage: 'repository',
                step: 'complete',
                pid: object_row.pid,
                handle: handle_url || null,
                parts_count: parts.length,
                master_file: master ? master.file : null,
                is_compound: object_row.is_compound === 1,
                sftp_cleanup,
                move_to_ingested: archive_to_ingested,
            },
        }
    );

    await sleep_or_abort(cfg.complete_hold_ms, signal);

    if (signal && signal.aborted) {
        return {
            ok: true,
            pid: object_row.pid,
            handle: handle_url,
            parts_count: parts.length,
            sftp_cleanup,
            move_to_ingested: archive_to_ingested,
        };
    }

    /*
     * Hand-off to Stage 6 OR finalize. When AIP_STORE_ENABLED is on
     * the row transitions to AIP_STORE_PENDING (still visible in the
     * queue, is_complete=0) so the next worker tick picks it up and
     * runs the Wasabi copy. With the flag off, behavior matches
     * pre-Stage-6 (flip is_complete=1, row drops out of the default
     * view). The branch is here at the very end of Stage 5 — past
     * every side effect that defines "ingest succeeded" — so a
     * Wasabi outage CANNOT roll back ingest success.
     */
    const aip_store_cfg = app_config().aip_store;
    if (aip_store_cfg && aip_store_cfg.enabled) {
        await model.update_queue(
            { id: row.id },
            { status: 'AIP_STORE_PENDING' },
            {
                actor: 'worker',
                payload: {
                    stage: 'repository',
                    step: 'handoff_to_aip_store',
                    pid: object_row.pid,
                },
            }
        );
    } else {
        await model.update_queue({ id: row.id }, { is_complete: 1 });
    }

    return {
        ok: true,
        pid: object_row.pid,
        handle: handle_url,
        parts_count: parts.length,
        sftp_cleanup,
        move_to_ingested: archive_to_ingested,
        aip_store_handoff: Boolean(aip_store_cfg && aip_store_cfg.enabled),
    };
}

/*
 * Best-effort SFTP cleanup wrapper. Returns one of:
 *   { ok: true,  status }           — curation-API returned 2xx
 *   { ok: false, status }           — curation-API returned non-2xx
 *   { ok: false, error: message }   — transport-level failure
 *   { ok: false, skipped: 'reason'} — qa_service not configured or
 *                                     missing qa_uuid on the row
 * Never throws. The Stage 5 caller records this in the audit log
 * but does not branch the success path on it.
 */
async function _cleanup_sftp_safely(qa, row) {
    if (!qa || (qa.is_configured && !qa.is_configured())) {
        return { ok: false, skipped: 'qa_not_configured' };
    }
    const qa_uuid =
        row.collection_uuid && row.collection_uuid !== 'PENDING'
            ? row.collection_uuid
            : `q-${row.id}`;
    if (!row.package || row.package === 'PENDING') {
        return { ok: false, skipped: 'missing_archival_package' };
    }
    try {
        const r = await qa.cleanup_sftp(qa_uuid, row.package);
        if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
        log.warn({
            event: 'sftp_cleanup_bad_status',
            queue_id: row.id,
            status: r.status,
        });
        return { ok: false, status: r.status };
    } catch (err) {
        log.warn({ event: 'sftp_cleanup_failed', queue_id: row.id, err: err.message });
        return { ok: false, error: err.message };
    }
}

/*
 * Best-effort wrapper for the 002-ingest → 003-ingested move + Wasabi
 * S3 copy. The curation-API's move_to_ingested does both in one call
 * (see qa_service.move_to_ingested comment for protocol details).
 * 
 * The curation route always returns HTTP 200 even when the Wasabi
 * upload fails (errors land in data.errors[]), so 2xx alone isn't
 * proof of success. We surface both signals in the result:
 *   { ok: true,  status, result }                — clean success
 *   { ok: false, status, errors: [...] }         — curation reported
 *                                                   per-step failures
 *                                                   (e.g. Wasabi missing
 *                                                   creds, S3 timeout)
 *   { ok: false, status }                        — non-2xx HTTP
 *   { ok: false, error: message }                — transport-level fail
 *   { ok: false, skipped: 'reason' }             — qa not configured or
 *                                                   row missing batch/uuid
 * Never throws. Stage 5 records the result in the COMPLETE audit
 * payload but does not branch on it — the ingest is still considered
 * successful; staff get visibility via the timeline.
 */
async function _move_to_ingested_safely(qa, row) {
    if (!qa || (qa.is_configured && !qa.is_configured())) {
        return { ok: false, skipped: 'qa_not_configured' };
    }
    const qa_uuid =
        row.collection_uuid && row.collection_uuid !== 'PENDING'
            ? row.collection_uuid
            : `q-${row.id}`;
    if (!row.batch || row.batch === 'PENDING') {
        return { ok: false, skipped: 'missing_folder' };
    }
    try {
        const r = await qa.move_to_ingested(qa_uuid, row.batch);
        if (r.status < 200 || r.status >= 300) {
            log.warn({
                event: 'move_to_ingested_bad_status',
                queue_id: row.id,
                status: r.status,
            });
            return { ok: false, status: r.status };
        }
        /*
         * Curation returns 200 even on partial failure — inspect
         * data.errors[] to see whether the Wasabi copy or the local
         * move actually succeeded. data shape:
         *   { result: 'packages_moved_to_ingested_folder', errors: [] }
         *   { result: 'packages_not_moved_to_ingested_folder',
         *     errors: ['ERROR: Unable to move packages to wasabi s3'] }
         */
        const data = r.data;
        const errors = data && Array.isArray(data.errors) ? data.errors : [];
        const result = data && typeof data.result === 'string' ? data.result : null;
        if (errors.length > 0) {
            log.warn({
                event: 'move_to_ingested_partial_failure',
                queue_id: row.id,
                errors,
                result,
            });
            return { ok: false, status: r.status, result, errors };
        }
        return { ok: true, status: r.status, result };
    } catch (err) {
        log.warn({
            event: 'move_to_ingested_failed',
            queue_id: row.id,
            err: err.message,
        });
        return { ok: false, error: err.message };
    }
}

/*
 * Record a FAILED archive_to_wasabi job when the end-of-ingest
 * archive copy did not fully succeed (003-ingested retirement,
 * phase 1 — see the call site in run() for the rationale).
 *
 * Recording rules:
 *   ok:true                       → nothing recorded (quiet on success)
 *   skipped:'missing_folder'      → nothing recorded (synthetic rows
 *                                   without a batch; there is no
 *                                   collection_folder to record against)
 *   skipped:'qa_not_configured'   → recorded — an unconfigured
 *                                   curation service means the batch
 *                                   was NOT archived, which staff must
 *                                   see once the local copy is retired
 *   any other failure             → recorded with the error detail
 *
 * Best-effort like everything else at this point in Stage 5: a
 * job-table insert failure is logged and swallowed — it must never
 * unwind a completed ingest.
 */
async function _record_archive_failure_safely(jobs, row, archive_result) {
    if (!archive_result || archive_result.ok === true) return;
    if (archive_result.skipped === 'missing_folder') return;
    if (!row.batch || row.batch === 'PENDING') return;

    let error;
    if (archive_result.skipped === 'qa_not_configured') {
        error = 'Curation service is not configured — the batch was NOT archived to Wasabi.';
    } else if (Array.isArray(archive_result.errors) && archive_result.errors.length > 0) {
        error = archive_result.errors.join('; ');
    } else if (archive_result.error) {
        error = archive_result.error;
    } else {
        error = `Archive to Wasabi failed (HTTP ${archive_result.status || 'unknown'}).`;
    }

    try {
        await jobs.record_job({
            job_type: 'archive_to_wasabi',
            status: 'FAILED',
            collection_folder: row.batch,
            packages: row.package ? [row.package] : [],
            actor: 'worker',
            resolved_actor_name: 'Ingest worker',
            error,
        });
        log.error({
            event: 'archive_to_wasabi_failed',
            queue_id: row.id,
            batch: row.batch,
            package: row.package,
            error,
        });
    } catch (err) {
        log.warn({
            event: 'archive_failure_job_record_failed',
            queue_id: row.id,
            err: err.message,
        });
    }
}

/*
 * Parse the resource URI out of the queue row's collection_uuid
 * (which carries the staff-facing folder name, NOT a UUID despite
 * the column name — historical schema artifact). Matches the same
 * `-resources_N` / `-archival_objects_N` convention enforced by
 * workspace._parse_resource_uri. Returns null on unparseable input
 * so the caller can leave is_member_of_collection='' rather than
 * halting Stage 5 on an unrecoverable parse error.
 */
function _parse_collection_uri(folder_name) {
    if (!folder_name || typeof folder_name !== 'string') return null;
    const tail = folder_name.split('-').pop();
    const match = /^(resources|archival_objects)_(\d+)$/.exec(tail);
    if (!match) return null;
    const [, kind, id] = match;
    /*
     * The Stage 5 lookup doesn't have the repo_id readily injected,
     * but find_collection_by_uri matches on the FULL URI we wrote
     * at submit time. We re-derive it the same way workspace.js does.
     */
    const repo_id =
        (require('../../config/app')().archivespace &&
            require('../../config/app')().archivespace.repository_id) ||
        '2';
    return `/repositories/${repo_id}/${kind}/${id}`;
}

function parse_metadata(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

async function halt(model, row, payload) {
    const error_text = payload.error || payload.reason || 'halted';
    await model.update_queue(
        { id: row.id },
        { status: 'INGEST_HALTED', error: error_text },
        {
            actor: 'worker',
            event_type: 'state_change',
            payload: { stage: 'repository', ...payload },
        }
    );
}

module.exports = { run };
