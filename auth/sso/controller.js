'use strict';

/*
 * SSO callback handler. Sits at POST /repo/auth/sso. The upstream proxy
 * (authproxy.du.edu in prod) authenticates the user against DU's
 * central credential store, then POSTs back to us with body fields:
 * 
 *   employeeID    — required, the user's du_id
 *   HTTP_HOST     — legacy compat (Layer 0)
 *   timestamp     — required when SSO_REQUIRE_FRESHNESS=1 (Layer 2)
 *   nonce         — required when SSO_REQUIRE_FRESHNESS=1 (Layer 2)
 *   signature     — required when SSO_REQUIRE_HMAC=1 (Layer 3)
 *   next          — optional, where to redirect after success
 * 
 * Layer enforcement order (fail fast on the highest-confidence rejection):
 *   1. IP allowlist                  (middleware, runs first)
 *   2. Request shape validation
 *   3. HMAC signature                (if SSO_REQUIRE_HMAC=1)
 *   4. Timestamp + nonce freshness   (if SSO_REQUIRE_FRESHNESS=1)
 *   5. Legacy HTTP_HOST string match (defense-in-depth)
 *   6. User lookup in tbl_users
 *   7. Mint session cookie, 303 redirect
 * 
 * Every attempt — success or fail — emits a structured audit log with
 * request_id, ip, employeeID (when known), outcome, and which layers
 * were active. Useful when reviewing the access log for forged attempts.
 */

const validator = require('validator');

const app_config = require('../../config/app');
const auth_model = require('../model');
const jwt = require('../../libs/jwt');
const log = require('../../libs/log');
const { UnauthorizedError, ValidationError, ForbiddenError } = require('../../libs/errors');
const hmac = require('./hmac');
const replay_guard = require('./replay_guard');

function build_audit(req, cfg) {
    return {
        event: 'sso_attempt',
        request_id: req.id,
        ip: req.ip,
        ua: req.get && req.get('user-agent'),
        layers: {
            ip_allowlist: (cfg.sso.trusted_ips || []).length > 0,
            require_freshness: cfg.sso.require_freshness,
            require_hmac: cfg.sso.require_hmac,
            host_check: Boolean(cfg.sso.expected_host),
        },
    };
}

function build_payload(user) {
    return { sub: String(user.id), du_id: user.du_id, email: user.email };
}

/*
 * Safe-redirect: only allow same-origin paths starting with `/` and not
 * `//`. Mirrors the helper in dashboard/controller.js but the lib is
 * internal there; duplicating the few lines keeps the SSO module
 * self-contained.
 */
function safe_next(raw, fallback) {
    if (typeof raw !== 'string' || raw.length === 0) return fallback;
    const decoded = validator.unescape(raw.trim());
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return fallback;
    if (decoded.includes('\n') || decoded.includes('\r')) return fallback;
    return decoded;
}

function validate_shape(body) {
    if (!body || typeof body !== 'object') {
        throw new ValidationError('Body required');
    }
    const employee_id = String(body.employeeID || '').trim();
    if (!employee_id) {
        throw new ValidationError('employeeID is required', [
            { field: 'employeeID', error: 'required' },
        ]);
    }
    if (!validator.isNumeric(employee_id)) {
        throw new ValidationError('employeeID must be numeric');
    }
    if (employee_id.length > 10) {
        throw new ValidationError('employeeID exceeds 10 digits');
    }
    return { employee_id };
}

async function sso_callback(req, res) {
    const cfg = app_config();
    const audit = build_audit(req, cfg);

    try {
        // Step 2 — shape (Layer 1 ran as middleware).
        const { employee_id } = validate_shape(req.body);
        audit.employee_id = employee_id;

        // Step 3 — HMAC (Layer 3, if enabled).
        if (cfg.sso.require_hmac) {
            const secrets = [cfg.sso.hmac_secret, cfg.sso.hmac_secret_next].filter(Boolean);
            if (secrets.length === 0) {
                // Fail-closed: misconfiguration = no access, not access-anyway.
                audit.outcome = 'misconfigured:no_hmac_secret';
                log.error(audit);
                throw new Error('SSO_REQUIRE_HMAC=1 but SSO_HMAC_SECRET is empty');
            }
            hmac.verify(req.body, secrets);
        }

        // Step 4 — timestamp + nonce (Layer 2, if enabled).
        if (cfg.sso.require_freshness) {
            replay_guard.check(req.body.timestamp, req.body.nonce, {
                max_skew_seconds: cfg.sso.max_skew_seconds,
            });
        }

        /*
         * Step 5 — legacy HTTP_HOST (Layer 0, defense-in-depth).
         * Skipped if SSO_HOST is empty (e.g. dev). Even when present,
         * this is NEVER the only check — at minimum Layer 1 must also
         * have rejected attackers from outside the allowlist.
         */
        if (cfg.sso.expected_host) {
            if (!req.body.HTTP_HOST) {
                throw new ValidationError('HTTP_HOST is required');
            }
            if (!validator.isFQDN(String(req.body.HTTP_HOST))) {
                throw new ValidationError('HTTP_HOST must be a fully qualified domain');
            }
            if (req.body.HTTP_HOST !== cfg.sso.expected_host) {
                audit.outcome = 'rejected:host_mismatch';
                log.warn(audit);
                throw new UnauthorizedError('Authentication failed');
            }
        }

        // Step 6 — user lookup.
        const user = await auth_model.find_active_user(employee_id);
        if (!user) {
            audit.outcome = 'rejected:user_not_found_or_inactive';
            log.warn(audit);
            /*
             * Same response shape as any other auth failure — don't
             * leak whether the du_id exists.
             */
            throw new UnauthorizedError('Authentication failed');
        }
        audit.user_id = user.id;

        // Step 7 — mint session.
        await auth_model.rotate_refresh_token(user.id);
        jwt.issue_cookie(res, build_payload(user));

        audit.outcome = 'success';
        log.info(audit);

        const target = safe_next(req.body.next, cfg.sso.default_redirect);
        return res.redirect(303, target);
    } catch (err) {
        /*
         * Make sure every rejection has an audit trail, even
         * ValidationErrors thrown before we set an outcome explicitly.
         */
        if (!audit.outcome) {
            audit.outcome = 'rejected:' + (err.code || 'error');
            audit.error = err.message;
            log.warn(audit);
        }
        throw err;
    }
}

/*
 * GET /repo/auth/sso/start — kicks off the SSO redirect. The user
 * clicks "Sign in with DU SSO" on the login page; we redirect them to
 * SSO_URL with two appended params:
 *   - app_url=<SSO_RESPONSE_URL>  — matches the legacy convention so
 *     authproxy.du.edu can use the same wiring it already understands.
 *     Skipped when SSO_RESPONSE_URL is unset.
 *   - next=<safe path>            — preserved so the callback can bounce
 *     the user to their intended destination after auth.
 */
function sso_start(req, res) {
    const cfg = app_config();
    if (!cfg.sso.url) {
        throw new ForbiddenError('SSO not configured (SSO_URL is empty)');
    }
    const target = new URL(cfg.sso.url);
    if (cfg.sso.response_url) {
        target.searchParams.set('app_url', cfg.sso.response_url);
    }
    const next = safe_next(req.query.next, cfg.sso.default_redirect);
    target.searchParams.set('next', next);
    return res.redirect(302, target.toString());
}

module.exports = {
    sso_callback,
    sso_start,
    // exported for tests
    _safe_next: safe_next,
    _validate_shape: validate_shape,
};
