'use strict';

// Dashboard routes for TIFF→JPG conversion. Mounted after the main
// dashboard routes (see config/express.js) so the single-object action
// /objects/:pid/convert sits alongside the other per-object POSTs
// without shadowing them (distinct trailing segment, same hazard the
// metadata-refresh /objects/:pid/metadata/refresh route navigates).
// All staff-only via require_dashboard_auth.

const app_config = require('../config/app');
const { require_dashboard_auth } = require('../dashboard/middleware');
const { require_permission, PERMISSIONS } = require('../auth/rbac');
const { write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/dashboard`;

    // The batch convert admin surface (/admin/convert/*) is admin-only. The
    // single-object convert action below is a staff curation action and is
    // NOT gated here (Phase 2: edit_object).
    const can_manage = require_permission(PERMISSIONS.MANAGE_CONVERT);
    // Single-object convert is staff curation → edit_object.
    const can_edit = require_permission(PERMISSIONS.EDIT_OBJECT);

    // Admin landing page + polled status partial.
    app.get(`${base}/admin/convert`, require_dashboard_auth, can_manage, controller.convert_page);
    app.get(`${base}/admin/convert/status`, require_dashboard_auth, can_manage, controller.status_partial);

    // Dry-run preview (resolve + show payloads, enqueue nothing) and the
    // real start. Both are writes → rate-limited.
    app.post(
        `${base}/admin/convert/preview`,
        require_dashboard_auth,
        can_manage,
        write_limiter(),
        controller.convert_preview
    );
    app.post(
        `${base}/admin/convert/start`,
        require_dashboard_auth,
        can_manage,
        write_limiter(),
        controller.convert_start
    );

    // Single-object action from the Objects table kebab menu.
    app.post(
        `${base}/objects/:pid/convert`,
        require_dashboard_auth,
        can_edit,
        write_limiter(),
        controller.convert_object
    );
};
