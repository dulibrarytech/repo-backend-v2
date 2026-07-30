'use strict';

/*
 * Batch-archive browser client. Thin HTTP wrapper over the curation
 * service's read-only /api/v2/archive/* blueprint, which lists the
 * Wasabi batch archive (the retired 003-ingested folders' replacement
 * — repo/WASABI_ARCHIVE_BROWSER_PLAN.md) and mints presigned download
 * URLs:
 *
 *   GET  /collections
 *   GET  /collections/<c>/packages?token=
 *   GET  /collections/<c>/packages/<p>/files?token=
 *   POST /download-url               body {key, ttl_seconds?}
 *
 * Same conventions as aip_store_client: X-API-Key from the shared
 * `curation_api` config block, `{status, data}` returns with
 * validateStatus pass-through so callers branch on HTTP status, and
 * UpstreamError on transport-level failure.
 *
 * Read-only by construction — the blueprint has no mutating
 * endpoints, so nothing this client can do changes the archive.
 */

const http_default = require('axios');
const app_config = require('../../config/app');
const log = require('../../libs/log');
const { UpstreamError } = require('../../libs/errors');

const ARCHIVE_PATH = '/api/v2/archive/';

function is_configured() {
    const cfg = app_config().curation_api;
    return Boolean(cfg && cfg.url && cfg.api_key);
}

function build_url(endpoint, query = {}) {
    const cfg = app_config().curation_api;
    const base = cfg.url.replace(/\/+$/, '');
    const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    const path = `${base}${ARCHIVE_PATH}${endpoint}`;
    return qs ? `${path}?${qs}` : path;
}

function default_headers() {
    const cfg = app_config().curation_api;
    return {
        'Content-Type': 'application/json',
        'X-API-Key': cfg.api_key,
    };
}

async function _get(http, url, op) {
    const cfg = app_config().curation_api;
    try {
        const res = await http.get(url, {
            timeout: cfg.timeout_ms,
            headers: default_headers(),
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    } catch (err) {
        log.warn({ event: `archive_${op}_failed`, err: err.message });
        throw new UpstreamError(`curation /archive/${op} failed: ${err.message}`);
    }
}

function create_client(http = http_default) {
    return {
        is_configured,

        /* All collection folder names. `{result: {collections: [...]}}` */
        async list_collections() {
            return _get(http, build_url('collections'), 'collections');
        },

        /*
         * One page of package names in a collection.
         * `{result: {packages: [...], next_token}}`
         */
        async list_packages(collection, { token, q } = {}) {
            /*
             * `q` = server-side S3 prefix search (2026-07-30): matches
             * package names starting with q, bucket-side. Without it
             * the dashboard could only filter the loaded page — a
             * fresh backup in a 4,000-package migrated collection
             * looked missing when it was pages deep.
             */
            return _get(
                http,
                build_url(`collections/${encodeURIComponent(collection)}/packages`, { token, q }),
                'packages'
            );
        },

        /*
         * One page of files (+ any nested folder names) in a package.
         * `{result: {files: [{name,key,size,last_modified}], folders, next_token}}`
         */
        async list_files(collection, pkg, { token } = {}) {
            return _get(
                http,
                build_url(
                    `collections/${encodeURIComponent(collection)}/packages/` +
                        `${encodeURIComponent(pkg)}/files`,
                    { token }
                ),
                'files'
            );
        },

        /*
         * Presigned GET URL for one object. `{ok, url, expires_at}`
         * on 200; the caller must check `data.ok` — mint failures come
         * back 200 with ok=false (same posture as the AIP client).
         */
        async download_url(key, { ttl_seconds } = {}) {
            const cfg = app_config().curation_api;
            const url = build_url('download-url');
            try {
                const res = await http.post(
                    url,
                    ttl_seconds ? { key, ttl_seconds } : { key },
                    {
                        timeout: cfg.timeout_ms,
                        headers: default_headers(),
                        validateStatus: () => true,
                    }
                );
                return { status: res.status, data: res.data };
            } catch (err) {
                log.warn({ event: 'archive_download_url_failed', key, err: err.message });
                throw new UpstreamError(`curation /archive/download-url failed: ${err.message}`);
            }
        },
    };
}

const default_client = create_client();

module.exports = {
    ...default_client,
    create_client,
};
