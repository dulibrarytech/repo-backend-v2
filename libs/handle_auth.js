'use strict';

/*
 * Handle.net HTTP JSON API authentication (HS_PUBKEY session handshake).
 *
 * ---------------------------------------------------------------------
 * NOT CURRENTLY WIRED IN. Retained deliberately.
 *
 * The DU handle server does not serve the session endpoints — /api/sessions
 * and /api/sessions/this both return a bare 403 — so this handshake has
 * nowhere to go, and writes run through libs/handle_writer.js on the native
 * protocol instead. If the handle administrator enables those endpoints,
 * this module is the replacement for handle_writer: point
 * libs/handles.js `create_client()` back at it and the Java helper can be
 * dropped. Working the handshake out cost real effort; deleting it would
 * mean paying that twice.
 *
 * Note it expects a PKCS#8 PEM (converted from admpriv.bin with
 * hdl-convert-key), whereas the Java helper reads Handle's binary format
 * directly. Only the HTTP path needs the conversion.
 * ---------------------------------------------------------------------
 *
 * Replaces the out-of-process `hdl-genericbatch` invocation that the
 * retired Python handles-service used. The DU site record for prefix
 * 10176 advertises an admin-capable HTTP interface on port 8000, so
 * create/delete can be done as authenticated REST calls with no shell,
 * no batch file, and no passphrase written to disk.
 *
 * The handshake, per the Handle 9 technical manual:
 *
 *   1. POST /api/sessions              -> { sessionId, nonce }
 *   2. sign(server_nonce || cnonce) with the prefix admin private key
 *   3. POST /api/sessions/this         with the signature
 *   4. subsequent calls carry Authorization: Handle sessionId="..."
 *
 * The private key must be converted out of Handle's own binary format
 * (admpriv.bin is PBKDF2+AES-CBC wrapped) into PKCS#8 PEM once, offline:
 *
 *   handle-client-9.3.1/bin/hdl-convert-key -crypt admpriv.bin \
 *       -format pem -o admpriv.pem
 *
 * Keep the PEM encrypted (-crypt) and hand the same passphrase to this
 * module via HANDLE_ADMIN_PASSPHRASE. Node loads ENCRYPTED PRIVATE KEY
 * PEMs natively, so the key is never on disk in the clear.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

const http_default = require('axios');
const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError } = require('./errors');

/*
 * Sessions are reusable across many operations. Cache the id and drop it
 * on any 401/403 so the next call re-authenticates rather than failing.
 */
let cached_session = null;

function reset_session() {
    cached_session = null;
}

/*
 * Load and decrypt the admin private key. Cached after first use — the
 * PBKDF2 unwrap Node performs on an encrypted PKCS#8 PEM is not free and
 * the key never changes within a process.
 */
let cached_key = null;

function load_private_key() {
    if (cached_key) return cached_key;

    const cfg = app_config().handles;
    let pem;
    try {
        pem = fs.readFileSync(cfg.admin_key_path);
    } catch (err) {
        throw new UpstreamError(
            `Cannot read handle admin key at ${cfg.admin_key_path}: ${err.message}`
        );
    }

    try {
        cached_key = crypto.createPrivateKey(
            cfg.admin_passphrase
                ? { key: pem, passphrase: cfg.admin_passphrase }
                : pem
        );
    } catch (err) {
        throw new UpstreamError(
            'Cannot load handle admin key. It must be PKCS#8 PEM — convert '
            + `admpriv.bin with hdl-convert-key. (${err.message})`
        );
    }

    return cached_key;
}

/*
 * Handle signs with SHA-256 over DSA or RSA depending on the key that
 * backs the HS_PUBKEY value. Derive it from the key itself rather than
 * hardcoding, so a future key rotation to RSA needs no code change.
 */
function signature_algorithm(key) {
    switch (key.asymmetricKeyType) {
        case 'dsa': return { node: 'SHA256', handle: 'SHA256' };
        case 'rsa': return { node: 'RSA-SHA256', handle: 'SHA256' };
        default:
            throw new UpstreamError(
                `Unsupported handle admin key type: ${key.asymmetricKeyType}`
            );
    }
}

function admin_url(path) {
    const cfg = app_config().handles;
    const base = cfg.admin_url.endsWith('/') ? cfg.admin_url.slice(0, -1) : cfg.admin_url;
    return `${base}${path}`;
}

/*
 * Build the Authorization header for step 3. The Handle server expects
 * comma-separated key="value" pairs; `id` is the admin index and handle
 * that owns the HS_PUBKEY the signature must verify against.
 */
function auth_header(parts) {
    const pairs = Object.entries(parts)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ');
    return `Handle version="0", ${pairs}`;
}

/*
 * Full handshake. Returns a sessionId usable as
 * `Authorization: Handle version="0", sessionId="<id>"`.
 */
async function authenticate(http = http_default) {
    const cfg = app_config().handles;
    const key = load_private_key();
    const alg = signature_algorithm(key);

    /* 1. open a session and collect the server's nonce */
    let start;
    try {
        start = await http.post(admin_url('/api/sessions'), '', {
            timeout: cfg.timeout_ms,
            validateStatus: () => true,
            headers: { Authorization: 'Handle version="0"' },
        });
    } catch (err) {
        throw new UpstreamError(`Handle session open failed: ${err.message}`);
    }

    if (start.status !== 200 || !start.data || !start.data.sessionId) {
        throw new UpstreamError(
            `Handle session open returned ${start.status} `
            + `(${JSON.stringify(start.data || '').slice(0, 200)})`
        );
    }

    const session_id = start.data.sessionId;
    const server_nonce = Buffer.from(start.data.nonce, 'base64');

    /*
     * 2. sign server_nonce || cnonce. The client nonce must be fresh per
     * handshake — it is what stops a captured signature being replayed.
     */
    const cnonce = crypto.randomBytes(16);
    const signature = crypto
        .createSign(alg.node)
        .update(Buffer.concat([server_nonce, cnonce]))
        .sign(key);

    /* 3. present the signature against this session */
    let verify;
    try {
        verify = await http.post(admin_url('/api/sessions/this'), '', {
            timeout: cfg.timeout_ms,
            validateStatus: () => true,
            headers: {
                Authorization: auth_header({
                    sessionId: session_id,
                    id: cfg.admin_id,
                    type: 'HS_PUBKEY',
                    cnonce: cnonce.toString('base64'),
                    alg: alg.handle,
                    signature: signature.toString('base64'),
                }),
            },
        });
    } catch (err) {
        throw new UpstreamError(`Handle session auth failed: ${err.message}`);
    }

    if (verify.status !== 200 || !verify.data || verify.data.authenticated !== true) {
        throw new UpstreamError(
            `Handle authentication rejected (${verify.status}): `
            + `${JSON.stringify(verify.data || '').slice(0, 200)}`
        );
    }

    log.info({ event: 'handle_session_authenticated', id: cfg.admin_id });
    return session_id;
}

/*
 * Return a live session, authenticating only when there isn't one.
 */
async function session(http = http_default) {
    if (cached_session) return cached_session;
    cached_session = await authenticate(http);
    return cached_session;
}

/*
 * Authorization header for an ordinary authenticated request.
 */
async function authorization(http = http_default) {
    const id = await session(http);
    return auth_header({ sessionId: id });
}

module.exports = {
    authenticate,
    authorization,
    session,
    reset_session,
    load_private_key,
    signature_algorithm,
    _admin_url: admin_url,
};
