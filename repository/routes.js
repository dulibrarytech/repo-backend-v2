'use strict';

const app_config = require('../config/app');
const { require_auth } = require('../auth/middleware');
const { write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/objects`;

    app.get(base, require_auth, controller.list_objects);
    app.get(`${base}/:pid`, require_auth, controller.get_object);
    app.post(`${base}/:pid/publish`, require_auth, write_limiter(), controller.publish_object);
    app.post(`${base}/:pid/suppress`, require_auth, write_limiter(), controller.suppress_object);
    app.delete(`${base}/:pid`, require_auth, write_limiter(), controller.delete_object);
};
