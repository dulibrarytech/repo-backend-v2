'use strict';

/*
 * Stage 4 — Archivematica ingest + post-AM checks + DuraCloud wait.
 * 
 *   entry:  TRANSFER_COMPLETE          (success path)
 *         | INGEST_IN_PROGRESS         (resume mid-ingest poll)
 *         | INGEST_COMPLETE            (resume after AM said done; needs DC)
 *         | WAITING_FOR_DURACLOUD      (resume mid-DC probe)
 *   exit:   METADATA_PROCESSED         (DC propagation confirmed)
 *         | INGEST_STATUS_TIMEOUT      (6 hr — post-AM rollback)
 *         | FAILED                     (AM reported failure mid-ingest)
 *         | AS_METADATA_DRIFT          (re-validation failed)
 *         | DURACLOUD_TIMEOUT          (access copy: budget ran out, or the
 *                                      copy can't succeed; Retry, then
 *                                      Rollback AIP)
 *         | INGEST_HALTED              (flag off: get_dip_path failed)
 * 
 * Why so many entry states:
 *   Stage 4 has three substeps that each may take hours. Resume needs
 *   to land in the right substep instead of restarting the whole
 *   stage. The state machine flags which substep was in flight when
 *   the worker crashed.
 * 
 * Substeps:
 *   1. Poll AM ingest_status(sip_uuid) every `ingest_poll_ms` until
 *      status === 'COMPLETE'. Halt at INGEST_STATUS_TIMEOUT or FAILED.
 *   2. Post-AM AS drift check: re-fetch the AS record + re-validate.
 *      The cached snapshot from stage 1 is the baseline. If staff
 *      edited the AS record while AM was processing, surface as
 *      AS_METADATA_DRIFT.
 *   3. DuraCloud wait: fetch get_dip_path(sip_uuid) to get the
 *      DC-side folder, then probe the METS file until it lands.
 *      With DIP_COPY_ENABLED (DuraCloud Preserve), wait_and_copy_dip
 *      replaces it: wait for the DIP package to be UPLOADED, then have
 *      curation copy its served files to Wasabi. Every one of its halts
 *      is DURACLOUD_TIMEOUT, whose Retry brings the row back here.
 */

const am_default = require('../../libs/archivematica');
const aspace_default = require('../../libs/archivesspace');
const duracloud_default = require('../../libs/duracloud');
const dip_store_default = require('../../libs/dip_store');
const curation_default = require('../libs/aip_store_client');
const validator_default = require('../libs/aspace_validator');
const model_default = require('../model');
const app_config = require('../../config/app');
const log = require('../../libs/log');
const { poll } = require('../lib/polling');
const { fetch_record_with_retry } = require('../../libs/aspace_session');
const { UpstreamError } = require('../../libs/errors');

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

    /*
     * --- Substep 1: poll ingest_status until terminal ----------------
     * 
     * Skipped on resume from INGEST_COMPLETE or WAITING_FOR_DURACLOUD.
     */
    if (row.pipeline_state === 'TRANSFER_COMPLETE' || row.pipeline_state === 'INGEST_IN_PROGRESS') {
        /*
         * Move to INGEST_IN_PROGRESS on fresh entry so the dashboard
         * shows the active substep.
         */
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

                /*
                 * Terminal FIRST so the terminal tick is write-free and can't
                 * race the subsequent INGEST_COMPLETE write (MariaDB
                 * optimistic-concurrency — see stages/transfer.js).
                 */
                if (am_status === 'FAILED' || am_status === 'REJECTED') {
                    return { done: true, value: { failed: true, am_status, microservice } };
                }
                if (am_status === 'COMPLETE') {
                    return { done: true, value: { microservice } };
                }

                /*
                 * In progress — heartbeat (last_poll_at) every poll for the
                 * dashboard's "checked Ns ago", plus the current microservice
                 * on change. No status → no event.
                 */
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

        /*
         * Refresh `row.pipeline_state` so the substep guards below
         * see the post-update state.
         */
        row.pipeline_state = 'INGEST_COMPLETE';
    }

    /*
     * --- Substep 2: post-AM AS drift check ---------------------------
     * 
     * Re-fetch the AS record and re-validate. Use the cached snapshot
     * from stage 1 (row.metadata) as a comparison baseline so we can
     * detect drift (staff edited the record while AM was processing).
     * 
     * Skipped on resume from WAITING_FOR_DURACLOUD — we already passed
     * the drift check before going to DC wait.
     */
    if (row.pipeline_state === 'INGEST_COMPLETE') {
        const drift_outcome = await check_for_drift(row, {
            aspace,
            validator,
            session: deps.session,
            sleep: deps.sleep,
        });
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

    if (cfg.dip_copy_enabled) {
        return wait_and_copy_dip(row, {
            am,
            curation: deps.curation || curation_default,
            dip_store: deps.dip_store || dip_store_default,
            model,
            cfg,
            signal,
            sip_uuid,
        });
    }

    /*
     * --- Substep 3: DuraCloud wait -----------------------------------
     * 
     * Resolve the DC-side folder via AM, then probe the METS file
     * until it returns 200.
     * 
     * `dip_path` is persisted to the row on first resolve so resume
     * doesn't need to re-call AM. (The path is deterministic from
     * sip_uuid + AM's storage layout, but re-resolving costs a
     * round-trip we don't need.)
     */
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
            /*
             * Not ready yet — heartbeat so the dashboard shows the DuraCloud
             * wait is alive ("checked Ns ago"), not stalled. No status → no event.
             */
            try {
                await model.update_queue({ id: row.id }, { last_poll_at: Date.now() });
            } catch (err) {
                log.warn({
                    event: 'duracloud_heartbeat_write_failed',
                    queue_id: row.id,
                    err: err.message,
                });
            }
            /*
             * 404 is the expected "not ready yet" signal during AIP
             * propagation; log only the non-404 cases to avoid noise.
             */
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

    /*
     * Success. Hand off to stage 5 (repository build). METADATA_PROCESSED
     * signals "AM done + DC reachable + AS still valid" — the canonical
     * entry point into the repository-build stage.
     */
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

/*
 * Storage Service statuses a DIP never comes back from: waiting on them
 * only burns the budget. DEL_REQ is a deletion request awaiting an admin;
 * DEL_FAIL and FAIL are a failed deletion and a failed store.
 */
const DIP_TERMINAL_STATUSES = {
    DELETED: 'dip_deleted',
    DEL_REQ: 'dip_deletion_requested',
    DEL_FAIL: 'dip_deletion_failed',
    FAIL: 'dip_failed',
};

/*
 * The last segment of a stored path, without a `.7z` suffix: the DIP's
 * folder, whether worked out from the AIP's name or read from the DIP's
 * own record.
 */
function folder_of(stored_path) {
    if (typeof stored_path !== 'string') return null;
    const segments = stored_path.split('/').filter(Boolean);
    const last = segments.length ? segments[segments.length - 1] : '';
    return last.replace(/\.7z$/, '') || null;
}

/*
 * The error text of a curation answer: `error` in a JSON object, else
 * the body itself (its auth failure is a JSON array).
 */
function detail_of(res) {
    const body = res.data;
    if (Array.isArray(body)) return body.join(' ').trim() || 'no detail';
    if (body && typeof body === 'object') return body.error || 'no detail';
    if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 200);
    return 'no detail';
}

/*
 * Errors the wait retries within its budget: the clients' UpstreamError,
 * and anything carrying a code (a Node system error, a MySQL error such as
 * ER_LOCK_DEADLOCK on the dip_path write). A TypeError has none.
 */
function is_retryable(err) {
    return err instanceof UpstreamError || Boolean(err && typeof err.code === 'string');
}

/*
 * --- Substep 3 with DIP_COPY_ENABLED: wait for the DIP, then copy it ---
 *
 * Archivematica writes the DIP to DuraCloud Preserve; the public site reads
 * the Wasabi copy of its served files. Within the old wait's budget
 * (duracloud_poll_ms / duracloud_timeout_ms), each attempt:
 *   (a) asks Archivematica for the AIP's DIP link until there is one (the
 *       old wait halts at once without it), once per run, so a resumed row
 *       asks again; records dip_path;
 *   (b) reads the DIP package record: not a DIP, deleted, a deletion
 *       request or a failure → halt; a folder other than dip_path's →
 *       halt; UPLOADED with a size → go on; anything else → try again.
 *       Its current_path goes into the events;
 *   (c) asks curation to check that the DIP is complete in DCP and copy its
 *       served files (copy_dip, with the package's size): 'incomplete' →
 *       try once more a poll interval later, then halt (the folder is
 *       final once the package is UPLOADED); 'copied' → METADATA_PROCESSED.
 * Transport and database errors (is_retryable) and curation 5xx are retried
 * within the budget, with a heartbeat; any other error halts at once. Every
 * halt is DURACLOUD_TIMEOUT: the AIP and the DIP are safe in DCP by then,
 * so the dashboard offers Retry (back to WAITING_FOR_DURACLOUD) first and
 * Rollback AIP second. The copy skips what already landed.
 */
async function wait_and_copy_dip(row, { am, curation, dip_store, model, cfg, signal, sip_uuid }) {
    const missing = [
        !curation.is_configured() && 'the curation API (CURATION_API, CURATION_API_KEY)',
        !dip_store.is_configured() && 'the DIP store (DIP_STORE_*)',
    ].filter(Boolean);
    if (missing.length) {
        await halt(model, row, 'DURACLOUD_TIMEOUT', {
            stage: 'ingest',
            step: 'dip_copy',
            reason: 'not_configured',
            error: `DIP_COPY_ENABLED is on, but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not configured`,
            sip_uuid,
        });
        return { ok: false, reason: 'dip_copy_not_configured' };
    }

    let dip_path = null;
    let dip_uuid = null;
    let dip_current_path = null;
    let incomplete_answers = 0;
    // The path, once known, rides on every later write, so no halt loses it.
    const columns = () => (dip_path ? { dip_path } : {});
    if (row.pipeline_state !== 'WAITING_FOR_DURACLOUD') {
        await model.update_queue(
            { id: row.id },
            { status: 'WAITING_FOR_DURACLOUD' },
            {
                actor: 'worker',
                payload: { stage: 'ingest', step: 'dip_wait_started', sip_uuid },
            }
        );
    }

    /*
     * Why the row is still waiting, for the timeout halt: `reason` is
     * a code, `error` the text LDT reads on the Timeline.
     */
    let waiting = {
        reason: 'dip_not_linked',
        error: 'Archivematica has not linked a DIP to this AIP',
    };
    async function wait_again(reason, error, detail = {}) {
        waiting = { reason, error, ...detail };
        try {
            await model.update_queue({ id: row.id }, { last_poll_at: Date.now() });
        } catch (err) {
            log.warn({
                event: 'dip_wait_heartbeat_write_failed',
                queue_id: row.id,
                err: err.message,
            });
        }
        return { done: false };
    }

    const outcome = await poll(
        async () => {
            if (!dip_uuid) {
                const dp = await am.get_dip_path(sip_uuid);
                if (!dp.dip_path || !dp.dip_uuid) {
                    return wait_again(
                        'dip_not_linked',
                        'Archivematica has not linked a DIP to this AIP',
                        { am_status: dp.status }
                    );
                }
                if (dp.dip_path !== row.dip_path) {
                    // No state change, so no event: the dip_copied event names it.
                    await model.update_queue({ id: row.id }, { dip_path: dp.dip_path });
                    row.dip_path = dp.dip_path;
                }
                // Set only once the path is stored: a failed write is retried next time.
                dip_path = dp.dip_path;
                dip_uuid = dp.dip_uuid;
            }

            const pkg = await am.get_dip_package(dip_uuid);
            if (pkg.status !== 200 || !pkg.data) {
                return wait_again(
                    'dip_record_unavailable',
                    `Archivematica did not return the DIP record (HTTP ${pkg.status})`
                );
            }
            dip_current_path = pkg.current_path;
            if (pkg.package_type && pkg.package_type !== 'DIP') {
                /*
                 * get_dip_path takes the AIP's first related package to be
                 * its DIP (v1's rule). If it is something else, its size
                 * can never match the DIP folder: say so now, not after
                 * the budget.
                 */
                return {
                    done: true,
                    value: {
                        halt: 'not_a_dip',
                        error: `The AIP's first related package in Archivematica is not a DIP (package type ${pkg.package_type})`,
                    },
                };
            }
            const terminal = DIP_TERMINAL_STATUSES[pkg.package_status];
            if (terminal) {
                return {
                    done: true,
                    value: {
                        halt: terminal,
                        error: `Archivematica reports the DIP as ${pkg.package_status}`,
                    },
                };
            }
            const recorded_folder = folder_of(dip_current_path);
            if (recorded_folder && recorded_folder !== folder_of(dip_path)) {
                /*
                 * dip_path is worked out from the AIP's name (v1's rule);
                 * the DIP's own record names its folder. If they differ,
                 * the rule is wrong for this package: say so now.
                 */
                return {
                    done: true,
                    value: {
                        halt: 'dip_path_mismatch',
                        error: `The DIP's folder in Archivematica (${recorded_folder}) is not the one worked out from the AIP's name (${folder_of(dip_path)})`,
                    },
                };
            }
            if (pkg.package_status !== 'UPLOADED') {
                return wait_again(
                    'dip_not_uploaded',
                    `Archivematica reports the DIP as ${pkg.package_status || 'no status'}, not UPLOADED`,
                    { package_status: pkg.package_status }
                );
            }
            if (!pkg.size) {
                return wait_again('dip_size_missing', 'Archivematica reports no size for the DIP');
            }

            const res = await curation.copy_dip(sip_uuid, dip_path, pkg.size, {
                timeout_ms: cfg.dip_copy_timeout_ms,
                signal,
            });
            const data = res.data && typeof res.data === 'object' ? res.data : {};
            if (res.status >= 500 || res.status === 429) {
                return wait_again(
                    'curation_unavailable',
                    `The curation API answered HTTP ${res.status}`
                );
            }
            if (res.status !== 200) {
                return {
                    done: true,
                    value: {
                        halt: 'dip_copy_rejected',
                        error: `The curation API refused the copy (HTTP ${res.status}): ${detail_of(res)}`,
                    },
                };
            }
            if (data.status === 'incomplete') {
                const counts = {
                    dcp_bytes: data.dcp_bytes,
                    expected_bytes: data.expected_bytes,
                    mets: data.mets,
                };
                incomplete_answers += 1;
                if (incomplete_answers > 1) {
                    /*
                     * The package is UPLOADED, so the folder in DCP is
                     * final: a second shortfall is a wrong path or size,
                     * not a slow upload. Halt rather than wait the hour.
                     */
                    return {
                        done: true,
                        value: {
                            halt: 'dip_incomplete',
                            error: `Archivematica reports the DIP as stored, but ${data.error || 'it is not complete in DCP'}`,
                            detail: counts,
                        },
                    };
                }
                return wait_again(
                    'dip_incomplete',
                    data.error || 'The DIP is not complete in DCP yet',
                    counts
                );
            }
            if (data.ok === true && data.status === 'copied') {
                return { done: true, value: { copied: data } };
            }
            return {
                done: true,
                value: {
                    halt: 'dip_copy_failed',
                    error: data.error || 'The DIP copy failed',
                    failures: Array.isArray(data.failures) ? data.failures : undefined,
                },
            };
        },
        {
            interval_ms: cfg.duracloud_poll_ms,
            timeout_ms: cfg.duracloud_timeout_ms,
            signal,
            on_attempt: async ({ error }) => {
                if (!is_retryable(error)) return false;
                log.warn({ event: 'dip_wait_error', queue_id: row.id, err: error.message });
                await wait_again('upstream_error', error.message);
                return true;
            },
        }
    ).catch((err) => ({ unexpected: err }));

    if (outcome.unexpected) {
        /*
         * Not a transport or database error: a bug or a changed client.
         * Halt now, with the message, rather than retry it for an hour.
         */
        const err = outcome.unexpected;
        log.error({
            event: 'dip_wait_unexpected_error',
            queue_id: row.id,
            err: err.message,
            stack: err.stack,
        });
        await halt(
            model,
            row,
            'DURACLOUD_TIMEOUT',
            {
                stage: 'ingest',
                step: 'dip_wait',
                reason: 'unexpected_error',
                error: `The access-copy wait failed: ${err.message}`,
                sip_uuid,
                dip_uuid,
                dip_path,
                dip_current_path,
            },
            columns()
        );
        return { ok: false, reason: 'unexpected_error' };
    }
    if (outcome.aborted) return { ok: false, reason: 'aborted' };
    if (outcome.timed_out) {
        await halt(
            model,
            row,
            'DURACLOUD_TIMEOUT',
            {
                stage: 'ingest',
                step: 'dip_wait',
                ...waiting,
                error: `Still waiting when the budget ran out: ${waiting.error}`,
                attempts: outcome.attempts,
                elapsed_ms: outcome.elapsed_ms,
                sip_uuid,
                dip_uuid,
                dip_path,
                dip_current_path,
            },
            columns()
        );
        return { ok: false, reason: 'duracloud_timeout' };
    }
    if (outcome.result.halt) {
        await halt(
            model,
            row,
            'DURACLOUD_TIMEOUT',
            {
                stage: 'ingest',
                step: 'dip_copy',
                reason: outcome.result.halt,
                error: outcome.result.error,
                failures: outcome.result.failures,
                ...(outcome.result.detail || {}),
                sip_uuid,
                dip_uuid,
                dip_path,
                dip_current_path,
            },
            columns()
        );
        return { ok: false, reason: outcome.result.halt };
    }

    const copied = outcome.result.copied;
    await model.update_queue(
        { id: row.id },
        { status: 'METADATA_PROCESSED', ...columns() },
        {
            actor: 'worker',
            payload: {
                stage: 'ingest',
                step: 'dip_copied',
                sip_uuid,
                dip_uuid,
                dip_path,
                dip_current_path,
                files: copied.files,
                bytes: copied.bytes,
                verified: copied.verified,
                attempts: outcome.attempts,
                elapsed_ms: outcome.elapsed_ms,
            },
        }
    );
    return { ok: true, sip_uuid, dip_path };
}

/*
 * Detect drift between the cached AS snapshot (taken at stage 1) and
 * the current AS state. We need a non-empty validator result OR a
 * structural change (different identifiers, different parts) to halt;
 * surface-level edits (title typo fix, etc.) we let through.
 * 
 * v1's behavior was "re-run the same validator; if it now errors,
 * it's drift". We keep that contract — extra-strict drift detection
 * (e.g. structural diff) is a future enhancement.
 */
async function check_for_drift(row, { aspace, validator, session, sleep }) {
    try {
        /*
         * Shared session + transport retry (2026-07-29 burst
         * hardening) — same treatment as stage 1's fetch; see
         * libs/aspace_session.js.
         */
        const res = await fetch_record_with_retry(row.metadata_uri, {
            aspace,
            session,
            sleep,
        });
        if (res.status !== 200 || !res.data) {
            /*
             * We couldn't re-fetch; treat that as a non-drift halt
             * signal. Caller maps to AS_METADATA_DRIFT for staff
             * visibility (the AM-side AIP exists, so this is a
             * post-AM failure regardless).
             */
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

async function halt(model, row, terminal_state, payload, columns = {}) {
    const error_text = payload.errors
        ? payload.errors.slice(0, 5).join('; ').slice(0, 1000)
        : payload.error || payload.reason || 'halted';
    await model.update_queue(
        { id: row.id },
        { status: terminal_state, error: error_text, ...columns },
        { actor: 'worker', event_type: 'state_change', payload }
    );
}

module.exports = { run, _check_for_drift: check_for_drift };
