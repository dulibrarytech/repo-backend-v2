'use strict';

// Public API routes. Mounted at /repo/api/v1.
//
// Three pieces of middleware sit in front of every public API route:
//
//   1. cors({ origin: '*' }) — Access-Control-Allow-Origin: * so any
//      caller (browser, curl, third-party script) can hit us without
//      preflight rejection. We do NOT include credentials, so the
//      open origin is the standard public-API pattern, not a security
//      surface.
//   2. api_limiter() — 300 req/min per IP. Loose enough for normal
//      browsing, tight enough to brake a runaway scraper. Separate
//      bucket from the staff write_limiter.
//   3. controller.log_request — light-touch access logging (JSON
//      endpoints only, skip thumbnails + health).
//
// Routes are intentionally simple — no auth middleware, no SSO, no
// CSRF (no state-changing operations live here).

const cors = require('cors');

const app_config = require('../config/app');
const { api_limiter } = require('../auth/rate_limit');
const controller = require('./controller');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/api/v1`;

    // CORS: applied as a path-scoped middleware so the dashboard's
    // stricter origin allowlist (config/security.js) keeps governing
    // its own routes. No credentials → "*" is safe.
    const public_cors = cors({
        origin: '*',
        credentials: false,
        methods: ['GET', 'HEAD', 'OPTIONS'],
        allowedHeaders: ['Content-Type'],
        exposedHeaders: ['X-Request-Id'],
        maxAge: 86400,
    });

    app.use(base, public_cors);
    app.use(base, api_limiter());
    app.use(base, controller.log_request);

    // Routes — order matters: /collections must come before any
    // /objects/:pid routes (no conflict in practice since they're
    // different prefixes, but worth noting).
    app.get(`${base}/health`, controller.health);
    app.get(`${base}/search`, controller.search);
    app.get(`${base}/collections`, controller.list_collections);
    app.get(`${base}/objects/:pid/thumbnail`, controller.get_thumbnail);
    app.get(`${base}/objects/:pid`, controller.get_object);
};
