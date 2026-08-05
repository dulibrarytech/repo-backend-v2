'use strict';

/*
 * Convert-service client. POSTs one {sip_uuid, full_path, object_name,
 * mime_type} payload to DU's TIFF→JPG convert API and returns the HTTP
 * status + body. The remote service authenticates via an `api_key`
 * query parameter (matching the legacy post_tiff_convert.py wire format
 * and the deployed service) — so we never log the URL, only the object.
 * 
 * Shape mirrors libs/handles.js / libs/tn_service.js:
 *   - injectable-http factory so tests can pass a fake axios
 *   - validateStatus:()=>true so a non-2xx comes back as data, not a throw
 *   - throws UpstreamError on transport failure (timeout/DNS/TLS/abort)
 *     so the worker can requeue the row
 * 
 * Pacing + retry are the worker's job, not the client's — a single call
 * here is one HTTP round-trip.
 */

const http_default = require('axios');
const app_config = require('../config/app');
const log = require('../libs/log');
const { UpstreamError } = require('../libs/errors');

function is_configured() {
    const cfg = app_config().convert_service;
    return Boolean(cfg && cfg.url && cfg.api_key);
}

function build_url() {
    const cfg = app_config().convert_service;
    const sep = cfg.url.includes('?') ? '&' : '?';
    return `${cfg.url}${sep}api_key=${encodeURIComponent(cfg.api_key)}`;
}

/*
 * The service's GET /image endpoint, derived from the configured convert
 * URL (…/convert/api/v1/convert/tiff → …/convert/api/v1/image). Returns
 * null when the URL doesn't match the expected shape — verification then
 * reports 'unavailable' rather than failing rows.
 */
function build_image_url(filename) {
    const cfg = app_config().convert_service;
    if (!/\/convert\/tiff\/?$/.test(cfg.url || '')) return null;
    const base = cfg.url.replace(/\/convert\/tiff\/?$/, '/image');
    return (
        `${base}?filename=${encodeURIComponent(filename)}` +
        `&api_key=${encodeURIComponent(cfg.api_key)}`
    );
}

function create_client(http = http_default) {
    return {
        is_configured,

        /*
         * POST one payload. Returns { status, body } for ANY HTTP status.
         * Throws UpstreamError if the request never completed.
         */
        async convert(payload, { signal } = {}) {
            const cfg = app_config().convert_service;
            const url = build_url();
            try {
                const res = await http.post(url, payload, {
                    timeout: cfg.timeout_ms,
                    signal,
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    validateStatus: () => true,
                });
                return { status: res.status, body: res.data };
            } catch (err) {
                // Never log `url` — it carries the api_key.
                log.warn({
                    event: 'convert_post_failed',
                    object: payload && payload.object_name,
                    err: err.message,
                });
                throw new UpstreamError(`Convert API request failed: ${err.message}`);
            }
        },

        /*
         * Probe the service's GET /image endpoint for a derivative, with
         * a 1-byte Range so a good file costs a header exchange, not a
         * download. Classifies the derivative's state:
         *
         *   { outcome: 'ok', bytes }   — real file (200/206; size from
         *                                Content-Range total when ranged)
         *   { outcome: 'empty' }       — exists but 0 bytes (the service
         *                                validates size and 400s
         *                                "File is empty" — the ENOSPC
         *                                signature)
         *   { outcome: 'missing' }     — 404 with the controller's JSON
         *                                shape (conversion not landed)
         *   { outcome: 'unavailable' } — endpoint absent (older service:
         *                                non-JSON 404 / unroutable URL) —
         *                                caller falls back to unverified
         *                                completion rather than failing
         *                                rows it can't check
         *
         * Throws UpstreamError on transport failure (service down).
         */
        async verify_image(filename, { signal } = {}) {
            const cfg = app_config().convert_service;
            const url = build_image_url(filename);
            if (!url) return { outcome: 'unavailable' };
            try {
                const res = await http.get(url, {
                    timeout: cfg.timeout_ms,
                    signal,
                    headers: { Range: 'bytes=0-0', Accept: 'application/json, */*' },
                    responseType: 'arraybuffer',
                    validateStatus: () => true,
                });
                if (res.status === 200 || res.status === 206) {
                    const range = String(res.headers['content-range'] || '');
                    const total = range.includes('/') ? Number(range.split('/').pop()) : NaN;
                    const bytes = Number.isFinite(total)
                        ? total
                        : Number(res.headers['content-length']) || null;
                    return { outcome: 'ok', bytes };
                }
                /*
                 * The controller's error responses are JSON with
                 * error:true; an Express route miss is HTML. Only the
                 * JSON shapes are authoritative about the file.
                 */
                let body = null;
                try {
                    body = JSON.parse(Buffer.from(res.data).toString('utf8'));
                } catch {
                    body = null;
                }
                if (res.status === 400 && body && body.error) {
                    const msgs = []
                        .concat(body.errors || [], body.message || [])
                        .join(' ');
                    /*
                     * "File is empty" is the verdict we act on; any other
                     * 400 is a validation quirk, not a file state.
                     */
                    if (/empty/i.test(msgs)) return { outcome: 'empty' };
                    log.warn({
                        event: 'convert_verify_rejected',
                        object: filename,
                        detail: msgs.slice(0, 200),
                    });
                    return { outcome: 'unavailable' };
                }
                if (res.status === 404 && body && body.error) return { outcome: 'missing' };
                log.warn({
                    event: 'convert_verify_unexpected_status',
                    object: filename,
                    status: res.status,
                });
                return { outcome: 'unavailable' };
            } catch (err) {
                log.warn({
                    event: 'convert_verify_failed',
                    object: filename,
                    err: err.message,
                });
                throw new UpstreamError(`Convert verify request failed: ${err.message}`);
            }
        },
    };
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
/*
 * Shared with the images gateway (images/gateway.js) so both derive the
 * service's GET /image endpoint from the one CONVERT_SERVICE setting.
 */
module.exports.build_image_url = build_image_url;
