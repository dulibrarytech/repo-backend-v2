'use strict';

// Admin: AIP backfill — catch-up the ~tens of thousands of AIPs that
// ingested under v2 BEFORE Stage 6 existed (or with the feature flag
// off). Each "Start backfill" click enqueues up to
// cfg.aip_store.backfill_chunk_size synthetic queue rows that the
// existing ingest worker drains via Stage 6.
//
// Routes mounted at /dashboard/admin/aip-backfill/* (see
// dashboard/routes.js):
//
//   GET  /dashboard/admin/aip-backfill            full page
//   GET  /dashboard/admin/aip-backfill/status     status partial (polled)
//   POST /dashboard/admin/aip-backfill/start      enqueue next chunk
//   POST /dashboard/admin/aip-backfill/cancel     cancel pending rows in
//                                                  the latest batch
//
// Shape mirrors metadata/admin_controller.js so operators only have
// to learn one admin pattern. Each handler is a thin shell over the
// ingester/aip_backfill model; ValidationError bubbles to the central
// handler for the JSON envelope, all other errors land as a 500
// (with the request id) via the standard error path.

const app_config = require('../config/app');
const aip_backfill = require('../ingester/aip_backfill');
const { ValidationError } = require('../libs/errors');

function render_page(req, res, view, locals = {}) {
    const cfg = app_config();
    const base_locals = {
        title: locals.title || 'AIP Backfill — Repo Dashboard',
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

function render_partial(req, res, view, locals = {}) {
    const cfg = app_config();
    res.render(view, {
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        ...locals,
    });
}

function trigger_events(res, events) {
    const existing = res.get('HX-Trigger');
    let payload = {};
    if (existing) {
        try {
            payload = JSON.parse(existing);
        } catch {
            payload = {};
        }
    }
    res.set('HX-Trigger', JSON.stringify({ ...payload, ...events }));
}

function trigger_toast(res, level, message) {
    trigger_events(res, { toast: { level, message } });
}

// Build the status object the partial renders. Combines the model's
// per-state counts with the total "missing AIPs" headline so the
// operator can see, in one glance: how many are left to do AND how
// the in-flight batch is progressing.
async function build_status() {
    const cfg = app_config();
    const aip_cfg = cfg.aip_store || {};
    const [missing, status] = await Promise.all([
        aip_backfill.count_missing_aips(),
        aip_backfill.get_status(),
    ]);
    return {
        missing,
        status,
        // Surface the chunk size + feature-flag state so the page
        // doesn't have to import config itself.
        chunk_size: aip_cfg.backfill_chunk_size || 1000,
        aip_store_enabled: Boolean(aip_cfg.enabled),
    };
}

async function backfill_page(req, res) {
    const data = await build_status();
    render_page(req, res, 'dashboard/admin/aip_backfill', {
        page: 'aip_backfill',
        active: 'admin',
        title: 'AIP Backfill — Repo Dashboard',
        ...data,
    });
}

async function backfill_status_partial(req, res) {
    const data = await build_status();
    render_partial(req, res, 'dashboard/partials/aip_backfill_status', data);
}

// Start a chunk. Refuses if Stage 6 itself is disabled — without
// AIP_STORE_ENABLED=true the worker would just drain the synthetic
// rows as no-ops without contacting Wasabi. Better to fail loudly
// at start than have the operator wonder why nothing happened.
async function backfill_start(req, res) {
    const cfg = app_config().aip_store;
    try {
        if (!cfg || !cfg.enabled) {
            // ASCII-only message: HTTP header values can't carry
            // a Unicode em-dash, and trigger_toast round-trips
            // through HX-Trigger. Same gotcha documented in
            // metadata/admin_controller.js's start_refresh handler.
            throw new ValidationError(
                'AIP_STORE_ENABLED is off - set it to true and restart the ' +
                    'worker before starting a backfill (otherwise the queue ' +
                    'rows will drain as no-ops).'
            );
        }
        const actor = (req.user && req.user.du_id) || (req.user && req.user.sub) || '';
        const result = await aip_backfill.enqueue_backfill_batch({ actor });
        if (result.count === 0) {
            trigger_toast(
                res,
                'info',
                'No eligible AIPs found - every active object with an AM ' +
                    'sip_uuid is already in tbl_aip_store.'
            );
        } else {
            trigger_toast(
                res,
                'success',
                `AIP backfill queued - ${result.count} row${
                    result.count === 1 ? '' : 's'
                } added. The worker will drain them on the next tick.`
            );
        }
    } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        trigger_toast(res, 'error', err.message);
    }
    return backfill_status_partial(req, res);
}

// Cancel the pending rows in the most recent batch. We don't ask the
// caller for a batch_marker - the page only has one "Cancel" button
// and the most-recent batch is the only one that could realistically
// have rows still PENDING (worker drains FIFO).
async function backfill_cancel(req, res) {
    try {
        const status = await aip_backfill.get_status();
        if (!status.latest_batch_marker) {
            throw new ValidationError('No backfill batch found to cancel.');
        }
        const result = await aip_backfill.cancel_backfill(status.latest_batch_marker);
        trigger_toast(
            res,
            'success',
            `Cancelled ${result.cancelled} pending backfill row${
                result.cancelled === 1 ? '' : 's'
            }. In-flight rows will finish their current Wasabi upload.`
        );
    } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        trigger_toast(res, 'error', err.message);
    }
    return backfill_status_partial(req, res);
}

module.exports = {
    backfill_page,
    backfill_status_partial,
    backfill_start,
    backfill_cancel,
    // Test helpers
    _build_status: build_status,
};
