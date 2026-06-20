'use strict';

// Mount points for the ingest REST API. Mirrors the shape of
// collections/routes.js — auth + rate-limiter wrappers, base path
// derived from app config so a different APP_PATH at deploy time
// shifts everything in lockstep.

const app_config = require('../config/app');
const { require_auth } = require('../auth/middleware');
const { require_permission, PERMISSIONS } = require('../auth/rbac');
const { api_limiter, write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/api/ingest`;
    // Every ingest WRITE requires manage_ingest; GET reads stay open to any
    // authenticated user (view_repository).
    const can_ingest = require_permission(PERMISSIONS.MANAGE_INGEST);

    // Writes get the stricter write_limiter; reads use api_limiter.
    // The enqueue endpoint is the most expensive — a single batch can
    // schedule hundreds of rows — so it's rate-limited the same as
    // bulk-publish in repository/routes.js.

    app.post(`${base}/queue`, require_auth, can_ingest, write_limiter(), controller.enqueue);

    app.get(base, require_auth, api_limiter(), controller.list);
    app.get(`${base}/reset-orphaned`, require_auth, api_limiter(), (_req, res) => {
        // Defensive: this used to be a GET in some staff scripts. Surface
        // a 405 with a hint so anyone hitting the legacy URL learns the
        // new shape. Real action moves through POST below.
        res.set('Allow', 'POST').status(405).json({
            error: 'method_not_allowed',
            hint: 'POST /api/ingest/reset-orphaned',
        });
    });
    app.post(`${base}/reset-orphaned`, require_auth, can_ingest, write_limiter(), controller.reset_orphaned);

    // :id-scoped endpoints. Order matters — Express matches the more-
    // specific paths first when they share a prefix.
    app.get(`${base}/:id`, require_auth, api_limiter(), controller.get_one);
    app.get(`${base}/:id/timeline`, require_auth, api_limiter(), controller.get_timeline);
    app.post(
        `${base}/:id/rollback-pre`,
        require_auth,
        can_ingest,
        write_limiter(),
        controller.rollback_pre_ingest
    );
    app.post(
        `${base}/:id/rollback-am`,
        require_auth,
        can_ingest,
        write_limiter(),
        controller.rollback_archivematica
    );
    app.post(`${base}/:id/reset`, require_auth, can_ingest, write_limiter(), controller.reset_row);
    app.post(`${base}/:id/cancel`, require_auth, can_ingest, write_limiter(), controller.cancel_row);
    app.post(
        `${base}/:id/return-to-packaging`,
        require_auth,
        can_ingest,
        write_limiter(),
        controller.return_to_packaging
    );
};
