'use strict';

/*
 * Handle.net client — talks to the handle server's HTTP JSON API directly.
 *
 * Supersedes the standalone Python handles-service (digitaldu-backend-handles)
 * that ran on libsftp01 and shelled out to `hdl-genericbatch`. That service
 * had two criticals (shell injection via an unvalidated uuid, and batch-file
 * injection carrying full 10176 prefix authority) and reported HTTP 201 on
 * failure, so callers could not tell a real mint from a failed one. Removing
 * the hop deletes all of that rather than sanitizing around it:
 *
 *   - no subprocess, so no shell or batch-file injection surface
 *   - no admin passphrase written to disk per operation
 *   - no cross-host cleartext hop with the API key in a query string
 *   - the handle server's actual error reaches the ingest worker, which is
 *     what decides between retry and INGEST_HALTED
 *
 * Public contract is unchanged so call sites do not move:
 * `is_configured()`, `build_handle_url()`, `create_handle()` and
 * `update_handle()` behave as before, including returning
 * `{ status: 201, handle }` on success — ingester/stages/repository.js
 * gates on exactly that.
 */

const http_default = require('axios');
const app_config = require('../config/app');
const log = require('./log');
const handle_auth_default = require('./handle_auth');
const { UpstreamError } = require('./errors');

/*
 * Handle values carry permission bits as admin-read/admin-write/
 * public-read/public-write. 1110 is what the retired batch client wrote
 * ("2 URL 86400 1110 UTF8 ..."), and matches every existing 10176 handle.
 */
const URL_PERMISSIONS = '1110';
const URL_INDEX = 2;

/*
 * Existing handles under this prefix carry a single value — index 2, type
 * URL — and no per-handle HS_ADMIN; they are administered implicitly by
 * the prefix admin. Reproduce that exactly so new handles stay consistent
 * with the ~2,000 already minted.
 */
function url_value(uuid) {
    const cfg = app_config().handles;
    return {
        index: URL_INDEX,
        type: 'URL',
        data: { format: 'string', value: `${cfg.target}${uuid}` },
        ttl: cfg.ttl,
        permissions: URL_PERMISSIONS,
    };
}

function is_configured() {
    const cfg = app_config().handles;
    return Boolean(
        cfg
        && cfg.admin_url
        && cfg.admin_id
        && cfg.admin_key_path
        && cfg.target
        && cfg.prefix
        && cfg.server
    );
}

function build_handle_url(uuid) {
    const cfg = app_config().handles;
    /*
     * server typically ends with `/`; prefix usually does not. Glue
     * carefully so we never produce a double-slash or missing-slash.
     */
    const server = cfg.server.endsWith('/') ? cfg.server : `${cfg.server}/`;
    const prefix = cfg.prefix.replace(/^\/+|\/+$/g, '');
    return `${server}${prefix}/${uuid}`;
}

function qualified_handle(uuid) {
    const cfg = app_config().handles;
    return `${cfg.prefix.replace(/^\/+|\/+$/g, '')}/${uuid}`;
}

/*
 * The uuid lands in a URL path and in the handle identifier. The old
 * service interpolated it into a shell string and a batch file, which is
 * how a `;` or a newline became remote code execution and prefix-wide
 * handle deletion. Nothing here reaches a shell, but validating at the
 * boundary keeps malformed identifiers out of the handle namespace —
 * 10176/0, 10176/du-test-handle04 and 10176/du-handle-test-0001 all exist
 * today because nothing ever checked.
 */
const UUID_PATTERN =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function assert_valid_uuid(uuid) {
    if (typeof uuid !== 'string' || !UUID_PATTERN.test(uuid)) {
        throw new UpstreamError(`Refusing to mint a handle for malformed uuid: ${uuid}`);
    }
}

function create_client(http = http_default, handle_auth = handle_auth_default) {
    /*
     * Sessions expire server-side and we cannot see when. Rather than
     * track a TTL, treat one 401/403 as "session died" — drop it and
     * retry once with a fresh handshake. A second rejection is a real
     * credential problem and propagates.
     */
    async function authed_request(method, path, body, extra_params = {}) {
        const cfg = app_config().handles;

        async function attempt() {
            const authorization = await handle_auth.authorization(http);
            const base = cfg.admin_url.endsWith('/')
                ? cfg.admin_url.slice(0, -1)
                : cfg.admin_url;
            return http.request({
                method,
                url: `${base}${path}`,
                data: body,
                params: extra_params,
                timeout: cfg.timeout_ms,
                validateStatus: () => true,
                headers: {
                    Authorization: authorization,
                    'Content-Type': 'application/json',
                },
            });
        }

        let res = await attempt();
        if (res.status === 401 || res.status === 403) {
            log.info({ event: 'handle_session_expired_retrying', status: res.status });
            handle_auth.reset_session();
            res = await attempt();
        }
        return res;
    }

    return {
        is_configured,
        build_handle_url,

        /*
         * Mint a handle for `uuid`. Returns { status: 201, handle } when the
         * handle exists afterwards — including when it already existed, since
         * from the caller's point of view "a handle resolves at this URL" is
         * the outcome that matters, and failing an otherwise-good ingest over
         * it would be wrong. The two cases are distinguished in the log, not
         * in the return value.
         */
        async create_handle(uuid) {
            assert_valid_uuid(uuid);
            const handle = qualified_handle(uuid);

            let res;
            try {
                res = await authed_request(
                    'put',
                    `/api/handles/${handle}`,
                    { values: [url_value(uuid)] },
                    { overwrite: false },
                );
            } catch (err) {
                log.warn({ event: 'handle_create_failed', uuid, err: err.message });
                throw new UpstreamError(`Handle create failed: ${err.message}`);
            }

            if (res.status === 201 || res.status === 200) {
                log.info({ event: 'handle_created', uuid, handle });
                return { status: 201, handle: build_handle_url(uuid) };
            }

            /*
             * responseCode 101 is HANDLE ALREADY EXISTS; the server pairs it
             * with HTTP 409 when overwrite=false.
             */
            if (res.status === 409 || (res.data && res.data.responseCode === 101)) {
                log.info({ event: 'handle_already_exists', uuid, handle });
                return { status: 201, handle: build_handle_url(uuid) };
            }

            log.warn({
                event: 'handle_create_unexpected_status',
                uuid,
                status: res.status,
                response_code: res.data && res.data.responseCode,
                message: res.data && res.data.message,
            });
            return { status: res.status, handle: null };
        },

        /*
         * Re-point an existing handle at the current HANDLE_TARGET. Used by
         * the domain retarget (specialcollections -> digitalarchives) and
         * available to staff tooling for repointing a single object.
         *
         * Unlike create this overwrites, but scoped to index 2 — any other
         * values on the handle are left alone.
         */
        async update_handle(uuid) {
            assert_valid_uuid(uuid);
            const handle = qualified_handle(uuid);

            let res;
            try {
                res = await authed_request(
                    'put',
                    `/api/handles/${handle}`,
                    { values: [url_value(uuid)] },
                    { index: URL_INDEX },
                );
            } catch (err) {
                log.warn({ event: 'handle_update_failed', uuid, err: err.message });
                throw new UpstreamError(`Handle update failed: ${err.message}`);
            }

            if (res.status === 200 || res.status === 201) {
                log.info({ event: 'handle_updated', uuid, handle });
                return { status: 201, handle: build_handle_url(uuid) };
            }

            log.warn({
                event: 'handle_update_unexpected_status',
                uuid,
                status: res.status,
                response_code: res.data && res.data.responseCode,
            });
            return { status: res.status, handle: null };
        },

        /*
         * Resolve a handle. Unauthenticated — resolution is public — so this
         * deliberately skips the session handshake. Returns null when the
         * handle does not exist, which is what a reconciliation sweep needs
         * in order to tell a real handle from a phantom.
         */
        async get_handle(uuid) {
            assert_valid_uuid(uuid);
            const cfg = app_config().handles;
            const handle = qualified_handle(uuid);
            const base = cfg.admin_url.endsWith('/')
                ? cfg.admin_url.slice(0, -1)
                : cfg.admin_url;

            let res;
            try {
                res = await http.get(`${base}/api/handles/${handle}`, {
                    timeout: cfg.timeout_ms,
                    validateStatus: () => true,
                });
            } catch (err) {
                throw new UpstreamError(`Handle resolve failed: ${err.message}`);
            }

            if (res.status === 404 || (res.data && res.data.responseCode === 100)) {
                return null;
            }
            if (res.status !== 200) {
                throw new UpstreamError(
                    `Handle resolve returned ${res.status} for ${handle}`
                );
            }
            return res.data;
        },

        /*
         * Remove a handle. Present because the retired service exposed it,
         * but note the reconciliation guidance: an orphaned handle should be
         * re-pointed at a tombstone, not deleted — a persistent identifier
         * already in a citation ought to keep resolving. Reserve this for
         * genuinely junk handles.
         */
        async delete_handle(uuid) {
            assert_valid_uuid(uuid);
            const handle = qualified_handle(uuid);

            let res;
            try {
                res = await authed_request('delete', `/api/handles/${handle}`);
            } catch (err) {
                log.warn({ event: 'handle_delete_failed', uuid, err: err.message });
                throw new UpstreamError(`Handle delete failed: ${err.message}`);
            }

            if (res.status === 200) {
                log.info({ event: 'handle_deleted', uuid, handle });
                return { status: 200, deleted: true };
            }
            if (res.status === 404 || (res.data && res.data.responseCode === 100)) {
                log.info({ event: 'handle_delete_not_found', uuid, handle });
                return { status: 404, deleted: false };
            }

            log.warn({
                event: 'handle_delete_unexpected_status',
                uuid,
                status: res.status,
                response_code: res.data && res.data.responseCode,
            });
            return { status: res.status, deleted: false };
        },
    };
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
module.exports.build_handle_url = build_handle_url;
