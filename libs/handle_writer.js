'use strict';

/*
 * Write transport for libs/handles.js — drives the DuHandleTool Java helper.
 *
 * Reads (resolution) go over the handle server's HTTP JSON API straight from
 * Node. Writes cannot: that server exposes a reachable write handler on port
 * 8000 but serves no authentication mechanism (/api/sessions is a bare 403,
 * HS_SECKEY Basic auth is off, no WWW-Authenticate challenge), so an
 * unauthenticated PUT returns RC_AUTHENTICATION_NEEDED with no way to satisfy
 * it. Admin operations are only available on the native binary protocol on
 * port 2641, so the write path delegates to the official client library via a
 * short-lived subprocess. See repo/HANDLES_SERVICE_REMEDIATION_PLAN.md.
 *
 * The credential is passed on the helper's STDIN — never in argv, where `ps`
 * would expose it, and never written to a file. Nothing is interpolated into
 * a shell: spawn() is given an argument array.
 *
 * If the handle administrator later enables the session endpoints, this module
 * is the only thing that needs replacing — libs/handles.js talks to it through
 * a two-method interface.
 */

const { spawn } = require('node:child_process');

const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError } = require('./errors');

/*
 * Handle protocol response codes (net.handle.hdllib.AbstractMessage), mapped
 * to the HTTP-ish statuses libs/handles.js already branches on. Keeping that
 * vocabulary means the calling code is identical whether writes go over HTTP
 * or through the helper.
 */
const RC_SUCCESS = 1;
const RC_HANDLE_NOT_FOUND = 100;
const RC_HANDLE_ALREADY_EXISTS = 101;

function status_for(response_code) {
    switch (response_code) {
        case RC_SUCCESS: return 200;
        case RC_HANDLE_NOT_FOUND: return 404;
        case RC_HANDLE_ALREADY_EXISTS: return 409;
        default: return 502;
    }
}

/*
 * HANDLE_ADMIN_ID is "<index>:<handle>", e.g. "300:0.NA/10176". The helper
 * wants those as separate fields.
 */
function split_admin_id(admin_id) {
    const match = /^(\d+):(.+)$/.exec(admin_id || '');
    if (!match) {
        throw new UpstreamError(
            `HANDLE_ADMIN_ID must look like "<index>:<handle>" (got "${admin_id}")`
        );
    }
    return { index: Number.parseInt(match[1], 10), handle: match[2] };
}

function run_helper(payload, cfg) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            cfg.java_bin,
            ['-cp', cfg.helper_classpath, 'DuHandleTool'],
            { stdio: ['pipe', 'pipe', 'pipe'] },
        );

        let stdout = '';
        let stderr = '';
        let settled = false;

        /*
         * The helper's own network calls have no timeout of their own, so
         * this is the only bound on how long a mint can hang the worker.
         */
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new UpstreamError('Handle helper timed out'));
        }, cfg.timeout_ms);

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new UpstreamError(
                `Cannot run handle helper (${cfg.java_bin}): ${err.message}`
            ));
        });

        child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            const text = stdout.trim();
            if (!text) {
                reject(new UpstreamError(
                    `Handle helper produced no output${stderr ? `: ${stderr.trim()}` : ''}`
                ));
                return;
            }
            try {
                resolve(JSON.parse(text));
            } catch {
                reject(new UpstreamError(
                    `Handle helper returned unparseable output: ${text.slice(0, 300)}`
                ));
            }
        });

        /*
         * Credential travels here, not in argv.
         */
        child.stdin.on('error', () => { /* surfaced via 'error'/'close' above */ });
        child.stdin.end(JSON.stringify(payload));
    });
}

/*
 * Perform one write. `op` is create | modify | delete. Returns the same
 * { status, data: { responseCode, message } } shape the HTTP path returned,
 * so libs/handles.js branches on it unchanged.
 */
async function write(op, uuid, { index, url } = {}) {
    const cfg = app_config().handles;
    const admin = split_admin_id(cfg.admin_id);

    const payload = {
        op,
        prefix: cfg.prefix.replace(/^\/+|\/+$/g, ''),
        suffix: uuid,
        adminHandle: admin.handle,
        adminIndex: admin.index,
        keyPath: cfg.admin_key_path,
        passphrase: cfg.admin_passphrase || null,
    };

    if (op === 'create' || op === 'modify') {
        payload.url = url;
        payload.index = index;
        payload.ttl = cfg.ttl;
        payload.permissions = '1110';
    }

    const result = await run_helper(payload, cfg);
    const response_code = typeof result.responseCode === 'number'
        ? result.responseCode
        : -1;

    if (!result.ok) {
        log.warn({
            event: 'handle_helper_failed',
            op,
            uuid,
            response_code,
            message: result.message,
        });
    }

    return {
        status: status_for(response_code),
        data: { responseCode: response_code, message: result.message },
    };
}

/*
 * Authenticate without writing anything — resolves the admin handle with
 * credentials attached. Used by scripts/verify_handle_auth.js.
 */
async function check() {
    const cfg = app_config().handles;
    const admin = split_admin_id(cfg.admin_id);

    return run_helper({
        op: 'check',
        prefix: cfg.prefix.replace(/^\/+|\/+$/g, ''),
        adminHandle: admin.handle,
        adminIndex: admin.index,
        keyPath: cfg.admin_key_path,
        passphrase: cfg.admin_passphrase || null,
    }, cfg);
}

module.exports = { write, check, split_admin_id, status_for };
