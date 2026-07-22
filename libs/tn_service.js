'use strict';

/*
 * Thumbnail (TN) service client.
 * 
 * Ports v1's primary thumbnail fetch path. The TN service generates
 * fresh thumbnails from the canonical source files; the quality is
 * more consistent than DuraCloud's archived versions, which is why
 * staff prefer it.
 * 
 * Three concerns owned here:
 * 
 *   1. is_configured() — cheap gate. The proxy in dashboard/
 *      checks this before deciding whether to try TN at all.
 *   2. get_thumbnail(pid) — the read path. Checks disk cache first,
 *      falls through to a TN service fetch on miss, caches the
 *      result, returns the buffer. UpstreamError on any failure
 *      (transport, non-200) so the caller can map to a fallback.
 *   3. Atomic disk caching — write-temp + rename, same pattern as
 *      dashboard/thumbnails.js, so a concurrent reader never sees
 *      a half-written file.
 * 
 * Factory-injectable HTTP client so unit tests can drive the full
 * path (cache miss → fetch → cache → hit) without going near the
 * network.
 */

const fs = require('node:fs/promises');
const fs_sync = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const http_default = require('axios');

const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError } = require('./errors');

function is_configured() {
    const cfg = app_config().tn_service;
    return Boolean(cfg && cfg.url && cfg.api_key);
}

/*
 * Build the endpoint v1 used:
 *   <TN_SERVICE>/datastream/<uuid>/tn?key=<API_KEY>
 * 
 * We URL-encode the pid (defense-in-depth — the caller validates it
 * as a UUID, but a router or proxy in front of us could conceivably
 * rewrite it) and the key. The api_key can contain URL-special chars
 * in some deployments and must be percent-encoded too.
 */
function build_endpoint(uuid) {
    const cfg = app_config().tn_service;
    if (!cfg.url) {
        throw new Error('TN_SERVICE is not configured');
    }
    const base = cfg.url.replace(/\/+$/, '');
    return `${base}/datastream/${encodeURIComponent(uuid)}/tn?key=${encodeURIComponent(cfg.api_key)}`;
}

// Disk cache helpers --------------------------------------------------

function cache_file_path(pid) {
    const cfg = app_config().tn_service;
    return path.join(cfg.cache_path, `${pid}.jpg`);
}

/*
 * Synchronous existence check. We use this in the caller's hot path
 * so the proxy can return cached bytes without awaiting a stat call.
 * fs.existsSync is acceptable for this read-mostly cache directory.
 */
function cached_exists(pid) {
    const cfg = app_config().tn_service;
    if (!cfg.cache_path) return false;
    try {
        return fs_sync.existsSync(cache_file_path(pid));
    } catch {
        return false;
    }
}

async function get_cached(pid) {
    const cfg = app_config().tn_service;
    if (!cfg.cache_path) return null;
    const p = cache_file_path(pid);
    try {
        return await fs.readFile(p);
    } catch (err) {
        /*
         * ENOENT is a cache miss, not an error. Anything else (perm
         * denied, IO error) we log + treat as miss — better to refetch
         * than to fail the request.
         */
        if (err && err.code !== 'ENOENT') {
            log.warn({ event: 'tn_cache_read_failed', pid, err: err.message });
        }
        return null;
    }
}

/*
 * Atomic write: temp file + rename. The temp suffix is random so two
 * concurrent writes (same pid arriving via two concurrent tabs)
 * don't collide on the temp path either.
 */
async function write_cache(pid, buffer) {
    const cfg = app_config().tn_service;
    if (!cfg.cache_path) return;
    try {
        await fs.mkdir(cfg.cache_path, { recursive: true });
    } catch (err) {
        log.warn({ event: 'tn_cache_mkdir_failed', err: err.message });
        return;
    }
    const final_path = cache_file_path(pid);
    const temp_path = `${final_path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.writeFile(temp_path, buffer, { flag: 'wx' });
        await fs.rename(temp_path, final_path);
    } catch (err) {
        /*
         * Best-effort cleanup. Ignore unlink failures (the temp may
         * never have been written) — the main error is what matters.
         */
        await fs.unlink(temp_path).catch(() => {});
        /*
         * Log but don't throw: a cache miss next time is cheaper than
         * a 500 on this request.
         */
        log.warn({ event: 'tn_cache_write_failed', pid, err: err.message });
    }
}

/*
 * Invalidate the disk-cached thumbnail for a single pid. Returns
 * { invalidated: bool } — true if a cache file was actually removed,
 * false if there was nothing to remove. ENOENT is a no-op, not an
 * error: "no cache file" is the desired post-condition either way.
 * Other unlink failures (permission, IO) propagate as throws so the
 * caller can surface them.
 */
async function invalidate_cache(pid) {
    const cfg = app_config().tn_service;
    if (!cfg.cache_path) return { invalidated: false };
    const p = cache_file_path(pid);
    try {
        await fs.unlink(p);
        log.info({ event: 'tn_cache_invalidated', pid });
        return { invalidated: true };
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return { invalidated: false };
        }
        log.warn({ event: 'tn_cache_invalidate_failed', pid, err: err.message });
        throw err;
    }
}

// HTTP fetch (no caching) ---------------------------------------------

function create_client(http = http_default) {
    return {
        is_configured,
        build_endpoint,
        cached_exists,

        /*
         * The bare fetch. Returns a Buffer on 200; throws UpstreamError
         * otherwise. Used by get_thumbnail (cache-aware) and exposed
         * for tests that want to exercise the network path directly.
         */
        async fetch_thumbnail(pid) {
            if (!is_configured()) {
                throw new UpstreamError('TN service is not configured');
            }
            const cfg = app_config().tn_service;
            const url = build_endpoint(pid);
            let res;
            try {
                res = await http.get(url, {
                    responseType: 'arraybuffer',
                    timeout: cfg.timeout_ms,
                    /*
                     * Don't auto-throw on non-2xx; we want to surface
                     * a clean UpstreamError with the actual status.
                     */
                    validateStatus: () => true,
                });
            } catch (err) {
                // Network-level failures (timeout, DNS, TLS) land here.
                log.warn({ event: 'tn_fetch_transport_failed', pid, err: err.message });
                throw new UpstreamError(`TN service fetch failed: ${err.message}`);
            }
            if (res.status !== 200) {
                throw new UpstreamError(`TN service returned HTTP ${res.status}`);
            }
            if (!res.data || res.data.length === 0) {
                throw new UpstreamError('TN service returned empty body');
            }
            /*
             * axios with responseType=arraybuffer gives us an
             * ArrayBuffer-shaped object; normalize to Node Buffer.
             */
            return Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
        },

        /*
         * Cache-first lookup. Returns a Buffer on success, throws
         * UpstreamError on miss + fetch failure.
         */
        async get_thumbnail(pid) {
            const cached = await get_cached(pid);
            if (cached) return cached;
            const buffer = await this.fetch_thumbnail(pid);
            /*
             * Cache best-effort. If the cache write fails we still
             * return the bytes — the caller doesn't care.
             */
            await write_cache(pid, buffer);
            return buffer;
        },
    };
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
module.exports.build_endpoint = build_endpoint;
module.exports.cached_exists = cached_exists;
module.exports.invalidate_cache = invalidate_cache;
// Test seams.
module.exports._get_cached = get_cached;
module.exports._write_cache = write_cache;
module.exports._cache_file_path = cache_file_path;
