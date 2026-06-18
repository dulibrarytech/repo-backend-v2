'use strict';

// Admin-facing controllers for TIFF→JPG conversion. Flows:
//
//   GET  /dashboard/admin/convert                full admin page
//   GET  /dashboard/admin/convert/status         status partial (HTMX-polled)
//   POST /dashboard/admin/convert/preview        dry-run (resolve, show, no enqueue)
//   POST /dashboard/admin/convert/start          enqueue a collection/sip_uuid batch
//   POST /dashboard/objects/:pid/convert          single-object action (Objects kebab)
//
// Start enqueues the work and returns immediately — the convert worker
// drains the queue in the background, one object every
// CONVERT_SERVICE_DELAY_MS. We surface the queued count as a toast and
// return the freshly-rendered status panel so the page updates without
// an extra round-trip (same pattern as the indexer admin controller).
//
// Validation errors (bad token, sip_uuid that fans out, empty scope)
// throw ValidationError; the central error handler returns 400 and
// dashboard.js surfaces it as an error toast via htmx:responseError.

const app_config = require('../config/app');
const validator = require('validator');

const model = require('./model');
const { ValidationError } = require('../libs/errors');

// --- render helpers (mirror indexer/controller.js) ------------------- //

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
        title: locals.title || 'Repository @ DU',
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

// --- input helpers --------------------------------------------------- //

// Accept only UUID-ish tokens (letters, digits, hyphens) — matches the
// legacy script's _safe_token guard and keeps junk out of the query.
function clean_token(v, label) {
    if (v === undefined || v === null) return '';
    const s = String(v).trim();
    if (s === '') return '';
    if (!/^[A-Za-z0-9-]+$/.test(s)) {
        throw new ValidationError(
            `Invalid ${label}: only letters, digits, and hyphens are allowed.`
        );
    }
    return s;
}

function parse_limit(v) {
    if (v === undefined || v === null || String(v).trim() === '') return undefined;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) {
        throw new ValidationError('Limit must be a positive whole number.');
    }
    return n;
}

function actor_of(req) {
    const u = req.user || {};
    return String(u.du_id || u.sub || u.email || '');
}

function actor_name_of(req) {
    const u = req.user || {};
    return String(u.name || u.full_name || u.email || '');
}

// Read + normalize the scope from a form body. sip_uuid takes precedence
// over collection (matching post_tiff_convert.py's --sip-uuid override).
function scope_from_body(body) {
    const sip_uuid = clean_token(body.sip_uuid, 'sip_uuid');
    let collection = clean_token(body.collection, 'collection');
    if (sip_uuid) collection = '';
    const limit = parse_limit(body.limit);
    return { sip_uuid, collection, limit };
}

// --- handlers -------------------------------------------------------- //

async function convert_page(req, res) {
    render_page(req, res, 'dashboard/admin/convert', {
        page: 'convert',
        active: 'admin',
        title: 'TIFF to JPG Conversion — Repository @ DU',
    });
}

async function status_partial(req, res) {
    const summary = await model.status_summary();
    render_partial(req, res, 'dashboard/partials/convert_status', { s: summary });
}

async function convert_preview(req, res) {
    const { sip_uuid, collection, limit } = scope_from_body(req.body || {});
    if (!sip_uuid && !collection) {
        throw new ValidationError('Enter a collection UUID or a SIP UUID to preview.');
    }
    const preview = await model.preview({
        collection: collection || undefined,
        sip_uuid: sip_uuid || undefined,
        limit,
    });
    render_partial(req, res, 'dashboard/partials/convert_preview', {
        preview,
        scope: sip_uuid ? `sip_uuid ${sip_uuid}` : `collection ${collection}`,
    });
}

async function convert_start(req, res) {
    const { sip_uuid, collection, limit } = scope_from_body(req.body || {});
    if (!sip_uuid && !collection) {
        throw new ValidationError('Enter a collection UUID or a SIP UUID to convert.');
    }
    const result = await model.enqueue({
        collection: collection || undefined,
        sip_uuid: sip_uuid || undefined,
        limit,
        actor: actor_of(req),
        actor_name: actor_name_of(req),
    });
    const secs = Math.round(app_config().convert_service.delay_ms / 1000);
    trigger_toast(
        res,
        'success',
        `Queued ${result.count} object${result.count === 1 ? '' : 's'} for conversion. ` +
            `The worker posts one every ${secs}s.`
    );
    return status_partial(req, res);
}

// Single-object action from the Objects-table kebab menu. Button uses
// hx-swap="none", so we reply with an empty body + a toast.
async function convert_object(req, res) {
    const pid = String(req.params.pid || '');
    if (!validator.isUUID(pid)) {
        throw new ValidationError('pid must be a UUID');
    }
    await model.enqueue({
        pid,
        actor: actor_of(req),
        actor_name: actor_name_of(req),
    });
    // ASCII-only header value — no Unicode ellipsis (same gotcha the
    // indexer publish toast hit).
    trigger_toast(res, 'success', `Queued JPG conversion for ${pid.slice(0, 8)}... (1 object).`);
    res.set('Content-Type', 'text/html').send('');
}

module.exports = {
    convert_page,
    status_partial,
    convert_preview,
    convert_start,
    convert_object,
};
