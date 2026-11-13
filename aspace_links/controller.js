'use strict';

const app_config = require('../config/app');
const log = require('../libs/log');
const model = require('./model');
const { ATTENTION_STATES } = require('./sync');

const LIST_LIMIT = 200;

const STATE_LABELS = Object.freeze({
    failed: 'Update failed',
    contested: 'More than one object shares this record',
    needs_review: 'Needs review',
    record_not_found: 'Not found in ArchivesSpace',
    invalid_handle: 'Object has no usable handle',
    pending: 'Needs an update',
    unpublished_link: 'Link is not published',
    orphan_link: 'Links to a deleted object',
    updated: 'Updated',
    in_sync: 'Up to date',
});

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
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        app_version: cfg.version,
        asset_v: cfg.asset_v,
        user: res.locals.user || null,
        ...locals,
    };
    res.render(view, base_locals, (err, body) => {
        if (err) return res.status(500).send(err.message);
        res.render('dashboard/layout', { ...base_locals, body });
    });
}

function trigger(res, level, message, events = {}) {
    res.set('HX-Trigger', JSON.stringify({ toast: { level, message }, ...events }));
}

function actor_of(req) {
    return String((req.user && (req.user.du_id || req.user.sub)) || '');
}

function notes_of(row) {
    const detail = row.detail || {};
    const notes = [];
    if (detail.link === 'add') notes.push('Found no repository link on the record.');
    if (detail.link === 'update') notes.push(`Found the link pointing at ${detail.link_previous}`);
    if (detail.digital_object === 'update') {
        notes.push(`Found the digital object identifier ${detail.digital_object_previous}`);
    }
    if (detail.note) notes.push(detail.note);
    if (row.error) notes.push(row.error);
    return notes;
}

async function build_status() {
    const cfg = app_config();
    return {
        summary: await model.summary(),
        labels: STATE_LABELS,
        worker_enabled: cfg.aspace_links.enabled,
        writes_enabled: cfg.archivespace.writes_enabled,
    };
}

async function build_list(query = {}) {
    const requested = typeof query.state === 'string' ? query.state : '';
    const state = Object.hasOwn(STATE_LABELS, requested) ? requested : '';
    const found = await model.list({
        states: state ? [state] : ATTENTION_STATES,
        limit: LIST_LIMIT,
    });
    return {
        rows: found.rows.map((row) => ({ ...row, notes: notes_of(row) })),
        total: found.total,
        state_filter: state,
        labels: STATE_LABELS,
    };
}

async function links_page(req, res) {
    render_page(req, res, 'dashboard/admin/aspace_links', {
        page: 'aspace_links',
        active: 'admin',
        title: 'ArchivesSpace Links — Digital Archives Manager @ DU',
        ...(await build_status()),
        ...(await build_list(req.query)),
    });
}

async function status_partial(req, res) {
    render_partial(req, res, 'dashboard/partials/aspace_links_status', await build_status());
}

async function list_partial(req, res) {
    render_partial(req, res, 'dashboard/partials/aspace_links_list', await build_list(req.query));
}

async function check_all(req, res) {
    const count = await model.enqueue_all();
    log.info({ event: 'aspace_links_check_all', actor: actor_of(req), count });
    trigger(res, 'success', `Queued ${count} record${count === 1 ? '' : 's'} to check.`, {
        'aspace-links-changed': true,
    });
    return status_partial(req, res);
}

async function recheck(req, res) {
    const state = String((req.body && req.body.state) || '');
    if (!Object.hasOwn(STATE_LABELS, state)) {
        trigger(res, 'error', 'Choose a result to check again.');
    } else {
        const count = await model.requeue_state(state);
        log.info({ event: 'aspace_links_recheck', actor: actor_of(req), state, count });
        trigger(res, 'success', `Queued ${count} record${count === 1 ? '' : 's'} to check again.`, {
            'aspace-links-status': true,
        });
    }
    render_partial(req, res, 'dashboard/partials/aspace_links_list', await build_list({ state }));
}

module.exports = {
    STATE_LABELS,
    links_page,
    status_partial,
    list_partial,
    check_all,
    recheck,
};
