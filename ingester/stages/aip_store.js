'use strict';

// Stage 6 — preservation copy to Wasabi S3.
//
//   entry:  AIP_STORE_PENDING       (success path, from Stage 5)
//         | AIP_STORE_IN_PROGRESS   (resume mid-copy)
//   exit:   AIP_STORE_COMPLETE      (success + is_complete=1)
//         | AIP_STORE_FAILED        (retries exhausted; operator-only
//                                    via the dashboard "Retry" button)
//
// What it does:
//   1. Look up the Archivematica AIP UUID for the row's sip_uuid.
//      In v2 the queue's sip_uuid IS AM's package UUID — the AM
//      Storage Service /v2/file/<sip_uuid>/ endpoint already returns
//      metadata for the AIP package. We pass sip_uuid through as the
//      aip_uuid to the curation API.
//   2. Idempotency check: if tbl_aip_store already has a row for
//      this PID with is_migrated in the success set, skip the copy
//      and transition straight to AIP_STORE_COMPLETE. This catches
//      the "stage 6 ran, crashed before flipping state, resume"
//      case without re-uploading multi-GB AIPs.
//   3. Call curation /api/v2/aip/copy-to-wasabi. Synchronous; can
//      take many minutes for a large AIP. We pass the configured
//      timeout (cfg.aip_store.copy_timeout_ms, default 60 min).
//   4. On success: upsert tbl_aip_store with the canonical key +
//      bucket + bytes + copied_at, flip queue to AIP_STORE_COMPLETE
//      + is_complete=1.
//   5. On failure: increment attempts, compute backoff, write
//      next_attempt_at on the store row. If attempts < max_attempts
//      flip queue back to AIP_STORE_PENDING so the next worker tick
//      re-runs after the backoff. If attempts === max_attempts,
//      flip to AIP_STORE_FAILED + is_complete=0 (still visible in
//      the default queue view); operator clicks "Retry" in the
//      dashboard to reset.
//
// Resume behavior:
//   The curation /copy-to-wasabi endpoint is idempotent on the
//   Wasabi side (head_object check before re-upload), so a resume
//   after a crash mid-call re-runs the same request and the curation
//   service short-circuits. Stage 6 doesn't need to track its own
//   sub-state.
//
// Failure does NOT roll back Stage 5: the row was already marked
// COMPLETE in Stage 5's first phase. We're flipping is_complete back
// to 0 only so the row stays visible in the queue view while Stage
// 6 retries. Once Stage 6 succeeds (or operator gives up), is_
// complete goes to 1 and the row drops from the default view.

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

    // Feature flag — if the operator disables aip_store mid-run, any
    // queue rows already at AIP_STORE_PENDING get drained into a
    // terminal state without contacting Wasabi. We treat them as
    // "complete enough" (Stage 5 already succeeded) and flip
    // is_complete=1 so they exit the queue view.
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

    // Client misconfigured — same handling as the disabled case.
    // Loud log so the operator knows why a row that should have
    // been copied just drained to COMPLETE.
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
        // No AM UUID = nothing to copy. Treat as a non-fatal skip;
        // the row's already at Stage 5 success. The operator can
        // investigate via the dashboard timeline if this is unexpected.
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

    // The repository PID this AIP belongs to. Stage 5 wrote it as
    // an audit event payload (`pid` field on the COMPLETE event),
    // but the queue row's `package` column ISN'T the repo PID —
    // it's the staging folder name. The pid we want lives in
    // tbl_objects (find_by_sip_uuid) or in the row's metadata.
    //
    // Simplest stable read: tbl_objects.pid where the row was
    // created by Stage 5 (the queue row's sip_uuid matches the
    // tbl_objects.sip_uuid we just wrote). We look it up here rather
    // than threading it through every queue column change.
    const pid = await _resolve_repo_pid(deps, row);
    if (!pid) {
        // Shouldn't happen — Stage 5 succeeded so tbl_objects has a
        // row. But be defensive: if we can't find it, skip Stage 6
        // rather than write a tbl_aip_store row with a bogus uuid.
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

    // Idempotency check — if we've already copied this PID's AIP
    // (legacy migration OR a prior successful Stage 6), short-circuit.
    // Doesn't re-call Wasabi; the dashboard's "Retry" affordance is
    // for the failure path, and a manual recopy from a working state
    // would be a separate flow.
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

    // Orphan short-circuit — if AM 404'd on a prior attempt and we
    // marked this row as an orphan, dead-letter the queue row
    // immediately. Don't call curation, don't burn an attempt. The
    // operator must investigate; retry can't fix it.
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

    // Backoff guard — if a prior attempt set next_attempt_at in the
    // future, exit early WITHOUT burning an attempt or contacting
    // curation. We don't write the queue row: it's already at
    // AIP_STORE_PENDING (the worker only claims by status, doesn't
    // flip to IN_PROGRESS until Stage 6 chooses to do so further
    // below), so leaving it untouched keeps the worker's next-tick
    // claim eligibility correct. The next tick (~5s later) re-runs
    // Stage 6 entry; once next_attempt_at elapses, we fall through
    // to the IN_PROGRESS transition and the real attempt.
    //
    // Without this, the worker's 5s claim cadence raced through 5
    // attempts in ~20s regardless of the backoff schedule — the
    // attempts counter is per-aip-store-row but the worker doesn't
    // consult it before claiming, so each tick re-fired Stage 6.
    //
    // The chatter cost is ~1 SELECT on tbl_aip_store every 5s per
    // backed-off row, which is negligible at the row counts we're
    // talking about (tens to low thousands).
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

    // Move into the in-progress state so the dashboard shows a
    // distinct phase and a resume after a crash lands here.
    if (row.pipeline_state !== 'AIP_STORE_IN_PROGRESS') {
        await model.update_queue(
            { id: row.id },
            { status: 'AIP_STORE_IN_PROGRESS' },
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

    let res;
    try {
        res = await client.copy_to_wasabi(row.sip_uuid, pid, {
            timeout_ms: cfg.copy_timeout_ms,
        });
    } catch (err) {
        // Transport-level (timeout, network, TLS). Always retryable.
        return await _record_failure({
            aip_store_model,
            model,
            cfg,
            row,
            pid,
            error_text: err instanceof UpstreamError ? err.message : String(err),
            wire_status: null,
        });
    }
    if (signal && signal.aborted) {
        // Graceful shutdown. Leave the row in its current state —
        // the next worker boot will resume and re-call the curation
        // endpoint (idempotent on the curation side).
        return { ok: false, aborted: true };
    }

    // Inspect the response. Two failure modes:
    //   - res.status non-2xx: HTTP-level failure.
    //   - res.status 2xx with data.ok === false: the curation service
    //     itself reported the copy failed (e.g., AM file missing,
    //     Wasabi auth refused). The body shape is documented in
    //     ingester/libs/aip_store_client.js.
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    if (res.status < 200 || res.status >= 300 || data.ok !== true) {
        const error_text =
            data.error || `curation /copy-to-wasabi returned HTTP ${res.status}`;
        return await _record_failure({
            aip_store_model,
            model,
            cfg,
            row,
            pid,
            error_text,
            wire_status: res.status,
        });
    }

    // ---- Success -------------------------------------------------------

    const bucket = data.bucket || null;
    const key = data.key || null;
    const bytes = Number.isFinite(data.bytes) ? data.bytes : null;
    const copied_at = new Date();
    const upsert = await aip_store_model.upsert_by_uuid(pid, {
        aip_uuid: row.sip_uuid,
        // Legacy `aip` column gets the basename for backwards-compat
        // with anything that still reads it (and for the dashboard's
        // "show me a short id" column). The full key lives in
        // wasabi_key.
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
        message: null,
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

// Locate the repository PID created by Stage 5 for this queue row.
// We use the AM SIP UUID as the join key — tbl_objects.sip_uuid is
// the natural identifier Stage 5's _insert sets. We don't import
// repository/model here to keep Stage 6 dependency-injectable; tests
// pass a `find_repo_pid_by_sip` stub via deps.
async function _resolve_repo_pid(deps, row) {
    if (deps.find_repo_pid_by_sip) {
        return deps.find_repo_pid_by_sip(row.sip_uuid);
    }
    // Default — direct DB read. Avoids a circular import with
    // repository/model.
    const { db } = require('../../config/db');
    const tables = require('../../config/db_tables');
    const obj = await db()(tables.objects)
        .select('pid')
        .where({ sip_uuid: row.sip_uuid })
        .first();
    return obj ? obj.pid : null;
}

// Detect the "AM Storage Service returned 404" failure mode. We
// pattern-match on the curation /copy-to-wasabi error text because
// the wire contract documents that exact phrasing (see
// digitaldu-backend-curation-service_latest/lib/aip_ops.py:
// `f'AIP {aip_uuid} not found in AM Storage Service'`). A future
// curation update could add a structured `error_kind: 'am_not_found'`
// field; until then, the string check is the load-bearing signal.
//
// When this fires the row is an orphan (no AM record exists for the
// UUID — see the dashboard for the diagnosis flow). Retry can't fix
// it, so we dead-letter immediately + tag with AM_NOT_FOUND so the
// backfill eligibility filter excludes it from future runs.
function _is_am_not_found_error(error_text) {
    return /not found in AM Storage Service/i.test(error_text || '');
}

// Common failure path — writes a tbl_aip_store row + decides whether
// to retry or terminate. Mirrors metadata/model.js mark_failed in
// spirit: increment attempts, compute backoff, decide outcome.
async function _record_failure({
    aip_store_model,
    model,
    cfg,
    row,
    pid,
    error_text,
    wire_status,
}) {
    // Truncate to 1000 chars — matches the column width and prevents
    // a giant HTML error page from bloating the row.
    const truncated = String(error_text || 'unknown error').slice(0, 1000);

    // Inspect any existing row to get the current attempts counter.
    // We don't fail if the read errors — we'll still try to record
    // a fresh failure.
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
    // "AIP not found in AM Storage Service" is AMBIGUOUS: a genuine orphan,
    // OR a large/slow AIP that AM hasn't finished registering in the Storage
    // Service yet when Stage 6 first queries. So it gets its own, more
    // generous attempt budget and is RETRIED (spaced by the backoff below,
    // now that the entry backoff-guard properly throttles re-claims) — and
    // only declared a terminal orphan once it is STILL not found at the end
    // of that budget. Previously the first 404 dead-lettered the row
    // instantly, permanently stranding legitimate large AIPs (which the
    // dashboard Retry then couldn't recover, because orphan rows
    // short-circuit on entry).
    const is_not_found = _is_am_not_found_error(truncated);
    const max_attempts = is_not_found
        ? cfg.not_found_max_attempts > 0
            ? cfg.not_found_max_attempts
            : 8
        : cfg.max_attempts > 0
          ? cfg.max_attempts
          : 5;

    // Terminal orphan — ONLY once a not-found has persisted through its full
    // retry budget. Tag is_migrated=8 (AM_NOT_FOUND) so the backfill
    // eligibility filter excludes it; dead-letter the queue row. A genuine
    // orphan ends up here too, just later — the (bounded) cost of giving a
    // real large AIP time to land.
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
        // Exponential backoff: base * 2 ** (n-1), capped at max. n=1
        // → base; n=2 → 2×base; etc. The cap stops a high
        // max_attempts from scheduling a retry hours into the future.
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

    // Distinguish "not-found, still within its grace budget" from a generic
    // transient failure in the audit trail + stored message. Both use the
    // retry-eligible INGEST_COPY_FAILED status (NOT orphan), so the entry
    // short-circuit lets the next attempt through.
    const failure_message = is_not_found ? 'AM_NOT_FOUND_RETRY' : 'COPY_FAILED';
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
        // Even if the audit write failed, we still want to advance
        // the queue state so the worker doesn't spin on this row
        // forever. Carry on.
    }

    await model.update_queue(
        { id: row.id },
        {
            status: final_state,
            // is_complete=0 keeps the row in the default queue view
            // even on AIP_STORE_FAILED — the operator needs to see
            // and act on it.
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
