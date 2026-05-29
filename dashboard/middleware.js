'use strict';

// Browser-friendly auth gate for dashboard pages.
//
// require_auth (auth/middleware.js) is the right thing for API routes —
// missing/invalid token → 401 JSON. For browser pages we want:
//   - Full page nav (GET /dashboard/home) → 302 redirect to /login.
//   - HTMX request (any verb, HX-Request: true) → 401 with HX-Redirect
//     header so the htmx client can perform a soft redirect without
//     leaving the user staring at an error blob.
//
// Mounts in front of every dashboard route except /login.

const app_config = require('../config/app');
const jwt = require('../libs/jwt');

function is_htmx_request(req) {
    return req.get('hx-request') === 'true';
}

function login_url(cfg, return_to) {
    const base = `${cfg.path}/dashboard/login`;
    if (!return_to) return base;
    return `${base}?next=${encodeURIComponent(return_to)}`;
}

function require_dashboard_auth(req, res, next) {
    const cfg = app_config();
    const token = jwt.extract(req);

    if (token) {
        try {
            req.user = jwt.verify(token);
            return next();
        } catch {
            // fall through to the redirect path
        }
    }

    const target = login_url(cfg, req.originalUrl || req.url);

    if (is_htmx_request(req)) {
        res.set('HX-Redirect', target);
        return res.status(401).type('text/html').send(`
            <div class="alert alert-warning">Your session has expired. Redirecting to login…</div>
        `);
    }

    return res.redirect(302, target);
}

// Variant for the login page itself: if the user already has a valid
// session, bounce them to the home page. Otherwise render the form.
function redirect_if_authenticated(req, res, next) {
    const cfg = app_config();
    const token = jwt.extract(req);
    if (token) {
        try {
            jwt.verify(token);
            return res.redirect(302, `${cfg.path}/dashboard/`);
        } catch {
            // Invalid/expired — let them log in fresh.
        }
    }
    return next();
}

module.exports = {
    require_dashboard_auth,
    redirect_if_authenticated,
    is_htmx_request,
};
