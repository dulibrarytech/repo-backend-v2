'use strict';

/*
 * Shared ArchivesSpace session holder + retrying record fetch.
 *
 * Born from the 95-package burst incident (2026-07-29): the ingest
 * worker's stages minted a FRESH ASpace session per package
 * (process_metadata, and the stage-4 drift check), so a big batch
 * fired dozens of logins in quick succession — ASpace started
 * resetting connections ("ArchivesSpace login failed: read
 * ECONNRESET") and every affected row halted with no retry.
 *
 * Two fixes live here:
 *
 *   1. holder_for(client) — ONE cached session token per ASpace
 *      client instance (WeakMap-keyed, so the production default
 *      client shares a single token across every stage call, while
 *      test fakes get their own). Concurrent callers share one
 *      in-flight login instead of racing. Invalidate-on-401 mirrors
 *      metadata/worker.js's token_holder pattern.
 *
 *   2. fetch_record_with_retry(uri, opts) — get_record with the
 *      holder's token, a single refresh-and-retry on 401/403, and
 *      bounded exponential backoff (with jitter) on TRANSPORT
 *      failures and 5xx/429 responses. Definitive statuses (200,
 *      404, a 401 that survives refresh) return immediately — only
 *      burst-shaped failures are retried, so a genuinely bad URI
 *      still halts on the first attempt.
 */

const aspace_default = require('./archivesspace');
const app_config = require('../config/app');
const log = require('./log');

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_MS = 1000;

function default_sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Process-wide fetch pacing (2026-07-29 follow-up): ASpace can't take
 * more than a few requests at a time, so beyond session reuse the
 * ingest stages also SPACE their record fetches — one per
 * ASPACE_FETCH_MIN_INTERVAL_MS (default 10s), matching the metadata
 * worker's gentle tick cadence. Implemented as a promise chain so
 * concurrent stage runs line up single-file: each caller waits for
 * the previous fetch's slot plus the remaining interval. Retry
 * attempts pace too — a retry is still a request.
 */
let _pace_chain = Promise.resolve();
let _pace_last_at = 0;
function _pace(min_interval_ms, sleep) {
    if (!min_interval_ms || min_interval_ms <= 0) return Promise.resolve();
    const turn = _pace_chain.then(async () => {
        const wait = _pace_last_at + min_interval_ms - Date.now();
        if (wait > 0) await sleep(wait);
        _pace_last_at = Date.now();
    });
    /* Keep the chain alive even if a sleep implementation throws. */
    _pace_chain = turn.catch(() => {});
    return turn;
}

function create_holder(aspace = aspace_default) {
    let token = null;
    let minting = null;
    return {
        /*
         * Return the cached token, minting one if absent. Concurrent
         * calls during a mint await the SAME login promise — a burst
         * of packages produces one login, not N.
         */
        async get() {
            if (token) return token;
            if (!minting) {
                minting = aspace.get_session_token().finally(() => {
                    minting = null;
                });
            }
            token = await minting;
            return token;
        },
        invalidate() {
            token = null;
        },
    };
}

/*
 * One holder per client instance. The production default client gets
 * a process-wide shared session; injected test fakes each get their
 * own (and are garbage-collected with it).
 */
const _holders = new WeakMap();
function holder_for(aspace = aspace_default) {
    let holder = _holders.get(aspace);
    if (!holder) {
        holder = create_holder(aspace);
        _holders.set(aspace, holder);
    }
    return holder;
}

/*
 * Fetch one record with session reuse + bounded retry.
 *
 * Returns the final { status, data } response for DEFINITIVE
 * statuses — the caller keeps its own 200/404/auth mapping. Throws
 * (the last transport error) only after `attempts` tries. Backoff:
 * base_ms * 2^(attempt-1), scaled by 0.5–1.5 jitter so concurrent
 * retries don't re-align into a new burst.
 */
async function fetch_record_with_retry(uri, opts = {}) {
    const aspace = opts.aspace || aspace_default;
    const session = opts.session || holder_for(aspace);
    const attempts = opts.attempts || DEFAULT_ATTEMPTS;
    const base_ms = opts.base_ms === undefined ? DEFAULT_BASE_MS : opts.base_ms;
    const sleep = opts.sleep || default_sleep;
    /*
     * Pacing applies by default only to the shared PRODUCTION client —
     * that's the one talking to the real ASpace. Injected clients
     * (test fakes, special-purpose callers) default to unpaced and
     * opt in via opts.min_interval_ms.
     */
    const min_interval_ms =
        opts.min_interval_ms !== undefined
            ? opts.min_interval_ms
            : aspace === aspace_default
              ? app_config().archivespace.fetch_min_interval_ms
              : 0;

    let last_err = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await _pace(min_interval_ms, sleep);
            let token = await session.get();
            let res = await aspace.get_record(uri, token);
            if (res.status === 401 || res.status === 403) {
                /*
                 * Session expired or was culled server-side — refresh
                 * once and re-fetch. A 401 that SURVIVES the refresh
                 * is definitive (bad credentials), not burst noise.
                 */
                session.invalidate();
                token = await session.get();
                res = await aspace.get_record(uri, token);
            }
            if (res.status >= 500 || res.status === 429) {
                last_err = new Error(`ArchivesSpace ${uri} returned HTTP ${res.status}`);
            } else {
                return res;
            }
        } catch (err) {
            /*
             * Transport-level failure (UpstreamError from the client:
             * ECONNRESET, timeout, DNS) — the token may have died with
             * the connection; drop it so the next attempt re-mints.
             */
            session.invalidate();
            last_err = err;
        }
        if (attempt < attempts) {
            const delay = Math.round(base_ms * 2 ** (attempt - 1) * (0.5 + Math.random()));
            log.warn({
                event: 'aspace_fetch_retry',
                uri,
                attempt,
                of: attempts,
                delay_ms: delay,
                err: last_err ? last_err.message : null,
            });
            await sleep(delay);
        }
    }
    throw last_err;
}

module.exports = { create_holder, holder_for, fetch_record_with_retry };
