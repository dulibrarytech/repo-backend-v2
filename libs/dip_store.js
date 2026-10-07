'use strict';

/*
 * DIP store client: the Wasabi copy of every DIP's served files
 * (DIP_STORE_LOCATION), written by the curation service and only read
 * here. See repo/notes/WASABI_DIP_SERVING_FINDINGS.md.
 *
 * is_configured, fetch_text, mets_path and ping mirror libs/duracloud.js,
 * so a call site switches with a one-line change. head, get_stream and
 * pipe_to are the gateway's and the thumbnail chains' reads; `s3` is an
 * optional client of the caller's own (create_client), otherwise calls
 * share this module's.
 *
 * `path` is a stored DB path relative to the location prefix, e.g.
 * `<dip folder>/thumbnails/<uuid>.jpg`, and must be a string (Express 5
 * hands a `*key` wildcard over as an array; the route joins it).
 *
 * Statuses: 200 found (`data` is a stream for GETs); 404 missing; 403
 * denied, or the existence check failed (key_exists). A timeout, a
 * transport failure, a caller's abort and a 2xx the SDK can't decode
 * throw UpstreamError, which the central handler answers with 502: a
 * route that needs another status (the gateway's 500) catches it.
 *
 * DIP_STORE_TIMEOUT_MS bounds the whole wait for response headers,
 * retries included; fetch_text gives its small body the same again. A
 * streamed body is never limited: the frontend would cache a cut-off
 * file as complete. A 200 body holds one of the client's MAX_SOCKETS
 * connections until it is read to the end or destroyed, so the caller
 * aborts on its client's disconnect and pipes or destroys `data`;
 * pipe_to does that.
 *
 * The reader key is folder-scoped (s3:GetObject on <bucket>/dip-store/*,
 * s3:ListBucket only under an s3:prefix condition), so HeadBucket is
 * denied (ping lists instead) and a missing key may answer 403 rather
 * than 404; key_exists tells the two apart by listing the exact key.
 */

const { pipeline } = require('node:stream');
const {
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    S3Client,
} = require('@aws-sdk/client-s3');

const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError, ValidationError } = require('./errors');

/*
 * Connections per client (the SDK's default): every open download holds
 * one, so the gateway builds its own client rather than sharing this
 * module's with the thumbnails, the METS reads and the Services probe.
 */
const MAX_SOCKETS = 50;

let cached = null;
let client_override = null;

function cfg() {
    return app_config().dip_store;
}

function is_configured() {
    const c = cfg();
    return Boolean(
        c && c.location && c.endpoint && c.region && c.access_key_id && c.secret_access_key
    );
}

// DIP_GATEWAY_ENABLED and configured: the thumbnail chains read the store.
function is_serving() {
    return Boolean(cfg().gateway_enabled) && is_configured();
}

/*
 * Split `s3://<bucket>/<prefix>/` into { bucket, prefix } (prefix '' or
 * ending in '/'), with the same rules as curation's wasabi._parse_bucket.
 * Any scheme but s3:// is refused rather than taken as a bucket name.
 */
function parse_location(raw) {
    let s = String(raw || '').trim();
    if (!s) throw new Error('DIP_STORE_LOCATION is not configured');
    const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (scheme) {
        if (scheme[1].toLowerCase() !== 's3') {
            throw new Error(
                `DIP_STORE_LOCATION must be s3://<bucket>/<prefix>/ or a bucket name (got ${scheme[1]}://)`
            );
        }
        s = s.slice(scheme[0].length);
    }
    s = s.replace(/^\/+|\/+$/g, '');
    if (!s) throw new Error('DIP_STORE_LOCATION has no bucket name');
    const slash = s.indexOf('/');
    if (slash === -1) return { bucket: s, prefix: '' };
    return {
        bucket: s.slice(0, slash),
        prefix: `${s.slice(slash + 1).replace(/^\/+|\/+$/g, '')}/`,
    };
}

/*
 * The S3 key for a stored path: the location prefix plus the path minus
 * leading slashes. `.` and `..` segments are refused so nothing between
 * here and the bucket can normalize a path out of the prefix; a
 * non-string is refused rather than coerced to a comma-joined key.
 */
function key_for(path) {
    if (path === undefined || path === null || path === '') {
        throw new ValidationError('A DIP path is required');
    }
    if (typeof path !== 'string') {
        throw new ValidationError('A DIP path must be a string');
    }
    const { prefix } = parse_location(cfg().location);
    const tail = path.replace(/^\/+/, '');
    if (!tail) throw new ValidationError('A DIP path is required');
    if (tail.split('/').some((seg) => seg === '.' || seg === '..')) {
        throw new ValidationError('A DIP path may not contain . or .. segments');
    }
    return prefix + tail;
}

// The METS sits at the top of the DIP folder; same as libs/duracloud.js.
function mets_path(sip_uuid, dip_path) {
    if (!sip_uuid || !dip_path) {
        throw new Error('mets_path requires sip_uuid + dip_path');
    }
    return `${dip_path}/METS.${sip_uuid}.xml`;
}

// S3Client options for a dip_store config block.
function client_options(c) {
    return {
        endpoint: c.endpoint,
        region: c.region,
        credentials: {
            accessKeyId: c.access_key_id,
            secretAccessKey: c.secret_access_key,
        },
        // The SDK's newer checksum defaults are rejected by some S3-compatible stores.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        /*
         * Retries cover quick failures (a stale keep-alive socket, a
         * 5xx); deadline() caps the total wait, so silence isn't retried.
         */
        maxAttempts: 3,
        /*
         * requestTimeout is per attempt and only an error with
         * throwOnRequestTimeout. No socketTimeout: it would count a body
         * paused by a slow downstream client as idle.
         */
        requestHandler: {
            requestTimeout: c.timeout_ms,
            throwOnRequestTimeout: true,
            connectionTimeout: Math.min(c.timeout_ms, 5000),
            httpAgent: { maxSockets: MAX_SOCKETS },
            httpsAgent: { maxSockets: MAX_SOCKETS },
        },
    };
}

// A client with its own pool of MAX_SOCKETS connections (the gateway's).
function create_client(c = cfg()) {
    return new S3Client(client_options(c));
}

// One shared client per config object, so a config reset gives a fresh client.
function client() {
    if (client_override) return client_override;
    const c = cfg();
    if (!cached || cached.config !== c) {
        cached = { config: c, client: create_client(c) };
    }
    return cached.client;
}

function http_status(err) {
    return err && err.$metadata ? err.$metadata.httpStatusCode : undefined;
}

// Response metadata as lower-case HTTP header names, for pass-through.
function headers_from(out) {
    const h = {};
    if (out.ContentType) h['content-type'] = out.ContentType;
    if (out.ContentLength !== undefined) h['content-length'] = String(out.ContentLength);
    if (out.ContentEncoding) h['content-encoding'] = out.ContentEncoding;
    if (out.ContentDisposition) h['content-disposition'] = out.ContentDisposition;
    if (out.ETag) h.etag = out.ETag;
    if (out.LastModified) h['last-modified'] = new Date(out.LastModified).toUTCString();
    if (out.CacheControl) h['cache-control'] = out.CacheControl;
    return h;
}

/*
 * One call's time limit, retries included: the SDK's requestTimeout is
 * per attempt. Its signal also follows the caller's. Cleared once the
 * headers are in; fetch_text re-arms it for the body.
 */
function deadline(signal, ms) {
    const controller = new AbortController();
    let timer = null;
    const state = {
        ms,
        timed_out: false,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        arm() {
            clearTimeout(timer);
            timer = setTimeout(() => {
                state.timed_out = true;
                controller.abort();
            }, ms);
        },
        clear() {
            clearTimeout(timer);
            timer = null;
        },
    };
    state.arm();
    return state;
}

/*
 * After a failure: a deadline that fired or a caller that aborted ends
 * the call with an UpstreamError. A caller going away isn't logged as an
 * upstream problem.
 */
function throw_if_ended(dl, signal, phase, path) {
    if (dl.timed_out) {
        log.warn({ event: 'dip_store_timeout', phase, path, timeout_ms: dl.ms });
        throw new UpstreamError(`DIP store ${phase} timed out after ${dl.ms} ms`);
    }
    if (signal && signal.aborted) {
        throw new UpstreamError(`DIP store ${phase} aborted by the caller`);
    }
}

/*
 * A 2xx the SDK couldn't decode arrives as an error carrying the raw
 * response, whose unread body would hold a connection for good.
 */
function release_body(err) {
    const body = err && err.$response && err.$response.body;
    if (body && typeof body.destroy === 'function') body.destroy();
}

/*
 * Does exactly this key exist? A MaxKeys=1 listing of it as a prefix
 * (which the folder-scoped policy allows; the exact key sorts first).
 * null when the listing itself fails, so the caller keeps its status.
 */
async function key_exists(bucket, key, signal, s3) {
    try {
        const out = await s3.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }),
            { abortSignal: signal }
        );
        return (out.Contents || []).some((o) => o.Key === key);
    } catch (err) {
        if (!signal || !signal.aborted) {
            log.warn({ event: 'dip_store_exists_check_failed', key, err: err.message });
        }
        return null;
    }
}

/*
 * One HEAD or GET against one key, mapped to { status, data, headers }.
 * HTTP errors become statuses (a 403 confirmed as missing becomes 404);
 * a timeout, an abort, a transport failure or an undecodable 2xx throw.
 */
async function send_one(kind, bucket, key, dl, signal, s3) {
    const input = { Bucket: bucket, Key: key };
    const command = kind === 'head' ? new HeadObjectCommand(input) : new GetObjectCommand(input);
    try {
        const out = await s3.send(command, { abortSignal: dl.signal });
        const status = (out.$metadata && out.$metadata.httpStatusCode) || 200;
        return { status, data: kind === 'get' ? out.Body : null, headers: headers_from(out) };
    } catch (err) {
        throw_if_ended(dl, signal, 'request', key);
        const status = http_status(err);
        if (!status || status < 400) {
            release_body(err);
            log.warn({ event: 'dip_store_request_failed', key, status, err: err.message });
            throw new UpstreamError(`DIP store request failed: ${err.message}`);
        }
        if (status === 403) {
            const exists = await key_exists(bucket, key, dl.signal, s3);
            if (exists === null) throw_if_ended(dl, signal, 'request', key);
            if (exists === false) return { status: 404, data: null, headers: {} };
        }
        return { status, data: null, headers: {} };
    }
}

// A request under its deadline; `dl` is returned so fetch_text can re-arm it.
async function request(kind, path, { signal, s3 } = {}) {
    if (!is_configured()) {
        throw new UpstreamError('DIP store is not configured');
    }
    const { bucket } = parse_location(cfg().location);
    const key = key_for(path);
    const dl = deadline(signal, cfg().timeout_ms);
    try {
        return { res: await send_one(kind, bucket, key, dl, signal, s3 || client()), dl };
    } finally {
        dl.clear();
    }
}

async function head(path, { signal, s3 } = {}) {
    return (await request('head', path, { signal, s3 })).res;
}

async function get_stream(path, { signal, s3 } = {}) {
    return (await request('get', path, { signal, s3 })).res;
}

// The client of an HTTP response has gone, or the response is over.
function gone(res) {
    return res.destroyed || res.writableEnded;
}

/*
 * GET `path` and pipe it into `res`, an HTTP response. The abort follows
 * `res` closing, wired before the request goes out, so a client that
 * leaves at any point (before the call included) releases the
 * connection. On a 200, on_200(headers) runs before the first byte; the
 * body then streams with no time limit, and a mid-body failure destroys
 * `res`. Any other status is returned with nothing written. Throws like
 * get_stream; a client that has already left counts as an abort.
 */
async function pipe_to(res, path, { on_200, s3 } = {}) {
    const aborted = () => new UpstreamError('DIP store request aborted by the caller');
    if (gone(res)) throw aborted();
    const controller = new AbortController();
    let upstream_error = null;
    let client_left = false;
    const on_close = () => {
        /*
         * `res` also closes when pipeline destroys it after an upstream
         * failure; that one is logged below, a client leaving is not.
         */
        if (!upstream_error) client_left = true;
        controller.abort();
    };
    res.once('close', on_close);
    let out;
    try {
        out = await get_stream(path, { signal: controller.signal, s3 });
    } catch (err) {
        res.off('close', on_close);
        throw err;
    }
    const release = () => {
        res.off('close', on_close);
        if (out.data && typeof out.data.destroy === 'function') out.data.destroy();
    };
    if (out.status !== 200 || !out.data) {
        release();
        return out.status;
    }
    if (gone(res)) {
        release();
        throw aborted();
    }
    out.data.once('error', (err) => {
        upstream_error = err;
    });
    try {
        if (on_200) on_200(out.headers);
        pipeline(out.data, res, (err) => {
            res.off('close', on_close);
            if (err && !client_left) {
                log.warn({ event: 'dip_store_stream_failed', path, err: err.message });
            }
        });
    } catch (err) {
        release();
        throw new UpstreamError(`DIP store stream failed: ${err.message}`);
    }
    return 200;
}

/*
 * Read a text resource (the METS) by stored path: `data` is the UTF-8
 * body on a 200, '' otherwise. The body read gets its own
 * DIP_STORE_TIMEOUT_MS, so a stalled download can't hold the worker.
 */
async function fetch_text(path, { signal } = {}) {
    const { res, dl } = await request('get', path, { signal });
    if (res.status !== 200 || !res.data) {
        return { status: res.status, data: '', headers: res.headers };
    }
    dl.arm();
    try {
        const data = await res.data.transformToString('utf-8');
        return { status: 200, data, headers: res.headers };
    } catch (err) {
        throw_if_ended(dl, signal, 'read', path);
        log.warn({ event: 'dip_store_text_read_failed', path, err: err.message });
        throw new UpstreamError(`DIP store read failed: ${err.message}`);
    } finally {
        dl.clear();
    }
}

/*
 * Services Health probe: list one key under the prefix and HEAD it, so
 * a green card means the key can list and read. An empty folder is
 * healthy. Bounded by DIP_STORE_TIMEOUT_MS in total; never throws.
 */
async function ping() {
    if (!is_configured()) return false;
    const dl = deadline(null, cfg().timeout_ms);
    try {
        const { bucket, prefix } = parse_location(cfg().location);
        const out = await client().send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }),
            { abortSignal: dl.signal }
        );
        const first = (out.Contents || [])[0];
        if (first && first.Key) {
            await client().send(new HeadObjectCommand({ Bucket: bucket, Key: first.Key }), {
                abortSignal: dl.signal,
            });
        }
        return true;
    } catch (err) {
        log.warn({ event: 'dip_store_ping_failed', err: err.message, timed_out: dl.timed_out });
        return false;
    } finally {
        dl.clear();
    }
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
    is_configured,
    is_serving,
    parse_location,
    key_for,
    mets_path,
    head,
    get_stream,
    pipe_to,
    fetch_text,
    ping,
    create_client,
    MAX_SOCKETS,
    _client_options: client_options,
    _set_client,
    _reset,
};
