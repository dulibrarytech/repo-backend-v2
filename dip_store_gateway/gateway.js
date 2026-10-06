'use strict';

/*
 * DIP store gateway: answers the public frontend the way DuraCloud did,
 * from the Wasabi DIP store (plan P2, the serving cutover).
 *
 *   GET  <path>/api/v2/dip-store/<dip folder>/objects|thumbnails/<file>
 *   HEAD <the same>
 *
 * The frontend switches over by changing its REPOSITORY_* env values only:
 * it sends Basic credentials (DIP_GATEWAY_USER / DIP_GATEWAY_PASSWORD) and
 * reads the stored path back as the URL. nginx also admits only the
 * frontend host.
 *
 * Statuses, matched to the frontend, whose cache purge keeps a cached file
 * on exactly 200 or 500 and deletes it on anything else:
 *   200  found. GET streams the whole body; a Range header is ignored.
 *   404  missing, or not a DIP file path. Also the answer to anyone but
 *        the frontend while the gateway is switched off.
 *   401  missing or wrong credentials.
 *   500  anything else: a policy 403, a timeout, a transport failure, the
 *        store or the credential not configured, or the frontend (its
 *        credential presented) reaching a switched-off gateway, which is
 *        a misrouted frontend, not a missing file. Never 502, the central
 *        error handler's answer for an UpstreamError.
 *
 * The gateway has its own S3 client: every open download holds one of a
 * client's connections, and these must not use up the ones the
 * thumbnails, the METS reads and the Services probe need.
 */

const crypto = require('node:crypto');
const app_config = require('../config/app');
const log = require('../libs/log');
const dip_store = require('../libs/dip_store');

/*
 * <eight 4-hex-digit segments>/<package folder>/objects|thumbnails/<file>:
 * the shape of every served file in the DIP store. Nothing else is
 * served: no listing, no METS.
 */
const PATH_RE =
    /^[0-9a-f]{4}(?:\/[0-9a-f]{4}){7}\/[^/]{1,250}\/(?:objects|thumbnails)\/[^/]{1,250}$/i;

const PASSTHROUGH = [
    'content-type',
    'content-length',
    'content-encoding',
    'content-disposition',
    'etag',
    'last-modified',
];

let client_override = null;
let cached = null;

// The gateway's own client, rebuilt when the config object changes.
function s3() {
    if (client_override) return client_override;
    const c = app_config().dip_store;
    if (!cached || cached.config !== c) {
        cached = { config: c, client: dip_store.create_client(c) };
    }
    return cached.client;
}

/*
 * Constant-time string comparison. Both sides are hashed first, so the
 * time taken reveals neither the length nor the content of the
 * credential.
 */
function safe_equal(a, b) {
    const digest = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();
    return crypto.timingSafeEqual(digest(a), digest(b));
}

/*
 * Basic credentials from the Authorization header. Both halves are always
 * compared, each in constant time for equal lengths.
 */
function credentials_match(header, user, password) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || '');
    if (!m) return false;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) return false;
    const user_ok = safe_equal(decoded.slice(0, colon), user);
    const password_ok = safe_equal(decoded.slice(colon + 1), password);
    return user_ok && password_ok;
}

// The client went away; nothing can be written any more.
function gone(res) {
    return res.destroyed || !res.socket || res.socket.destroyed;
}

function unavailable(res, event, path, message) {
    log.warn({ event, path, err: message });
    if (!res.headersSent && !gone(res)) {
        res.status(500).json({ message: 'DIP store unavailable' });
    }
}

/*
 * Upstream headers verbatim (res.setHeader, not res.set, which would add
 * a charset to text types), plus the one that keeps compression off.
 */
function set_headers(res, headers) {
    for (const name of PASSTHROUGH) {
        if (headers[name] !== undefined) res.setHeader(name, headers[name]);
    }
    // The frontend caches the body byte for byte: nothing may re-encode it.
    res.setHeader('Cache-Control', 'no-transform');
}

function create_gateway() {
    /*
     * The checks every request passes before the store is asked. Returns
     * the stored path, or null once it has answered.
     */
    function admit(req, res) {
        const c = app_config().dip_store;
        const configured = Boolean(c.gateway_user && c.gateway_password);
        const authorized =
            configured &&
            credentials_match(req.get('authorization'), c.gateway_user, c.gateway_password);
        if (!c.gateway_enabled) {
            /*
             * The frontend reads a 404 as "file missing" and its purge
             * then deletes the cached copy. A request carrying its
             * credential is the frontend pointed at a switched-off
             * gateway: a 500 keeps its cache. Everyone else gets nothing.
             */
            if (authorized) {
                unavailable(
                    res,
                    'dip_gateway_disabled',
                    null,
                    'DIP_GATEWAY_ENABLED is off, but the frontend is pointed here'
                );
            } else {
                res.status(404).json({ message: 'Resource not found' });
            }
            return null;
        }
        if (!configured) {
            unavailable(
                res,
                'dip_gateway_unconfigured',
                null,
                'DIP_GATEWAY_USER / DIP_GATEWAY_PASSWORD not set'
            );
            return null;
        }
        if (!authorized) {
            res.set('WWW-Authenticate', 'Basic realm="dip-store"');
            res.status(401).json({ message: 'Unauthorized request' });
            return null;
        }
        /*
         * Express 5 hands the `*key` wildcard over as decoded segments;
         * the store takes the joined string. The router splits on the
         * literal '/' before decoding, so a segment can carry an encoded
         * slash ("2508%2F.."): refuse those, and check the dots on the
         * joined path, which is what key_for sees.
         */
        const segments = [].concat(req.params.key || []);
        const path = segments.join('/');
        if (
            segments.some((s) => s.includes('/')) ||
            !PATH_RE.test(path) ||
            path.split('/').some((s) => s === '.' || s === '..')
        ) {
            res.status(404).json({ message: 'Resource not found' });
            return null;
        }
        return path;
    }

    async function head(req, res) {
        const path = admit(req, res);
        if (path === null) return;
        const controller = new AbortController();
        const on_close = () => controller.abort();
        res.once('close', on_close);
        try {
            const out = await dip_store.head(path, { signal: controller.signal, s3: s3() });
            if (out.status === 200) {
                res.status(200);
                set_headers(res, out.headers);
                res.end();
                return;
            }
            if (out.status === 404) {
                res.status(404).end();
                return;
            }
            unavailable(res, 'dip_gateway_upstream_status', path, `status ${out.status}`);
        } catch (err) {
            if (controller.signal.aborted) return;
            unavailable(res, 'dip_gateway_head_failed', path, err.message);
        } finally {
            res.off('close', on_close);
        }
    }

    async function get(req, res) {
        const path = admit(req, res);
        if (path === null) return;
        let status;
        try {
            status = await dip_store.pipe_to(res, path, {
                s3: s3(),
                on_200: (headers) => {
                    res.status(200);
                    set_headers(res, headers);
                },
            });
        } catch (err) {
            if (gone(res)) return;
            unavailable(res, 'dip_gateway_get_failed', path, err.message);
            return;
        }
        if (status === 200) return;
        if (status === 404) {
            res.status(404).json({ message: 'Resource not found' });
            return;
        }
        unavailable(res, 'dip_gateway_upstream_status', path, `status ${status}`);
    }

    return { head, get };
}

// Test-only — never call from app code.
function _set_client(fake) {
    client_override = fake;
}

// Test-only — never call from app code.
function _reset() {
    client_override = null;
    cached = null;
}

module.exports = {
    create_gateway,
    PATH_RE,
    _credentials_match: credentials_match,
    _set_client,
    _reset,
};
