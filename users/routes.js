'use strict';

/*
 * Users routes.
 * 
 *   GET    /repo/users           — list active users (auth required)
 *   GET    /repo/users/:id       — one user (auth required)
 *   POST   /repo/users           — create (auth required, write-limited)
 *   PUT    /repo/users/:id       — update (auth required, write-limited)
 *   DELETE /repo/users/:id       — soft delete (auth required, write-limited)
 */

const app_config = require('../config/app');
const { require_auth } = require('../auth/middleware');
const { require_permission, PERMISSIONS } = require('../auth/rbac');
const { write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/users`;

    /*
     * User management is admin-only end-to-end (viewing the staff roster +
     * mutating it). require_permission runs after require_auth (reads
     * req.user.du_id).
     */
    const can_manage = require_permission(PERMISSIONS.MANAGE_USERS);

    app.get(base, require_auth, can_manage, controller.list_users);
    app.get(`${base}/:id`, require_auth, can_manage, controller.get_user);
    app.post(base, require_auth, can_manage, write_limiter(), controller.create_user);
    app.put(`${base}/:id`, require_auth, can_manage, write_limiter(), controller.update_user);
    app.delete(`${base}/:id`, require_auth, can_manage, write_limiter(), controller.delete_user);
};
