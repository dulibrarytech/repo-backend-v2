'use strict';

const app_config = require('../config/app');
const { require_auth } = require('../auth/middleware');
const { api_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/collections`;

    app.get(base, require_auth, api_limiter(), controller.list_collections);
    app.get(`${base}/:pid`, require_auth, api_limiter(), controller.get_collection);
    app.get(`${base}/:pid/members`, require_auth, api_limiter(), controller.get_members);
};
