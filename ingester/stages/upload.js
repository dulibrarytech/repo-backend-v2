'use strict';

// Stage 2 — upload to Archivematica SFTP via the QA service.
//
//   entry:  QA_COMPLETE
//   exit:   UPLOAD_COMPLETE  (success — N files arrived)
//         | UPLOAD_TIMEOUT   (poll budget exhausted; pre-AM rollback)
//         | INGEST_HALTED    (QA returned a hard error)
//
// What it does:
//   1. Look up the expected file count via QA package-file-count.
//      (Workers in v1 pre-fetched this; we do the same so the poll
//      has something to compare against.)
//   2. Tell QA to move the package from 001-ready to 002-ingest.
//      Fire-and-forget on the wire — QA does the move asynchronously
//      and we observe the result via subsequent calls.
//   3. Tell QA to push the staged batch up to the AM SFTP source.
//      Also fire-and-forget on the QA side; the long timeout is
//      bounded by `cfg.upload_timeout_ms` here.
//   4. Poll `sftp_upload_status` every `cfg.upload_poll_ms` until
//      the uploaded file count matches the expected count, or until
//      the total poll budget is exhausted (UPLOAD_TIMEOUT).
//
// The worker passes a per-row AbortSignal so shutdown can cancel the
// poll mid-flight; we resume from QA_COMPLETE on the next worker
// boot via the resume logic (Phase 3b will wire that explicitly).

const qa_default = require('../libs/qa_service');
const model_default = require('../model');
const app_config = require('../../config/app');
const log = require('../../libs/log');
const { poll } = require('../lib/polling');

async function run(row, deps = {}) {
    const qa = deps.qa || qa_default;
    const model = deps.model || model_default;
    const cfg = app_config().ingest_worker;
    const signal = deps.signal;

    // The qa_uuid for this row — the curation-API's namespace for
    // the Archivematica SFTP staging directory. Matches v1's design
    // (ingest_service.js:508 in digitaldu-backend-ingest-service):
    // the SFTP folder is named after the COLLECTION's PID, not after
    // each individual package. All packages in the same collection
    // share `<sftp_path>/<collection_pid>/<package_name>/`.
    //
    // The pre-flight gate in workspace.submit_to_ingest mints
    // collection_pid ONLY when a new collection is created;
    // existing collections reuse their PID. So submits for the same
    // collection land in the same SFTP folder.
    //
    // Defensive fallback: `PENDING` is the schema default for
    // collection_uuid in tbl_ingest_queue. Legacy rows that bypassed
    // submit_to_ingest's gate may have it. Treat it as missing and
    // fall through to a per-row `q-<id>` so the upload still has a
    // valid SFTP namespace to land in.
    const qa_uuid =
        row.collection_uuid && row.collection_uuid !== 'PENDING'
            ? row.collection_uuid
            : `q-${row.id}`;
    const folder = row.batch;
    const package_name = row.package;

    // Step 1 — pre-flight: how many files should land at AM?
    let expected_count;
    try {
        const res = await qa.get_package_file_count(folder, package_name);
        if (res.status !== 200 || res.data === null || res.data === undefined) {
            throw new Error(`QA package-file-count HTTP ${res.status}`);
        }
        // QA returns the count in `package_file_count`, `total`, or as
        // a bare number depending on the build. Tolerate all three.
        expected_count = pick_count(res.data);
        if (!Number.isFinite(expected_count) || expected_count <= 0) {
            throw new Error(`QA returned no usable file count (got ${JSON.stringify(res.data)})`);
        }
    } catch (err) {
        await halt(model, row, 'INGEST_HALTED', {
            stage: 'upload',
            reason: 'package_file_count_failed',
            error: err.message,
        });
        return { ok: false, reason: 'package_file_count_failed' };
    }

    // Record the count + flip to UPLOADING. The dashboard can now
    // show "0 of N uploaded" using these two fields.
    await model.update_queue(
        { id: row.id },
        { status: 'UPLOADING', file_count: expected_count },
        {
            actor: 'worker',
            payload: { stage: 'upload', expected_count, qa_uuid, folder, package: package_name },
        }
    );

    // Step 2 — request the folder move + the SFTP push. Both are
    // fire-and-forget at the QA layer; we don't gate on their
    // success because the poll below is the real signal.
    try {
        await qa.move_to_ingest(qa_uuid, folder, package_name);
        await qa.move_to_sftp(qa_uuid);
    } catch (err) {
        // Transport-level failure here is fatal — the move never
        // started, so the upload-status poll will never make progress.
        await halt(model, row, 'INGEST_HALTED', {
            stage: 'upload',
            reason: 'qa_move_failed',
            error: err.message,
        });
        return { ok: false, reason: 'qa_move_failed' };
    }

    // Step 3 — poll sftp_upload_status until we hit `expected_count`.
    let last_uploaded = 0;
    const outcome = await poll(
        async ({ attempt, elapsed_ms }) => {
            const res = await qa.sftp_upload_status(qa_uuid, expected_count);
            if (res.status !== 200 || res.data === null || res.data === undefined) {
                // QA hiccup — don't immediately halt; the next poll
                // may succeed. Log and keep going.
                log.warn({
                    event: 'upload_poll_qa_hiccup',
                    queue_id: row.id,
                    qa_uuid,
                    status: res.status,
                    attempt,
                });
                return { done: false };
            }
            const uploaded = pick_uploaded(res.data);
            if (uploaded !== last_uploaded) {
                last_uploaded = uploaded;
                log.debug({
                    event: 'upload_progress',
                    queue_id: row.id,
                    uploaded,
                    expected: expected_count,
                    elapsed_ms,
                });
            }
            // Done when the live count meets expectations OR when QA
            // reports the sentinel (POSITIVE_INFINITY, set by
            // pick_uploaded on `is_complete: true`). Number.isFinite
            // rejects the sentinel, so test it separately.
            if (typeof uploaded === 'number' && uploaded >= expected_count) {
                return { done: true, value: { uploaded } };
            }
            return { done: false };
        },
        {
            interval_ms: cfg.upload_poll_ms,
            timeout_ms: cfg.upload_timeout_ms,
            signal,
            on_attempt: async ({ error }) => {
                // Network errors during polling — log + continue. The
                // overall timeout still bounds us.
                log.warn({
                    event: 'upload_poll_error',
                    queue_id: row.id,
                    err: error.message,
                });
                return true;
            },
        }
    );

    if (outcome.aborted) {
        // Worker shutdown. Leave the row in UPLOADING so resume can
        // restart the poll later. No event needed — the worker logs
        // the abort already.
        return { ok: false, reason: 'aborted' };
    }
    if (outcome.timed_out) {
        await halt(model, row, 'UPLOAD_TIMEOUT', {
            stage: 'upload',
            reason: 'poll_exhausted',
            attempts: outcome.attempts,
            elapsed_ms: outcome.elapsed_ms,
            last_uploaded,
            expected_count,
        });
        return { ok: false, reason: 'upload_timeout' };
    }

    // Success.
    await model.update_queue(
        { id: row.id },
        { status: 'UPLOAD_COMPLETE' },
        {
            actor: 'worker',
            payload: {
                stage: 'upload',
                result: 'complete',
                uploaded: outcome.result.uploaded,
                attempts: outcome.attempts,
                elapsed_ms: outcome.elapsed_ms,
            },
        }
    );
    return { ok: true, uploaded: outcome.result.uploaded };
}

// QA's file-count response shape varies across legacy + v2 builds.
function pick_count(data) {
    if (data === null || data === undefined) return null;
    if (typeof data === 'number') return data;
    if (typeof data === 'object') {
        if (Number.isFinite(data.package_file_count)) return data.package_file_count;
        if (Number.isFinite(data.file_count)) return data.file_count;
        if (Number.isFinite(data.total)) return data.total;
        if (Number.isFinite(data.count)) return data.count;
    }
    return null;
}

// Map an upload-status response to a "files arrived" count the poll
// loop can compare against `expected_count`.
//
// The production curation-API (lib/archivematica_ops.py::check_sftp)
// returns one of two shapes — both expressed in terms of
// `remote_file_count`, NOT the legacy `uploaded` key. We learned this
// the hard way: pre-fix the function only recognized `uploaded` /
// `upload_count` / `count` / `is_complete`, none of which appear in
// either curation-API shape. Every poll returned null, the poll never
// advanced, and rows sat in UPLOADING until the 4h timeout fired.
//
// Curation-API shapes (see lib/archivematica_ops.py::check_sftp):
//
//   Done (local file count matches remote walk):
//     { message: 'upload_complete', data: [file_names, remote_file_count] }
//
//   Still uploading:
//     { message: 'in_progress',
//       file_names: [...],
//       remote_file_count: N,
//       local_file_count: M,
//       remote_package_size: '12.3M' }
//
// Plus a couple of legacy shapes preserved for back-compat (older
// builds + test fixtures).
function pick_uploaded(data) {
    if (data === null || data === undefined) return null;
    if (typeof data === 'number') return data;
    if (typeof data === 'object') {
        // Curation-API "done" signal — explicit terminal marker.
        // Use POSITIVE_INFINITY so the comparison
        // `uploaded >= expected_count` always succeeds even when
        // the response shape doesn't include a concrete count.
        if (data.message === 'upload_complete') return Number.POSITIVE_INFINITY;
        // Curation-API "in progress" signal — the live count.
        if (Number.isFinite(data.remote_file_count)) return data.remote_file_count;
        // Legacy QA-build shapes (preserved for test fixtures + any
        // older deploys that haven't picked up the curation-API
        // contract yet). Same priority order as before.
        if (data.is_complete === true) return Number.POSITIVE_INFINITY;
        if (Number.isFinite(data.uploaded)) return data.uploaded;
        if (Number.isFinite(data.upload_count)) return data.upload_count;
        if (Number.isFinite(data.count)) return data.count;
    }
    return null;
}

async function halt(model, row, terminal_state, payload) {
    const error_text = payload.errors
        ? payload.errors.join('; ').slice(0, 1000)
        : payload.error || payload.reason || 'halted';
    await model.update_queue(
        { id: row.id },
        { status: terminal_state, error: error_text },
        { actor: 'worker', event_type: 'state_change', payload }
    );
}

module.exports = { run, _pick_count: pick_count, _pick_uploaded: pick_uploaded };
