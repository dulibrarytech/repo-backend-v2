'use strict';

/*
 * DIP store client: the Wasabi access copy of every DIP.
 *
 * Archivematica writes DIPs to DuraCloud Preserve; the curation service
 * copies each one's served files to Wasabi (DIP_STORE_LOCATION, e.g.
 * s3://library-repository/dip-store/), and repov2 reads only that copy.
 * See repo/notes/WASABI_DIP_SERVING_FINDINGS.md.
 *
 * Where the two overlap, the exports mirror libs/duracloud.js, so a call
 * site can switch with a one-line change:
 *
 *   is_configured()                      → boolean
 *   fetch_text(path, { signal })         → { status, data, headers }
 *   mets_path(sip_uuid, dip_path)        → stored path of the DIP's METS
 *   ping()                               → boolean, never throws
 *
 * plus:
 *
 *   key_for(path)                        → the S3 key for a stored path
 *   head(path, { signal, s3 })           → { status, data: null, headers }
 *   get_stream(path, { signal, s3 })     → { status, data, headers }
 *   pipe_to(res, path, { on_200, s3 })   → upstream status; pipes a 200
 *   create_client()                      → a new S3Client with its own pool
 *   is_serving()                         → DIP_GATEWAY_ENABLED and configured
 *
 * `s3` is an optional client of the caller's own (from create_client);
 * without it, calls share this module's client.
 *
 * `path` is a stored DB path, relative to the location prefix, e.g.
 * `<dip folder>/objects/<file>` or `<dip folder>/thumbnails/<uuid>.jpg`.
 * It must be a string: Express 5 hands a `*key` wildcard over as an
 * array of segments, which the route joins with '/' first.
 *
 * Status semantics: 200 = found (`data` is a readable stream for GETs),
 * 404 = missing, 403 = the policy denied the key, or the check of
 * whether it exists failed (see key_exists). Transport failures (DNS,
 * TLS, a timeout, a caller's abort) and a 2xx the SDK can't decode
 * throw UpstreamError, as libs/duracloud.js does. The central error
 * handler answers an UpstreamError with 502; a route that must answer
 * something else (the gateway: 500) catches it itself.
 *
 * Timeouts: DIP_STORE_TIMEOUT_MS bounds the whole wait for the response
 * headers, retries included. Retries cover the quick failures (a stale
 * keep-alive socket, a 5xx); a store that stays silent is not tried
 * again. Nothing here limits a streamed body (the frontend would cache
 * a cut-off file as complete); fetch_text, which buffers a small text
 * body, gives the body the same budget again.
 *
 * Owning a 200 from get_stream: `data` holds one of this client's
 * MAX_SOCKETS connections until it is read to the end or destroyed, and
 * nothing here ends a body that stalls. The caller must therefore
 *   - pass a `signal` that aborts when its own client goes away, wired
 *     up BEFORE awaiting get_stream (aborting destroys the connection), and
 *   - pipe `data` and handle its 'error' event, or destroy it when it
 *     decides not to send it.
 * pipe_to does all of that for an HTTP response; prefer it.
 * head, fetch_text and ping share the pool, so leaked bodies eventually
 * fail every call with a connection timeout while Wasabi is healthy.
 *
 * The reader key is scoped to the dip-store/ folder: s3:GetObject on
 * <bucket>/dip-store/*, and s3:ListBucket only under an s3:prefix
 * condition. Two consequences:
 *   - HeadBucket carries no prefix, so the condition denies it. ping()
 *     lists the prefix instead, then HEADs the key it got back.
 *   - S3 may answer a missing key with 403 rather than 404, because the
 *     conditional ListBucket grant doesn't cover a plain GET. A 403 is
 *     therefore confirmed by listing the exact key: absent → 404,
 *     present → 403.
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
 * Connections per client: the SDK's default, made explicit because every
 * open download holds one (see the header). A public gateway should
 * build its own client, so its downloads can't starve the thumbnails,
 * the METS reads and the Services probe.
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

/*
 * Has serving switched to the DIP store (DIP_GATEWAY_ENABLED, plan P2)?
 * From then on the thumbnail chains read it instead of DuraCloud.
 */
function is_serving() {
    return Boolean(cfg().gateway_enabled) && is_configured();
}

/*
 * Split `s3://<bucket>/<prefix>/` into { bucket, prefix }. The prefix is
 * '' or ends in '/'. Same rules as the curation service's
 * wasabi._parse_bucket, so both services read the setting the same way;
 * any scheme other than s3:// (an https URL pasted in) is refused rather
 * than taken as a bucket name.
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
 * The S3 key for a stored path: the location prefix plus the path, with
 * leading slashes removed. `.` and `..` segments are refused so a path
 * can never be normalized out of the prefix by anything between here and
 * the bucket. Anything but a string is refused too: String() would turn
 * an array into a comma-joined key that quietly answers 404.
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

/*
 * Conventional METS location inside a DIP folder (the slash-chunked UUID
 * folder AM's get_dip_path returns): a sibling of objects/ and
 * thumbnails/. Same as libs/duracloud.js mets_path.
 */
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
        /*
         * Newer SDK defaults add request/response checksum behavior that
         * some S3-compatible services reject. Only where an operation
         * requires it.
         */
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        /*
         * Retries are for the quick failures (a stale keep-alive socket,
         * a 5xx). The per-call deadline below bounds the whole wait for
         * headers at timeout_ms, so a silent store is never tried three
         * times over.
         */
        maxAttempts: 3,
        /*
         * requestTimeout bounds one attempt's wait for response headers;
         * the SDK only logs it unless throwOnRequestTimeout is set.
         * Nothing here bounds a body once it streams: the SDK's
         * socketTimeout counts a stream paused by a slow downstream
         * client as idle, so it would cut healthy transfers short. A
         * streaming caller handles body stalls itself (abortSignal).
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

/*
 * A new client, with its own pool of MAX_SOCKETS connections. For a
 * caller whose open downloads must not starve everyone else (the
 * gateway); pass it back as `s3`.
 */
function create_client(c = cfg()) {
    return new S3Client(client_options(c));
}

/*
 * One S3 client per config object. app_config() returns the same object
 * until a reload, so tests that reset config also get a fresh client.
 */
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
 * One call's time limit. The SDK's requestTimeout is per attempt, so
 * with retries a silent store would cost three of them; this bounds the
 * whole wait for the response headers at `ms`, retries included. Its
 * signal also follows the caller's own signal. The caller clears it once
 * the headers are in, and fetch_text re-arms it for the body.
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
 * After a failure: the deadline fired, or the caller aborted. Either
 * ends the call with an UpstreamError. A caller going away (a browser
 * cancelling a thumbnail, the worker stopping) is not an upstream
 * problem, so it is not logged as one.
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
 * A 2xx the SDK could not decode (a header it can't parse) arrives as
 * an error that still carries the raw response; its body was never
 * read, and would hold a connection for good.
 */
function release_body(err) {
    const body = err && err.$response && err.$response.body;
    if (body && typeof body.destroy === 'function') body.destroy();
}

/*
 * Does exactly this key exist? Lists it as a prefix with MaxKeys=1, which
 * the folder-scoped policy allows; the exact key sorts before any longer
 * key that shares it. Returns true/false, or null when the listing itself
 * fails, so the caller keeps whatever status it had.
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

/*
 * A request with its deadline. The deadline is cleared once the headers
 * are in (or the call failed); the returned `dl` lets fetch_text re-arm
 * it for the body.
 */
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
 * GET `path` and pipe it into `res`, an HTTP response: the safe way to
 * own a 200 (see the header). The abort is wired to `res` closing before
 * the request goes out, so a client that leaves at any point, before the
 * call included, releases the connection. On a 200, on_200(headers) runs
 * before the first byte (set the status and headers there), and the body
 * then streams with no time limit; a failure mid-body destroys `res` and
 * is logged. Any other status is returned with nothing written to `res`.
 * Throws like get_stream; a client that has already left is an
 * UpstreamError "aborted by the caller", as during the request.
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
 * Read a text resource (the METS) by stored path. On a 200, `data` is the
 * body as a UTF-8 string; on any other status it is ''. The body read
 * gets its own DIP_STORE_TIMEOUT_MS, so a download that stalls after the
 * headers fails instead of holding the ingest worker.
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
 * Reachability + credential probe for the Services Health page: list one
 * key under the prefix, then HEAD the key it returned, so the card proves
 * the key can read, not only list. An empty folder still counts as
 * reachable. Bounded by DIP_STORE_TIMEOUT_MS in total, retries included.
 * Returns a boolean and never throws, like duracloud.ping().
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
