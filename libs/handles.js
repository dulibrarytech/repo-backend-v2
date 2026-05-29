'use strict';

// Handle service client. DU's Handle.net front-end accepts POST to
// create a new handle and PUT to refresh / re-point an existing one.
// Both return 201 with no useful body — the handle URL is fully
// determined by `server + prefix + uuid`, so we synthesize it locally
// on a successful response.
//
// Differences from v1 (libs/handles.js):
//   - Functional + injectable-http factory shape.
//   - Throws UpstreamError on transport errors instead of returning
//     false. The worker needs the distinction between "service said no"
//     and "couldn't even reach the service" to decide whether the row
//     should retry or halt with INGEST_HALTED.
//   - Returns { status, handle } on success so the caller has both the
//     HTTP code and the built URL.

const http_default = require('axios');
const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError } = require('./errors');

function is_configured() {
    const cfg = app_config().handles;
    return Boolean(cfg && cfg.service && cfg.prefix && cfg.server && cfg.api_key);
}

function build_handle_url(uuid) {
    const cfg = app_config().handles;
    // server typically ends with `/`; prefix usually does not. Glue
    // carefully so we never produce a double-slash or missing-slash.
    const server = cfg.server.endsWith('/') ? cfg.server : `${cfg.server}/`;
    const prefix = cfg.prefix.replace(/^\/+|\/+$/g, '');
    return `${server}${prefix}/${uuid}`;
}

function service_url(uuid) {
    const cfg = app_config().handles;
    const sep = cfg.service.includes('?') ? '&' : '?';
    return `${cfg.service}${sep}uuid=${encodeURIComponent(uuid)}&api_key=${encodeURIComponent(cfg.api_key)}`;
}

function create_client(http = http_default) {
    return {
        is_configured,
        build_handle_url,

        // Create a fresh handle for `uuid`. Returns the constructed
        // public URL on HTTP 201. On any other status returns
        // { status, handle: null } so the caller can log and decide.
        async create_handle(uuid) {
            const cfg = app_config().handles;
            const url = service_url(uuid);
            try {
                const res = await http.post(url, '', {
                    timeout: cfg.timeout_ms,
                    validateStatus: () => true,
                });
                if (res.status === 201) {
                    return { status: res.status, handle: build_handle_url(uuid) };
                }
                log.warn({ event: 'handle_create_unexpected_status', uuid, status: res.status });
                return { status: res.status, handle: null };
            } catch (err) {
                log.warn({ event: 'handle_create_failed', uuid, err: err.message });
                throw new UpstreamError(`Handle create failed: ${err.message}`);
            }
        },

        // Refresh / update an existing handle. The Handle service
        // documents this as 'idempotent — safe to call on a missing
        // handle' (it creates one), but we still surface non-201s so
        // the worker can flag drift.
        async update_handle(uuid) {
            const cfg = app_config().handles;
            const url = service_url(uuid);
            try {
                const res = await http.put(url, '', {
                    timeout: cfg.timeout_ms,
                    validateStatus: () => true,
                });
                if (res.status === 201) {
                    return { status: res.status, handle: build_handle_url(uuid) };
                }
                log.warn({ event: 'handle_update_unexpected_status', uuid, status: res.status });
                return { status: res.status, handle: null };
            } catch (err) {
                log.warn({ event: 'handle_update_failed', uuid, err: err.message });
                throw new UpstreamError(`Handle update failed: ${err.message}`);
            }
        },
    };
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
module.exports.build_handle_url = build_handle_url;
