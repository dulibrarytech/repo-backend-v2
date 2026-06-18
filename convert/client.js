'use strict';

// Convert-service client. POSTs one {sip_uuid, full_path, object_name,
// mime_type} payload to DU's TIFF→JPG convert API and returns the HTTP
// status + body. The remote service authenticates via an `api_key`
// query parameter (matching the legacy post_tiff_convert.py wire format
// and the deployed service) — so we never log the URL, only the object.
//
// Shape mirrors libs/handles.js / libs/tn_service.js:
//   - injectable-http factory so tests can pass a fake axios
//   - validateStatus:()=>true so a non-2xx comes back as data, not a throw
//   - throws UpstreamError on transport failure (timeout/DNS/TLS/abort)
//     so the worker can requeue the row
//
// Pacing + retry are the worker's job, not the client's — a single call
// here is one HTTP round-trip.

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

function create_client(http = http_default) {
    return {
        is_configured,

        // POST one payload. Returns { status, body } for ANY HTTP status.
        // Throws UpstreamError if the request never completed.
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
    };
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
