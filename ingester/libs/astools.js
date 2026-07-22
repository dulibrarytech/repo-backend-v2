'use strict';

/*
 * ASTools client. The v2 curation-service (Python) exposes a set of
 * `/api/v1/astools/*` endpoints that wrap the legacy AStools scripts
 * for staff workflows:
 *
 *   - GET  /workspace                          — list folders WITHOUT uri.txt
 *   - GET  /processed                          — list folders WITH uri.txt
 *   - GET  /workspace/packages?batch=          — list packages in a folder
 *   - GET  /workspace/uri?folder=&package=     — read a package's uri.txt
 *   - POST /make-digital-objects               — body: {folder, ...}
 *   - POST /revert-to-make-digital-objects     — body: {folder}
 *
 * All responses are wrapped: `{ result: <payload>, errors: [string] }`.
 * `result` is a list for listing endpoints and a nested object for
 * /workspace/uri (`{ uris: [...], files: [...] }`).
 *
 * Two parameter quirks worth memorizing:
 *   - /workspace/packages uses `batch=` (not `folder=`)
 *   - /workspace/uri uses `folder=` + `package=`
 *   - POST endpoints take JSON bodies, not query strings.
 *
 * Auth scheme: `X-API-Key` header. Reads url + key from the
 * shared `curation_api` config block — same host as the QA client
 * (ingester/libs/qa_service.js) since both surfaces live in the
 * same Python curation-service process.
 *
 * All methods return `{ status, data }` so callers can branch on
 * HTTP status without re-mapping. Transport-level failures raise
 * UpstreamError.
 */

const http_default = require('axios');
const app_config = require('../../config/app');
const log = require('../../libs/log');
const { UpstreamError } = require('../../libs/errors');

const ASTOOLS_PATH = '/api/v1/astools/';

function is_configured() {
    const cfg = app_config().curation_api;
    return Boolean(cfg && cfg.url && cfg.api_key);
}

/*
 * Normalize the base URL by stripping any trailing slashes AND a
 * trailing `/api/v1/astools/` if present. Both shapes are accepted
 * in env files so operators can paste the value verbatim from the
 * legacy ingest-service .env (which includes the path tail) without
 * us double-appending below.
 */
function _normalize_base(url) {
    const trimmed = url.replace(/\/+$/, '');
    return trimmed.replace(/\/api\/v1\/astools$/, '');
}

function build_url(endpoint, query = {}) {
    const cfg = app_config().curation_api;
    const base = _normalize_base(cfg.url);
    const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    return qs ? `${base}${ASTOOLS_PATH}${endpoint}?${qs}` : `${base}${ASTOOLS_PATH}${endpoint}`;
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
         * List collection folders in 001-ready/ that DON'T have uri.txt
         * yet (i.e. awaiting Make Digital Objects). Response shape:
         *   { result: [<folder name>, ...], errors: [string] }
         */
        async list_workspace() {
            return _get(http, build_url('workspace'), 'list_workspace');
        },

        /*
         * List collection folders in 001-ready/ that DO have uri.txt
         * (i.e. MDO has run; ready for QA or Packaging). Response
         * shape mirrors list_workspace.
         */
        async list_processed() {
            return _get(http, build_url('processed'), 'list_processed');
        },

        /*
         * List the package names inside a single collection folder.
         * The curation-service uses the `batch=` query param here, NOT
         * `folder=`. Response: `{ result: [<package name>, ...], errors: [] }`.
         */
        async list_packages(folder) {
            return _get(http, build_url('workspace/packages', { batch: folder }), 'list_packages');
        },

        /*
         * Read the uri.txt for a single package. Response shape:
         *   { result: { uris: ['<aspace URI>'], files: ['uri.txt', ...] }, errors: [] }
         * The `uris` array is empty when uri.txt is missing; callers
         * should treat `uris[0]` as the canonical URI.
         */
        async get_uri(folder, pkg) {
            return _get(http, build_url('workspace/uri', { folder, package: pkg }), 'get_uri');
        },

        /*
         * Long-running MDO script. Curation-service expects the JSON
         * wrapped in a `data` envelope: `{ data: { folder, ... } }`.
         * This is inconsistent with revert (which takes a flat
         * `{ folder }`) but matches `_validate_make_digital_objects_request`
         * in the curation-service's routes/astools.py. The validator
         * returns "Invalid request format: missing or invalid data
         * object" when the envelope is missing — exactly the error
         * an unwrapped POST produces.
         * 
         * Minimum required field inside data: `folder`. Optional:
         * is_kaltura, packages, files, no_caption, no_publish, test,
         * verbose — all default sensibly server-side.
         */
        async make_digital_objects(folder, opts = {}) {
            const cfg = app_config().curation_api;
            const body = { data: { folder, ...opts } };
            return _post(
                http,
                build_url('make-digital-objects'),
                body,
                'make_digital_objects',
                cfg.mdo_timeout_ms
            );
        },

        /*
         * Revert: removes uri.txt from every package in the folder.
         * JSON body, same shape: `{ folder }`. Idempotent on the
         * server (already-empty folders are reported as not_present).
         */
        async revert_to_mdo(folder) {
            return _post(
                http,
                build_url('revert-to-make-digital-objects'),
                { folder },
                'revert_to_mdo'
            );
        },
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
        log.warn({ event: `astools_${op}_failed`, err: err.message });
        throw new UpstreamError(`ASTools ${op} failed: ${err.message}`);
    }
}

async function _post(http, url, body, op, override_timeout) {
    const cfg = app_config().curation_api;
    const timeout = override_timeout || cfg.timeout_ms;
    try {
        const res = await http.post(url, body, {
            timeout,
            headers: default_headers(),
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    } catch (err) {
        log.warn({ event: `astools_${op}_failed`, err: err.message });
        throw new UpstreamError(`ASTools ${op} failed: ${err.message}`);
    }
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
