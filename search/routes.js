'use strict';

const app_config = require('../config/app');
const { require_auth } = require('../auth/middleware');
const { api_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/search`;

    app.get(`${base}/objects`, require_auth, api_limiter(), controller.search_objects);
    app.get(`${base}/lookup`, require_auth, api_limiter(), controller.quick_lookup);
};
