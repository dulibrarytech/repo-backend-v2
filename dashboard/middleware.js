'use strict';

/*
 * Browser-friendly auth gate for dashboard pages.
 * 
 * require_auth (auth/middleware.js) is the right thing for API routes —
 * missing/invalid token → 401 JSON. For browser pages we want:
 *   - Full page nav (GET /dashboard/home) → 302 redirect to /login.
 *   - HTMX request (any verb, HX-Request: true) → 401 with HX-Redirect
 *     header so the htmx client can perform a soft redirect without
 *     leaving the user staring at an error blob.
 * 
 * Mounts in front of every dashboard route except /login.
 */

const app_config = require('../config/app');
const jwt = require('../libs/jwt');
const { has_permission } = require('../auth/rbac');
const user_model = require('../users/model');

function is_htmx_request(req) {
    return req.get('hx-request') === 'true';
}

function login_url(cfg, return_to) {
    const base = `${cfg.path}/dashboard/login`;
    if (!return_to) return base;
    return `${base}?next=${encodeURIComponent(return_to)}`;
}

/*
 * Attach the authenticated user's role + a can(permission) helper to
 * res.locals so dashboard views can show/hide actions by capability.
 * DB-fresh (a role change reflects immediately); best-effort — a lookup
 * failure leaves role=null (admin actions hidden) and the page still
 * renders. Authorization itself is still enforced server-side by
 * require_permission on each gated route, so a hidden-but-clicked action
 * is denied regardless of what the UI showed.
 */
async function attach_role_context(req, res) {
    let role = null;
    let profile = null;
    try {
        if (req.user && req.user.du_id) {
            const row = await user_model.get_by_du_id(req.user.du_id);
            if (row) {
                role = row.role || null;
                profile = row;
            }
        }
    } catch {
        role = null;
    }
    req.user.role = role;
    /*
     * The JWT carries only sub/du_id/email — NOT the user's name. Merge the
     * name from tbl_users (already fetched above for the role) onto req.user
     * so the header shows the full name in EVERY view, not just the ones
     * (like the home page) that fetch the full record themselves. Falls back
     * to the du_id in the header when the lookup fails (profile stays null).
     */
    if (profile) {
        if (profile.first_name) req.user.first_name = profile.first_name;
        if (profile.last_name) req.user.last_name = profile.last_name;
    }
    res.locals.user = req.user;
    res.locals.user_role = role;
    res.locals.can = (permission) => has_permission(role, permission);
}

async function require_dashboard_auth(req, res, next) {
    const cfg = app_config();
    const token = jwt.extract(req);

    if (token) {
        let decoded = null;
        try {
            decoded = jwt.verify(token);
        } catch {
            decoded = null;
        }
        if (decoded) {
            req.user = decoded;
            await attach_role_context(req, res);
            return next();
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

/*
 * Variant for the login page itself: if the user already has a valid
 * session, bounce them to the home page. Otherwise render the form.
 */
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
