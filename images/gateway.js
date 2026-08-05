'use strict';

/*
 * Derivative-image gateway: the ONE endpoint the public frontend and
 * the Cantaloupe delegate call for JPG derivatives.
 *
 *   GET <path>/api/v2/image/:filename      (X-API-Key / ?api_key=)
 *
 * The bytes live on the curation host's derivative share; this gateway
 * streams them from the curation service's GET /image endpoint —
 * derived from the same CONVERT_SERVICE setting the convert worker
 * uses, so there is exactly one place that knows where derivatives
 * come from (see repo/DERIVATIVE_PIPELINE_PLAN.md).
 *
 * Behavior:
 *   - api-key gated (IMAGES_API_KEY): raw filename access bypasses the
 *     published-only protection the frontend gets from the public
 *     index, so the key keeps unpublished derivatives non-enumerable.
 *     Constant-time comparison; 503 when the key is unconfigured
 *     (fail closed, loudly).
 *   - Range passthrough both ways — Cantaloupe probes with 1-byte
 *     ranges and the viewer streams partials.
 *   - Upstream 404 AND 400-empty both surface as 404: to a viewer a
 *     broken derivative should look absent, not like a server fault.
 *     Upstream 5xx/transport → 502.
 *   - The curation api key is attached server-side and never exposed.
 */

const crypto = require('node:crypto');
const http_default = require('axios');
const app_config = require('../config/app');
const log = require('../libs/log');
const convert_client = require('../convert/client');

// Plain .jpg basename only — no traversal, no other extensions.
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.jpg$/;

// Upstream headers forwarded to the consumer verbatim.
const PASSTHROUGH_HEADERS = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
];

function is_configured() {
    const cfg = app_config();
    return Boolean(
        cfg.images && cfg.images.api_key && convert_client.build_image_url('probe.jpg')
    );
}

// Constant-time key check against IMAGES_API_KEY.
function key_matches(provided, expected) {
    if (typeof provided !== 'string' || provided.length === 0) return false;
    if (provided.length > 256) return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function create_gateway({ http = http_default } = {}) {
    async function serve_image(req, res) {
        const cfg = app_config();
        const expected = cfg.images && cfg.images.api_key;
        if (!expected) {
            log.warn({ event: 'images_gateway_unconfigured', msg: 'IMAGES_API_KEY not set' });
            return res
                .status(503)
                .json({ message: 'Image service is not configured' });
        }

        const provided = req.get('x-api-key') || req.query.api_key || '';
        if (!key_matches(String(provided), expected)) {
            return res.status(401).json({ message: 'Unauthorized request' });
        }

        const filename = String(req.params.filename || '');
        if (!FILENAME_RE.test(filename)) {
            return res.status(400).json({ message: 'Invalid filename' });
        }

        const upstream_url = convert_client.build_image_url(filename);
        if (!upstream_url) {
            log.warn({
                event: 'images_gateway_no_upstream',
                msg: 'CONVERT_SERVICE is not set to a …/convert/tiff URL',
            });
            return res
                .status(503)
                .json({ message: 'Image service is not configured' });
        }

        let upstream;
        try {
            const headers = {};
            if (req.headers.range) headers.Range = req.headers.range;
            upstream = await http.get(upstream_url, {
                responseType: 'stream',
                timeout: cfg.convert_service.timeout_ms,
                headers,
                validateStatus: () => true,
            });
        } catch (err) {
            // Never log upstream_url — it carries the curation api key.
            log.warn({ event: 'images_gateway_fetch_failed', filename, err: err.message });
            return res.status(502).json({ message: 'Image source unavailable' });
        }

        const status = upstream.status;
        if (status === 200 || status === 206) {
            res.status(status);
            for (const name of PASSTHROUGH_HEADERS) {
                if (upstream.headers[name] !== undefined) {
                    res.set(name, upstream.headers[name]);
                }
            }
            upstream.data.on('error', (err) => {
                log.warn({ event: 'images_gateway_stream_error', filename, err: err.message });
                res.destroy();
            });
            return upstream.data.pipe(res);
        }

        // Drain non-2xx upstream bodies so sockets are released.
        if (upstream.data && typeof upstream.data.resume === 'function') {
            upstream.data.resume();
        }
        if (status === 404 || status === 400) {
            // Missing and 0-byte both read as "not found" to a viewer.
            return res.status(404).json({ message: 'Resource not found' });
        }
        log.warn({ event: 'images_gateway_upstream_error', filename, status });
        return res.status(502).json({ message: 'Image source unavailable' });
    }

    return { serve_image };
}

module.exports = {
    create_gateway,
    is_configured,
    _key_matches: key_matches,
    _FILENAME_RE: FILENAME_RE,
};
