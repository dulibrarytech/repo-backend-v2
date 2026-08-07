'use strict';

/*
 * Stage 6 — preservation copy to Wasabi S3.
 *
 *   entry:  AIP_STORE_PENDING       (success path, from Stage 5)
 *         | AIP_STORE_IN_PROGRESS   (resume mid-copy)
 *   exit:   AIP_STORE_COMPLETE      (success, is_complete=1)
 *         | AIP_STORE_FAILED        (retries exhausted; reopened only by the
 *                                    dashboard "Retry" button)
 *
 * Steps:
 *   1. Resolve the repository PID for the row (tbl_objects.sip_uuid). The
 *      queue's sip_uuid is passed through to curation as the aip_uuid.
 *   2. Idempotency check: a tbl_aip_store row for this PID already in the
 *      success set transitions straight to AIP_STORE_COMPLETE.
 *   3. Call curation /api/v2/aip/copy-to-wasabi. Synchronous, and can run for
 *      hours on a large AIP; bounded by cfg.aip_store.copy_timeout_ms.
 *   4. On success: upsert tbl_aip_store with key, bucket, bytes and copied_at,
 *      then AIP_STORE_COMPLETE + is_complete=1.
 *   5. On failure: increment attempts, compute the backoff, write
 *      next_attempt_at. Below max_attempts the row returns to
 *      AIP_STORE_PENDING for the next tick; at max_attempts it becomes
 *      AIP_STORE_FAILED with is_complete=0, so it stays in the queue view.
 *
 * A terminal orphan (see _is_am_not_found_error) is the one failure that exits
 * with is_complete=1.
 *
 * Stage 6 keeps no sub-state: the curation endpoint is idempotent, so a resume
 * simply re-runs the same request.
 */

const aip_store_client_default = require('../libs/aip_store_client');
const aip_store_model_default = require('../../repository/aip_store_model');
const model_default = require('../model');
const app_config = require('../../config/app');
const log = require('../../libs/log');
const { UpstreamError } = require('../../libs/errors');

async function run(row, deps = {}) {
    const client = deps.client || aip_store_client_default;
    const aip_store_model = deps.aip_store_model || aip_store_model_default;
    const model = deps.model || model_default;
    const signal = deps.signal;
    const cfg = app_config().aip_store;

    /*
     * Disabled mid-run: drain rows already at AIP_STORE_PENDING to COMPLETE
     * without contacting Wasabi, so they exit the queue view.
     */
    if (!cfg.enabled) {
        log.info({
            event: 'aip_store_skipped_disabled',
            queue_id: row.id,
        });
        await model.update_queue(
            { id: row.id },
            { status: 'COMPLETE', is_complete: 1 },
            {
                actor: 'worker',
                payload: { stage: 'aip_store', step: 'skipped_disabled' },
            }
        );
        return { ok: true, skipped: 'aip_store_disabled' };
    }

    // Misconfigured client drains the same way. Logged loudly.
    if (!client.is_configured()) {
        log.warn({
            event: 'aip_store_skipped_client_not_configured',
            queue_id: row.id,
        });
        await model.update_queue(
            { id: row.id },
            { status: 'COMPLETE', is_complete: 1 },
            {
                actor: 'worker',
                payload: {
                    stage: 'aip_store',
                    step: 'skipped_client_not_configured',
                },
            }
        );
        return { ok: true, skipped: 'client_not_configured' };
    }

    if (!row.sip_uuid || row.sip_uuid === 'PENDING') {
        // No AM UUID, nothing to copy. Non-fatal — Stage 5 already succeeded.
        log.warn({ event: 'aip_store_no_sip_uuid', queue_id: row.id });
        await model.update_queue(
            { id: row.id },
            { status: 'COMPLETE', is_complete: 1 },
            {
                actor: 'worker',
                payload: { stage: 'aip_store', step: 'skipped_no_sip_uuid' },
            }
        );
        return { ok: true, skipped: 'no_sip_uuid' };
    }

    /*
     * The repository PID this AIP belongs to, read from tbl_objects. The queue
     * row's `package` column is the staging folder name, NOT the repo PID.
     */
    const pid = await _resolve_repo_pid(deps, row);
    if (!pid) {
        // Defensive: skip rather than write a tbl_aip_store row with a bogus uuid.
        log.warn({
            event: 'aip_store_no_repo_pid',
            queue_id: row.id,
            sip_uuid: row.sip_uuid,
        });
        await model.update_queue(
            { id: row.id },
            { status: 'COMPLETE', is_complete: 1 },
            {
                actor: 'worker',
                payload: {
                    stage: 'aip_store',
                    step: 'skipped_no_repo_pid',
                    sip_uuid: row.sip_uuid,
                },
            }
        );
        return { ok: true, skipped: 'no_repo_pid' };
    }

    /*
     * Already copied — by the legacy migration or a prior successful Stage 6.
     * Short-circuits without re-calling Wasabi.
     */
    const existing = await aip_store_model.get_by_uuid(pid);
    if (existing && aip_store_model.is_terminal_success(existing)) {
        log.info({
            event: 'aip_store_already_copied',
            queue_id: row.id,
            pid,
            aip_store_id: existing.id,
        });
        await model.update_queue(
            { id: row.id },
            { status: 'AIP_STORE_COMPLETE', is_complete: 1 },
            {
                actor: 'worker',
                payload: {
                    stage: 'aip_store',
                    step: 'already_copied',
                    pid,
                    wasabi_key: existing.wasabi_key || existing.aip,
                },
            }
        );
        return { ok: true, skipped: 'already_copied', aip_store_id: existing.id };
    }

    /*
     * Already tagged an orphan: dead-letter immediately, without calling
     * curation or burning an attempt. Retry cannot fix it.
     */
    if (existing && aip_store_model.is_orphan(existing)) {
        log.info({
            event: 'aip_store_skip_orphan',
            queue_id: row.id,
            pid,
            aip_store_id: existing.id,
        });
        await model.update_queue(
            { id: row.id },
            {
                status: 'AIP_STORE_FAILED',
                is_complete: 1,
                error: 'AIP marked as orphan (AM 404 on prior attempt). Use the AIPs page → status=orphan to investigate.',
            },
            {
                actor: 'worker',
                payload: {
                    stage: 'aip_store',
                    step: 'skipped_orphan',
                    pid,
                    aip_store_id: existing.id,
                },
            }
        );
        return { ok: false, skipped: 'orphan', aip_store_id: existing.id };
    }

    /*
     * Backoff guard — a next_attempt_at in the future exits early without
     * burning an attempt or contacting curation, and WITHOUT writing the queue
     * row: it is already at AIP_STORE_PENDING, so leaving it untouched keeps
     * the worker's next-tick claim eligibility correct. Each tick re-runs this
     * entry until next_attempt_at elapses.
     */
    if (
        existing &&
        existing.next_attempt_at &&
        new Date(existing.next_attempt_at) > new Date()
    ) {
        log.debug({
            event: 'aip_store_backoff_wait',
            queue_id: row.id,
            pid,
            next_attempt_at: existing.next_attempt_at,
            attempts: existing.attempts,
        });
        return {
            ok: false,
            skipped: 'backoff',
            next_attempt_at: existing.next_attempt_at,
        };
    }

    // Distinct phase for the dashboard, and where a post-crash resume lands.
    if (row.pipeline_state !== 'AIP_STORE_IN_PROGRESS') {
        await model.update_queue(
            { id: row.id },
            {
                status: 'AIP_STORE_IN_PROGRESS',
                /*
                 * Zeroed: these still hold Stage 2's upload bytes and Stage 4's
                 * last microservice, which the dashboard would render as Stage 6
                 * progress. The side-poll below refills them.
                 */
                bytes_uploaded: 0,
                total_bytes: 0,
                micro_service: 'PENDING',
            },
            {
                actor: 'worker',
                payload: {
                    stage: 'aip_store',
                    step: 'started',
                    pid,
                    sip_uuid: row.sip_uuid,
                },
            }
        );
    }

    // ---- Make the call -------------------------------------------------

    /*
     * copy_to_wasabi is ONE synchronous call that can run for hours, so poll
     * the curation copy-progress endpoint alongside it and persist bytes plus a
     * heartbeat to the queue row. Best-effort; see _start_progress_poller.
     */
    const progress_poller = _start_progress_poller({
        client,
        model,
        cfg,
        queue_id: row.id,
        aip_uuid: row.sip_uuid,
    });

    /*
     * Source selection (2026-08-01). Default source is AM Storage; the
     * AIPs dashboard's "Retry from DuraCloud" stamps the tbl_aip_store
     * row with message=RETRY_FROM_DURACLOUD, and every attempt in that
     * retry budget then copies from DuraCloud's aip-store replica
     * instead (AM's download path can't serve 66-75 GB AIPs — hangs,
     * then 502s). _record_failure preserves the flag while attempts
     * remain, so the whole budget stays on the chosen source.
     */
    const use_duracloud = Boolean(
        existing &&
            existing.message === 'RETRY_FROM_DURACLOUD' &&
            typeof client.copy_from_duracloud === 'function'
    );

    let res;
    try {
        const copy_opts = {
            timeout_ms: cfg.copy_timeout_ms,
            // Rides into the HTTP request, so a Stop tears the call down at once.
            signal,
        };
        res = use_duracloud
            ? await client.copy_from_duracloud(row.sip_uuid, pid, copy_opts)
            : await client.copy_to_wasabi(row.sip_uuid, pid, copy_opts);
    } catch (err) {
        if (signal && signal.aborted) {
            /*
             * Aborted, not failed. Recording a failure would burn an attempt
             * AND race the Stop handler's row write, potentially flipping the
             * row back to AIP_STORE_PENDING after staff parked it.
             */
            return { ok: false, aborted: true };
        }
        // Transport-level (timeout, network, TLS). Always retryable.
        return await _record_failure({
            aip_store_model,
            model,
            cfg,
            row,
            pid,
            error_text: err instanceof UpstreamError ? err.message : String(err),
            wire_status: null,
            use_duracloud,
        });
    } finally {
        // Must run on every exit path, or the interval keeps writing to the row.
        progress_poller.stop();
    }
    if (signal && signal.aborted) {
        // Graceful shutdown: leave the row as-is; the next boot resumes.
        return { ok: false, aborted: true };
    }

    /*
     * Two failure modes: a non-2xx status, or a 2xx whose body reports
     * data.ok === false (AM file missing, Wasabi auth refused, …). The body
     * shape is documented in ingester/libs/aip_store_client.js.
     */
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    if (res.status < 200 || res.status >= 300 || data.ok !== true) {
        const error_text =
            data.error ||
            `curation ${use_duracloud ? '/copy-from-duracloud' : '/copy-to-wasabi'} returned HTTP ${res.status}`;
        return await _record_failure({
            aip_store_model,
            model,
            cfg,
            row,
            pid,
            error_text,
            wire_status: res.status,
            use_duracloud,
        });
    }

    // ---- Success -------------------------------------------------------

    const bucket = data.bucket || null;
    const key = data.key || null;
    const bytes = Number.isFinite(data.bytes) ? data.bytes : null;
    const copied_at = new Date();
    const upsert = await aip_store_model.upsert_by_uuid(pid, {
        aip_uuid: row.sip_uuid,
        // Legacy column: the basename only. The full key lives in wasabi_key.
        aip: key ? key.split('/').pop() : '',
        wasabi_bucket: bucket,
        wasabi_key: key,
        bytes,
        copied_at,
        source: aip_store_model.SOURCE.INGEST_V2,
        is_migrated: aip_store_model.STATUS.INGEST_COPIED_OK,
        attempts: 0,
        next_attempt_at: null,
        error: null,
        /*
         * Provenance: which source actually served the bytes. The
         * response's `source` field is authoritative — since the
         * 2026-08-03 large-AIP routing, the curation side can serve
         * from DuraCloud even on a plain copy_to_wasabi call.
         */
        message:
            use_duracloud || data.source === 'duracloud'
                ? 'COPIED_FROM_DURACLOUD'
                : null,
    });

    await model.update_queue(
        { id: row.id },
        { status: 'AIP_STORE_COMPLETE', is_complete: 1 },
        {
            actor: 'worker',
            payload: {
                stage: 'aip_store',
                step: 'complete',
                pid,
                aip_store_id: upsert.id,
                wasabi_bucket: bucket,
                wasabi_key: key,
                bytes,
                elapsed_ms: data.elapsed_ms || null,
            },
        }
    );

    return {
        ok: true,
        pid,
        aip_store_id: upsert.id,
        bucket,
        key,
        bytes,
    };
}

/*
 * Start the byte-progress side-poll for an in-flight copy. Returns { stop() }.
 * Every `cfg.progress_poll_ms` (0 disables), GET the curation copy-progress
 * endpoint and persist what came back to the queue row:
 *
 *   200 + {bytes_sent, total_bytes}  → bytes_uploaded/total_bytes +
 *                                      last_poll_at (live bar + heartbeat)
 *   anything else (404, old build)   → last_poll_at only (the heartbeat still
 *                                      proves the worker is alive)
 *
 * Updates carry NO status, so enrich_update writes no events and a multi-hour
 * copy cannot flood the timeline. Every failure is swallowed (log-only):
 * progress display must never affect the copy's outcome. The interval is
 * unref'd so a hung poll cannot hold the process open on shutdown. Clients
 * without copy_progress (older builds, test doubles) disable the poller.
 */
function _start_progress_poller({ client, model, cfg, queue_id, aip_uuid }) {
    const poll_ms = cfg.progress_poll_ms;
    if (!poll_ms || poll_ms <= 0 || typeof client.copy_progress !== 'function') {
        return { stop() {} };
    }
    let stopped = false;
    let in_flight = false;
    const timer = setInterval(async () => {
        if (stopped || in_flight) return;
        in_flight = true;
        try {
            const res = await client.copy_progress(aip_uuid);
            if (stopped) return;
            const progress = { last_poll_at: Date.now() };
            const data = res.status === 200 && res.data && typeof res.data === 'object'
                ? res.data
                : null;
            if (data && Number.isFinite(Number(data.bytes_sent))) {
                progress.bytes_uploaded = Number(data.bytes_sent);
                if (Number.isFinite(Number(data.total_bytes)) && Number(data.total_bytes) > 0) {
                    progress.total_bytes = Number(data.total_bytes);
                }
            }
            await model.update_queue({ id: queue_id }, progress);
        } catch (err) {
            log.debug({
                event: 'aip_store_progress_poll_failed',
                queue_id,
                aip_uuid,
                err: err.message,
            });
        } finally {
            in_flight = false;
        }
    }, poll_ms);
    if (timer.unref) timer.unref();
    return {
        stop() {
            stopped = true;
            clearInterval(timer);
        },
    };
}

/*
 * The repository PID Stage 5 created for this queue row, or null. Joined on
 * tbl_objects.sip_uuid, the identifier Stage 5's _insert sets. Tests inject a
 * `find_repo_pid_by_sip` stub through deps.
 */
async function _resolve_repo_pid(deps, row) {
    if (deps.find_repo_pid_by_sip) {
        return deps.find_repo_pid_by_sip(row.sip_uuid);
    }
    // Direct DB read, to avoid a circular import with repository/model.
    const { db } = require('../../config/db');
    const tables = require('../../config/db_tables');
    const obj = await db()(tables.objects)
        .select('pid')
        .where({ sip_uuid: row.sip_uuid })
        .first();
    return obj ? obj.pid : null;
}

/*
 * Detect the "AM Storage Service returned 404" failure mode by matching the
 * curation /copy-to-wasabi error text, whose exact phrasing is the documented
 * wire contract (digitaldu-backend-curation-service_latest/lib/aip_ops.py:
 * `f'AIP {aip_uuid} not found in AM Storage Service'`).
 *
 * A match is NOT immediately terminal — see the not-found attempt budget in
 * _record_failure.
 */
function _is_am_not_found_error(error_text) {
    /*
     * Two ambiguous not-found shapes share the generous retry budget:
     *   - AM's "not found in AM Storage Service" — a large AIP may
     *     register in the Storage Service late.
     *   - DuraCloud's "not found in DuraCloud (not replicated yet?)"
     *     — AM replicates to DuraCloud asynchronously, so a fresh
     *     large AIP (routed to the DuraCloud source by default since
     *     2026-08-03) may simply not be there yet.
     * Both usually resolve with time; neither should burn the short
     * budget or dead-letter on first sight.
     */
    return /not found in (AM Storage Service|DuraCloud)/i.test(error_text || '');
}

/*
 * Common failure path: write a tbl_aip_store row, then decide whether to retry
 * or terminate. Increments attempts, computes the backoff, sets the outcome.
 */
async function _record_failure({
    aip_store_model,
    model,
    cfg,
    row,
    pid,
    error_text,
    wire_status,
    use_duracloud = false,
}) {
    // 1000 chars matches the column width and caps a giant HTML error page.
    const truncated = String(error_text || 'unknown error').slice(0, 1000);

    // For the attempts counter. A read failure still records a fresh failure.
    let existing = null;
    try {
        existing = await aip_store_model.get_by_uuid(pid);
    } catch (err) {
        log.warn({
            event: 'aip_store_existing_read_failed',
            queue_id: row.id,
            pid,
            err: err.message,
        });
    }
    const prior_attempts = existing && Number.isFinite(existing.attempts) ? existing.attempts : 0;
    const next_attempts = prior_attempts + 1;
    /*
     * A not-found gets its own, more generous attempt budget
     * (not_found_max_attempts, default 8) because the message is ambiguous
     * between a genuine orphan and a large AIP that AM has not finished
     * registering yet. Everything else uses max_attempts (default 5).
     */
    const is_not_found = _is_am_not_found_error(truncated);
    const max_attempts = is_not_found
        ? cfg.not_found_max_attempts > 0
            ? cfg.not_found_max_attempts
            : 8
        : cfg.max_attempts > 0
          ? cfg.max_attempts
          : 5;

    /*
     * Terminal orphan — only once a not-found has persisted through its full
     * budget. Tags AM_NOT_FOUND (is_migrated=8), which the backfill
     * eligibility filter excludes, and dead-letters the queue row.
     */
    if (is_not_found && next_attempts >= max_attempts) {
        try {
            await aip_store_model.upsert_by_uuid(pid, {
                aip_uuid: row.sip_uuid,
                source: aip_store_model.SOURCE.INGEST_V2,
                is_migrated: aip_store_model.STATUS.AM_NOT_FOUND,
                attempts: next_attempts,
                next_attempt_at: null,
                error: truncated,
                message: 'ORPHAN_AM_NOT_FOUND',
            });
        } catch (err) {
            log.warn({
                event: 'aip_store_upsert_failed',
                queue_id: row.id,
                pid,
                err: err.message,
            });
        }
        await model.update_queue(
            { id: row.id },
            {
                status: 'AIP_STORE_FAILED',
                is_complete: 1,
                error: truncated,
            },
            {
                actor: 'worker',
                payload: {
                    stage: 'aip_store',
                    step: 'orphan',
                    pid,
                    attempts: next_attempts,
                    max_attempts,
                    wire_status,
                    error: truncated,
                },
            }
        );
        return {
            ok: false,
            pid,
            orphan: true,
            final_state: 'AIP_STORE_FAILED',
            attempts: next_attempts,
            error: truncated,
        };
    }

    let next_attempt_at = null;
    let final_state;
    if (next_attempts < max_attempts) {
        /*
         * base * 2 ** (n-1), capped at retry_max_backoff_ms so a high
         * max_attempts cannot schedule a retry hours out.
         */
        const base_ms =
            cfg.retry_base_backoff_ms > 0 ? cfg.retry_base_backoff_ms : 60_000;
        const max_ms =
            cfg.retry_max_backoff_ms > 0 ? cfg.retry_max_backoff_ms : 30 * 60 * 1000;
        const backoff_ms = Math.min(base_ms * Math.pow(2, next_attempts - 1), max_ms);
        next_attempt_at = new Date(Date.now() + backoff_ms);
        final_state = 'AIP_STORE_PENDING';
    } else {
        final_state = 'AIP_STORE_FAILED';
    }

    /*
     * Names the two cases apart in the audit trail. Both store the
     * retry-eligible INGEST_COPY_FAILED status, never orphan, so the entry
     * short-circuit lets the next attempt through.
     */
    /*
     * Preserve the DuraCloud-source flag while attempts remain so the
     * WHOLE retry budget stays on the source staff chose; only a
     * terminal failure records the descriptive message. (Without this,
     * the first DC failure overwrote the flag and the next auto-retry
     * silently fell back to the broken AM path.)
     */
    const retrying = next_attempts < max_attempts;
    const failure_message = use_duracloud
        ? retrying
            ? 'RETRY_FROM_DURACLOUD'
            : 'DURACLOUD_COPY_FAILED'
        : is_not_found
          ? 'AM_NOT_FOUND_RETRY'
          : 'COPY_FAILED';
    const failure_step = is_not_found ? 'am_not_found_retry' : 'failed';

    try {
        await aip_store_model.upsert_by_uuid(pid, {
            aip_uuid: row.sip_uuid,
            source: aip_store_model.SOURCE.INGEST_V2,
            is_migrated: aip_store_model.STATUS.INGEST_COPY_FAILED,
            attempts: next_attempts,
            next_attempt_at,
            error: truncated,
            message: failure_message,
        });
    } catch (err) {
        log.warn({
            event: 'aip_store_upsert_failed',
            queue_id: row.id,
            pid,
            err: err.message,
        });
        // Advance the queue state anyway, so the worker doesn't spin on this row.
    }

    await model.update_queue(
        { id: row.id },
        {
            status: final_state,
            // Keeps the row in the default queue view even on AIP_STORE_FAILED.
            is_complete: 0,
            error: truncated,
        },
        {
            actor: 'worker',
            payload: {
                stage: 'aip_store',
                step: failure_step,
                pid,
                attempts: next_attempts,
                max_attempts,
                next_attempt_at: next_attempt_at
                    ? next_attempt_at.toISOString()
                    : null,
                wire_status,
                not_found: is_not_found,
                error: truncated,
            },
        }
    );

    return {
        ok: false,
        pid,
        attempts: next_attempts,
        final_state,
        error: truncated,
    };
}

module.exports = { run };
