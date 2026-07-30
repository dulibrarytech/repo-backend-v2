'use strict';

/*
 * Ingest pipeline REST surface — staff actions on tbl_ingest_queue.
 * 
 * Endpoints (mounted in routes.js):
 * 
 *   POST   /api/ingest/queue                  → enqueue a batch of packages
 *   GET    /api/ingest                        → list queue rows (paginated)
 *   GET    /api/ingest/:id                    → fetch one row
 *   GET    /api/ingest/:id/timeline           → event log for one row
 *   POST   /api/ingest/:id/rollback-pre       → return folder + clear queue
 *   POST   /api/ingest/:id/rollback-am        → submit AM AIP deletion + halt
 *   POST   /api/ingest/:id/reset              → reset to PENDING (no AM action)
 *   POST   /api/ingest/reset-orphaned         → boot-time orphan recovery
 * 
 * Auth scheme: every endpoint requires a valid JWT (require_auth). The
 * actor on event-log rows is the JWT's `du_id` claim — so every staff
 * action is attributable. No role check yet; Phase 3 will introduce a
 * staff-vs-admin split.
 * 
 * Errors thrown here flow through the central error handler in
 * config/express.js — ValidationError → 400, NotFoundError → 404, etc.
 */

const model = require('./model');
const jobs = require('./jobs');
const {
    available_actions,
    CANCELLABLE_STATES,
    POST_UPLOAD_PRE_AM_PRIOR_STATES,
    AM_PRIOR_STATES,
} = require('./state_metadata');
const { ValidationError, NotFoundError, ForbiddenError } = require('../libs/errors');
/*
 * External clients used by the rollback endpoints. Required lazily
 * at call-time inside each handler so the modules' env reads happen
 * against the live config (test setup mutates env between cases).
 */
const qa_service = require('./libs/qa_service');
const archivematica = require('../libs/archivematica');
const worker_registry = require('./worker');
const log = require('../libs/log');

/*
 * Write a FAILED packaging_and_ingesting job-history row for a
 * rolled-back queue row. The queue row itself is hidden from the
 * default queue view (via is_complete=1 set by the caller); the
 * history row keeps the action visible on the Job History page.
 * 
 * Best-effort: a job-history write failure does NOT unwind the
 * rollback. We log + continue — the queue row + audit event are
 * the canonical record; history is a staff-convenience view.
 */
async function _record_rollback_in_history(row, { actor, action, error_text }) {
    try {
        await jobs.record_job({
            job_type: 'packaging_and_ingesting',
            status: 'FAILED',
            collection_folder: row.batch,
            packages: row.package ? [row.package] : [],
            actor,
            error: error_text,
        });
    } catch (err) {
        log.warn({
            event: 'rollback_job_history_write_failed',
            queue_id: row.id,
            action,
            err: err.message,
        });
    }
}

/*
 * Helper: pull a stable actor string from the authenticated principal.
 * JWT payload shape (see auth/controller.js): { id, du_id, email, ... }.
 * We prefer du_id (matches v1's audit format) then email then id.
 */
function actor_of(req) {
    const u = req.user || {};
    return u.du_id || u.email || (u.id ? `user:${u.id}` : 'staff');
}

/*
 * Helper: derive the curation-API "uuid" namespace for a queue row.
 * MUST match the resolution in stages/upload.js so the rollback path
 * targets the SAME SFTP folder Stage 2 created.
 * 
 * v1 (ingest_service.js:508) names the SFTP folder after the
 * collection's PID — all packages in a collection share one folder.
 * The collection PID is minted only when a new collection is created
 * (workspace._ensure_collection_exists); existing collections reuse
 * it across submits.
 * 
 * Defensive fallback for legacy rows with the schema default
 * `collection_uuid='PENDING'` (rows that bypassed the gate): fall
 * through to `q-<id>` so the SFTP namespace is still per-row valid.
 */
function _qa_uuid(row) {
    return row.collection_uuid && row.collection_uuid !== 'PENDING'
        ? row.collection_uuid
        : `q-${row.id}`;
}

/*
 * Compose a human-readable error description for the FAILED job-
 * history row a rollback writes. The pieces:
 *   action   — short label of the rollback path
 *   from     — the state the row was in BEFORE the rollback
 *   existing — row.error (whatever the pipeline already recorded)
 *   note     — staff-supplied note or reason
 *   extra    — optional addendum (qa_error / am_error)
 * All falsy fields are dropped so the result reads cleanly even
 * when most context is missing. Capped well under the jobs table's
 * 1000-char error column truncation in record_job.
 */
function _rollback_error_text({ action, from, existing, note, extra }) {
    const parts = [];
    if (action) parts.push(action);
    if (from) parts.push(`from ${from}`);
    let line = parts.join(' ');
    const trailers = [];
    if (existing) trailers.push(`Pipeline error: ${existing}`);
    if (note) trailers.push(`Note: ${note}`);
    if (extra) trailers.push(extra);
    if (trailers.length > 0) line += `. ${trailers.join('; ')}`;
    return line;
}

/*
 * --- POST /api/ingest/queue ---------------------------------------------
 * 
 * Body shape:
 *   {
 *     rows: [
 *       {
 *         batch: string,            // required
 *         package: string,          // required
 *         collection_uuid: string,  // required
 *         job_uuid?: string,
 *         metadata_uri?: string,
 *         status?: string,          // defaults to PENDING
 *         ...                       // any other tbl_ingest_queue column
 *       },
 *       ...
 *     ]
 *   }
 * 
 * Returns { count, ids }. The model writes one 'state_change' event per
 * row with actor = the JWT principal.
 */
async function enqueue(req, res) {
    const body = req.body || {};
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
        throw new ValidationError('rows must be a non-empty array');
    }
    /*
     * Per-row minimum-field validation. Surfaced as a single 400 with
     * a per-row reason list so the dashboard can highlight bad inputs
     * without N round-trips.
     */
    const errors = [];
    body.rows.forEach((row, i) => {
        if (!row || typeof row !== 'object') {
            errors.push({ index: i, error: 'row must be an object' });
            return;
        }
        if (!row.batch) errors.push({ index: i, error: 'batch is required' });
        if (!row.package) errors.push({ index: i, error: 'package is required' });
        if (!row.collection_uuid) {
            errors.push({ index: i, error: 'collection_uuid is required' });
        }
    });
    if (errors.length > 0) {
        throw new ValidationError('row validation failed', errors);
    }
    const ids = await model.queue_packages(body.rows, { actor: actor_of(req) });
    res.status(201).json({ count: ids.length, ids });
}

/*
 * --- GET /api/ingest ----------------------------------------------------
 * 
 * Query params: status, batch, is_complete, limit (default 100, cap 500),
 * offset.
 */
async function list(req, res) {
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.batch) filters.batch = req.query.batch;
    if (req.query.is_complete !== undefined) {
        filters.is_complete = req.query.is_complete === '1' || req.query.is_complete === 'true';
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = await model.list_queue(filters, { limit, offset });
    /*
     * Attach the available-actions list per row so the dashboard
     * doesn't have to know the state-set classification rules.
     * For CANCELLED_BY_USER rows we need to consult the audit log to
     * recover the prior state — the rollback target depends on
     * whether AM had started ingesting when the cancel fired.
     */
    const out = await Promise.all(
        rows.map(async (r) => {
            const prev = await _prev_state_if_needed(r);
            return { ...r, actions: available_actions(r.pipeline_state, prev) };
        })
    );
    res.json({ count: out.length, limit, offset, rows: out });
}

// --- GET /api/ingest/:id ------------------------------------------------
async function get_one(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    const prev = await _prev_state_if_needed(row);
    res.json({ row: { ...row, actions: available_actions(row.pipeline_state, prev) } });
}

/*
 * CANCELLED_BY_USER is the only state whose action-set depends on a
 * prior state. For every other state we skip the audit lookup —
 * avoids a DB roundtrip per row on the queue page.
 */
async function _prev_state_if_needed(row) {
    if (row.pipeline_state !== 'CANCELLED_BY_USER') return null;
    try {
        return await model.get_prev_state_for_cancel(row.id);
    } catch (err) {
        /*
         * The action lookup degrades gracefully — without prev_state
         * the dashboard falls back to 'reset', which is the safest
         * option (no upstream side effects).
         */
        log.warn({
            event: 'prev_state_lookup_failed',
            queue_id: row.id,
            err: err.message,
        });
        return null;
    }
}

// --- GET /api/ingest/:id/timeline ---------------------------------------
async function get_timeline(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    // Verify the row exists so timeline=[] doesn't quietly mean "no row".
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    const events = await model.get_timeline(id);
    res.json({ id, events });
}

/*
 * --- POST /api/ingest/:id/rollback-pre ----------------------------------
 * 
 * "Rollback before Archivematica activity". Used when the row halted
 * in a PRE_AM_FAILURE state. The folder is in 002-ingest but no AIP
 * exists yet, so we tell QA to move it back to 001-ready, then flip
 * the queue row to ROLLED_BACK_TO_READY. The QA call is best-effort —
 * if it fails we still flip the queue row (staff intervention may
 * move the folder manually) but record the QA error in the audit
 * payload so the dashboard can surface it.
 */
async function rollback_pre_ingest(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    if (!available_actions(row.pipeline_state).includes('rollback_pre_ingest')) {
        throw new ForbiddenError(
            `rollback_pre_ingest not available from state ${row.pipeline_state}`
        );
    }
    const note = (req.body && req.body.note) || null;
    const { affected, qa_outcome, qa_error } = await _rollback_pre_row(row, {
        actor: actor_of(req),
        note,
    });
    res.json({
        id,
        affected,
        new_state: 'ROLLED_BACK_TO_READY',
        qa_outcome,
        qa_error,
    });
}

/*
 * Shared core of the pre-AM rollback: QA folder move + queue flip +
 * Job History record for ONE row. Callers have already verified the
 * row's state allows rollback_pre_ingest. Used by the single-row
 * endpoint above and the batch endpoint below.
 */
async function _rollback_pre_row(row, { actor, note = null } = {}) {
    /*
     * Match upload.js's qa_uuid resolution exactly — the rollback
     * needs to target the same SFTP folder Stage 2 created. See
     * upload.js for why we treat the legacy '0' default as missing.
     */
    const qa_uuid = _qa_uuid(row);

    /*
     * Fire the QA move-from-ingest-to-ready. Best-effort: we capture
     * the outcome in the audit payload but never block the queue
     * flip on it. A 200 is success; anything else (including a
     * transport throw) gets folded into qa_error for the timeline.
     */
    let qa_outcome = null;
    let qa_error = null;
    if (qa_service.is_configured && qa_service.is_configured()) {
        try {
            /*
             * Curation-API needs uuid + folder (row.batch) + package
             * (row.package) — it moves one package at a time. Passing
             * only uuid silently returned HTTP 400, leaving the
             * folder stuck in 002-ingest.
             */
            const r = await qa_service.move_from_ingest_to_ready(qa_uuid, row.batch, row.package, {
                actor,
            });
            qa_outcome = { status: r.status };
            if (r.status !== 200) {
                qa_error = `QA returned HTTP ${r.status}`;
            }
        } catch (err) {
            qa_error = `QA move failed: ${err.message}`;
            log.warn({
                event: 'rollback_pre_qa_failed',
                queue_id: row.id,
                err: err.message,
            });
        }
    } else {
        // No QA configured (dev) — log but don't block.
        qa_error = 'qa_service not configured';
    }

    const result = await model.update_queue(
        { id: row.id },
        { status: 'ROLLED_BACK_TO_READY', is_complete: 1 },
        {
            actor,
            event_type: 'staff_action',
            payload: {
                action: 'rollback_pre_ingest',
                from: row.pipeline_state,
                note,
                qa_uuid,
                qa_outcome,
                qa_error,
            },
        }
    );
    /*
     * Surface the rollback on the Job History page as a FAILED
     * packaging_and_ingesting entry — the queue row is now hidden
     * (is_complete=1) and history is staff's only visible record
     * that this package's ingest attempt was rolled back.
     */
    const error_text = _rollback_error_text({
        action: 'pre-ingest rollback',
        from: row.pipeline_state,
        existing: row.error,
        note,
        extra: qa_error,
    });
    await _record_rollback_in_history(row, {
        actor,
        action: 'rollback_pre_ingest',
        error_text,
    });
    return { affected: result.affected, qa_outcome, qa_error };
}

/*
 * --- POST /api/ingest/:id/rollback-batch-pre -----------------------------
 *
 * Batch-wide pre-AM rollback, anchored on any rolled-back-able row of
 * the batch. Born from the 95-package overload incident (2026-07-29):
 * a big submit burst tipped over ArchivesSpace logins and AM's SFTP
 * connection cap, halting dozens of rows at once — recovering them
 * one kebab click at a time doesn't scale.
 *
 * Semantics: every OPEN row of the anchor's batch whose state allows
 * rollback_pre_ingest gets the exact same per-row rollback (QA folder
 * move + flip + history). Everything else is counted and left alone:
 *   - in-flight rows (cancellable) — staff must cancel them first;
 *     yanking a row the worker is actively driving invites races.
 *   - AM-side failures — those need the deliberate per-row
 *     rollback-am (AIP deletion request) decision, never a bulk one.
 *
 * Rows are processed SEQUENTIALLY on purpose — the whole point is
 * recovering from a burst; the recovery must not create another one.
 */
async function rollback_batch_pre(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const anchor = await model.get_queue_row({ id });
    if (!anchor) throw new NotFoundError(`queue row ${id} not found`);
    /*
     * Anchor must itself be batch-rollback-able: either a halt-state
     * row (rollback_pre_ingest) or a post-cancel row
     * (rollback_to_packaging — the "Halt entire batch" flow can leave
     * a batch that is ALL cancelled rows, and staff anchor from one).
     */
    const anchor_prev =
        anchor.pipeline_state === 'CANCELLED_BY_USER'
            ? await model.get_prev_state_for_cancel(anchor.id)
            : null;
    const anchor_actions = available_actions(anchor.pipeline_state, anchor_prev);
    if (
        !anchor_actions.includes('rollback_pre_ingest') &&
        !anchor_actions.includes('rollback_to_packaging')
    ) {
        throw new ForbiddenError(
            `rollback_batch_pre not available from state ${anchor.pipeline_state}`
        );
    }
    const note = (req.body && req.body.note) || null;
    const actor = actor_of(req);

    /* Every open row of the batch — 1000 far exceeds any real batch. */
    const rows = await model.list_queue(
        { batch: anchor.batch, is_complete: 0 },
        { limit: 1000, offset: 0 }
    );

    const summary = {
        batch: anchor.batch,
        total_open: rows.length,
        rolled_back: 0,
        qa_errors: 0,
        am_cleanup_needed: 0,
        skipped_in_flight: 0,
        skipped_am_side: 0,
        skipped_other: 0,
    };
    for (const row of rows) {
        /*
         * CANCELLED_BY_USER rows need prev_state for both the
         * action check and the state-aware cleanup — one audit read
         * per cancelled row, same price the single endpoint pays.
         */
        const prev_state =
            row.pipeline_state === 'CANCELLED_BY_USER'
                ? await model.get_prev_state_for_cancel(row.id)
                : null;
        const actions = available_actions(row.pipeline_state, prev_state);
        if (actions.includes('rollback_pre_ingest')) {
            const r = await _rollback_pre_row(row, { actor, note });
            summary.rolled_back++;
            if (r.qa_error) summary.qa_errors++;
        } else if (actions.includes('rollback_to_packaging')) {
            /*
             * Post-cancel rows (the "Halt entire batch" flow lands
             * every moving row here) — same state-aware cleanup the
             * per-row Return-to-Packaging runs.
             */
            const r = await _return_row_to_packaging(row, { actor, note, prev_state });
            summary.rolled_back++;
            if (r.qa_error) summary.qa_errors++;
            if (r.needed_am_cleanup) summary.am_cleanup_needed++;
        } else if (actions.includes('rollback_archivematica')) {
            summary.skipped_am_side++;
        } else if (actions.includes('cancel')) {
            summary.skipped_in_flight++;
        } else {
            summary.skipped_other++;
        }
    }
    log.info({ event: 'rollback_batch_pre', ...summary, actor });
    res.json(summary);
}

/*
 * --- POST /api/ingest/:id/cancel-batch -----------------------------------
 *
 * Batch-wide HALT, anchored on any row of the batch. Companion to the
 * batch rollback: that one only recovers rows already in a FAILURE
 * state, so after a partial-batch incident the untouched
 * PENDING/QA_COMPLETE rows kept marching forward (2026-07-30 report).
 * This stops the whole batch: every open row in a cancellable state
 * gets the same two-step the per-row cancel does — abort the worker's
 * in-flight dispatch (if any), then flip to CANCELLED_BY_USER.
 * Already-halted rows are left as they are (they're not moving), and
 * completed rows are never touched. Follow with "Return entire batch
 * to Packaging", which now also cleans up the cancelled rows.
 */
async function cancel_batch(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const anchor = await model.get_queue_row({ id });
    if (!anchor) throw new NotFoundError(`queue row ${id} not found`);
    const reason = (req.body && req.body.reason) || 'Batch halted by staff';
    const actor = actor_of(req);

    const rows = await model.list_queue(
        { batch: anchor.batch, is_complete: 0 },
        { limit: 1000, offset: 0 }
    );

    const summary = {
        batch: anchor.batch,
        total_open: rows.length,
        cancelled: 0,
        was_running: 0,
        already_halted: 0,
        skipped_other: 0,
    };
    const worker = worker_registry.get_active_worker();
    for (const row of rows) {
        if (!CANCELLABLE_STATES.has(row.pipeline_state)) {
            if (available_actions(row.pipeline_state).some((a) => a.startsWith('rollback') || a === 'reset')) {
                summary.already_halted++;
            } else {
                summary.skipped_other++;
            }
            continue;
        }
        if (worker && typeof worker.cancel_row === 'function') {
            const out = worker.cancel_row(row.id);
            if (out && out.aborted) summary.was_running++;
        }
        const result = await model.cancel(row.id, { actor, reason });
        if (result.ok) {
            summary.cancelled++;
            await _cancel_inflight_upload(row, result.prev_state);
        } else {
            /* Raced into a terminal state between list and cancel. */
            summary.skipped_other++;
        }
    }
    log.info({ event: 'cancel_batch', ...summary, actor });
    res.json(summary);
}

/*
 * --- POST /api/ingest/:id/rollback-am -----------------------------------
 * 
 * "Rollback after Archivematica activity". Submits an AIP deletion
 * request to AM Storage Service (async — an AM admin approves in the
 * Storage Service UI) and moves the row to AM_DELETION_REQUESTED.
 * 
 * Requires the row to have a sip_uuid (set by stage 3). Without one
 * we can't even tell AM what to delete; we surface a 422 in that
 * case so staff can pick a different rollback path.
 */
async function rollback_archivematica(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    if (!available_actions(row.pipeline_state).includes('rollback_archivematica')) {
        throw new ForbiddenError(
            `rollback_archivematica not available from state ${row.pipeline_state}`
        );
    }
    if (!row.sip_uuid || row.sip_uuid === 'PENDING') {
        throw new ValidationError(
            'cannot rollback Archivematica without sip_uuid — use rollback-pre instead'
        );
    }
    const reason = (req.body && req.body.reason) || 'staff-initiated rollback';

    /*
     * Submit the deletion request to AM. 202 = request accepted
     * (pending AM admin approval). 200 with a "deletion request
     * already exists" body is also fine (idempotent). Anything else
     * we record + still flip the queue row so staff have something
     * to investigate in the timeline.
     */
    let am_outcome = null;
    let am_error = null;
    if (archivematica.is_storage_configured && archivematica.is_storage_configured()) {
        try {
            const r = await archivematica.delete_aip_request({
                uuid: row.sip_uuid,
                delete_reason: reason,
            });
            am_outcome = { status: r.status, message: r.data && r.data.message };
            if (r.status !== 200 && r.status !== 202) {
                am_error = `AM returned HTTP ${r.status}`;
            }
        } catch (err) {
            am_error = `AM delete request failed: ${err.message}`;
            log.warn({
                event: 'rollback_am_failed',
                queue_id: id,
                sip_uuid: row.sip_uuid,
                err: err.message,
            });
        }
    } else {
        am_error = 'archivematica storage not configured';
    }

    const actor = actor_of(req);
    const result = await model.update_queue(
        { id },
        { status: 'AM_DELETION_REQUESTED', is_complete: 1 },
        {
            actor,
            event_type: 'staff_action',
            payload: {
                action: 'rollback_archivematica',
                from: row.pipeline_state,
                reason,
                sip_uuid: row.sip_uuid,
                am_outcome,
                am_error,
            },
        }
    );
    const error_text = _rollback_error_text({
        action: 'Archivematica rollback',
        from: row.pipeline_state,
        existing: row.error,
        note: reason,
        extra: am_error,
    });
    await _record_rollback_in_history(row, {
        actor,
        action: 'rollback_archivematica',
        error_text,
    });
    res.json({
        id,
        affected: result.affected,
        new_state: 'AM_DELETION_REQUESTED',
        am_outcome,
        am_error,
    });
}

/*
 * --- POST /api/ingest/:id/reset -----------------------------------------
 * 
 * "Reset, no rollback needed". Used when the row halted before any
 * folder move (AS_METADATA_INVALID). No AM activity, no QA folder
 * move — we just clear the queue row to PENDING so staff can re-run.
 */
async function reset_row(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    if (!available_actions(row.pipeline_state).includes('reset')) {
        throw new ForbiddenError(`reset not available from state ${row.pipeline_state}`);
    }
    const result = await model.update_queue(
        { id },
        { status: 'PENDING' },
        {
            actor: actor_of(req),
            event_type: 'staff_action',
            payload: { action: 'reset', from: row.pipeline_state },
        }
    );
    res.json({ id, affected: result.affected, new_state: 'PENDING' });
}

/*
 * --- POST /api/ingest/:id/cancel ----------------------------------------
 * 
 * Staff-initiated cancel of an in-flight row. Two-step:
 * 
 *   1. Signal the worker's AbortController for the row (if any).
 *      Long-poll stages (UPLOADING wait, TRANSFER_IN_PROGRESS poll,
 *      DuraCloud propagation wait) wake immediately and return; no-op
 *      if the row isn't currently dispatched.
 * 
 *   2. Flip the queue row to CANCELLED_BY_USER and write an audit
 *      event whose payload records the prior state (`from`). The
 *      dashboard's available_actions(state, prev_state) consults
 *      that on the next render to surface the right rollback target.
 * 
 * State guard: cancel is rejected if the row is already in a terminal
 * state (see TERMINAL_FOR_CANCEL in model.js) — returns 409 with the
 * current state so the toast can explain.
 * 
 * Cancel does NOT clean up SFTP / AM by itself; that's the rollback
 * step that follows. The two-step is intentional — staff might cancel
 * for reasons other than wanting a full rollback (e.g. interrupt a
 * runaway poll to investigate AM state out-of-band).
 */
async function cancel_row(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    if (!CANCELLABLE_STATES.has(row.pipeline_state)) {
        throw new ForbiddenError(`cancel not available from state ${row.pipeline_state}`);
    }
    const reason = (req.body && req.body.reason) || 'Cancelled by staff';
    const actor = actor_of(req);

    /*
     * 1. Signal worker AbortController. No-op if the row isn't
     *    currently being dispatched (e.g. it's PENDING but the next
     *    tick hasn't claimed it yet). The worker registry returns
     *    `null` in tests / non-bootstrapped runs — handle gracefully.
     */
    let was_running = false;
    const worker = worker_registry.get_active_worker();
    if (worker && typeof worker.cancel_row === 'function') {
        const out = worker.cancel_row(id);
        was_running = !!(out && out.aborted);
    }

    /*
     * 2. Flip the queue row + audit log. The model guards against
     *    races where the row reached a terminal state between our
     *    read above and the write here.
     */
    const result = await model.cancel(id, { actor, reason });
    if (!result.ok && result.reason === 'already_terminal') {
        return res.status(409).json({
            id,
            error: 'already_terminal',
            current_state: result.current_state,
        });
    }
    await _cancel_inflight_upload(row, result.prev_state);
    res.json({
        id,
        affected: result.affected,
        was_running,
        prev_state: result.prev_state,
        new_state: 'CANCELLED_BY_USER',
    });
}

/*
 * If the row we just cancelled was mid-upload, tell the curation side
 * to stop the background put too (2026-07-30: cancelling the queue row
 * stopped the Node poll, but the curation daemon thread kept uploading
 * to completion). Best-effort — a failure here never blocks the
 * cancel; the put just runs out its course like before.
 */
async function _cancel_inflight_upload(row, prev_state) {
    if (prev_state !== 'UPLOADING') return;
    if (!(qa_service.is_configured && qa_service.is_configured())) return;
    try {
        await qa_service.cancel_upload(_qa_uuid(row));
    } catch (err) {
        log.warn({
            event: 'cancel_upload_request_failed',
            queue_id: row.id,
            err: err.message,
        });
    }
}

/*
 * --- POST /api/ingest/:id/return-to-packaging ---------------------------
 * 
 * Single follow-up for any CANCELLED_BY_USER row, regardless of
 * prev_state. Always lands the row in RETURNED_TO_PACKAGING; the
 * physical-cleanup side-effects branch internally on prev_state so
 * staff only sees one kebab item:
 * 
 *   - prev_state ∈ PRE_UPLOAD_PRIOR_STATES (PENDING / STARTING /
 *     PROCESSING_METADATA / QA_COMPLETE): folder never left
 *     001-ready, so curation-API still lists it in /processed. We
 *     just flip the queue row. No QA call.
 * 
 *   - prev_state ∈ POST_UPLOAD_PRE_AM_PRIOR_STATES (UPLOADING /
 *     UPLOAD_COMPLETE / TRANSFER_*): Stage 2 moved the folder to
 *     002-ingest. Call qa.move_from_ingest_to_ready to put it back
 *     into 001-ready (uri.txt preserved → visible in /processed).
 *     The curation-API also cleans up the SFTP staging copy.
 * 
 *   - prev_state ∈ AM_PRIOR_STATES (INGEST_IN_PROGRESS /
 *     INGEST_COMPLETE / WAITING_FOR_DURACLOUD / ...): AM has its
 *     own copy of the SIP (from the SFTP source), but the staff-
 *     visible folder is still in 002-ingest — nothing in the
 *     pipeline moves it out automatically (qa.move_to_ingested
 *     exists but is never called). Same as the post-upload case:
 *     call qa.move_from_ingest_to_ready so the folder reappears
 *     in /processed. The needed_am_cleanup flag stays set so the
 *     dashboard reminds staff to delete the AIP in AM's Storage
 *     Service UI manually — that's an independent concern.
 * 
 * QA failure: best-effort. If the QA call fails we still flip the
 * queue row (staff may be moving folders manually) and record the
 * error in the audit payload.
 */
async function return_to_packaging(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);

    /*
     * Read the prior state from the audit log. It's the only thing
     * that tells us whether the folder needs to be moved or not.
     */
    const prev_state = await model.get_prev_state_for_cancel(id);
    const allowed = available_actions(row.pipeline_state, prev_state).includes(
        'rollback_to_packaging'
    );
    if (!allowed) {
        throw new ForbiddenError(
            `return_to_packaging not available from state ${row.pipeline_state}` +
                (prev_state ? ` (prev_state=${prev_state})` : '')
        );
    }

    const note = (req.body && req.body.note) || null;
    const out = await _return_row_to_packaging(row, {
        actor: actor_of(req),
        note,
        prev_state,
    });
    res.json({
        id,
        affected: out.affected,
        new_state: 'RETURNED_TO_PACKAGING',
        prev_state,
        needed_qa_move: out.needed_qa_move,
        needed_am_cleanup: out.needed_am_cleanup,
        qa_outcome: out.qa_outcome,
        qa_error: out.qa_error,
    });
}

/*
 * Shared core of the post-cancel Return-to-Packaging: state-aware QA
 * folder move + queue flip + Job History record for ONE row. Callers
 * have already verified the action is available for the row (and
 * fetched prev_state — passed in so the batch path pays one audit
 * read per row, same as the single path). Used by the single-row
 * endpoint above and the batch rollback below.
 */
async function _return_row_to_packaging(row, { actor, note = null, prev_state }) {
    /*
     * Same SFTP folder Stage 2 created — see _qa_uuid helper for why
     * we ignore the legacy '0' default.
     */
    const qa_uuid = _qa_uuid(row);

    /*
     * Call QA whenever the folder physically left 001-ready — that's
     * any post-upload prev_state. AM-side cancels included: AM reads
     * from the SFTP source, not from 002-ingest, so the staff folder
     * is still there waiting to be moved back.
     */
    let qa_outcome = null;
    let qa_error = null;
    const needs_qa_move =
        POST_UPLOAD_PRE_AM_PRIOR_STATES.has(prev_state) || AM_PRIOR_STATES.has(prev_state);
    /*
     * AM-side cancels leave an AIP behind that this endpoint can't
     * clean up — the response carries the flag so the dashboard can
     * surface a "manual AM cleanup required" hint, and the audit log
     * captures it for ops. Independent of needs_qa_move.
     */
    const needs_am_cleanup = AM_PRIOR_STATES.has(prev_state);
    if (needs_qa_move) {
        if (qa_service.is_configured && qa_service.is_configured()) {
            try {
                /*
                 * The curation-API endpoint requires uuid + folder
                 * (row.batch) + package — it operates one package at
                 * a time. row.batch is the SFTP folder name; row.package
                 * is the archival object directory inside it.
                 */
                const r = await qa_service.move_from_ingest_to_ready(
                    qa_uuid,
                    row.batch,
                    row.package,
                    { actor }
                );
                qa_outcome = { status: r.status };
                if (r.status !== 200) {
                    qa_error = `QA returned HTTP ${r.status}`;
                }
            } catch (err) {
                qa_error = `QA move failed: ${err.message}`;
                log.warn({
                    event: 'return_to_packaging_qa_failed',
                    queue_id: row.id,
                    err: err.message,
                });
            }
        } else {
            qa_error = 'qa_service not configured';
        }
    }

    const result = await model.update_queue(
        { id: row.id },
        { status: 'RETURNED_TO_PACKAGING', is_complete: 1 },
        {
            actor,
            event_type: 'staff_action',
            payload: {
                action: 'rollback_to_packaging',
                from: row.pipeline_state,
                prev_state,
                needed_qa_move: needs_qa_move,
                needed_am_cleanup: needs_am_cleanup,
                qa_uuid: needs_qa_move ? qa_uuid : null,
                qa_outcome,
                qa_error,
                note,
            },
        }
    );
    const error_text = _rollback_error_text({
        action: 'Returned to packaging',
        from: prev_state || row.pipeline_state,
        existing: row.error,
        note,
        extra: qa_error,
    });
    await _record_rollback_in_history(row, {
        actor,
        action: 'rollback_to_packaging',
        error_text,
    });
    return {
        affected: result.affected,
        needed_qa_move: needs_qa_move,
        needed_am_cleanup: needs_am_cleanup,
        qa_outcome,
        qa_error,
    };
}

/*
 * --- POST /api/ingest/reset-orphaned ------------------------------------
 * 
 * Boot/maintenance: sweep ACTIVELY_RUNNING rows back to PENDING.
 * Normally fired automatically by the worker on startup; exposed here
 * for staff to trigger after a manual worker restart.
 */
async function reset_orphaned(req, res) {
    const result = await model.reset_orphaned({ actor: actor_of(req) });
    res.json(result);
}

module.exports = {
    enqueue,
    list,
    get_one,
    get_timeline,
    rollback_pre_ingest,
    rollback_batch_pre,
    cancel_batch,
    rollback_archivematica,
    reset_row,
    cancel_row,
    return_to_packaging,
    reset_orphaned,
};
