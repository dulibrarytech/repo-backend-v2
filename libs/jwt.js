'use strict';

/*
 * JWT helpers — sign/verify, plus httpOnly cookie issuance/extraction.
 * 
 * Authentication strategy (per MODERNIZATION_PLAN §1.6):
 *   - Browser/dashboard: SameSite=Lax, httpOnly, Secure cookie. JS can't
 *     read the token → reduced XSS blast radius.
 *   - Public API: Bearer header (Authorization: Bearer <token>).
 * 
 * `extract(req)` prefers the cookie, falls back to the bearer header.
 * Anything else throws an UnauthorizedError-shaped failure upstream.
 */

const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'repo_session';

function secret() {
    const s = process.env.TOKEN_SECRET;
    if (!s) throw new Error('TOKEN_SECRET is not configured');
    return s;
}

function algorithm() {
    return process.env.TOKEN_ALGO || 'HS512';
}

function expires_in() {
    return process.env.TOKEN_EXPIRES || '12h';
}

function issuer() {
    return process.env.TOKEN_ISSUER || 'repo-backend-v2';
}

function sign(payload, overrides = {}) {
    return jwt.sign(payload, secret(), {
        algorithm: algorithm(),
        expiresIn: expires_in(),
        issuer: issuer(),
        ...overrides,
    });
}

function verify(token) {
    return jwt.verify(token, secret(), {
        algorithms: [algorithm()],
        issuer: issuer(),
    });
}

function cookie_options() {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
    };
}

function issue_cookie(res, payload) {
    const token = sign(payload);
    res.cookie(COOKIE_NAME, token, cookie_options());
    return token;
}

function clear_cookie(res) {
    res.clearCookie(COOKIE_NAME, cookie_options());
}

function extract(req) {
    if (req.cookies && typeof req.cookies[COOKIE_NAME] === 'string') {
        return req.cookies[COOKIE_NAME];
    }
    const auth = req.get && req.get('authorization');
    if (typeof auth === 'string') {
        const m = auth.match(/^Bearer\s+(.+)$/i);
        if (m) return m[1];
    }
    return null;
}

module.exports = {
    COOKIE_NAME,
    sign,
    verify,
    issue_cookie,
    clear_cookie,
    extract,
};
