'use strict';

const app_config = require('../config/app');
const { require_dashboard_auth } = require('../dashboard/middleware');
const { write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/dashboard/admin/indexer`;

    // Admin landing page + polled status partial.
    app.get(`${base}`, require_dashboard_auth, controller.indexer_page);
    app.get(`${base}/status`, require_dashboard_auth, controller.status_partial);

    // Reindex actions. Each dirties rows; the worker picks up the
    // work on its next poll. Rate-limited because "reindex all" is
    // cheap to invoke but expensive in worker minutes.
    app.post(
        `${base}/reindex-all`,
        require_dashboard_auth,
        write_limiter(),
        controller.reindex_all
    );
    app.post(
        `${base}/reindex-collection/:pid`,
        require_dashboard_auth,
        write_limiter(),
        controller.reindex_collection
    );
    app.post(
        `${base}/reindex/:pid`,
        require_dashboard_auth,
        write_limiter(),
        controller.reindex_pid
    );

    // Destructive: drops the ES index and recreates it from current
    // mappings, then dirties every eligible row. Same auth + rate
    // limit as reindex-all — staff confirms via the data-confirm
    // modal in the view before the request even leaves the browser.
    app.post(
        `${base}/rebuild-index`,
        require_dashboard_auth,
        write_limiter(),
        controller.rebuild_index
    );
};
