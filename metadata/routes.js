'use strict';

const app_config = require('../config/app');
const { require_dashboard_auth } = require('../dashboard/middleware');
const { write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');
const admin_controller = require('./admin_controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/dashboard`;
    const admin_base = `${base}/admin/metadata-refresh`;

    // ---- System-wide refresh admin surface ----
    app.get(admin_base, require_dashboard_auth, admin_controller.metadata_refresh_page);
    app.get(`${admin_base}/status`, require_dashboard_auth, admin_controller.status_partial);
    app.get(`${admin_base}/preview`, require_dashboard_auth, admin_controller.preview_total);
    app.post(
        `${admin_base}/start`,
        require_dashboard_auth,
        write_limiter(),
        admin_controller.start_refresh
    );
    app.post(
        `${admin_base}/:uuid/cancel`,
        require_dashboard_auth,
        write_limiter(),
        admin_controller.cancel_refresh
    );

    // Bulk-multi-select refresh — registered BEFORE the per-pid form
    // so Express can't mis-match `/objects/metadata/refresh-bulk`
    // against `/objects/:pid/metadata/refresh` with pid="metadata".
    app.post(
        `${base}/objects/metadata/refresh-bulk`,
        require_dashboard_auth,
        write_limiter(),
        controller.refresh_bulk
    );

    // Per-object: enqueue one row, return progress modal.
    app.post(
        `${base}/objects/:pid/metadata/refresh`,
        require_dashboard_auth,
        write_limiter(),
        controller.refresh_object
    );

    // Collection-scoped: enqueue ONLY the collection/resource record
    // itself. Triggered from the kabob on the collections list — the
    // detail-page button uses /refresh-members for the bulk expansion.
    // Registered BEFORE /refresh-members so Express path-matching is
    // unambiguous (refresh is a prefix of refresh-members; without
    // the explicit order Express still routes correctly because both
    // are full paths, but listing them adjacently makes intent clear).
    app.post(
        `${base}/collections/:pid/metadata/refresh`,
        require_dashboard_auth,
        write_limiter(),
        controller.refresh_collection_record
    );

    // Collection-scoped: enqueue every active member.
    app.post(
        `${base}/collections/:pid/metadata/refresh-members`,
        require_dashboard_auth,
        write_limiter(),
        controller.refresh_collection_members
    );

    // Progress + cancel — the modal polls /progress every 1s and the
    // Cancel button posts to /cancel. Both return the same progress
    // partial so the open modal stays in sync.
    app.get(
        `${base}/jobs/:batch_uuid/progress`,
        require_dashboard_auth,
        controller.batch_progress_partial
    );
    app.post(
        `${base}/jobs/:batch_uuid/cancel`,
        require_dashboard_auth,
        write_limiter(),
        controller.cancel_batch
    );
};
