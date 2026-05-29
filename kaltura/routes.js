'use strict';

// Mount points for the Kaltura REST API. Mirrors the shape of
// ingester/routes.js — auth + rate-limit wrappers, base path derived
// from app config so a different APP_PATH at deploy time shifts
// everything in lockstep.
//
// Endpoint summary:
//
//   POST /api/v1/kaltura/session            → mint a KS
//   POST /api/v1/kaltura/metadata           → enqueue + drain
//   GET  /api/v1/kaltura/queue              → list pending queue rows
//   GET  /api/v1/kaltura/queue/entry_ids    → list resolved IDs
//   POST /api/v1/kaltura/queue/clear        → wipe queue + IDs tables
//
// All endpoints require a JWT. Writes use write_limiter; reads use
// api_limiter — same split as ingester routes.

const app_config = require('../config/app');
const { require_auth } = require('../auth/middleware');
const { api_limiter, write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/api/v1/kaltura`;

    app.post(`${base}/session`, require_auth, write_limiter(), controller.get_session);

    // /metadata is a write (it queues + drains); rate-limit accordingly.
    app.post(`${base}/metadata`, require_auth, write_limiter(), controller.post_metadata);

    app.get(`${base}/queue`, require_auth, api_limiter(), controller.get_queue);
    app.get(`${base}/queue/entry_ids`, require_auth, api_limiter(), controller.get_entry_ids);
    app.post(`${base}/queue/clear`, require_auth, write_limiter(), controller.clear_queue);
};
