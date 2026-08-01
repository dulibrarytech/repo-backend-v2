'use strict';

/*
 * Admin: Handles — mint a small number of handles by hand, and remove ones
 * minted by mistake.
 *
 * Routes mounted at /dashboard/admin/handles/* (see dashboard/routes.js):
 *
 *   GET  /dashboard/admin/handles              full page
 *   GET  /dashboard/admin/handles/list         list partial (re-fetched after writes)
 *   POST /dashboard/admin/handles/mint         mint 1-5
 *   POST /dashboard/admin/handles/:id/delete   delete one
 *
 * Shape mirrors dashboard/aip_backfill_controller.js so operators only have
 * to learn one admin pattern. Handlers are thin shells over handles/model;
 * ValidationError and ConflictError bubble to the central handler.
 *
 * Unlike the ingest-minted handles, these are not necessarily attached to
 * repository records. See repo/REPOV2_HANDLES_ADMIN_PLAN.md.
 */

const app_config = require('../config/app');
const handles_model = require('../handles/model');
const handles_client = require('../libs/handles');
const { ValidationError, ConflictError, NotFoundError } = require('../libs/errors');

function render_page(req, res, view, locals = {}) {
    const cfg = app_config();
    const base_locals = {
        title: locals.title || 'Handles - Repo Dashboard',
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

function actor_of(req) {
    return (req.user && req.user.du_id) || (req.user && req.user.sub) || '';
}

/*
 * The mint form posts a fixed five rows so "up to 5" needs no add-row
 * scripting. Blank rows are dropped here; a row counts as filled if it has
 * a target URL, so a stray note without a URL is a validation error rather
 * than a silently ignored row.
 */
function entries_from_body(body) {
    const targets = [].concat(body.target_url || []);
    const notes = [].concat(body.note || []);
    const entries = [];
    for (let i = 0; i < targets.length; i++) {
        const target = String(targets[i] || '').trim();
        const note = String(notes[i] || '').trim();
        if (!target && !note) continue;
        entries.push({ target_url: target, note });
    }
    return entries;
}

async function build_list(query = {}) {
    const status = typeof query.status === 'string' && query.status ? query.status : null;
    const rows = await handles_model.list({ status });
    return {
        rows,
        status_filter: status || '',
        statuses: Object.values(handles_model.STATUS),
    };
}

async function handles_page(req, res) {
    const data = await build_list(req.query);
    render_page(req, res, 'dashboard/admin/handles', {
        page: 'handles',
        active: 'admin',
        title: 'Handles - Repo Dashboard',
        max_per_submission: handles_model.MAX_PER_SUBMISSION,
        allowed_hosts: handles_model.allowed_hosts(),
        configured: handles_client.is_configured(),
        ...data,
    });
}

async function handles_list_partial(req, res) {
    const data = await build_list(req.query);
    render_partial(req, res, 'dashboard/partials/handles_list', data);
}

/*
 * Expected, operator-correctable failures (a target host outside the
 * allowlist, a handle that is in use) are turned into a toast and a 200
 * carrying the refreshed list — NOT rethrown.
 *
 * Letting them bubble produces a 400 with a JSON envelope, and htmx does not
 * swap on a 4xx: the dashboard's only htmx:responseError handler covers 401
 * for session expiry. The result is a click that appears to do nothing at
 * all, which is what happened the first time a target outside du.edu was
 * submitted. Matches aip_backfill_controller's handling.
 */
function is_expected(err) {
    return err instanceof ValidationError
        || err instanceof ConflictError
        || err instanceof NotFoundError;
}

async function handles_mint(req, res) {
    try {
        const entries = entries_from_body(req.body);
        const results = await handles_model.mint(entries, { actor: actor_of(req) });

        const minted = results.filter((r) => r.ok).length;
        const failed = results.length - minted;
        if (failed === 0) {
            trigger_toast(res, 'success',
                `Minted ${minted} handle${minted === 1 ? '' : 's'}.`);
            /*
             * Clear the form only when everything succeeded. Leaving the
             * values would let a second click mint a duplicate handle for
             * the same page; clearing them after a PARTIAL failure would
             * throw away URLs the operator still has to correct. Consumed by
             * the handle_mint_rows module in public/assets/dashboard.js.
             */
            trigger_events(res, { 'handles-reset': true });
        } else if (minted === 0) {
            trigger_toast(res, 'error',
                `Could not mint ${failed} handle${failed === 1 ? '' : 's'} - see the list for details.`);
        } else {
            trigger_toast(res, 'warning',
                `Minted ${minted}, ${failed} failed - see the list for details.`);
        }
    } catch (err) {
        if (!is_expected(err)) throw err;
        trigger_toast(res, 'error', err.message);
    }
    return handles_list_partial(req, res);
}

async function handles_delete(req, res) {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const removed = await handles_model.remove(id, { actor: actor_of(req) });
        trigger_toast(res, 'success', `Deleted ${removed.handle}.`);
    } catch (err) {
        if (!is_expected(err)) throw err;
        trigger_toast(res, 'error', err.message);
    }
    return handles_list_partial(req, res);
}

module.exports = {
    handles_page,
    handles_list_partial,
    handles_mint,
    handles_delete,
    entries_from_body,
};
