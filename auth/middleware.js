'use strict';

/*
 * JWT auth middleware. Accepts either:
 *   - the `repo_session` cookie (browser/dashboard)
 *   - an `Authorization: Bearer <token>` header (public API)
 * 
 * On success, attaches the decoded payload to `req.user` and calls
 * `next()`. On any failure, forwards an UnauthorizedError to the central
 * error handler.
 */

const jwt = require('../libs/jwt');
const { UnauthorizedError } = require('../libs/errors');

function require_auth(req, _res, next) {
    const token = jwt.extract(req);
    if (!token) {
        return next(new UnauthorizedError('Missing authentication token'));
    }
    try {
        req.user = jwt.verify(token);
        return next();
    } catch (err) {
        const msg =
            err.name === 'TokenExpiredError'
                ? 'Authentication token expired'
                : 'Invalid authentication token';
        return next(new UnauthorizedError(msg));
    }
}

/*
 * Optional auth: if a token is present and valid, populate req.user;
 * otherwise continue anonymously. Useful for routes that change behavior
 * when logged in but don't require it.
 */
function optional_auth(req, _res, next) {
    const token = jwt.extract(req);
    if (!token) return next();
    try {
        req.user = jwt.verify(token);
    } catch {
        // Silently ignore — caller treats this as anonymous.
    }
    return next();
}

module.exports = { require_auth, optional_auth };
