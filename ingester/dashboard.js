'use strict';

// Ingest dashboard controllers. Mirrors the v2 ingest-service layout:
//
//   Pages           Action endpoints
//   ─────           ────────────────
//   /ingest                   (queue list)
//   /ingest/workspace         (Make Digital Objects)
//   /ingest/aspace-qa         (ASpace Description QA)
//   /ingest/packaging         (Packaging and Ingesting)
//
//   POST /ingest/workspace/:folder/make-digital-objects
//   POST /ingest/workspace/:folder/check-metadata
//   POST /ingest/workspace/:folder/submit-ingest
//   POST /ingest/workspace/:folder/revert-to-mdo
//
// Page rendering: render the body template, then wrap in
// dashboard/layout.ejs. Partials skip the layout.

const app_config = require('../config/app');
const model = require('./model');
const workspace = require('./workspace');
const jobs = require('./jobs');
const qa_service = require('./libs/qa_service');
const archivematica = require('../libs/archivematica');
const duracloud = require('../libs/duracloud');
const aspace = require('../libs/archivesspace');
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
        title: locals.title || 'Ingest — Repository @ DU',
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
    // Default to "Open only" (is_complete=0). Terminal rows
    // (RETURNED_TO_PACKAGING, ROLLED_BACK_TO_READY, AM_DELETION_REQUESTED,
    // COMPLETE, etc.) clutter the live view and create the appearance of
    // duplicates after a re-submit: the old terminal row sits next to
    // the new PENDING row, both showing the same package. Staff can flip
    // to "All rows" / "Closed only" via the dropdown when they need to
    // audit terminal rows.
    //
    // To opt OUT of the default and see every row, pass `is_complete=all`.
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
    // 'all' (and any unrecognized value) skips the is_complete filter
    // entirely so both halves of the queue surface.

    // Hide AIP-backfill synthetic rows from the default queue view.
    // They show up on the /admin/aip-backfill page instead. Staff
    // opt in to seeing them here by entering the batch marker
    // explicitly in the batch filter (their `batch` value starts
    // with 'aip-backfill-' — the model's whereNot filter is bypassed
    // when filters.batch is set, since the exact-match takes
    // precedence over the LIKE exclusion's intent).
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
            // CANCELLED_BY_USER rows need the prior state to choose
            // the right rollback target; for every other state the
            // lookup is skipped to avoid a per-row DB roundtrip on
            // the queue page.
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
            // For CANCELLED_BY_USER rows we always surface ONE
            // follow-up action ("Return to Packaging") regardless of
            // prev_state. The hint names it explicitly so staff
            // doesn't have to interpret the word "rollback" — and so
            // the row text matches the kebab label one-for-one.
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

// One-line hint for a CANCELLED_BY_USER row. We deliberately use the
// same copy regardless of prev_state — the kebab always shows
// "Return to Packaging" and the controller branches on prev_state
// internally to decide what cleanup runs. The hint names that
// kebab item explicitly so staff doesn't have to guess.
//
// Keep this aligned with ingest_row.ejs's "Return to Packaging"
// label — if you rename the kebab item, update this string too.
function _cancel_followup_text(prev_state) {
    // Pre-upload cancels never moved the folder out of 001-ready, so
    // the worded hint is slightly different (no "moved back" phrasing
    // — the folder never left). All other cases share the longer
    // version that explains the move.
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
    // `show_passed=1` opts out of the qa-passed filter so the
    // operator can see every folder in /processed (including ones
    // already QA'd). Any other value — including absent — keeps
    // the default of hiding already-passed folders so the view
    // shows ONLY work that still needs review.
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

async function packaging_list_partial(req, res) {
    const data = await workspace.list_workspace({
        scope: 'processed',
        q: req.query.q,
    });
    render_partial(req, res, 'dashboard/partials/workspace_table', {
        ...data,
        view: 'packaging-and-ingesting',
        actions: ['submit_ingest', 'revert_to_mdo'],
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
    // Pull the package list AFTER the run completed so a folder that
    // grew/shrank mid-job is captured accurately. List failures here
    // don't block the job record — we record with an empty array.
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
        // No in-process marker any more: the SUCCESSFUL row we
        // record into tbl_ingest_jobs below IS the marker that
        // list_workspace's qa-passed filter reads from. We still
        // emit workspace:refresh so the page re-queries; the
        // record_job call is awaited before the response, so the
        // refresh sees the new row.
        res.set('HX-Trigger', 'workspace:refresh');
    }
    // Capture the package names QA actually validated against (one
    // per AS record checked). This is the most accurate snapshot
    // for the history view — staff can see exactly what was QA'd —
    // and also the trigger that hides the folder from the QA list
    // on the next refresh.
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
    const result = await workspace.submit_to_ingest(folder, actor);
    // Get the package list we actually queued. On failure we still
    // pull it (for the audit row) but tolerate any error.
    const packages = await _packages_for_history(folder).catch(() => []);
    await _record_job_safely({
        job_type: 'packaging_and_ingesting',
        status: result.ok ? 'SUCCESSFUL' : 'FAILED',
        collection_folder: folder,
        packages,
        actor,
        error: result.ok ? null : result.error,
    });
    // Also record a SUCCESSFUL archivesspace_description_qa job on
    // successful submit. The submit path implicitly QA-passes the
    // folder (the pre-flight gate validates the AS resource exists,
    // and the worker re-validates per-package via Stage 1). Without
    // this marker, a folder that went through submit → cancel →
    // return-to-packaging would resurface in the ASpace QA view
    // even though it was already QA'd at submit time. The marker
    // makes the QA filter idempotent across re-submit cycles.
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
    // Both the workspace lists AND the queue table need to refresh —
    // the folder leaves the packaging view and new rows appear in
    // the queue. The redirect_to / redirect_delay_ms options drive
    // dashboard.js to navigate after the success banner has
    // surfaced (~2s).
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

// Staff-initiated cancel from the queue page. Pairs the worker abort
// (kicks long polls awake immediately) with the model flip
// (CANCELLED_BY_USER + audit event whose payload carries the prior
// state). Returns the rendered row partial so HTMX can swap it in
// place; on a stale row (already terminal between page render and
// click) we return a 409 with the current state for the toast.
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
        // Stale row — surface as a toast via the row's data-attrs.
        // The dashboard.js error handler picks up 409 responses.
        return res.status(409).json({
            id,
            error: 'already_terminal',
            current_state: result.current_state,
        });
    }

    // Re-read + decorate so the response carries the updated state
    // (and the post-cancel action list — rollback options surface
    // here based on the captured prior state).
    const updated = await model.get_queue_row({ id });
    const [decorated] = await decorate([updated]);
    res.set('HX-Trigger', 'queue:refresh');
    render_partial(req, res, 'dashboard/partials/ingest_row', { row: decorated });
}

// --- Queue row mutation wrappers -------------------------------------
//
// The REST API endpoints (controller.rollback_pre_ingest etc.) return
// JSON for programmatic clients. The dashboard's row kebab menu wants
// the row to re-render in place via HTMX outerHTML swap — so these
// thin wrappers run the same API logic, then either pass through the
// JSON error (for 4xx/5xx) or re-fetch + render the row partial on
// success. Avoids duplicating the per-action orchestration in two
// places (was the source of an earlier bug where the row UI showed
// raw JSON because hx-post pointed at the JSON API endpoint).

async function _wrap_api_as_partial(api_fn, req, res) {
    // Capture whatever the API controller writes to `res`. The
    // controller may call status(), json(), and set() in any order;
    // we record state and only flush to the real `res` after the
    // function settles.
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

    // Validation / not-found / forbidden errors propagate to the
    // central error handler — same as a direct API hit.
    await api_fn(req, mock_res);

    if (status_code >= 400) {
        // Surface the error as a real HTTP response so dashboard.js's
        // htmx:responseError listener can render a toast.
        return res.status(status_code).json(json_body);
    }

    // Success path: re-read the row so the response carries the
    // updated state + the next action list.
    const id = parseInt(req.params.id, 10);
    const updated = await model.get_queue_row({ id });
    if (!updated) {
        // Defensive — shouldn't happen because the API controller
        // already 404'd if the row was missing. Surface a 404 with
        // an empty body so HTMX can fall back to the toast handler.
        return res.status(404).json({ error: 'not_found', id });
    }
    const [decorated] = await decorate([updated]);
    res.set('HX-Trigger', hx_trigger || 'queue:refresh');
    render_partial(req, res, 'dashboard/partials/ingest_row', { row: decorated });
}

async function rollback_pre_ingest_action(req, res) {
    return _wrap_api_as_partial(api_controller.rollback_pre_ingest, req, res);
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

// Admin landing page for "external services this app talks to".
// Two panels: a combined upstream-services panel (curation-API,
// Archivematica, DuraCloud, ArchivesSpace — see services_health_partial)
// and the deeper Wasabi probe (boto3 head_bucket via the curation host).
// Mounted under /dashboard/admin/services, alongside the indexer +
// metadata-refresh admin pages.
async function services_page(req, res) {
    render_page(req, res, 'dashboard/admin/services', {
        page: 'services',
        active: 'admin',
        title: 'Services Health — Repository @ DU',
    });
}

// The four upstream services the ingest pipeline depends on, each with
// a single non-throwing reachability/auth probe. Order here is the
// render order on the page. Each `probe` resolves to a boolean
// (reachable) or — for curation — we read the HTTP status.
const SERVICE_PROBES = [
    { key: 'curation_api', label: 'Curation API', probe: _probe_curation },
    { key: 'archivematica', label: 'Archivematica', probe: _probe_archivematica },
    { key: 'duracloud', label: 'DuraCloud', probe: _probe_duracloud },
    { key: 'archivesspace', label: 'ArchivesSpace', probe: _probe_archivesspace },
];

// HTMX-polled combined health panel. Probes all four upstream services
// IN PARALLEL — each probe carries its own client-configured timeout,
// so the panel's wall-clock is the slowest single probe, not the sum.
// Every probe is wrapped so one failure can't reject the batch; the
// worst case for any card is reachable=false with the error in detail.
// Polled every 30s from services_page (same gentle cadence as Wasabi —
// upstream state changes on the scale of outages + config edits).
async function services_health_partial(req, res) {
    const services = await Promise.all(
        SERVICE_PROBES.map(({ key, label, probe }) => _run_probe(key, label, probe))
    );
    render_partial(req, res, 'dashboard/partials/services_health', {
        services,
        checked_at: new Date().toISOString(),
    });
}

// Wrap a per-service probe with timing + uniform shape + a hard
// guarantee it never throws. Returns:
//   { key, label, configured, reachable, detail, elapsed_ms }
// `configured:false` renders as a neutral "not configured" badge (dev
// environments that don't wire a given service shouldn't show red).
async function _run_probe(key, label, probe) {
    const started = Date.now();
    try {
        const out = await probe();
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
        // Defensive: the individual _probe_* helpers are written not to
        // throw, but a surprise (e.g. a config read blowing up) must
        // still render a red card rather than 500 the whole panel.
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

// Curation API — GET /health (no auth). qa_service.health() throws on a
// transport failure, which _run_probe catches into reachable=false.
async function _probe_curation() {
    if (!qa_service.is_configured()) return { configured: false };
    const r = await qa_service.health();
    const ok = r.status === 200;
    return { configured: true, reachable: ok, detail: `GET /health → ${r.status}` };
}

// Archivematica — transfer (main) API liveness. health_api() returns
// { ok, status, error } so the card can name the actual failure (a
// 401/403 auth problem, a 404 base-URL problem, or a TLS/transport
// error) instead of a generic "no HTTP 200".
async function _probe_archivematica() {
    if (!archivematica.is_configured()) return { configured: false };
    const r = await archivematica.health_api();
    let detail;
    if (r.ok) {
        detail = 'transfer API reachable (HTTP 200)';
    } else if (r.error) {
        // Transport-level failure — surface it verbatim. A TLS message
        // here ("self-signed certificate", "unable to verify the first
        // certificate") means the AM cert isn't trusted; set
        // NODE_EXTRA_CA_CERTS to the AM host's CA (v2 doesn't disable
        // TLS verification the way v1 did).
        detail = `transport error: ${r.error}`;
    } else {
        // Got an HTTP response, just not 200. 401/403 → check
        // ARCHIVEMATICA_USERNAME / ARCHIVEMATICA_API_KEY; 404 → check
        // the ARCHIVEMATICA_API base URL.
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

// HTMX-polled Wasabi status panel. Single curation-API hit — the
// `head_bucket` probe — wrapped in graceful failure handling so a
// curation-side outage renders as a clear red card rather than a
// 500 page. Polled every 30s from the services_page (Wasabi state
// changes on the scale of config edits + outages, not seconds, so
// the cadence is gentler than the 5s indexer poll).
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
        // Cosmetics: render a relative timestamp client-side from
        // this server-side stamp. EJS templates don't have a great
        // date helper so we just stringify.
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

// List the packages currently in a folder via the curation-service.
// Used by the job-recorder so the history row captures the actual
// packages the action ran against (rather than guessing).
async function _packages_for_history(folder) {
    const data = await workspace.list_workspace({
        // Either scope works — we only need this folder's package list.
        // 'unprocessed' is the slightly more general endpoint.
        scope: 'unprocessed',
    });
    const match = (data.folders || []).find((f) => f.name === folder);
    if (match && Array.isArray(match.packages)) return match.packages;
    // Fall back to /processed (the folder may have moved between
    // calls). If both miss, return [] — the history row will simply
    // show no packages, which is honest.
    const data_p = await workspace.list_workspace({ scope: 'processed' });
    const match_p = (data_p.folders || []).find((f) => f.name === folder);
    return match_p && Array.isArray(match_p.packages) ? match_p.packages : [];
}

// Record-job wrapper — never throws. A history-write failure must not
// block the user-facing action result; we log and continue.
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
    rollback_pre_ingest_action,
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
};
