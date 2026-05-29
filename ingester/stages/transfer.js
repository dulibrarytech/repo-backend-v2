'use strict';

// Stage 3 — Archivematica transfer.
//
//   entry:  UPLOAD_COMPLETE          (success path)
//         | TRANSFER_STARTED         (resume mid-approve poll)
//         | TRANSFER_IN_PROGRESS     (resume mid-transfer poll)
//   exit:   TRANSFER_COMPLETE        (success — sip_uuid in hand)
//         | APPROVE_TIMEOUT          (10 min — pre-AM rollback eligible)
//         | TRANSFER_STATUS_TIMEOUT  (6 hr — pre-AM rollback eligible)
//         | INGEST_HALTED            (start_transfer hard error)
//
// What it does:
//   1. Call AM `start_transfer(collection_uuid, package)`. The
//      response includes `transfer_id` (the AM-internal UUID we'll
//      poll) and `directory` (the staged folder name AM expects in
//      approve_transfer).
//   2. Persist transfer_uuid + transfer_folder + flip to
//      TRANSFER_STARTED. The dashboard now shows the row is queued
//      at AM.
//   3. Poll AM's unapproved-transfer list every `approve_poll_ms`
//      until the transfer_folder appears, then call approve_transfer.
//      If it never appears within `approve_timeout_ms` → APPROVE_TIMEOUT.
//   4. Flip to TRANSFER_IN_PROGRESS, poll transfer_status every
//      `transfer_poll_ms` until status === 'COMPLETE' AND `sip_uuid`
//      is non-empty. Persist sip_uuid, flip to TRANSFER_COMPLETE.
//      If it never completes within `transfer_timeout_ms` →
//      TRANSFER_STATUS_TIMEOUT.
//
// Resume behavior:
//   - From TRANSFER_STARTED: re-read transfer_uuid + transfer_folder
//     from the row and re-enter at step 3 (approve poll).
//   - From TRANSFER_IN_PROGRESS: re-read transfer_uuid + sip_uuid (if
//     present) and re-enter at step 4. AM returns the same status
//     whether polled once or a thousand times.

const am_default = require('../../libs/archivematica');
const model_default = require('../model');
const app_config = require('../../config/app');
const log = require('../../libs/log');
const { poll } = require('../lib/polling');

async function run(row, deps = {}) {
    const am = deps.am || am_default;
    const model = deps.model || model_default;
    const cfg = app_config().ingest_worker;
    const signal = deps.signal;

    // Per-stage state. We persist these to the row at each transition
    // so resume can pick up exactly where we left off.
    let transfer_uuid =
        row.transfer_uuid && row.transfer_uuid !== 'PENDING' ? row.transfer_uuid : null;
    let transfer_folder =
        row.transfer_folder && row.transfer_folder !== 'PENDING' ? row.transfer_folder : null;
    let sip_uuid = row.sip_uuid && row.sip_uuid !== 'PENDING' ? row.sip_uuid : null;

    // --- Step 1: start_transfer (fresh runs only) ----------------------
    //
    // Resume from TRANSFER_STARTED or TRANSFER_IN_PROGRESS skips this.
    //
    // AM's transfer-source path mirrors what Stage 2 actually uploaded
    // to SFTP. After task #128 we switched to v1's layout: the SFTP
    // folder is named after row.collection_uuid (the local collection
    // PID, minted once per collection by the pre-flight gate), and all
    // packages in the collection live under that one folder. So the
    // path we hand to AM is `<source>:<sftp_path>/<collection_uuid>/<package>`
    // — built inside libs/archivematica.start_transfer from the two args
    // below. Passing row.batch (the staff folder name) here would point
    // AM at a directory that doesn't exist on SFTP and AM returns 500
    // — that was the start_transfer_bad_status halt seen in production.
    //
    // Defensive `qa_uuid` resolution (skipping the legacy 'PENDING'
    // schema default) mirrors what upload.js does so Stage 3's path
    // resolution stays consistent with Stage 2's even for old rows.
    if (row.pipeline_state === 'UPLOAD_COMPLETE') {
        const collection_pid =
            row.collection_uuid && row.collection_uuid !== 'PENDING'
                ? row.collection_uuid
                : `q-${row.id}`;
        let res;
        try {
            res = await am.start_transfer(collection_pid, row.package);
        } catch (err) {
            await halt(model, row, 'INGEST_HALTED', {
                stage: 'transfer',
                reason: 'start_transfer_failed',
                error: err.message,
            });
            return { ok: false, reason: 'start_transfer_failed' };
        }
        if (res.status !== 200 || !res.data) {
            await halt(model, row, 'INGEST_HALTED', {
                stage: 'transfer',
                reason: 'start_transfer_bad_status',
                status: res.status,
            });
            return { ok: false, reason: 'start_transfer_bad_status' };
        }
        // Real AM /transfer/start_transfer/ response shape (verified in
        // production against AM 1.13):
        //
        //   { "message": "Copy successful.",
        //     "path":    "/var/archivematica/sharedDirectory/
        //                 watchedDirectories/activeTransfers/
        //                 standardTransfer/<basename>-<uuid>/" }
        //
        // Neither `id` nor `transfer_id` is present — the transfer UUID
        // is the trailing UUID at the end of the path basename (after
        // the last `-`). The directory name AM expects in approve_transfer
        // is the path basename (NOT the full path).
        //
        // We tolerate a few alternate shapes for back-compat:
        //   - `data.id` / `data.transfer_id` — legacy AM builds
        //   - `data.directory` — some builds return basename explicitly
        const am_basename = _basename_from_path(res.data.path);
        transfer_uuid =
            res.data.id ||
            res.data.transfer_id ||
            _trailing_uuid_from_basename(am_basename) ||
            null;
        transfer_folder =
            res.data.directory || am_basename || `${collection_pid}_${row.package}_transfer`;
        if (!transfer_folder) {
            // Without a folder name we can't match the transfer in the
            // unapproved-list poll. Real halt-worthy condition.
            await halt(model, row, 'INGEST_HALTED', {
                stage: 'transfer',
                reason: 'start_transfer_missing_folder',
                am_response: res.data,
            });
            return { ok: false, reason: 'start_transfer_missing_folder' };
        }
        // transfer_uuid may still be null here — that's OK. The approve
        // poll below queries `/transfer/unapproved/`, which returns
        // `{ directory, uuid }` per entry; on match we capture uuid
        // from there. Defense-in-depth: this covers any future AM
        // response shape change at start_transfer.

        // Only write transfer_uuid when we actually have one — the
        // column is NOT NULL DEFAULT 'PENDING' in the schema. The
        // approve-poll fills it in later if start_transfer's response
        // didn't carry a parseable UUID.
        const update = {
            status: 'TRANSFER_STARTED',
            transfer_folder,
        };
        if (transfer_uuid) update.transfer_uuid = transfer_uuid;
        await model.update_queue({ id: row.id }, update, {
            actor: 'worker',
            payload: { stage: 'transfer', step: 'started', transfer_uuid, transfer_folder },
        });
    }

    // We MUST have transfer_folder to proceed — it's how we find
    // the entry in the unapproved-list to capture the uuid. The uuid
    // itself can still be missing here (the approve poll fills it in
    // from the matched unapproved-list entry; that's the recovery
    // path for AM builds where start_transfer omits the uuid). For
    // resume from TRANSFER_IN_PROGRESS the uuid IS required — we
    // skip the approve poll entirely in that branch — so the check
    // for that case lives just inside Step 3.
    if (!transfer_folder) {
        // Resume saw the row in TRANSFER_STARTED/TRANSFER_IN_PROGRESS
        // but the row was missing the AM identifiers — likely a
        // partial write from a prior crash. Halt with enough context
        // for staff to investigate.
        await halt(model, row, 'INGEST_HALTED', {
            stage: 'transfer',
            reason: 'missing_am_identifiers',
            transfer_uuid,
            transfer_folder,
        });
        return { ok: false, reason: 'missing_am_identifiers' };
    }

    // --- Step 2: poll the unapproved-transfer list + approve ----------
    //
    // Skipped on resume from TRANSFER_IN_PROGRESS — we already
    // approved the transfer before going to that state.
    if (row.pipeline_state !== 'TRANSFER_IN_PROGRESS') {
        const approved = await poll(
            async ({ attempt }) => {
                const list_res = await am.get_unapproved_transfer_list();
                if (list_res.status !== 200 || !list_res.data) {
                    log.warn({
                        event: 'transfer_approve_poll_hiccup',
                        queue_id: row.id,
                        status: list_res.status,
                        attempt,
                    });
                    return { done: false };
                }
                // The response shape is `{ results: [{ directory: 'name', uuid: '...' }, ...] }`
                // on most AM versions. Some emit a top-level array.
                const list = Array.isArray(list_res.data)
                    ? list_res.data
                    : Array.isArray(list_res.data.results)
                      ? list_res.data.results
                      : [];
                const match = list.find(
                    (e) =>
                        e &&
                        (e.directory === transfer_folder ||
                            (transfer_uuid && e.uuid === transfer_uuid))
                );
                if (!match) return { done: false };
                // Defense-in-depth: if start_transfer's response didn't
                // give us a usable transfer_uuid (which happens on the
                // production AM build — only `path` + `message` come
                // back), the unapproved-list entry is authoritative.
                // Capture it from there and persist before approving
                // so a worker crash between approve and status-poll
                // resumes correctly.
                if (!transfer_uuid && match.uuid) {
                    transfer_uuid = match.uuid;
                    try {
                        await model.update_queue(
                            { id: row.id },
                            { transfer_uuid },
                            {
                                actor: 'worker',
                                payload: {
                                    stage: 'transfer',
                                    step: 'transfer_uuid_resolved_via_unapproved_list',
                                    transfer_uuid,
                                },
                            }
                        );
                    } catch (err) {
                        log.warn({
                            event: 'transfer_uuid_persist_failed',
                            queue_id: row.id,
                            err: err.message,
                        });
                    }
                }
                // Approve it. If approve fails, log + keep polling —
                // a transient AM hiccup shouldn't burn the entire
                // approve budget on the first try.
                const ap_res = await am.approve_transfer(transfer_folder);
                if (ap_res.status === 200) {
                    return { done: true, value: { approved: true } };
                }
                log.warn({
                    event: 'transfer_approve_failed_retry',
                    queue_id: row.id,
                    status: ap_res.status,
                    attempt,
                });
                return { done: false };
            },
            {
                interval_ms: cfg.approve_poll_ms,
                timeout_ms: cfg.approve_timeout_ms,
                signal,
                on_attempt: async ({ error }) => {
                    log.warn({
                        event: 'transfer_approve_poll_error',
                        queue_id: row.id,
                        err: error.message,
                    });
                    return true;
                },
            }
        );
        if (approved.aborted) return { ok: false, reason: 'aborted' };
        if (approved.timed_out) {
            await halt(model, row, 'APPROVE_TIMEOUT', {
                stage: 'transfer',
                step: 'approve_poll',
                attempts: approved.attempts,
                elapsed_ms: approved.elapsed_ms,
                transfer_folder,
                transfer_uuid,
            });
            return { ok: false, reason: 'approve_timeout' };
        }

        await model.update_queue(
            { id: row.id },
            { status: 'TRANSFER_APPROVED' },
            { actor: 'worker', payload: { stage: 'transfer', step: 'approved' } }
        );
        await model.update_queue(
            { id: row.id },
            { status: 'TRANSFER_IN_PROGRESS' },
            { actor: 'worker', payload: { stage: 'transfer', step: 'in_progress' } }
        );
    }

    // --- Step 3: poll transfer_status until COMPLETE + sip_uuid ------
    //
    // We need transfer_uuid here — AM's /transfer/status/<uuid>/
    // endpoint is keyed on it. The fresh-run path picks it up from
    // start_transfer's `path` OR the approve-poll's unapproved-list
    // match (Step 2). Resume from TRANSFER_IN_PROGRESS read it off
    // the row at the top of the function. If somehow we got here
    // without one, halt.
    if (!transfer_uuid) {
        await halt(model, row, 'INGEST_HALTED', {
            stage: 'transfer',
            step: 'status_poll_no_uuid',
            transfer_folder,
        });
        return { ok: false, reason: 'transfer_uuid_missing' };
    }
    const status_outcome = await poll(
        async ({ attempt }) => {
            const st_res = await am.get_transfer_status(transfer_uuid);
            if (st_res.status !== 200 || !st_res.data) {
                log.warn({
                    event: 'transfer_status_poll_hiccup',
                    queue_id: row.id,
                    status: st_res.status,
                    attempt,
                });
                return { done: false };
            }
            const am_status = st_res.data.status;
            const am_sip = st_res.data.sip_uuid;
            const microservice = st_res.data.microservice;
            // Record the microservice so the dashboard can show "where
            // it is" without staff drilling into AM. We only write on
            // change (not every probe) to avoid event spam.
            //
            // AWAIT the update — previously this was fire-and-forget
            // ("not critical for the poll to continue"), but on the
            // FINAL poll tick (the one that returns done=true), the
            // unawaited transaction was still in-flight when the
            // subsequent TRANSFER_COMPLETE update fired. MariaDB's
            // optimistic-concurrency check detected the row checksum
            // had changed between read and write and threw
            // "Record has changed since last read in table
            // 'tbl_ingest_queue'" — a real production halt that
            // sqlite tests never reproduced. Awaiting serializes the
            // two writes and removes the race. Performance cost is
            // negligible (one extra ~10ms write per AM microservice
            // transition; poll cadence is 30s+).
            if (microservice && microservice !== row.micro_service) {
                row.micro_service = microservice; // local cache
                try {
                    await model.update_queue({ id: row.id }, { micro_service: microservice });
                } catch (err) {
                    // Best-effort: log + continue. The poll should
                    // keep running even if this column write fails
                    // (it's an informational field, not part of the
                    // state-machine contract).
                    log.warn({
                        event: 'transfer_microservice_write_failed',
                        queue_id: row.id,
                        microservice,
                        err: err.message,
                    });
                }
            }
            if (am_status === 'FAILED' || am_status === 'REJECTED') {
                return { done: true, value: { failed: true, am_status, microservice } };
            }
            if (am_status === 'COMPLETE' && am_sip) {
                return { done: true, value: { am_sip, microservice } };
            }
            return { done: false };
        },
        {
            interval_ms: cfg.transfer_poll_ms,
            timeout_ms: cfg.transfer_timeout_ms,
            signal,
            on_attempt: async ({ error }) => {
                log.warn({
                    event: 'transfer_status_poll_error',
                    queue_id: row.id,
                    err: error.message,
                });
                return true;
            },
        }
    );

    if (status_outcome.aborted) return { ok: false, reason: 'aborted' };
    if (status_outcome.timed_out) {
        await halt(model, row, 'TRANSFER_STATUS_TIMEOUT', {
            stage: 'transfer',
            step: 'status_poll',
            attempts: status_outcome.attempts,
            elapsed_ms: status_outcome.elapsed_ms,
            transfer_uuid,
        });
        return { ok: false, reason: 'transfer_status_timeout' };
    }
    if (status_outcome.result.failed) {
        // AM said the transfer itself failed — halt with FAILED so
        // staff can do an AM-side rollback (the AIP exists in AM's
        // failure bucket).
        await halt(model, row, 'FAILED', {
            stage: 'transfer',
            step: 'status_poll',
            am_status: status_outcome.result.am_status,
            microservice: status_outcome.result.microservice,
            transfer_uuid,
        });
        return { ok: false, reason: 'am_failed' };
    }

    sip_uuid = status_outcome.result.am_sip;
    await model.update_queue(
        { id: row.id },
        { status: 'TRANSFER_COMPLETE', sip_uuid },
        {
            actor: 'worker',
            payload: {
                stage: 'transfer',
                step: 'complete',
                sip_uuid,
                transfer_uuid,
                attempts: status_outcome.attempts,
                elapsed_ms: status_outcome.elapsed_ms,
            },
        }
    );

    // Best-effort: clear the transfer from AM's queue so it doesn't
    // pile up. Don't await — failure here is non-fatal.
    am.clear_transfer(transfer_uuid).catch((err) =>
        log.warn({ event: 'am_clear_transfer_failed', queue_id: row.id, err: err.message })
    );

    return { ok: true, sip_uuid, transfer_uuid };
}

async function halt(model, row, terminal_state, payload) {
    const error_text = payload.error || payload.reason || 'halted';
    await model.update_queue(
        { id: row.id },
        { status: terminal_state, error: error_text },
        { actor: 'worker', event_type: 'state_change', payload }
    );
}

// Pull the basename (last path component) out of an AM watched-dir
// `path` like "/var/.../standardTransfer/<basename>-<uuid>/". Trailing
// slash stripped before split. Returns null on falsy / non-string.
function _basename_from_path(path) {
    if (!path || typeof path !== 'string') return null;
    const trimmed = path.replace(/\/+$/, '');
    const i = trimmed.lastIndexOf('/');
    return i === -1 ? trimmed : trimmed.slice(i + 1);
}

// Pull the trailing UUID out of an AM watched-dir basename like
// `<name>-<uuid>`. AM appends `-<generated_uuid>` to the `name` we
// sent in start_transfer; the UUID is always the last `-<UUID>`
// chunk. Returns null if no canonical UUID is found.
function _trailing_uuid_from_basename(basename) {
    if (!basename || typeof basename !== 'string') return null;
    const m = basename.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    return m ? m[1].toLowerCase() : null;
}

module.exports = {
    run,
    // Exposed for tests:
    _basename_from_path,
    _trailing_uuid_from_basename,
};
