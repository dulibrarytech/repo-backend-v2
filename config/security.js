'use strict';

/*
 * Security configuration. Single source of truth for helmet, CORS,
 * and request body limits. Wired into the Express factory in
 * config/express.js.
 */

const app_config = require('./app');

/*
 * ----------------------------------------------------------------------------
 * helmet
 * 
 * CSP is enabled (the legacy app had it explicitly disabled — see
 * MODERNIZATION_PLAN §1.2). All front-end assets (Bootstrap + HTMX) are
 * self-hosted under /static/assets/vendor, so scripts/styles/fonts stay
 * 'self'-only — no third-party CDN origin is allowed. This is also why the
 * sign-in page renders with zero external dependencies; it previously
 * blocked on cdn.jsdelivr.net whenever the network to DU services was down.
 * 
 * A function (not a static object) because `form-action` has to include
 * the SSO logout URL's origin when SSO_LOGOUT_URL is set — otherwise the
 * browser blocks the logout form's 303 redirect to the IdP. (CSP applies
 * `form-action` to every URL in the submission's redirect chain, not
 * just the form's `action` target.)
 * ----------------------------------------------------------------------------
 */
function helmet_options() {
    const cfg = app_config();
    const form_action_sources = ["'self'"];
    if (cfg.sso && cfg.sso.logout_url) {
        try {
            form_action_sources.push(new URL(cfg.sso.logout_url).origin);
        } catch {
            /*
             * Misconfigured SSO_LOGOUT_URL — leave form-action at 'self'.
             * The logout endpoint will still 303 to it; the browser
             * will block, but that's a config error, not a code bug.
             */
        }
    }

    return {
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                'default-src': ["'self'"],
                'script-src': ["'self'"],
                /*
                 * 'unsafe-inline' stays for inline style="..." attributes used
                 * across the EJS partials (style-src-attr); no CDN host needed.
                 */
                'style-src': ["'self'", "'unsafe-inline'"],
                'img-src': ["'self'", 'data:', 'https:'],
                'font-src': ["'self'"],
                /*
                 * Sourcemaps (*.css.map / *.js.map) are vendored next to the
                 * minified assets, so DevTools fetches them same-origin;
                 * connect-src stays 'self'-only.
                 */
                'connect-src': ["'self'"],
                'frame-ancestors': ["'self'"],
                'object-src': ["'none'"],
                'base-uri': ["'self'"],
                'form-action': form_action_sources,
            },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'no-referrer' },
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
    };
}

/*
 * ----------------------------------------------------------------------------
 * CORS
 * 
 * Legacy code matched req.headers.host (the *server's* host, not the
 * requester's origin) — that was a bug. v2 matches the `Origin` header
 * against an explicit allowlist from CORS_ALLOWED_ORIGINS.
 * 
 * Requests with no Origin header (same-origin browser nav, server-to-
 * server callers) are allowed without CORS headers being set.
 * ----------------------------------------------------------------------------
 */
function cors_options() {
    const cfg = app_config();
    const allowed = new Set(cfg.cors_allowed_origins);

    return function delegate(req, callback) {
        const origin = req.headers.origin;
        if (!origin) return callback(null, { origin: false });
        if (allowed.has(origin)) {
            return callback(null, {
                origin: true,
                credentials: true,
                methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
                allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
                exposedHeaders: ['X-Request-Id'],
            });
        }
        return callback(null, { origin: false });
    };
}

/*
 * ----------------------------------------------------------------------------
 * Body parser limits
 * 
 * Express built-ins (no body-parser dep). `extended: false` for urlencoded
 * — we don't need qs and it widens prototype-pollution surface.
 * `strict: true` for JSON — top-level must be array/object.
 * ----------------------------------------------------------------------------
 */
const body_limits = {
    json: { limit: '1mb', strict: true },
    urlencoded: { limit: '1mb', extended: false },
};

module.exports = {
    helmet_options,
    cors_options,
    body_limits,
};
