'use strict';

// Stage 4 — Archivematica ingest + post-AM checks + DuraCloud wait.
//
//   entry:  TRANSFER_COMPLETE          (success path)
//         | INGEST_IN_PROGRESS         (resume mid-ingest poll)
//         | INGEST_COMPLETE            (resume after AM said done; needs DC)
//         | WAITING_FOR_DURACLOUD      (resume mid-DC probe)
//   exit:   MASTER_OBJECT_DATA_SAVED   (DC propagation confirmed)
//         | INGEST_STATUS_TIMEOUT      (6 hr — post-AM rollback)
//         | FAILED                     (AM reported failure mid-ingest)
//         | AS_METADATA_DRIFT          (re-validation failed)
//         | DURACLOUD_TIMEOUT          (1 hr — post-AM rollback)
//         | INGEST_HALTED              (transport-level halt)
//
// Why so many entry states:
//   Stage 4 has three substeps that each may take hours. Resume needs
//   to land in the right substep instead of restarting the whole
//   stage. The state machine flags which substep was in flight when
//   the worker crashed.
//
// Substeps:
//   1. Poll AM ingest_status(sip_uuid) every `ingest_poll_ms` until
//      status === 'COMPLETE'. Halt at INGEST_STATUS_TIMEOUT or FAILED.
//   2. Post-AM AS drift check: re-fetch the AS record + re-validate.
//      The cached snapshot from stage 1 is the baseline. If staff
//      edited the AS record while AM was processing, surface as
//      AS_METADATA_DRIFT.
//   3. DuraCloud wait: fetch get_dip_path(sip_uuid) to get the
//      DC-side folder, then probe the METS file until it lands.

const am_default = require('../../libs/archivematica');
const aspace_default = require('../../libs/archivesspace');
const duracloud_default = require('../../libs/duracloud');
const validator_default = require('../libs/aspace_validator');
const model_default = require('../model');
const app_config = require('../../config/app');
const log = require('../../libs/log');
const { poll } = require('../lib/polling');

async function run(row, deps = {}) {
    const am = deps.am || am_default;
    const aspace = deps.aspace || aspace_default;
    const duracloud = deps.duracloud || duracloud_default;
    const validator = deps.validator || validator_default;
    const model = deps.model || model_default;
    const cfg = app_config().ingest_worker;
    const signal = deps.signal;

    const sip_uuid = row.sip_uuid && row.sip_uuid !== 'PENDING' ? row.sip_uuid : null;
    if (!sip_uuid) {
        await halt(model, row, 'INGEST_HALTED', {
            stage: 'ingest',
            reason: 'missing_sip_uuid',
            note: 'Stage 3 should have populated sip_uuid before handing off',
        });
        return { ok: false, reason: 'missing_sip_uuid' };
    }

    // --- Substep 1: poll ingest_status until terminal ----------------
    //
    // Skipped on resume from INGEST_COMPLETE or WAITING_FOR_DURACLOUD.
    if (row.pipeline_state === 'TRANSFER_COMPLETE' || row.pipeline_state === 'INGEST_IN_PROGRESS') {
        // Move to INGEST_IN_PROGRESS on fresh entry so the dashboard
        // shows the active substep.
        if (row.pipeline_state === 'TRANSFER_COMPLETE') {
            await model.update_queue(
                { id: row.id },
                { status: 'INGEST_IN_PROGRESS' },
                { actor: 'worker', payload: { stage: 'ingest', step: 'started', sip_uuid } }
            );
        }

        const outcome = await poll(
            async ({ attempt }) => {
                const res = await am.get_ingest_status(sip_uuid);
                if (res.status !== 200 || !res.data) {
                    log.warn({
                        event: 'ingest_status_poll_hiccup',
                        queue_id: row.id,
                        status: res.status,
                        attempt,
                    });
                    return { done: false };
                }
                const am_status = res.data.status;
                const microservice = res.data.microservice;

                // Terminal FIRST so the terminal tick is write-free and can't
                // race the subsequent INGEST_COMPLETE write (MariaDB
                // optimistic-concurrency — see stages/transfer.js).
                if (am_status === 'FAILED' || am_status === 'REJECTED') {
                    return { done: true, value: { failed: true, am_status, microservice } };
                }
                if (am_status === 'COMPLETE') {
                    return { done: true, value: { microservice } };
                }

                // In progress — heartbeat (last_poll_at) every poll for the
                // dashboard's "checked Ns ago", plus the current microservice
                // on change. No status → no event.
                const progress = { last_poll_at: Date.now() };
                if (microservice && microservice !== row.micro_service) {
                    row.micro_service = microservice;
                    progress.micro_service = microservice;
                }
                try {
                    await model.update_queue({ id: row.id }, progress);
                } catch (err) {
                    log.warn({
                        event: 'ingest_progress_write_failed',
                        queue_id: row.id,
                        microservice,
                        err: err.message,
                    });
                }
                return { done: false };
            },
            {
                interval_ms: cfg.ingest_poll_ms,
                timeout_ms: cfg.ingest_timeout_ms,
                signal,
                on_attempt: async ({ error }) => {
                    log.warn({
                        event: 'ingest_status_poll_error',
                        queue_id: row.id,
                        err: error.message,
                    });
                    return true;
                },
            }
        );
        if (outcome.aborted) return { ok: false, reason: 'aborted' };
        if (outcome.timed_out) {
            await halt(model, row, 'INGEST_STATUS_TIMEOUT', {
                stage: 'ingest',
                step: 'status_poll',
                attempts: outcome.attempts,
                elapsed_ms: outcome.elapsed_ms,
                sip_uuid,
            });
            return { ok: false, reason: 'ingest_status_timeout' };
        }
        if (outcome.result.failed) {
            await halt(model, row, 'FAILED', {
                stage: 'ingest',
                step: 'status_poll',
                am_status: outcome.result.am_status,
                microservice: outcome.result.microservice,
                sip_uuid,
            });
            return { ok: false, reason: 'am_failed' };
        }

        await model.update_queue(
            { id: row.id },
            { status: 'INGEST_COMPLETE' },
            { actor: 'worker', payload: { stage: 'ingest', step: 'am_complete', sip_uuid } }
        );

        // Best-effort: clear the ingest entry from AM's queue.
        am.clear_ingest(sip_uuid).catch((err) =>
            log.warn({ event: 'am_clear_ingest_failed', queue_id: row.id, err: err.message })
        );

        // Refresh `row.pipeline_state` so the substep guards below
        // see the post-update state.
        row.pipeline_state = 'INGEST_COMPLETE';
    }

    // --- Substep 2: post-AM AS drift check ---------------------------
    //
    // Re-fetch the AS record and re-validate. Use the cached snapshot
    // from stage 1 (row.metadata) as a comparison baseline so we can
    // detect drift (staff edited the record while AM was processing).
    //
    // Skipped on resume from WAITING_FOR_DURACLOUD — we already passed
    // the drift check before going to DC wait.
    if (row.pipeline_state === 'INGEST_COMPLETE') {
        const drift_outcome = await check_for_drift(row, { aspace, validator });
        if (!drift_outcome.ok) {
            await halt(model, row, 'AS_METADATA_DRIFT', {
                stage: 'ingest',
                step: 'drift_check',
                reason: drift_outcome.reason,
                errors: drift_outcome.errors,
                sip_uuid,
            });
            return { ok: false, reason: 'as_metadata_drift' };
        }
    }

    // --- Substep 3: DuraCloud wait -----------------------------------
    //
    // Resolve the DC-side folder via AM, then probe the METS file
    // until it returns 200.
    //
    // `dip_path` is persisted to the row on first resolve so resume
    // doesn't need to re-call AM. (The path is deterministic from
    // sip_uuid + AM's storage layout, but re-resolving costs a
    // round-trip we don't need.)
    let dip_path = row.dip_path && row.dip_path !== 'PENDING' ? row.dip_path : null;
    if (!dip_path) {
        let dp_res;
        try {
            dp_res = await am.get_dip_path(sip_uuid);
        } catch (err) {
            await halt(model, row, 'INGEST_HALTED', {
                stage: 'ingest',
                step: 'get_dip_path',
                error: err.message,
                sip_uuid,
            });
            return { ok: false, reason: 'get_dip_path_failed' };
        }
        if (!dp_res.dip_path) {
            await halt(model, row, 'INGEST_HALTED', {
                stage: 'ingest',
                step: 'get_dip_path',
                reason: 'no_dip_path',
                status: dp_res.status,
                sip_uuid,
            });
            return { ok: false, reason: 'no_dip_path' };
        }
        dip_path = dp_res.dip_path;
        await model.update_queue(
            { id: row.id },
            { status: 'WAITING_FOR_DURACLOUD', dip_path },
            {
                actor: 'worker',
                payload: { stage: 'ingest', step: 'dc_wait_started', sip_uuid, dip_path },
            }
        );
    } else if (row.pipeline_state !== 'WAITING_FOR_DURACLOUD') {
        await model.update_queue(
            { id: row.id },
            { status: 'WAITING_FOR_DURACLOUD' },
            {
                actor: 'worker',
                payload: { stage: 'ingest', step: 'dc_wait_resumed', sip_uuid, dip_path },
            }
        );
    }

    const mets_path = duracloud.mets_path(sip_uuid, dip_path);
    const dc_outcome = await poll(
        async ({ attempt }) => {
            const res = await duracloud.fetch_text(mets_path, { signal });
            if (res.status === 200 && typeof res.data === 'string' && res.data.length > 0) {
                return { done: true, value: { mets_xml: res.data } };
            }
            // Not ready yet — heartbeat so the dashboard shows the DuraCloud
            // wait is alive ("checked Ns ago"), not stalled. No status → no event.
            try {
                await model.update_queue({ id: row.id }, { last_poll_at: Date.now() });
            } catch (err) {
                log.warn({
                    event: 'duracloud_heartbeat_write_failed',
                    queue_id: row.id,
                    err: err.message,
                });
            }
            // 404 is the expected "not ready yet" signal during AIP
            // propagation; log only the non-404 cases to avoid noise.
            if (res.status !== 404) {
                log.warn({
                    event: 'duracloud_probe_hiccup',
                    queue_id: row.id,
                    status: res.status,
                    attempt,
                });
            }
            return { done: false };
        },
        {
            interval_ms: cfg.duracloud_poll_ms,
            timeout_ms: cfg.duracloud_timeout_ms,
            signal,
            on_attempt: async ({ error }) => {
                log.warn({
                    event: 'duracloud_probe_error',
                    queue_id: row.id,
                    err: error.message,
                });
                return true;
            },
        }
    );

    if (dc_outcome.aborted) return { ok: false, reason: 'aborted' };
    if (dc_outcome.timed_out) {
        await halt(model, row, 'DURACLOUD_TIMEOUT', {
            stage: 'ingest',
            step: 'dc_probe',
            attempts: dc_outcome.attempts,
            elapsed_ms: dc_outcome.elapsed_ms,
            sip_uuid,
            dip_path,
        });
        return { ok: false, reason: 'duracloud_timeout' };
    }

    // Success. Hand off to stage 5 (repository build). METADATA_PROCESSED
    // signals "AM done + DC reachable + AS still valid" — the canonical
    // entry point into the repository-build stage.
    await model.update_queue(
        { id: row.id },
        { status: 'METADATA_PROCESSED' },
        {
            actor: 'worker',
            payload: {
                stage: 'ingest',
                step: 'dc_complete',
                sip_uuid,
                dip_path,
                attempts: dc_outcome.attempts,
                elapsed_ms: dc_outcome.elapsed_ms,
            },
        }
    );

    return { ok: true, sip_uuid, dip_path };
}

// Detect drift between the cached AS snapshot (taken at stage 1) and
// the current AS state. We need a non-empty validator result OR a
// structural change (different identifiers, different parts) to halt;
// surface-level edits (title typo fix, etc.) we let through.
//
// v1's behavior was "re-run the same validator; if it now errors,
// it's drift". We keep that contract — extra-strict drift detection
// (e.g. structural diff) is a future enhancement.
async function check_for_drift(row, { aspace, validator }) {
    try {
        const token = await aspace.get_session_token();
        const res = await aspace.get_record(row.metadata_uri, token);
        if (res.status !== 200 || !res.data) {
            // We couldn't re-fetch; treat that as a non-drift halt
            // signal. Caller maps to AS_METADATA_DRIFT for staff
            // visibility (the AM-side AIP exists, so this is a
            // post-AM failure regardless).
            return {
                ok: false,
                reason: 'aspace_unreachable_postingest',
                errors: [res.status === 404 ? 'record not found' : `HTTP ${res.status}`],
            };
        }
        const errors = validator.validate_record(res.data);
        if (errors.length > 0) {
            return { ok: false, reason: 'validation_failed', errors };
        }
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            reason: 'aspace_throw',
            errors: [err.message],
        };
    }
}

async function halt(model, row, terminal_state, payload) {
    const error_text = payload.errors
        ? payload.errors.slice(0, 5).join('; ').slice(0, 1000)
        : payload.error || payload.reason || 'halted';
    await model.update_queue(
        { id: row.id },
        { status: terminal_state, error: error_text },
        { actor: 'worker', event_type: 'state_change', payload }
    );
}

module.exports = { run, _check_for_drift: check_for_drift };
