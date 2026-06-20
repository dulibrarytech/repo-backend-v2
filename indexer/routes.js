'use strict';

const app_config = require('../config/app');
const { require_dashboard_auth } = require('../dashboard/middleware');
const { require_permission, PERMISSIONS } = require('../auth/rbac');
const { write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/dashboard/admin/indexer`;

    // The indexer is an admin tool end-to-end (incl. drop & rebuild), so the
    // whole surface — page, status, and every action — requires manage_index.
    const can_manage = require_permission(PERMISSIONS.MANAGE_INDEX);

    // Admin landing page + polled status partial.
    app.get(`${base}`, require_dashboard_auth, can_manage, controller.indexer_page);
    app.get(`${base}/status`, require_dashboard_auth, can_manage, controller.status_partial);

    // Reindex actions. Each dirties rows; the worker picks up the
    // work on its next poll. Rate-limited because "reindex all" is
    // cheap to invoke but expensive in worker minutes.
    app.post(
        `${base}/reindex-all`,
        require_dashboard_auth,
        can_manage,
        write_limiter(),
        controller.reindex_all
    );
    app.post(
        `${base}/reindex-collection/:pid`,
        require_dashboard_auth,
        can_manage,
        write_limiter(),
        controller.reindex_collection
    );
    app.post(
        `${base}/reindex/:pid`,
        require_dashboard_auth,
        can_manage,
        write_limiter(),
        controller.reindex_pid
    );

    // Retry dead-lettered rows: clears index_error + attempt counter and
    // re-dirties every parked row. Same auth + rate limit as the other
    // reindex actions. Surfaced only when dead-lettered > 0 in the status
    // partial, after the operator has fixed the underlying cause.
    app.post(
        `${base}/reindex-failed`,
        require_dashboard_auth,
        can_manage,
        write_limiter(),
        controller.retry_dead_lettered
    );

    // Destructive: drops the ES index and recreates it from current
    // mappings, then dirties every eligible row. Same auth + rate
    // limit as reindex-all — staff confirms via the data-confirm
    // modal in the view before the request even leaves the browser.
    app.post(
        `${base}/rebuild-index`,
        require_dashboard_auth,
        can_manage,
        write_limiter(),
        controller.rebuild_index
    );
};
