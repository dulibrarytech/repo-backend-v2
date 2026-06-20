'use strict';

const app_config = require('../config/app');
const { require_auth } = require('../auth/middleware');
const { require_permission, PERMISSIONS } = require('../auth/rbac');
const { write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/objects`;
    const can_publish = require_permission(PERMISSIONS.PUBLISH_OBJECT);
    const can_delete = require_permission(PERMISSIONS.DELETE_OBJECT);

    // Reads are open to any authenticated user (view_repository — every
    // role has it). Writes require the matching capability.
    app.get(base, require_auth, controller.list_objects);
    app.get(`${base}/:pid`, require_auth, controller.get_object);
    app.post(`${base}/:pid/publish`, require_auth, can_publish, write_limiter(), controller.publish_object);
    app.post(`${base}/:pid/suppress`, require_auth, can_publish, write_limiter(), controller.suppress_object);
    app.delete(`${base}/:pid`, require_auth, can_delete, write_limiter(), controller.delete_object);
};
