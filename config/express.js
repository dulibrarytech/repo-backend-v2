'use strict';

// Express 5 application factory.
//
// Phase 1: wires security middleware (helmet/CORS/body-limits/sanitize/
// request_id), cookie parser for JWT cookies, structured logging, the
// /health and /version endpoints, and a central error handler. Domain
// routes (auth, users, repository, indexer, dashboard, ingester, ...)
// land in Phase 3+.
//
// Does NOT call `listen()` — that's the entry point's job. Returning a
// bare app makes the factory directly usable from supertest in tests.

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const method_override = require('method-override');
const cookie_parser = require('cookie-parser');

const app_config = require('./app');
const security = require('./security');
const db_health = require('./db_health');
const sanitize = require('../libs/sanitize');
const request_id = require('../libs/request_id');
const health = require('../libs/health');
const log = require('../libs/log');
const errors = require('../libs/errors');

module.exports = function create_app() {
    const cfg = app_config();
    const app = express();

    // Register DB liveness checks against the health registry. Idempotent
    // — repeated factory calls (e.g. in tests) just overwrite the entries.
    db_health.register_all();

    app.disable('x-powered-by');
    if (cfg.is_prod) {
        // Single proxy hop (e.g. ALB / nginx). Required for accurate
        // client IPs in rate-limit and CORS logging.
        app.set('trust proxy', 1);
        app.use(compression());
    }

    // 1. Request id — first, so every later middleware can log against it.
    app.use(request_id);

    // 2. Security headers.
    app.use(helmet(security.helmet_options()));

    // 3. CORS.
    app.use(cors(security.cors_options()));

    // 4. Cookies (for JWT cookie auth).
    app.use(cookie_parser());

    // 5. Body parsers — explicit limits, JSON strict.
    app.use(express.json(security.body_limits.json));
    app.use(express.urlencoded(security.body_limits.urlencoded));

    // 6. Method override (?_method=DELETE etc.) for HTMX form posts.
    app.use(method_override());

    // 7. XSS sanitization (after body parsers, before handlers).
    app.use(sanitize.req_body);
    app.use(sanitize.req_query);

    // Views (placeholder until the HTMX dashboard lands in Phase 6).
    app.set('views', './views');
    app.set('view engine', 'ejs');
    app.set('view cache', cfg.is_prod);

    // Static assets — mounted under the app path so /repo/static/* works.
    app.use(`${cfg.path}/static`, express.static('./public'));

    // Thumbnails — uploaded JPEGs live outside ./public so the upload
    // path can be relocated (NFS, S3FS, etc.) without restructuring the
    // static tree. Mount them under /repo/static/tn so URLs stored in
    // tbl_objects.thumbnail remain stable. `fallthrough: false` makes a
    // missing thumbnail return a clean 404 instead of cascading into the
    // 404-handling middleware below — keeps logs less noisy for the
    // (very) common case of an object that doesn't have one yet.
    app.use(
        `${cfg.path}/static/tn`,
        express.static(cfg.thumbnail_upload_path, {
            fallthrough: true,
            maxAge: '1h',
        })
    );

    // Browsers request /favicon.ico unconditionally as a fallback even
    // when the page declares one via <link rel="icon">. Return 204 so
    // the browser stops retrying and the dev console stops complaining.
    app.get('/favicon.ico', (_req, res) => res.status(204).end());

    // Bare app path → dashboard. Without this, hitting the deployed
    // base URL (e.g. https://host/repo) falls through to the 404
    // handler since no route is registered at exactly `cfg.path`.
    app.get(cfg.path, (_req, res) => res.redirect(`${cfg.path}/dashboard`));

    // ----- Routes (Phase 1 surface) -----
    app.get(`${cfg.path}/health`, async (req, res, next) => {
        try {
            const snapshot = await health.report();
            res.status(snapshot.ok ? 200 : 503).json({
                status: snapshot.ok ? 'ok' : 'degraded',
                app: cfg.name,
                version: cfg.version,
                env: cfg.env,
                request_id: req.id,
                components: snapshot.components,
            });
        } catch (err) {
            next(err);
        }
    });

    app.get(`${cfg.path}/version`, (req, res) => {
        res.json({
            name: cfg.name,
            version: cfg.version,
            env: cfg.env,
            request_id: req.id,
        });
    });

    // Domain routes (API).
    require('../auth/routes')(app);
    require('../users/routes')(app);
    require('../repository/routes')(app);
    require('../search/routes')(app);
    require('../stats/routes')(app);
    require('../collections/routes')(app);
    require('../ingester/routes')(app);
    require('../ingester/dashboard_routes')(app);
    require('../kaltura/routes')(app);

    // Dashboard (HTMX-driven HTML).
    require('../dashboard/routes')(app);
    // Metadata refresh queue endpoints — share the dashboard auth
    // middleware. Mounted after the main dashboard routes so the
    // existing /objects/:pid/metadata (the MODAL display) still wins;
    // the new routes are /objects/:pid/metadata/refresh which has an
    // extra path segment so there's no ambiguity.
    require('../metadata/routes')(app);
    // Indexer admin endpoints (status, reindex-all, reindex-collection,
    // reindex-pid). All staff-only.
    require('../indexer/routes')(app);

    // Public API v1 — ES-backed search + object detail + thumbnail proxy +
    // collections list. NO auth, wide-open CORS, separate rate-limit
    // bucket. Mounted AFTER the dashboard so the dashboard's stricter
    // CORS + auth wiring is what governs /repo/dashboard/* requests.
    require('../api/routes')(app);

    // 404 fallthrough — must come after all routes, before error handler.
    app.use((req, _res, next) => {
        next(new errors.NotFoundError(`Route not found: ${req.method} ${req.path}`));
    });

    // Central error handler. Must keep 4 args so Express recognizes it.
    app.use((err, req, res, _next) => {
        const status = err.status || err.statusCode || 500;
        const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR');

        // Body-parser surfaces oversize bodies as type=entity.too.large.
        const is_payload_too_large = err.type === 'entity.too.large';
        const final_status = is_payload_too_large ? 413 : status;
        const final_code = is_payload_too_large ? 'PAYLOAD_TOO_LARGE' : code;

        log[final_status >= 500 ? 'error' : 'warn']({
            request_id: req.id,
            method: req.method,
            path: req.path,
            status: final_status,
            code: final_code,
            err: { message: err.message, stack: cfg.is_prod ? undefined : err.stack },
        });

        if (res.headersSent) return;

        res.status(final_status).json({
            error: err.message || 'Internal server error',
            code: final_code,
            request_id: req.id,
        });
    });

    return app;
};
