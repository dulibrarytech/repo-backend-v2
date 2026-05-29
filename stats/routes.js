'use strict';

const app_config = require('../config/app');
const { require_auth } = require('../auth/middleware');
const { api_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/stats`;

    app.get(`${base}/summary`, require_auth, api_limiter(), controller.summary);
    app.get(`${base}/by-collection`, require_auth, api_limiter(), controller.by_collection);
    app.get(`${base}/recent-ingests`, require_auth, api_limiter(), controller.recent_ingests);
};
