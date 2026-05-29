'use strict';

// Rate limiter factories. Each returns middleware suitable for
// `app.use(prefix, limiter)` or per-route mounting.
//
//   - login_limiter(): tight — 10 attempts per 15 min per IP. Apply to
//     POST /auth/login and similar credential endpoints.
//   - write_limiter(): broad — 60 writes/min per IP. Apply to any
//     unauthenticated write surface.
//   - api_limiter(): looser — 300 reqs/min per IP. Public API default.
//
// Storage is in-memory (per-instance). Behind a load balancer with many
// instances, swap in `rate-limit-redis` later. For now, MODERNIZATION_PLAN
// §1.5 calls for "per-route rate limiting" and that's what this delivers.

const rate_limit = require('express-rate-limit');

function base_options(overrides) {
    return {
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        validate: { trustProxy: false },
        handler: (req, res, _next, options) => {
            res.status(options.statusCode).json({
                error:
                    typeof options.message === 'string' ? options.message : options.message.error,
                code: 'RATE_LIMITED',
                request_id: req.id,
            });
        },
        ...overrides,
    };
}

function login_limiter(overrides = {}) {
    return rate_limit(
        base_options({
            windowMs: 15 * 60 * 1000,
            limit: 10,
            message: { error: 'Too many login attempts. Try again in 15 minutes.' },
            ...overrides,
        })
    );
}

function write_limiter(overrides = {}) {
    return rate_limit(
        base_options({
            windowMs: 60 * 1000,
            limit: 60,
            message: { error: 'Too many requests.' },
            ...overrides,
        })
    );
}

function api_limiter(overrides = {}) {
    return rate_limit(
        base_options({
            windowMs: 60 * 1000,
            limit: 300,
            message: { error: 'Too many requests.' },
            ...overrides,
        })
    );
}

module.exports = { login_limiter, write_limiter, api_limiter };
