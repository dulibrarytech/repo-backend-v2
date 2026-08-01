'use strict';

/*
 * Ingest dashboard controllers.
 *
 *   Pages                     Action endpoints
 *   ─────                     ────────────────
 *   /ingest  (queue list)     POST /ingest/workspace/:folder/make-digital-objects
 *   /ingest/workspace         POST /ingest/workspace/:folder/check-metadata
 *   /ingest/aspace-qa         POST /ingest/workspace/:folder/submit-ingest
 *   /ingest/packaging         POST /ingest/workspace/:folder/revert-to-mdo
 *
 * Pages render the body template, then wrap it in dashboard/layout.ejs.
 * Partials skip the layout.
 */

const app_config = require('../config/app');
const model = require('./model');
const workspace = require('./workspace');
const jobs = require('./jobs');
const qa_service = require('./libs/qa_service');
const archivematica = require('../libs/archivematica');
const duracloud = require('../libs/duracloud');
const aspace = require('../libs/archivesspace');
const es = require('../libs/elasticsearch');
const worker_registry = require('./worker');
const api_controller = require('./controller');
const {
    available_actions,
    STATUS_METADATA,
    PRE_AM_PRIOR_STATES,
    POST_UPLOAD_PRE_AM_PRIOR_STATES,
} = require('./state_metadata');
const { NotFoundError, ValidationError } = require('../libs/errors');
const log = require('../libs/log');

function render_page(req, res, view, locals = {}) {
    const cfg = app_config();
    const base_locals = {
        title: locals.title || 'Ingest — Digital Archives Manager @ DU',
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        app_version: cfg.version,
        asset_v: cfg.asset_v,
        page: locals.page || view,
        active: locals.active || 'ingest',
        user: locals.user || res.locals.user || null,
        ...locals,
    };
    res.render(view, base_locals, (err, body) => {
        if (err) return res.status(500).send(err.message);
        res.render('dashboard/layout', { ...base_locals, body });
    });
}

function render_partial(req, res, view, locals = {}) {
    const cfg = app_config();
    res.render(view, {
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        ...locals,
    });
}

function actor_from_request(req) {
    const u = req.user || {};
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    return u.du_id || u.email || `staff (${ip})`;
}

// --- Queue (existing — Phase 3d preserved) ---------------------------

function parse_filters(query = {}) {
    const status = (query.status || '').trim();
    const batch = (query.batch || '').trim();
    const is_complete_raw = query.is_complete;
    /*
     * is_complete: '1'/'true' → closed only, '0'/'false' → open only,
     * 'all' → every row. Default is open only (0).
     */
    let is_complete;
    if (is_complete_raw === '1' || is_complete_raw === 'true') is_complete = 1;
    else if (is_complete_raw === '0' || is_complete_raw === 'false') is_complete = 0;
    else if (is_complete_raw === 'all') is_complete = 'all';
    else is_complete = 0; // default
    return {
        status: status || '',
        batch: batch || '',
        is_complete: String(is_complete),
    };
}

function filters_to_query(filters) {
    const q = {};
    if (filters.status) q.status = filters.status;
    if (filters.batch) q.batch = filters.batch;
    if (filters.is_complete === '1') q.is_complete = true;
    if (filters.is_complete === '0') q.is_complete = false;
    // 'all' (and anything unrecognized) omits is_complete, surfacing both halves.

    /*
     * AIP-backfill synthetic rows (batch starts 'aip-backfill-') are excluded
     * unless a batch filter is set, in which case the exact match wins.
     */
    if (!filters.batch) q.exclude_backfill = true;
    return q;
}

async function decorate(rows) {
    return Promise.all(
        rows.map(async (r) => {
            const meta = STATUS_METADATA[r.pipeline_state] || {
                severity: 'INFO',
                suggested_action: null,
            };
            // Only CANCELLED_BY_USER rows need the prior state; others skip the lookup.
            let prev = null;
            if (r.pipeline_state === 'CANCELLED_BY_USER') {
                try {
                    prev = await model.get_prev_state_for_cancel(r.id);
                } catch (err) {
                    log.warn({
                        event: 'prev_state_lookup_failed',
                        queue_id: r.id,
                        err: err.message,
                    });
                }
            }
            // CANCELLED_BY_USER rows always get the same follow-up hint.
            let suggested_action = r.suggested_action || meta.suggested_action;
            if (r.pipeline_state === 'CANCELLED_BY_USER') {
                suggested_action = _cancel_followup_text(prev);
            }
            return {
                ...r,
                actions: available_actions(r.pipeline_state, prev),
                severity: r.severity || meta.severity,
                suggested_action,
            };
        })
    );
}

/*
 * One-line hint for a CANCELLED_BY_USER row. Both variants name the "Return to
 * Packaging" kebab item — keep them aligned with the label in ingest_row.ejs.
 */
function _cancel_followup_text(prev_state) {
    // Pre-upload cancels left the folder in 001-ready, so no "moved back" phrasing.
    if (PRE_AM_PRIOR_STATES.has(prev_state) && !POST_UPLOAD_PRE_AM_PRIOR_STATES.has(prev_state)) {
        return (
            'Cancelled by staff. Use Return to Packaging in the kebab menu' +
            ' to clear the queue row — the folder is still in the Packaging' +
            ' and Ingesting view, ready to re-submit.'
        );
    }
    return (
        'Cancelled by staff. Use Return to Packaging in the kebab menu to' +
        ' move the folder back to the Packaging and Ingesting view before' +
        ' re-running.'
    );
}

async function ingest_page(req, res) {
    render_page(req, res, 'dashboard/ingest', {
        page: 'ingest',
        active: 'queue',
        title: 'Queue — Ingest @ DU',
        filters: parse_filters(req.query),
    });
}

async function ingest_list_partial(req, res) {
    const filters = parse_filters(req.query);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = await model.list_queue(filters_to_query(filters), { limit, offset });
    const decorated = await decorate(rows);
    render_partial(req, res, 'dashboard/partials/ingest_table', {
        rows: decorated,
        filters,
        limit,
        offset,
        has_more: rows.length === limit,
    });
}

async function ingest_timeline_partial(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    const events = await model.get_timeline(id);
    const [decorated] = await decorate([row]);
    render_partial(req, res, 'dashboard/partials/ingest_timeline', {
        row: decorated,
        events,
    });
}

// --- Workspace pages -------------------------------------------------

async function workspace_page(req, res) {
    render_page(req, res, 'dashboard/ingest_workspace', {
        page: 'ingest_workspace',
        active: 'make-digital-objects',
        title: 'Make Digital Objects — Ingest @ DU',
    });
}

async function workspace_list_partial(req, res) {
    const data = await workspace.list_workspace({
        scope: 'unprocessed',
        q: req.query.q,
    });
    render_partial(req, res, 'dashboard/partials/workspace_table', {
        ...data,
        view: 'make-digital-objects',
        actions: ['make_digital_objects'],
    });
}

async function aspace_qa_page(req, res) {
    render_page(req, res, 'dashboard/ingest_aspace_qa', {
        page: 'ingest_aspace_qa',
        active: 'aspace-qa',
        title: 'ASpace Description QA — Ingest @ DU',
    });
}

async function aspace_qa_list_partial(req, res) {
    // show_passed=1 shows every folder in /processed; otherwise QA-passed ones are hidden.
    const show_passed = req.query.show_passed === '1';
    const data = await workspace.list_workspace({
        scope: 'processed',
        q: req.query.q,
        exclude_qa_passed: !show_passed,
    });
    render_partial(req, res, 'dashboard/partials/workspace_table', {
        ...data,
        view: 'aspace-qa',
        actions: ['check_metadata', 'revert_to_mdo'],
        show_passed,
    });
}

async function packaging_page(req, res) {
    render_page(req, res, 'dashboard/ingest_packaging', {
        page: 'ingest_packaging',
        active: 'packaging-and-ingesting',
        title: 'Packaging and Ingesting — Ingest @ DU',
    });
}

/*
 * Static Workflow Guide for the Digital Preservation Jobs section. Read-only;
 * no model calls. active='help' keeps the DPJ "workflow focus" sidebar mode.
 */
async function help_page(req, res) {
    render_page(req, res, 'dashboard/ingest_help', {
        page: 'ingest_help',
        active: 'help',
        title: 'Digital Preservation Jobs — Help',
    });
}

/*
 * Count of ingests claimable in stages 1–5 (metadata through repository
 * record). Stage 6 is excluded. Halted and terminal rows are not claimable and
 * do not count; count_rows_in_states already filters is_complete=0. Drives the
 * "Ingest in progress" banner and the one-submit-at-a-time guard.
 */
async function active_ingest_count() {
    return model.count_rows_in_states([...worker_registry.PIPELINE_STATES]);
}

/*
 * Count of background preservation copies (Stage 6) currently pending
 * or running. Informational only — never blocks submits.
 */
async function aip_copy_count() {
    return model.count_rows_in_states([...worker_registry.STAGE6_STATES]);
}

async function packaging_list_partial(req, res) {
    const data = await workspace.list_workspace({
        scope: 'processed',
        q: req.query.q,
    });
    const [in_progress, aip_copies] = await Promise.all([
        active_ingest_count(),
        aip_copy_count(),
    ]);
    render_partial(req, res, 'dashboard/partials/workspace_table', {
        ...data,
        view: 'packaging-and-ingesting',
        actions: ['submit_ingest', 'revert_to_mdo'],
        /*
         * ingest_in_progress drives the banner and the disabled Submit buttons
         * in workspace_table.ejs; the partial re-polls every 30s (and on
         * workspace:refresh), so both clear on their own.
         * aip_copy_in_progress_count is a notice only — it never disables Submit.
         */
        ingest_in_progress: in_progress > 0,
        ingest_in_progress_count: in_progress,
        aip_copy_in_progress_count: aip_copies,
    });
}

/*
 * "Recent Ingests" shell — repo objects ingested in the last 30 days. The table
 * is the shared Objects table, loaded via HTMX from /objects/list?recent_days=30,
 * so it reuses object_row.ejs and its RBAC.
 */
async function recent_ingests_page(req, res) {
    render_page(req, res, 'dashboard/ingest_recent', {
        page: 'ingest_recent',
        active: 'recent-ingests',
        title: 'Recent Ingests — Ingest @ DU',
        days: 30,
    });
}

// --- Workspace actions ----------------------------------------------

function render_action_result(req, res, payload) {
    render_partial(req, res, 'dashboard/partials/workspace_action_result', payload);
}

async function make_digital_objects_action(req, res) {
    const folder = req.params.folder;
    if (!folder) throw new ValidationError('folder is required');
    const actor = actor_from_request(req);
    const result = await workspace.run_make_digital_objects(folder);
    // Read after the run so a folder that grew or shrank mid-job is captured.
    const packages = await _packages_for_history(folder).catch(() => []);
    await _record_job_safely({
        job_type: 'make_digital_objects',
        status: result.ok ? 'SUCCESSFUL' : 'FAILED',
        collection_folder: folder,
        packages,
        actor,
        error: result.ok ? null : result.error || _errors_array(result).join('; '),
    });
    if (!result.ok) {
        return render_action_result(req, res, {
            ok: false,
            action: 'Make Digital Objects',
            folder,
            message: `Make Digital Objects failed for ${folder}.`,
            errors: _errors_array(result),
            detail: result.body,
        });
    }
    res.set('HX-Trigger', 'workspace:refresh');
    render_action_result(req, res, {
        ok: true,
        action: 'Make Digital Objects',
        folder,
        message: `Make Digital Objects completed for ${folder}.`,
        detail: result.body,
    });
}

async function aspace_qa_check_action(req, res) {
    const folder = req.params.folder;
    if (!folder) throw new ValidationError('folder is required');
    const actor = actor_from_request(req);
    const result = await workspace.run_qa_check(folder);
    if (result.ok && result.packages.length > 0) {
        res.set('HX-Trigger', 'workspace:refresh');
    }
    /*
     * The package names QA validated against, one per AS record checked. The
     * SUCCESSFUL job row recorded below is what list_workspace's qa-passed
     * filter reads, so it also hides the folder on the next refresh.
     */
    const package_names = (result.packages || []).map((p) => p && p.name).filter(Boolean);
    await _record_job_safely({
        job_type: 'archivesspace_description_qa',
        status: result.ok ? 'SUCCESSFUL' : 'FAILED',
        collection_folder: folder,
        packages: package_names,
        actor,
        error: result.ok ? null : result.error,
    });
    render_partial(req, res, 'dashboard/partials/qa_check_result', {
        ok: !!result.ok,
        folder,
        packages: result.packages || [],
        error: result.error || null,
    });
}

async function submit_ingest_action(req, res) {
    const folder = req.params.folder;
    if (!folder) throw new ValidationError('folder is required');
    const actor = actor_from_request(req);
    /*
     * One ingest in the pipeline at a time — the authoritative guard; the
     * disabled Submit button in the packaging list is UI-only. Not atomic:
     * two truly simultaneous submits can both pass.
     */
    if ((await active_ingest_count()) > 0) {
        return render_action_result(req, res, {
            ok: false,
            severity: 'warn',
            action: 'Submit to Ingest',
            folder,
            message:
                'An ingest is already in progress. Wait until it completes before submitting another — Archivematica processes one ingest at a time.',
        });
    }
    const result = await workspace.submit_to_ingest(folder, actor);
    // The packages actually queued; still read on failure, for the audit row.
    const packages = await _packages_for_history(folder).catch(() => []);
    await _record_job_safely({
        job_type: 'packaging_and_ingesting',
        status: result.ok ? 'SUCCESSFUL' : 'FAILED',
        collection_folder: folder,
        packages,
        actor,
        error: result.ok ? null : result.error,
    });
    /*
     * A successful submit also stamps a SUCCESSFUL QA job, so a folder that
     * goes submit → cancel → return-to-packaging does not resurface in the
     * ASpace QA view.
     */
    if (result.ok) {
        await _record_job_safely({
            job_type: 'archivesspace_description_qa',
            status: 'SUCCESSFUL',
            collection_folder: folder,
            packages,
            actor,
            error: null,
        });
    }
    if (!result.ok) {
        return render_action_result(req, res, {
            ok: false,
            action: 'Submit to Ingest',
            folder,
            message: `Submit to Ingest failed for ${folder}.`,
            errors: [result.error || 'unknown error'],
        });
    }
    /*
     * Both lists refresh: the folder leaves the packaging view and new rows
     * appear in the queue. redirect_to / redirect_delay_ms tell dashboard.js to
     * navigate once the success banner has surfaced.
     */
    res.set('HX-Trigger', 'workspace:refresh, queue:refresh');
    render_action_result(req, res, {
        ok: true,
        action: 'Submit to Ingest',
        folder,
        message: `Queued ${result.count} package${result.count === 1 ? '' : 's'} from ${folder} for ingest.`,
        redirect_to: `${app_config().path}/dashboard/ingest`,
        redirect_delay_ms: 2000,
        detail: { queue_ids: result.queue_ids },
    });
}

async function revert_to_mdo_action(req, res) {
    const folder = req.params.folder;
    if (!folder) throw new ValidationError('folder is required');
    const result = await workspace.revert_to_mdo(folder);
    if (!result.ok) {
        return render_action_result(req, res, {
            ok: false,
            action: 'Revert to Make Digital Objects',
            folder,
            message: `Revert failed for ${folder}.`,
            errors: _errors_array(result),
            detail: result.body,
        });
    }
    res.set('HX-Trigger', 'workspace:refresh');
    render_action_result(req, res, {
        ok: true,
        action: 'Revert to Make Digital Objects',
        folder,
        message: `${folder} reverted to Make Digital Objects.`,
        detail: result.body,
    });
}

// --- Queue actions ---------------------------------------------------

/*
 * Staff-initiated cancel from the queue page. Aborts the worker (waking the
 * long poll) and flips the row to CANCELLED_BY_USER with an audit event whose
 * payload carries the prior state. Returns the row partial for an HTMX swap,
 * or 409 with the current state if the row is already terminal.
 */
async function cancel_row_action(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    const actor = actor_from_request(req);
    const reason = (req.body && req.body.reason) || 'Cancelled by staff';

    // 1. Signal worker AbortController to wake the long poll.
    const worker = worker_registry.get_active_worker();
    if (worker && typeof worker.cancel_row === 'function') {
        worker.cancel_row(id);
    }

    // 2. Flip the row + write the audit event.
    const result = await model.cancel(id, { actor, reason });
    if (!result.ok && result.reason === 'already_terminal') {
        // dashboard.js's error handler turns a 409 into a toast.
        return res.status(409).json({
            id,
            error: 'already_terminal',
            current_state: result.current_state,
        });
    }

    // Re-read so the response carries the updated state and its action list.
    const updated = await model.get_queue_row({ id });
    const [decorated] = await decorate([updated]);
    res.set('HX-Trigger', 'queue:refresh');
    render_partial(req, res, 'dashboard/partials/ingest_row', { row: decorated });
}

const STOPPABLE_AIP_STATES = new Set(['AIP_STORE_PENDING', 'AIP_STORE_IN_PROGRESS']);

/*
 * Staff-initiated stop of a Stage 6 preservation copy. No rollback: it parks
 * the AIP→Wasabi copy at AIP_STORE_FAILED, skipping any remaining retry budget.
 * The AIPs dashboard stays the retry surface, and its Retry re-opens the queue
 * row. 409 if the row is not in a STOPPABLE_AIP_STATES state.
 *
 * The worker abort wakes the in-flight curation call; the stage returns without
 * recording a failure, so this handler's row write is the terminal word.
 */

async function stop_aip_copy_action(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    if (!STOPPABLE_AIP_STATES.has(row.pipeline_state)) {
        return res.status(409).json({
            id,
            error: 'not_stoppable',
            current_state: row.pipeline_state,
        });
    }
    const actor = actor_from_request(req);

    // 1. Abort any in-flight copy call in the worker.
    const worker = worker_registry.get_active_worker();
    if (worker && typeof worker.cancel_row === 'function') {
        worker.cancel_row(id);
    }

    /*
     * 2. Mark the tbl_aip_store row failed, creating it if no attempt has
     *    failed before, so the AIPs dashboard shows the stopped copy and its
     *    Retry. Best-effort.
     */
    try {
        const { db } = require('../config/db');
        const tables = require('../config/db_tables');
        const obj = await db()(tables.objects)
            .select('pid')
            .where({ sip_uuid: row.sip_uuid })
            .first();
        if (obj && obj.pid) {
            const aip_store_model = require('../repository/aip_store_model');
            await aip_store_model.upsert_by_uuid(obj.pid, {
                aip_uuid: row.sip_uuid,
                source: aip_store_model.SOURCE.INGEST_V2,
                is_migrated: aip_store_model.STATUS.INGEST_COPY_FAILED,
                next_attempt_at: null,
                error: 'Preservation copy stopped by staff',
                message: 'STOPPED_BY_STAFF',
            });
        }
    } catch (err) {
        log.warn({
            event: 'aip_stop_store_write_failed',
            queue_id: id,
            err: err.message,
        });
    }

    // 3. Park the queue row. Stays visible (is_complete=0) until Dismissed.
    await model.update_queue(
        { id },
        {
            status: 'AIP_STORE_FAILED',
            is_complete: 0,
            error: 'Preservation copy stopped by staff',
            suggested_action:
                'Preservation copy to cloud storage was stopped by staff. The' +
                ' ingest itself is complete. Retry any time from the AIPs' +
                ' dashboard, or use Dismiss to clear this row.',
        },
        {
            actor,
            event_type: 'staff_action',
            payload: { stage: 'aip_store', step: 'stopped_by_staff' },
        }
    );

    const updated = await model.get_queue_row({ id });
    const [decorated] = await decorate([updated]);
    res.set('HX-Trigger', 'queue:refresh');
    render_partial(req, res, 'dashboard/partials/ingest_row', { row: decorated });
}

/*
 * Staff acknowledgment of a failed preservation copy: flips is_complete=1 so
 * the row leaves the open queue view, and changes nothing else. The AIPs
 * dashboard keeps tracking the copy, and its Retry re-opens the row at
 * AIP_STORE_PENDING / is_complete=0. 409 unless the row is AIP_STORE_FAILED.
 *
 * The audit event goes through insert_event because is_complete alone is not a
 * state transition, and update_queue only records transitions.
 */
async function dismiss_aip_row_action(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await model.get_queue_row({ id });
    if (!row) throw new NotFoundError(`queue row ${id} not found`);
    if (row.pipeline_state !== 'AIP_STORE_FAILED') {
        return res.status(409).json({
            id,
            error: 'not_dismissable',
            current_state: row.pipeline_state,
        });
    }
    const actor = actor_from_request(req);
    await model.update_queue({ id }, { is_complete: 1 });
    try {
        await model.insert_event(id, {
            event_type: 'staff_action',
            actor,
            to_state: 'AIP_STORE_FAILED',
            payload: {
                stage: 'aip_store',
                step: 'dismissed_by_staff',
                note: 'Row dismissed from the queue view; the failed preservation copy remains tracked on the AIPs dashboard.',
            },
        });
    } catch (err) {
        log.warn({
            event: 'aip_dismiss_event_write_failed',
            queue_id: id,
            err: err.message,
        });
    }

    const updated = await model.get_queue_row({ id });
    const [decorated] = await decorate([updated]);
    res.set('HX-Trigger', 'queue:refresh');
    render_partial(req, res, 'dashboard/partials/ingest_row', { row: decorated });
}

/*
 * --- Queue row mutation wrappers -------------------------------------
 *
 * The REST API endpoints (controller.rollback_pre_ingest and friends) answer
 * with JSON. The dashboard's row kebab wants the row re-rendered in place via
 * an HTMX outerHTML swap, so these wrappers run the same API logic and then
 * either pass the JSON error through (4xx/5xx) or re-fetch and render the row
 * partial.
 */

async function _wrap_api_as_partial(api_fn, req, res) {
    /*
     * Records whatever the API controller writes — status(), json(), and set()
     * may arrive in any order — and flushes to the real `res` once it settles.
     * Validation / not-found / forbidden errors propagate to the central error
     * handler, as they would on a direct API hit.
     */
    let status_code = 200;
    let json_body = null;
    let hx_trigger = null;
    const mock_res = {
        status(code) {
            status_code = code;
            return this;
        },
        json(body) {
            json_body = body;
            return this;
        },
        set(name, value) {
            if (name === 'HX-Trigger') hx_trigger = value;
            return this;
        },
    };

    await api_fn(req, mock_res);

    if (status_code >= 400) {
        // A real HTTP error so dashboard.js's htmx:responseError listener toasts it.
        return res.status(status_code).json(json_body);
    }

    // Re-read the row so the response carries the updated state and action list.
    const id = parseInt(req.params.id, 10);
    const updated = await model.get_queue_row({ id });
    if (!updated) {
        // Unreachable in practice — the API controller 404s a missing row first.
        return res.status(404).json({ error: 'not_found', id });
    }
    const [decorated] = await decorate([updated]);
    res.set('HX-Trigger', hx_trigger || 'queue:refresh');
    render_partial(req, res, 'dashboard/partials/ingest_row', { row: decorated });
}

async function rollback_pre_ingest_action(req, res) {
    return _wrap_api_as_partial(api_controller.rollback_pre_ingest, req, res);
}

/*
 * Batch halt wrapper. Changes many rows, so it cannot answer with a row
 * partial: empty body (the kebab item uses hx-swap="none"), with queue:refresh
 * redrawing the table and a toast summarizing the counts. Toast text must be
 * ASCII — HX-Trigger is an HTTP header.
 */
async function cancel_batch_action(req, res) {
    let status_code = 200;
    let json_body = null;
    const mock_res = {
        status(code) {
            status_code = code;
            return this;
        },
        json(body) {
            json_body = body;
            return this;
        },
        set() {
            return this;
        },
    };
    await api_controller.cancel_batch(req, mock_res);
    if (status_code >= 400) {
        return res.status(status_code).json(json_body);
    }
    const s = json_body;
    let message =
        `Batch halted: ${s.cancelled} package${s.cancelled === 1 ? '' : 's'} cancelled` +
        (s.was_running > 0 ? ` (${s.was_running} stopped mid-stage)` : '') +
        '.';
    if (s.already_halted > 0) {
        message += ` ${s.already_halted} already halted.`;
    }
    if (s.skipped_other > 0) {
        message += ` ${s.skipped_other} skipped.`;
    }
    message += ' Use "Return entire batch to Packaging" to clean up.';
    res.set(
        'HX-Trigger',
        JSON.stringify({
            'queue:refresh': true,
            toast: { level: 'success', message },
        })
    );
    res.status(200).send('');
}

/*
 * Batch rollback wrapper — same empty-body + HX-Trigger contract as
 * cancel_batch_action above. Warns rather than succeeds when any folder move
 * reported an error.
 */
async function rollback_batch_pre_action(req, res) {
    let status_code = 200;
    let json_body = null;
    const mock_res = {
        status(code) {
            status_code = code;
            return this;
        },
        json(body) {
            json_body = body;
            return this;
        },
        set() {
            return this;
        },
    };
    await api_controller.rollback_batch_pre(req, mock_res);
    if (status_code >= 400) {
        return res.status(status_code).json(json_body);
    }
    const s = json_body;
    const skipped = s.skipped_in_flight + s.skipped_am_side + s.skipped_other;
    let message =
        `Batch rollback: ${s.rolled_back} package` +
        `${s.rolled_back === 1 ? '' : 's'} returned to Packaging.`;
    if (skipped > 0) {
        message += ` ${skipped} skipped (still running, completed, or needs Archivematica rollback).`;
    }
    if (s.qa_errors > 0) {
        message += ` ${s.qa_errors} folder move(s) reported errors - check the timelines.`;
    }
    res.set(
        'HX-Trigger',
        JSON.stringify({
            'queue:refresh': true,
            toast: { level: s.qa_errors > 0 ? 'warn' : 'success', message },
        })
    );
    res.status(200).send('');
}

async function rollback_archivematica_action(req, res) {
    return _wrap_api_as_partial(api_controller.rollback_archivematica, req, res);
}

async function reset_row_action(req, res) {
    return _wrap_api_as_partial(api_controller.reset_row, req, res);
}

async function return_to_packaging_action(req, res) {
    return _wrap_api_as_partial(api_controller.return_to_packaging, req, res);
}

// --- Job History page ------------------------------------------------

const JOB_TYPE_LABELS = {
    make_digital_objects: 'Make Digital Objects',
    archivesspace_description_qa: 'ArchivesSpace Description QA',
    packaging_and_ingesting: 'Packaging and Ingesting',
    /*
     * Worker-recorded, FAILED rows only. The history filter dropdown derives
     * from this map, so each entry doubles as a filter option.
     */
    archive_to_wasabi: 'Archive to Wasabi',
};

async function history_page(req, res) {
    render_page(req, res, 'dashboard/ingest_history', {
        page: 'ingest_history',
        active: 'history',
        title: 'Job History — Ingest @ DU',
        filters: _parse_history_filters(req.query),
        job_type_labels: JOB_TYPE_LABELS,
    });
}

async function history_list_partial(req, res) {
    const filters = _parse_history_filters(req.query);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const data = await jobs.list_jobs(
        {
            q: filters.q,
            job_type: filters.job_type,
            status: filters.status,
        },
        { limit, offset }
    );
    render_partial(req, res, 'dashboard/partials/ingest_history_table', {
        rows: data.rows,
        total: data.total,
        limit: data.limit,
        offset: data.offset,
        filters,
        job_type_labels: JOB_TYPE_LABELS,
    });
}

function _parse_history_filters(query = {}) {
    const q = (query.q || '').trim();
    const job_type = jobs.JOB_TYPES.has(query.job_type) ? query.job_type : '';
    const status = jobs.STATUSES.has(query.status) ? query.status : '';
    return { q, job_type, status };
}

// --- Services admin (curation-API + Wasabi health) ------------------

/*
 * Admin landing page at /dashboard/admin/services. Two panels: the combined
 * upstream-services panel (see services_health_partial) and the Wasabi probe
 * (boto3 head_bucket via the curation host).
 */
async function services_page(req, res) {
    render_page(req, res, 'dashboard/admin/services', {
        page: 'services',
        active: 'admin',
        title: 'Services Health — Digital Archives Manager @ DU',
    });
}

/*
 * The four upstream services the ingest pipeline depends on, each with one
 * non-throwing reachability/auth probe. Array order is render order.
 */
const SERVICE_PROBES = [
    { key: 'curation_api', label: 'Curation API', probe: _probe_curation },
    { key: 'archivematica', label: 'Archivematica', probe: _probe_archivematica },
    { key: 'duracloud', label: 'DuraCloud', probe: _probe_duracloud },
    { key: 'archivesspace', label: 'ArchivesSpace', probe: _probe_archivesspace },
];

/*
 * HTMX-polled combined health panel, re-fetched every 30s from services_page.
 * Probes run in parallel, each under its own client-configured timeout, and
 * each is wrapped so one failure cannot reject the batch — the worst case for
 * a card is reachable=false with the error in detail.
 */
async function services_health_partial(req, res) {
    const services = await Promise.all(
        SERVICE_PROBES.map(({ key, label, probe }) => _run_probe(key, label, probe))
    );
    render_partial(req, res, 'dashboard/partials/services_health', {
        services,
        checked_at: new Date().toISOString(),
    });
}

/*
 * Capability phrasing for the post-sign-in banner — the user-facing feature
 * each probed service backs. Keys match BANNER_PROBES.
 */
const SERVICE_CAPABILITY = {
    elasticsearch: 'search & browse',
    curation_api: 'ingest / QA moves',
    archivematica: 'ingest pipeline',
    duracloud: 'preservation storage',
    archivesspace: 'metadata sync',
};

/*
 * Everything the admin grid probes, plus Elasticsearch. Reuses SERVICE_PROBES
 * so the ingest-upstream set stays single-sourced.
 */
const BANNER_PROBES = [
    ...SERVICE_PROBES,
    { key: 'elasticsearch', label: 'Elasticsearch', probe: _probe_elasticsearch },
];

/*
 * Per-probe deadline for the banner. Must exceed the slowest HEALTHY probe, or
 * a live service is false-flagged as down: ArchivesSpace and DuraCloud are 15s,
 * Elasticsearch 10s. The invariant is guarded in tests against
 * ARCHIVESPACE_TIMEOUT_MS.
 */
const BANNER_PROBE_TIMEOUT_MS = 20000;

/*
 * Post-sign-in "degraded services" banner, lazy-loaded by the home page after
 * paint (hx-trigger="load"). Probes run in parallel and never throw
 * (_run_probe guarantees it). Renders the alert only for services that are
 * configured but unreachable; with nothing degraded the partial emits nothing
 * and the hx-swap="outerHTML" mount is removed.
 */
async function services_banner_partial(req, res) {
    const results = await Promise.all(
        BANNER_PROBES.map(({ key, label, probe }) =>
            _run_probe(key, label, probe, BANNER_PROBE_TIMEOUT_MS)
        )
    );
    const degraded = results
        .filter((s) => s.configured && !s.reachable)
        .map((s) => ({ label: s.label, capability: SERVICE_CAPABILITY[s.key] || '' }));
    render_partial(req, res, 'dashboard/partials/services_banner', {
        degraded,
        checked_at: new Date().toISOString(),
    });
}

/*
 * Race a probe against a deadline. On expiry it RESOLVES to a
 * `{ __timed_out: true }` sentinel rather than rejecting. A late rejection from
 * the losing promise is swallowed so it cannot surface as an unhandledRejection.
 * timeout_ms <= 0 means no deadline (the admin grid).
 */
function _with_deadline(probe, timeout_ms) {
    const p = Promise.resolve().then(probe);
    if (!timeout_ms || timeout_ms <= 0) return p;
    p.catch(() => {});
    return Promise.race([
        p,
        new Promise((resolve) => {
            const t = setTimeout(() => resolve({ __timed_out: true }), timeout_ms);
            if (t.unref) t.unref();
        }),
    ]);
}

/*
 * Wrap a per-service probe with timing and a uniform shape, and guarantee it
 * never throws. Returns:
 *   { key, label, configured, reachable, detail, elapsed_ms }
 * `configured:false` renders as a neutral "not configured" badge, never red.
 * `timeout_ms` (optional) bounds the probe — on expiry the service is reported
 * unreachable with a "timed out" detail rather than hanging.
 */
async function _run_probe(key, label, probe, timeout_ms = 0) {
    const started = Date.now();
    try {
        const out = await _with_deadline(probe, timeout_ms);
        if (out && out.__timed_out) {
            return {
                key,
                label,
                configured: true,
                reachable: false,
                detail: `probe timed out after ${timeout_ms}ms`,
                elapsed_ms: Date.now() - started,
            };
        }
        const configured = out.configured !== false;
        return {
            key,
            label,
            configured,
            reachable: configured ? !!out.reachable : false,
            detail: configured ? out.detail || '' : 'not configured',
            elapsed_ms: Date.now() - started,
        };
    } catch (err) {
        // The _probe_* helpers don't throw; a surprise renders a red card, not a 500.
        log.warn({ event: 'service_probe_threw', service: key, err: err.message });
        return {
            key,
            label,
            configured: true,
            reachable: false,
            detail: err.message,
            elapsed_ms: Date.now() - started,
        };
    }
}

// Curation API — GET /health (no auth). Throws on transport failure; _run_probe catches.
async function _probe_curation() {
    if (!qa_service.is_configured()) return { configured: false };
    const r = await qa_service.health();
    const ok = r.status === 200;
    return { configured: true, reachable: ok, detail: `GET /health → ${r.status}` };
}

/*
 * Archivematica — transfer (main) API liveness. health_api() returns
 * { ok, status, error }, so the card names the actual failure rather than a
 * generic "no HTTP 200".
 */
async function _probe_archivematica() {
    if (!archivematica.is_configured()) return { configured: false };
    const r = await archivematica.health_api();
    let detail;
    if (r.ok) {
        detail = 'transfer API reachable (HTTP 200)';
    } else if (r.error) {
        // Transport-level failure, surfaced verbatim.
        detail = `transport error: ${r.error}`;
    } else {
        // An HTTP response, just not 200.
        detail = `transfer API returned HTTP ${r.status}`;
    }
    return { configured: true, reachable: r.ok, detail };
}

// DuraCloud — HEAD on the dip-store space root (reachability + auth).
async function _probe_duracloud() {
    if (!duracloud.is_configured()) return { configured: false };
    const ok = await duracloud.ping();
    return {
        configured: true,
        reachable: ok,
        detail: ok ? 'dip-store reachable' : 'dip-store unreachable or auth rejected',
    };
}

// ArchivesSpace — login round-trip (reachability + auth).
async function _probe_archivesspace() {
    if (!aspace.is_configured()) return { configured: false };
    const ok = await aspace.ping();
    return {
        configured: true,
        reachable: ok,
        detail: ok ? 'login succeeded' : 'login failed or unreachable',
    };
}

/*
 * Elasticsearch — cluster health round-trip. es.health() catches internally and
 * returns { ok, status, err? }, never throwing. Banner-only; not part of the
 * ingest-upstream admin grid.
 */
async function _probe_elasticsearch() {
    if (!es.is_configured()) return { configured: false };
    const r = await es.health();
    if (r.ok) return { configured: true, reachable: true, detail: `cluster ${r.status}` };
    const detail =
        r.status === 'unreachable'
            ? `unreachable${r.err ? ': ' + r.err : ''}`
            : `cluster ${r.status}`;
    return { configured: true, reachable: false, detail };
}

/*
 * HTMX-polled Wasabi status panel, re-fetched every 30s from services_page. One
 * curation-API `head_bucket` hit; a curation-side outage renders as a red card
 * rather than a 500.
 */
async function services_wasabi_partial(req, res) {
    let reachable = false;
    let body = null;
    let transport_error = null;
    try {
        const result = await qa_service.health_wasabi();
        reachable = true;
        body = result.data || null;
    } catch (err) {
        transport_error = err.message;
        log.warn({ event: 'services_wasabi_partial_unreachable', err: err.message });
    }
    render_partial(req, res, 'dashboard/partials/services_wasabi', {
        reachable,
        body,
        transport_error,
        // Server-side stamp; the view renders it as a relative time client-side.
        checked_at: new Date().toISOString(),
    });
}

// --- Internal --------------------------------------------------------

function _errors_array(result) {
    if (result.body && Array.isArray(result.body.errors) && result.body.errors.length > 0) {
        return result.body.errors;
    }
    return result.error ? [result.error] : ['Unknown error'];
}

/*
 * The packages currently in a folder, via the curation-service, for the history
 * row. Returns [] if the folder is in neither scope.
 */
async function _packages_for_history(folder) {
    const data = await workspace.list_workspace({
        // Either scope carries this folder's package list; 'unprocessed' is broader.
        scope: 'unprocessed',
    });
    const match = (data.folders || []).find((f) => f.name === folder);
    if (match && Array.isArray(match.packages)) return match.packages;
    // The folder may have moved between calls.
    const data_p = await workspace.list_workspace({ scope: 'processed' });
    const match_p = (data_p.folders || []).find((f) => f.name === folder);
    return match_p && Array.isArray(match_p.packages) ? match_p.packages : [];
}

// Record-job wrapper — never throws; logs and returns null on failure.
async function _record_job_safely(payload) {
    try {
        return await jobs.record_job(payload);
    } catch (err) {
        log.warn({ event: 'job_history_write_failed', err: err.message, payload });
        return null;
    }
}

module.exports = {
    // Queue
    ingest_page,
    ingest_list_partial,
    ingest_timeline_partial,
    cancel_row_action,
    stop_aip_copy_action,
    dismiss_aip_row_action,
    _active_ingest_count: active_ingest_count,
    _aip_copy_count: aip_copy_count,
    rollback_pre_ingest_action,
    rollback_batch_pre_action,
    cancel_batch_action,
    rollback_archivematica_action,
    reset_row_action,
    return_to_packaging_action,
    // Workspace pages
    workspace_page,
    workspace_list_partial,
    aspace_qa_page,
    aspace_qa_list_partial,
    packaging_page,
    packaging_list_partial,
    recent_ingests_page,
    help_page,
    // Workspace actions
    make_digital_objects_action,
    aspace_qa_check_action,
    submit_ingest_action,
    revert_to_mdo_action,
    // Job History
    history_page,
    history_list_partial,
    // Services Health (admin)
    services_page,
    services_health_partial,
    services_wasabi_partial,
    services_banner_partial,
    // exported for tests
    _run_probe,
    _with_deadline,
    BANNER_PROBE_TIMEOUT_MS,
};
