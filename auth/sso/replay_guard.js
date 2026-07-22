'use strict';

/*
 * Layer 2: timestamp + nonce replay guard.
 * 
 * Rejects SSO callbacks whose timestamp is older than max_skew_seconds
 * OR whose nonce has already been seen within the LRU's TTL window.
 * Re-using a nonce is treated as a replay attempt — even within the
 * skew window — so a captured POST can't be replayed back.
 * 
 * Two-part defense:
 *   - freshness  → bounds *how old* a request can be
 *   - uniqueness → catches replays inside the freshness window
 * 
 * Memory is in-process. Behind a load balancer with N instances this
 * reduces the effective replay window from "indefinite" to "N tries,
 * each on a different instance". To close that gap fully, swap the
 * LRU for Redis. The interface here doesn't change.
 */

const { LRUCache } = require('lru-cache');

const { UnauthorizedError, ValidationError } = require('../../libs/errors');

/*
 * LRU sized for ~10k unique nonces inside the TTL. At 100 req/s that's
 * a comfortable buffer. TTL is computed from app_config at first call.
 */
let cache = null;

function build_cache(ttl_seconds) {
    return new LRUCache({
        max: 10_000,
        ttl: ttl_seconds * 1000,
    });
}

function get_cache(max_skew_seconds) {
    if (cache === null) cache = build_cache(max_skew_seconds * 2);
    return cache;
}

/**
 * @param {string|number} timestamp  Unix seconds (as int or string).
 * @param {string}        nonce      Random per-request identifier.
 * @param {object}        opts
 * @param {number}        opts.max_skew_seconds   Allowed clock drift.
 * @param {function}      [opts.now]              For tests; returns ms.
 * @throws ValidationError  on malformed input
 * @throws UnauthorizedError on stale timestamp or replayed nonce
 */
function check(timestamp, nonce, { max_skew_seconds, now = Date.now } = {}) {
    if (typeof max_skew_seconds !== 'number' || max_skew_seconds <= 0) {
        throw new Error('replay_guard.check: max_skew_seconds is required');
    }

    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || ts <= 0) {
        throw new ValidationError('Missing or invalid timestamp');
    }
    if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) {
        throw new ValidationError('Missing or invalid nonce');
    }

    const now_seconds = Math.floor(now() / 1000);
    const skew = Math.abs(now_seconds - ts);
    if (skew > max_skew_seconds) {
        throw new UnauthorizedError(
            `Request timestamp out of range (skew=${skew}s, max=${max_skew_seconds}s)`
        );
    }

    const key = `${ts}|${nonce}`;
    const store = get_cache(max_skew_seconds);
    if (store.has(key)) {
        throw new UnauthorizedError('Replay detected (nonce reused)');
    }
    store.set(key, true);
    return true;
}

/*
 * Test-only. Drops the in-memory store so independent test cases don't
 * observe each other's nonces.
 */
function _reset() {
    cache = null;
}

module.exports = { check, _reset };
