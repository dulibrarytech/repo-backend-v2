'use strict';

const app_config = require('../config/app');
const { require_dashboard_auth } = require('../dashboard/middleware');
const { require_permission, PERMISSIONS } = require('../auth/rbac');
const { write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const base = `${app_config().path}/dashboard/admin/aspace-links`;
    const can_manage = require_permission(PERMISSIONS.MANAGE_ASPACE_LINKS);

    app.get(base, require_dashboard_auth, can_manage, controller.links_page);
    app.get(`${base}/status`, require_dashboard_auth, can_manage, controller.status_partial);
    app.get(`${base}/list`, require_dashboard_auth, can_manage, controller.list_partial);
    app.post(
        `${base}/check-all`,
        require_dashboard_auth,
        can_manage,
        write_limiter(),
        controller.check_all
    );
    app.post(
        `${base}/recheck`,
        require_dashboard_auth,
        can_manage,
        write_limiter(),
        controller.recheck
    );
};
