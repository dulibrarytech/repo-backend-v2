'use strict';

/*
 * Admin-facing controllers for the system-wide metadata refresh.
 * 
 * Surface:
 * 
 *   GET  /dashboard/admin/metadata-refresh           — full admin page
 *   GET  /dashboard/admin/metadata-refresh/status    — status partial (HTMX-polled)
 *   POST /dashboard/admin/metadata-refresh/start     — start a new batch
 *   POST /dashboard/admin/metadata-refresh/:uuid/cancel — request cancel
 * 
 * The flow mirrors the existing indexer admin page:
 *   - One status panel polls every 5s and shows active-batch progress
 *     + a short history of past batches.
 *   - "Start refresh" enqueues a new batch row; the producer timer
 *     picks it up within METADATA_REFRESH_PRODUCER_POLL_MS.
 *   - "Cancel" flips the cancel flag and hard-deletes pending rows.
 * 
 * Pre-flight cutover guard: when the operator starts a batch, we
 * snapshot the current ASPACE_USE_TRANSFORMER flag. The admin page
 * shows the flag in effect at start, and the start handler refuses
 * to start if a previous batch's flag differs without an explicit
 * `?force=1`. Prevents a silent "I flipped the flag, then the cron
 * ran and re-stamped everything with the new transformer" sequence.
 */

const app_config = require('../config/app');

const batches = require('./batches');
const { db_queue } = require('../config/db');
const tables = require('../config/db_tables');
const { ValidationError } = require('../libs/errors');

const QUEUE = tables.metadata_update_queue;

function render_partial(req, res, view, locals = {}) {
    const cfg = app_config();
    res.render(view, {
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        ...locals,
    });
}

function render_page(req, res, view, locals = {}) {
    const cfg = app_config();
    const base_locals = {
        title: locals.title || 'Metadata Refresh — Digital Archives @ DU',
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        app_version: cfg.version,
        asset_v: cfg.asset_v,
        page: locals.page || view,
        active: locals.active || '',
        user: locals.user || res.locals.user || null,
        ...locals,
    };
    res.render(view, base_locals, (err, body) => {
        if (err) return res.status(500).send(err.message);
        res.render('dashboard/layout', { ...base_locals, body });
    });
}

function trigger_toast(res, level, message) {
    res.set('HX-Trigger', JSON.stringify({ toast: { level, message } }));
}

async function metadata_refresh_page(req, res) {
    render_page(req, res, 'dashboard/admin/metadata_refresh', {
        page: 'metadata_refresh',
        active: 'admin',
        title: 'Metadata Refresh — Digital Archives @ DU',
    });
}

/*
 * Compute rate / ETA / elapsed from the batch row's counters. Pure
 * function over a few numbers — exported as a test helper.
 * 
 * rate_per_min: terminal rows per minute since started_at. Stable
 *   enough for a status panel (we're sampling >= ~12 rows/min once
 *   the worker hits steady state).
 * eta_seconds: time until total - sum more rows finish, given the
 *   current rate. Null while rate is 0 (avoid Infinity) or once the
 *   batch is enqueue_complete + drained.
 * elapsed_seconds: now - started_at, capped at 0 (clock skew).
 * 
 * Returns floats — the partial decides display precision.
 */
function _compute_progress(active, now = Date.now()) {
    if (!active || !active.started_at) {
        return { elapsed_seconds: 0, rate_per_min: 0, eta_seconds: null, percent: 0 };
    }
    const started = new Date(active.started_at).getTime();
    const elapsed_ms = Math.max(0, now - started);
    const sum = Number(active.succeeded) + Number(active.failed) + Number(active.dead_lettered);
    const elapsed_minutes = elapsed_ms / 60000;
    const rate_per_min = elapsed_minutes > 0 ? sum / elapsed_minutes : 0;
    let eta_seconds = null;
    if (active.enqueue_complete && rate_per_min > 0) {
        const remaining = Math.max(0, Number(active.total) - sum);
        eta_seconds = remaining === 0 ? 0 : (remaining / rate_per_min) * 60;
    }
    /*
     * Percent is meaningful only after enqueue_complete (until then
     * `total` is a partial count). The partial uses this directly so
     * the bar doesn't snap-back when more rows arrive.
     */
    const percent =
        active.enqueue_complete && active.total > 0
            ? Math.min(100, Math.round((sum / active.total) * 100))
            : 0;
    return {
        elapsed_seconds: Math.floor(elapsed_ms / 1000),
        rate_per_min,
        eta_seconds,
        percent,
    };
}

/*
 * Build the state object the status partial renders. Resolved on the
 * server (rather than in the EJS) so the partial stays declarative
 * and we can unit-test the resolution if we add tests later.
 */
async function build_status() {
    const cfg = app_config();
    const active = await batches.get_active_batch();
    const history = await batches.list_batches({ limit: 10 });
    const pending_in_queue = await db_queue()(QUEUE)
        .where({ status: 'PENDING', is_complete: 0 })
        .count({ c: '*' })
        .first();

    /*
     * Worker health hint — without these the queue will never drain.
     * The admin page surfaces a warning so an operator doesn't sit
     * watching a "running" batch that's actually stuck because the
     * worker is disabled or ASpace creds are missing.
     */
    const worker_cfg = cfg.metadata_worker;
    const aspace_cfg = cfg.archivespace;
    const worker_health = {
        enabled: worker_cfg.enabled,
        aspace_configured: Boolean(
            aspace_cfg && aspace_cfg.host && aspace_cfg.user && aspace_cfg.password
        ),
        concurrency: worker_cfg.concurrency,
        poll_ms: worker_cfg.poll_ms,
        max_attempts: worker_cfg.max_attempts,
    };

    /*
     * Activity snapshot — what's in flight + what just completed.
     * Only fetched when there's an active batch; the history list
     * already gives a long-view summary for past batches.
     */
    let activity = { in_flight: [], recently_completed: [] };
    let progress = { elapsed_seconds: 0, rate_per_min: 0, eta_seconds: null, percent: 0 };
    if (active) {
        activity = await batches.get_activity_snapshot(active.batch_uuid);
        progress = _compute_progress(active);
    }

    return {
        active,
        history,
        activity,
        progress,
        worker_health,
        /*
         * Current flag/version, shown alongside the active batch's
         * snapshot so an operator can see at a glance whether the
         * production flag matches what's stamped on the in-flight
         * batch.
         */
        current_flag: cfg.archivespace.use_transformer ? '1' : '0',
        current_version: cfg.archivespace.transformer_version || '',
        pending_in_queue: pending_in_queue ? Number(pending_in_queue.c) : 0,
    };
}

async function status_partial(req, res) {
    const status = await build_status();
    render_partial(req, res, 'dashboard/partials/metadata_refresh_status', status);
}

/*
 * Refuse to start a new batch when the transformer flag has flipped
 * since the last batch ran, unless `force=1` is in the request. The
 * guard exists so a silent "operator flipped flag without realizing,
 * then started a refresh" can't silently restamp every row.
 */
async function _check_transformer_continuity(req) {
    const cfg = app_config().archivespace;
    const current_flag = cfg.use_transformer ? '1' : '0';
    const last = await db_queue()(tables.metadata_refresh_batches).orderBy('id', 'desc').first();
    if (!last) return; // no prior batches — nothing to compare
    if (last.transformer_flag === current_flag) return;
    if (req.body && req.body.force === '1') return;
    throw new ValidationError(
        `Transformer flag has changed since the last batch ` +
            `(was=${last.transformer_flag || 'unset'}, now=${current_flag}). ` +
            `This refresh will re-stamp every record with the new transformer ` +
            `output. Confirm by setting force=1 in the request body.`
    );
}

async function start_refresh(req, res) {
    /*
     * Catch ValidationError locally so the HTMX request gets back a
     * status partial + toast rather than the central handler's JSON
     * error envelope. Anything non-ValidationError keeps bubbling.
     */
    try {
        await _check_transformer_continuity(req);
        const actor = (req.user && req.user.du_id) || '';

        /*
         * Resume opt-in. The start form has a "Resume from last
         * cancelled batch" checkbox; when checked it POSTs
         * `resume=1`. We look up the cursor BEFORE create_batch so
         * the toast can honestly say what happened — and so we can
         * distinguish "resumed cleanly" from "resume requested but
         * no cancelled batch existed to resume from."
         */
        const wants_resume = req.body && req.body.resume === '1';
        let resume_info = null;
        if (wants_resume) {
            resume_info = await batches.get_last_cancelled_cursor();
        }

        const batch_uuid = await batches.create_batch({
            actor,
            inherit_cursor_id: resume_info ? resume_info.cursor_id : null,
        });

        /*
         * ASCII-only message: HTTP header values can't carry the
         * Unicode ellipsis (and `res.set('HX-Trigger', …)` round-
         * trips through a header). Same gotcha that bit the indexer
         * controller's toast strings.
         */
        let msg;
        if (wants_resume && resume_info) {
            msg =
                `Started system metadata refresh (batch ${batch_uuid.slice(0, 8)}...), ` +
                `resuming from cancelled batch ${resume_info.batch_uuid.slice(0, 8)}... ` +
                `at cursor ${resume_info.cursor_id}. Producer will enqueue rows on its next tick.`;
        } else if (wants_resume) {
            /*
             * Operator asked to resume but there's nothing to resume
             * from — fall through to a fresh-start run and tell them.
             */
            msg =
                `Started system metadata refresh (batch ${batch_uuid.slice(0, 8)}...). ` +
                `Resume requested but no prior cancelled batch was found, so this is a full rerun. ` +
                `Producer will enqueue rows on its next tick.`;
        } else {
            msg =
                `Started system metadata refresh (batch ${batch_uuid.slice(0, 8)}...). ` +
                `Producer will enqueue rows on its next tick.`;
        }
        trigger_toast(
            res,
            wants_resume && !resume_info ? 'warn' : 'success',
            msg
        );
    } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        trigger_toast(res, 'error', err.message);
    }
    return status_partial(req, res);
}

async function cancel_refresh(req, res) {
    try {
        const batch_uuid = req.params.uuid;
        const result = await batches.request_cancel(batch_uuid);
        trigger_toast(
            res,
            'success',
            `Cancelled batch ${batch_uuid.slice(0, 8)}... - ` +
                `removed ${result.pending_removed} pending row${
                    result.pending_removed === 1 ? '' : 's'
                } from the queue.`
        );
    } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        trigger_toast(res, 'error', err.message);
    }
    return status_partial(req, res);
}

/*
 * Best-effort, never throws. The admin page uses this to seed a
 * "preview" of how many rows the next batch would enqueue so the
 * operator can size expectations.
 */
async function preview_total(req, res) {
    const { db } = require('../config/db');
    const row = await db()(tables.objects)
        .where({ is_active: 1 })
        .whereNotNull('uri')
        .whereNot('uri', '')
        .count({ c: '*' })
        .first();
    res.json({ total: row ? Number(row.c) : 0 });
}

module.exports = {
    metadata_refresh_page,
    status_partial,
    start_refresh,
    cancel_refresh,
    preview_total,
    // Test helpers.
    _build_status: build_status,
    _check_transformer_continuity,
    _compute_progress,
};
