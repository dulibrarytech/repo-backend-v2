'use strict';

/*
 * Curation-API client for AIP-store operations.
 * 
 * The Python curation service owns Wasabi credentials and the
 * boto3 upload code (see digitaldu-backend-curation-service_latest/
 * lib/wasabi.py). v2's Stage 6 stays language-agnostic by calling
 * HTTP endpoints rather than re-implementing the upload in Node.
 * 
 * Two endpoints today:
 * 
 *   POST /api/v2/aip/copy-to-wasabi
 *     Body: { aip_uuid, repo_uuid }
 *     Returns: 200 {
 *       ok, bucket, key, bytes, elapsed_ms, error?
 *     }
 *     Long-running — the curation service downloads the AIP from AM
 *     Storage Service and uploads it to Wasabi in one synchronous
 *     call. Stage 6 awaits the response with a generous timeout
 *     (cfg.aip_store.copy_timeout_ms, default 60 min).
 * 
 *     The endpoint is idempotent: a second call for an aip_uuid
 *     whose key already exists in Wasabi at the expected size is a
 *     no-op that still returns ok=true with the existing metadata.
 *     This makes Stage 6 retries safe — a crashed mid-upload can
 *     resume without leaving stale partial objects.
 * 
 *   POST /api/v2/aip/presigned-url
 *     Body: { key, ttl_seconds }
 *     Returns: 200 { ok, url, expires_at, error? }
 *     Mints a short-lived presigned download URL. Used by the
 *     dashboard /aips/:id/download flow — the browser is redirected
 *     to the URL and bytes flow Wasabi → browser directly without
 *     transiting v2 or the curation service.
 * 
 * Auth: X-API-Key header (same shared key as qa_service.js). The
 * header is set via default_headers() so a future rotation to a
 * different scheme is a one-place change.
 */

const http_default = require('axios');
const app_config = require('../../config/app');
const log = require('../../libs/log');
const { UpstreamError } = require('../../libs/errors');

const AIP_PATH = '/api/v2/aip/';

function is_configured() {
    const cfg = app_config().curation_api;
    return Boolean(cfg && cfg.url && cfg.api_key);
}

function build_url(endpoint) {
    const cfg = app_config().curation_api;
    const base = cfg.url.replace(/\/+$/, '');
    return `${base}${AIP_PATH}${endpoint}`;
}

function default_headers() {
    const cfg = app_config().curation_api;
    return {
        'Content-Type': 'application/json',
        'X-API-Key': cfg.api_key,
    };
}

function create_client(http = http_default) {
    return {
        is_configured,

        /*
         * Trigger the AM → Wasabi copy for a single AIP. Synchronous
         * — resolves when the curation service has finished the
         * upload (or hit an error). Caller bounds the wall-clock via
         * `timeout_ms` (typically cfg.aip_store.copy_timeout_ms).
         * 
         * Returns: { status, data } where data shape on success is:
         *   { ok: true, bucket, key, bytes, elapsed_ms }
         * and on a clean failure response:
         *   { ok: false, error: '...' }
         * 
         * Throws UpstreamError on a transport-level failure (timeout,
         * DNS, TLS) — Stage 6 treats that as a retryable error.
         */
        async copy_to_wasabi(aip_uuid, repo_uuid, { timeout_ms } = {}) {
            const cfg = app_config().curation_api;
            const effective_timeout =
                timeout_ms || app_config().aip_store.copy_timeout_ms || cfg.timeout_ms;
            const url = build_url('copy-to-wasabi');
            try {
                const res = await http.post(
                    url,
                    { aip_uuid, repo_uuid },
                    {
                        timeout: effective_timeout,
                        headers: default_headers(),
                        /*
                         * Always pass through — Stage 6 distinguishes
                         * 4xx (terminal-ish: bad UUID, missing file)
                         * from 5xx (retryable) by inspecting res.status.
                         */
                        validateStatus: () => true,
                    }
                );
                return { status: res.status, data: res.data };
            } catch (err) {
                log.warn({
                    event: 'aip_copy_to_wasabi_failed',
                    aip_uuid,
                    repo_uuid,
                    err: err.message,
                });
                throw new UpstreamError(
                    `curation /aip/copy-to-wasabi failed: ${err.message}`
                );
            }
        },

        /*
         * Mint a presigned URL for a Wasabi key. The curation service
         * signs against the same boto3 client that uploaded the
         * file, so the URL is valid for cfg.ttl_seconds and grants
         * GET-only access to exactly that key.
         * 
         * Used by the dashboard's download action — the browser is
         * 302-redirected to the returned URL and pulls the bytes
         * straight from Wasabi.
         * 
         * Returns: { status, data } where data shape on success:
         *   { ok: true, url, expires_at }
         */
        async presigned_url(key, { ttl_seconds } = {}) {
            const cfg = app_config().curation_api;
            const effective_ttl =
                ttl_seconds || app_config().aip_store.presign_ttl_seconds || 900;
            const url = build_url('presigned-url');
            try {
                const res = await http.post(
                    url,
                    { key, ttl_seconds: effective_ttl },
                    {
                        timeout: cfg.timeout_ms,
                        headers: default_headers(),
                        validateStatus: () => true,
                    }
                );
                return { status: res.status, data: res.data };
            } catch (err) {
                log.warn({
                    event: 'aip_presigned_url_failed',
                    key,
                    err: err.message,
                });
                throw new UpstreamError(
                    `curation /aip/presigned-url failed: ${err.message}`
                );
            }
        },
    };
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
