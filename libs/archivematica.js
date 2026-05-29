'use strict';

// Archivematica HTTP client. Ports v1's libs/archivematica.js but
// narrows the surface to the calls the v2 ingest worker actually makes:
//
//   - start_transfer(collection_uuid, package_name)
//   - approve_transfer(transfer_folder)
//   - get_transfer_status(uuid)
//   - get_ingest_status(uuid)
//   - get_dip_path(sip_uuid)          ← storage API; used post-ingest
//   - delete_aip_request({ uuid, delete_reason })  ← storage API; rollback
//   - clear_transfer(uuid) / clear_ingest(uuid)    ← post-success cleanup
//   - ping_api() / ping_storage_api()              ← health endpoints
//
// Differences from v1:
//   1. Functional + factory shape — `create_client(http)` so tests can
//      inject a fake without monkey-patching axios. Matches the
//      pattern in libs/archivesspace.js.
//   2. Returns a structured `{ status, data }` for success cases instead
//      of `data | false | undefined`. Callers can branch on status
//      without re-mapping.
//   3. Throws UpstreamError on transport-level failure (timeout, DNS,
//      TLS). v1 swallowed-and-logged; the worker would then see
//      `undefined` and have no signal to retry. v2 distinguishes a
//      bad upstream response (data + non-2xx) from a dropped call.
//   4. Bounded timeout via app config rather than an env value read
//      per call. Single source of truth.
//
// The Archivematica REST API speaks two dialects:
//   - The "main" dashboard API (transfer / ingest endpoints) auths via
//     ?username= & api_key=  query string.
//   - The Storage Service API (file / space endpoints) auths via
//     Authorization: ApiKey user:key  header.
// Both base URLs need a trailing slash so URL building stays simple —
// the config block enforces that contract documentaionally.

const http_default = require('axios');
const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError } = require('./errors');

function is_configured() {
    const cfg = app_config().archivematica;
    return Boolean(cfg && cfg.api && cfg.username && cfg.api_key);
}

function is_storage_configured() {
    const cfg = app_config().archivematica;
    return Boolean(cfg && cfg.storage_api && cfg.storage_username && cfg.storage_api_key);
}

// Build a query string with main-API username + api_key already glued
// on, so call sites stay readable. Trailing slash on the path part is
// the caller's responsibility (Archivematica is picky about that).
function main_url(path) {
    const cfg = app_config().archivematica;
    const base = cfg.api.replace(/\/+$/, '');
    const sep = path.includes('?') ? '&' : '?';
    return `${base}/${path}${sep}username=${encodeURIComponent(cfg.username)}&api_key=${encodeURIComponent(cfg.api_key)}`;
}

function storage_url(path) {
    const cfg = app_config().archivematica;
    const base = cfg.storage_api.replace(/\/+$/, '');
    const sep = path.includes('?') ? '&' : '?';
    return `${base}/${path}${sep}username=${encodeURIComponent(cfg.storage_username)}&api_key=${encodeURIComponent(cfg.storage_api_key)}`;
}

// `Authorization: ApiKey user:key` header for storage-API calls that
// need to authenticate via header (vs the query-string variant most
// storage endpoints accept both).
function storage_auth_header() {
    const cfg = app_config().archivematica;
    return { Authorization: `ApiKey ${cfg.storage_username}:${cfg.storage_api_key}` };
}

function create_client(http = http_default) {
    return {
        is_configured,
        is_storage_configured,

        // Health probe — pings administration/dips/atom/levels (an
        // endpoint that exists on every AM instance) and returns true
        // on HTTP 200. Used by /health and by the worker's boot self-
        // check to surface AM-down conditions early.
        async ping_api() {
            const cfg = app_config().archivematica;
            const url = main_url('administration/dips/atom/levels/');
            try {
                const res = await http.get(url, {
                    timeout: cfg.timeout_ms,
                    headers: { 'Content-Type': 'application/json' },
                    validateStatus: () => true,
                });
                return res.status === 200;
            } catch (err) {
                log.warn({ event: 'am_ping_failed', err: err.message });
                return false;
            }
        },

        async ping_storage_api() {
            const cfg = app_config().archivematica;
            const url = storage_url('v2/file/');
            try {
                const res = await http.get(url, {
                    timeout: cfg.timeout_ms,
                    headers: { 'Content-Type': 'application/json' },
                    validateStatus: () => true,
                });
                return res.status === 200;
            } catch (err) {
                log.warn({ event: 'am_storage_ping_failed', err: err.message });
                return false;
            }
        },

        // Kicks off a transfer. AM expects the source as base64(
        //   "<source_uuid>:<remote_path>/<collection_uuid>/<package>")
        // and the body as form-encoded `name=…&type=standard&accession=&
        // paths[]=<base64>&rows_ids[]=[""]`. The v1 string was reverse-
        // engineered against AM 1.13; we keep the exact same encoding
        // so a v1 → v2 cutover doesn't change the wire format.
        //
        // Returns `{ status, data }` so the caller can read
        // `data.transfer_id` (UUID assigned by AM) and the status code
        // to confirm 200.
        async start_transfer(collection_uuid, package_name) {
            const cfg = app_config().archivematica;
            const location = `${cfg.transfer_source}:${cfg.sftp_remote_path}/${collection_uuid}/${package_name}`;
            const encoded_location = Buffer.from(location).toString('base64');
            const url = main_url('transfer/start_transfer/');
            const name = `${collection_uuid}_${package_name}_transfer`;
            const body =
                `name=${encodeURIComponent(name)}` +
                `&type=standard` +
                `&accession=` +
                `&paths%5B%5D=${encodeURIComponent(encoded_location)}` +
                `&rows_ids%5B%5D=%5B%22%22%5D`;
            // start_transfer gets the LONG timeout (default 10 min) —
            // AM does a filesystem probe of every staged file before
            // ACKing, and large media (multi-GB .mov / .mp4) can push
            // that probe well past the default 60s timeout_ms. See
            // config/app.js → archivematica.start_transfer_timeout_ms
            // for the env knob.
            const timeout =
                cfg.start_transfer_timeout_ms && cfg.start_transfer_timeout_ms > cfg.timeout_ms
                    ? cfg.start_transfer_timeout_ms
                    : cfg.timeout_ms;
            return _post_form(http, url, body, timeout, 'start_transfer');
        },

        // Returns the list of transfers AM hasn't approved yet. v2 uses
        // it during the APPROVE_TIMEOUT path to confirm the transfer is
        // actually queued before retrying / surfacing the error.
        async get_unapproved_transfer_list() {
            const cfg = app_config().archivematica;
            const url = main_url('transfer/unapproved/');
            return _get_json(http, url, cfg.timeout_ms, 'get_unapproved_transfer_list');
        },

        // Approves a queued transfer so AM will start ingesting it.
        async approve_transfer(transfer_folder) {
            const cfg = app_config().archivematica;
            const url = main_url('transfer/approve');
            const body = `type=standard&directory=${encodeURIComponent(transfer_folder)}`;
            return _post_form(http, url, body, cfg.timeout_ms, 'approve_transfer');
        },

        async get_transfer_status(uuid) {
            const cfg = app_config().archivematica;
            const url = main_url(`transfer/status/${encodeURIComponent(uuid)}/`);
            return _get_json(http, url, cfg.timeout_ms, 'get_transfer_status');
        },

        async get_ingest_status(uuid) {
            const cfg = app_config().archivematica;
            const url = main_url(`ingest/status/${encodeURIComponent(uuid)}/`);
            return _get_json(http, url, cfg.timeout_ms, 'get_ingest_status');
        },

        // Resolves the DIP-store path for a given SIP UUID. AM stores
        // its DIPs at a UUID-derived path inside DuraCloud; we need
        // that path to fetch the METS file. The string-mangling here
        // is a direct port of v1's logic (regex-split UUID on `-`,
        // chunk into 4-char groups, join with `/`, append the folder
        // basename minus the `.7z` extension).
        async get_dip_path(sip_uuid) {
            const cfg = app_config().archivematica;
            const url = storage_url(`v2/file/${encodeURIComponent(sip_uuid)}/`);
            try {
                const res = await http.get(url, {
                    timeout: cfg.timeout_ms,
                    headers: { 'Content-Type': 'application/json' },
                    validateStatus: () => true,
                });
                if (res.status !== 200 || !res.data) {
                    return { status: res.status, data: null, dip_path: null };
                }
                const data = res.data;
                if (!Array.isArray(data.related_packages) || data.related_packages.length === 0) {
                    return { status: res.status, data, dip_path: null };
                }
                const dipuuid_parts = data.related_packages[0].split('/').filter(Boolean);
                const dipuuid = dipuuid_parts[dipuuid_parts.length - 1];
                const path = dipuuid
                    .replace(/-/g, '')
                    .match(/.{1,4}/g)
                    .join('/');
                const folder_parts = (data.current_path || '').split('/');
                const folder = folder_parts[folder_parts.length - 1].replace('.7z', '');
                return { status: res.status, data, dip_path: `${path}/${folder}` };
            } catch (err) {
                log.warn({ event: 'am_get_dip_path_failed', sip_uuid, err: err.message });
                throw new UpstreamError(`Archivematica get_dip_path failed: ${err.message}`);
            }
        },

        // POST a deletion request to the Storage Service. AM responds:
        //   - 202: request submitted, awaiting Storage Service admin
        //          approval in the AM UI. Returns the request id.
        //   - 200 with `message: 'A deletion request already exists for
        //          this AIP.'`: idempotent; treat as success but flag.
        //   - anything else: surface to the caller for halt + audit.
        //
        // `obj` shape: { uuid, delete_reason }
        async delete_aip_request(obj) {
            const cfg = app_config().archivematica;
            const url = storage_url(`v2/file/${encodeURIComponent(obj.uuid)}/delete_aip/`);
            const body = {
                event_reason: obj.delete_reason,
                pipeline: cfg.pipeline,
                user_id: cfg.user_id,
                user_email: cfg.user_email,
            };
            try {
                const res = await http.post(url, body, {
                    timeout: cfg.timeout_ms,
                    headers: { 'Content-Type': 'application/json' },
                    validateStatus: () => true,
                });
                return { status: res.status, data: res.data };
            } catch (err) {
                log.warn({ event: 'am_delete_aip_failed', uuid: obj.uuid, err: err.message });
                throw new UpstreamError(`Archivematica delete_aip_request failed: ${err.message}`);
            }
        },

        // Cleanup helpers — fire-and-forget after a successful pipeline
        // run so AM's queue doesn't grow unbounded with terminal rows.
        // We don't care about the response body, just whether the
        // request landed.
        async clear_transfer(uuid) {
            const cfg = app_config().archivematica;
            const url = main_url(`transfer/${encodeURIComponent(uuid)}/delete/`);
            return _delete(http, url, cfg.timeout_ms, 'clear_transfer');
        },

        async clear_ingest(uuid) {
            const cfg = app_config().archivematica;
            const url = main_url(`ingest/${encodeURIComponent(uuid)}/delete/`);
            return _delete(http, url, cfg.timeout_ms, 'clear_ingest');
        },

        // Storage-usage stats. The Storage Service exposes per-space
        // metrics under v2/space/<uuid>. v2 surfaces these on the
        // /api/ingest/health endpoint for staff visibility.
        async get_dip_storage_usage() {
            const cfg = app_config().archivematica;
            const url = `${cfg.storage_api.replace(/\/+$/, '')}/v2/space/${cfg.storage_dip_uuid || ''}`;
            try {
                const res = await http.get(url, {
                    timeout: cfg.timeout_ms,
                    headers: storage_auth_header(),
                    validateStatus: () => true,
                });
                if (res.status === 200 && res.data) return res.data.used;
                return null;
            } catch (err) {
                log.warn({ event: 'am_dip_usage_failed', err: err.message });
                return null;
            }
        },

        async get_aip_storage_usage() {
            const cfg = app_config().archivematica;
            const url = `${cfg.storage_api.replace(/\/+$/, '')}/v2/space/${cfg.storage_aip_uuid || ''}`;
            try {
                const res = await http.get(url, {
                    timeout: cfg.timeout_ms,
                    headers: storage_auth_header(),
                    validateStatus: () => true,
                });
                if (res.status === 200 && res.data) return res.data.used;
                return null;
            } catch (err) {
                log.warn({ event: 'am_aip_usage_failed', err: err.message });
                return null;
            }
        },
    };
}

// --- internal helpers ------------------------------------------------

async function _get_json(http, url, timeout, op) {
    try {
        const res = await http.get(url, {
            timeout,
            headers: { 'Content-Type': 'application/json' },
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    } catch (err) {
        log.warn({ event: `am_${op}_failed`, err: err.message });
        throw new UpstreamError(`Archivematica ${op} failed: ${err.message}`);
    }
}

async function _post_form(http, url, body, timeout, op) {
    try {
        const res = await http.post(url, body, {
            timeout,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    } catch (err) {
        log.warn({ event: `am_${op}_failed`, err: err.message });
        throw new UpstreamError(`Archivematica ${op} failed: ${err.message}`);
    }
}

async function _delete(http, url, timeout, op) {
    try {
        const res = await http.delete(url, {
            timeout,
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    } catch (err) {
        log.warn({ event: `am_${op}_failed`, err: err.message });
        throw new UpstreamError(`Archivematica ${op} failed: ${err.message}`);
    }
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
module.exports.is_storage_configured = is_storage_configured;
