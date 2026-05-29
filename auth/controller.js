'use strict';

// Auth controllers. Express 5 async handlers — rejections propagate to
// the central error middleware.
//
// Endpoints:
//   POST /repo/auth/login   — body { du_id }, issues cookie + body payload
//   POST /repo/auth/logout  — clears cookie + DB refresh token
//   GET  /repo/auth/me      — returns the authenticated user
//   POST /repo/auth/refresh — exchanges {user_id, refresh_token} for new JWT
//
// The SSO callback lives in auth/sso/ and runs its own layered defense
// (IP allowlist → freshness → HMAC → host check → user lookup). This
// controller covers the local session surface only — direct login,
// logout, /me, refresh — which the dashboard and API clients use.

const auth_model = require('./model');
const user_model = require('../users/model');
const jwt = require('../libs/jwt');
const { UnauthorizedError, ValidationError } = require('../libs/errors');

function build_payload(user) {
    return {
        sub: String(user.id),
        du_id: user.du_id,
        email: user.email,
    };
}

function public_user(row) {
    if (!row) return null;
    return {
        id: row.id,
        du_id: row.du_id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
    };
}

async function login(req, res) {
    if (!req.body || typeof req.body !== 'object') {
        throw new ValidationError('Body must be a JSON object');
    }
    const du_id = String(req.body.du_id || '').trim();
    if (!du_id) {
        throw new ValidationError('du_id is required', [{ field: 'du_id', error: 'required' }]);
    }

    const user = await auth_model.find_active_user(du_id);
    if (!user) {
        // Same response shape as a wrong-password failure would be — don't
        // leak which du_ids exist.
        throw new UnauthorizedError('Invalid credentials');
    }

    const refresh = await auth_model.rotate_refresh_token(user.id);
    const token = jwt.issue_cookie(res, build_payload(user));

    res.json({
        user: public_user(user),
        token, // also handed back for non-cookie callers (CLI / API)
        refresh_token: refresh,
    });
}

async function logout(req, res) {
    // Best-effort clear — even if we have no req.user (token expired, etc.)
    // we still clear the cookie so the client comes back clean.
    if (req.user && req.user.sub) {
        await auth_model.clear_refresh_token(req.user.sub);
    }
    jwt.clear_cookie(res);
    res.status(204).end();
}

async function me(req, res) {
    const user = await auth_model.find_by_id(req.user.sub);
    if (!user || user.is_active !== 1) {
        // Token still valid but user was deactivated. Treat as auth failure.
        throw new UnauthorizedError('User no longer active');
    }
    res.json({ user: public_user(user) });
}

async function refresh(req, res) {
    if (!req.body || typeof req.body !== 'object') {
        throw new ValidationError('Body must be a JSON object');
    }
    const user_id = req.body.user_id;
    const refresh_token = req.body.refresh_token;
    if (!user_id || !refresh_token) {
        throw new ValidationError('user_id and refresh_token are required');
    }

    const ok = await auth_model.verify_refresh_token(user_id, refresh_token);
    if (!ok) throw new UnauthorizedError('Invalid refresh token');

    const user = await auth_model.find_by_id(user_id);
    const next_refresh = await auth_model.rotate_refresh_token(user_id);
    const token = jwt.issue_cookie(res, build_payload(user));

    res.json({
        user: public_user(user),
        token,
        refresh_token: next_refresh,
    });
}

// Used internally by tests / future bootstrap scripts. NOT exposed via a
// route. Reuses user_model so the same validation + duplicate check
// apply.
async function bootstrap_user(input) {
    return user_model.create(input);
}

module.exports = {
    login,
    logout,
    me,
    refresh,
    bootstrap_user,
};
