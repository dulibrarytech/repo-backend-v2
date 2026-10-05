'use strict';

/*
 * DIP store client: the Wasabi access copy of every DIP.
 *
 * Archivematica writes DIPs to DuraCloud Preserve; the curation service
 * copies each one to Wasabi (DIP_STORE_LOCATION, e.g.
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
 *   head(path, { signal })               → { status, data: null, headers }
 *   get_stream(path, { signal })         → { status, data, headers }
 *
 * Thumbnails use get_stream too: the caller pipes `data` on a 200 and
 * shows the placeholder on any other status.
 *
 * `path` is a stored DB path, relative to the location prefix, e.g.
 * `<dip folder>/objects/<file>` or `<dip folder>/thumbnails/<uuid>.jpg`.
 *
 * Status semantics: 200 = found (`data` is a readable stream for GETs),
 * 404 = missing, 403 = the key exists but the policy denies it.
 * Transport failures (DNS, TLS, timeout, abort) throw UpstreamError, as
 * libs/duracloud.js does.
 *
 * The reader key is scoped to the dip-store/ folder: s3:GetObject on
 * <bucket>/dip-store/*, and s3:ListBucket only under an s3:prefix
 * condition. Two consequences:
 *   - HeadBucket carries no prefix, so the condition denies it. ping()
 *     lists the prefix instead.
 *   - S3 may answer a missing key with 403 rather than 404, because the
 *     conditional ListBucket grant doesn't cover a plain GET. A 403 is
 *     therefore confirmed by listing the exact key: absent → 404,
 *     present → 403.
 */

const {
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    S3Client,
} = require('@aws-sdk/client-s3');

const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError, ValidationError } = require('./errors');

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
 * Split `s3://<bucket>/<prefix>/` into { bucket, prefix }. The prefix is
 * '' or ends in '/'. Same rules as the curation service's
 * wasabi._parse_bucket, so both services read the setting the same way.
 */
function parse_location(raw) {
    let s = String(raw || '').trim();
    if (!s) throw new Error('DIP_STORE_LOCATION is not configured');
    if (s.startsWith('s3://')) s = s.slice('s3://'.length);
    s = s.replace(/^\/+|\/+$/g, '');
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
 * the bucket.
 */
function key_for(path) {
    const { prefix } = parse_location(cfg().location);
    const tail = String(path || '').replace(/^\/+/, '');
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
        maxAttempts: 3,
        /*
         * requestTimeout bounds the wait for response headers; the SDK
         * only logs it unless throwOnRequestTimeout is set. Nothing here
         * bounds a body once it streams: the SDK's socketTimeout counts a
         * stream paused by a slow downstream client as idle, so it would
         * cut healthy transfers short. A streaming caller handles body
         * stalls itself (abortSignal).
         */
        requestHandler: {
            requestTimeout: c.timeout_ms,
            throwOnRequestTimeout: true,
            connectionTimeout: Math.min(c.timeout_ms, 5000),
        },
    };
}

/*
 * One S3 client per config object. app_config() returns the same object
 * until a reload, so tests that reset config also get a fresh client.
 */
function client() {
    if (client_override) return client_override;
    const c = cfg();
    if (!cached || cached.config !== c) {
        cached = { config: c, client: new S3Client(client_options(c)) };
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
    if (out.ETag) h.etag = out.ETag;
    if (out.LastModified) h['last-modified'] = new Date(out.LastModified).toUTCString();
    if (out.CacheControl) h['cache-control'] = out.CacheControl;
    return h;
}

/*
 * Does exactly this key exist? Lists it as a prefix with MaxKeys=1, which
 * the folder-scoped policy allows; the exact key sorts before any longer
 * key that shares it. Returns true/false, or null when the listing itself
 * fails, so the caller keeps whatever status it had.
 */
async function key_exists(bucket, key, signal) {
    try {
        const out = await client().send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }),
            { abortSignal: signal }
        );
        return (out.Contents || []).some((o) => o.Key === key);
    } catch (err) {
        log.warn({ event: 'dip_store_exists_check_failed', key, err: err.message });
        return null;
    }
}

/*
 * One HEAD or GET against one key, mapped to { status, data, headers }.
 * HTTP errors become statuses (a 403 confirmed as missing becomes 404);
 * only transport failures throw.
 */
async function send_one(kind, bucket, key, { signal } = {}) {
    const input = { Bucket: bucket, Key: key };
    const command = kind === 'head' ? new HeadObjectCommand(input) : new GetObjectCommand(input);
    try {
        const out = await client().send(command, { abortSignal: signal });
        const status = (out.$metadata && out.$metadata.httpStatusCode) || 200;
        return { status, data: kind === 'get' ? out.Body : null, headers: headers_from(out) };
    } catch (err) {
        const status = http_status(err);
        if (!status) {
            log.warn({ event: 'dip_store_request_failed', key, err: err.message });
            throw new UpstreamError(`DIP store request failed: ${err.message}`);
        }
        if (status === 403 && (await key_exists(bucket, key, signal)) === false) {
            return { status: 404, data: null, headers: {} };
        }
        return { status, data: null, headers: {} };
    }
}

async function request(kind, path, opts = {}) {
    if (!is_configured()) {
        throw new UpstreamError('DIP store is not configured');
    }
    const { bucket } = parse_location(cfg().location);
    return send_one(kind, bucket, key_for(path), opts);
}

async function head(path, { signal } = {}) {
    return request('head', path, { signal });
}

async function get_stream(path, { signal } = {}) {
    return request('get', path, { signal });
}

/*
 * Read a text resource (the METS) by stored path. On a 200, `data` is the
 * body as a UTF-8 string; on any other status it is ''.
 */
async function fetch_text(path, { signal } = {}) {
    const res = await request('get', path, { signal });
    if (res.status !== 200 || !res.data) {
        return { status: res.status, data: '', headers: res.headers };
    }
    try {
        const data = await res.data.transformToString('utf-8');
        return { status: 200, data, headers: res.headers };
    } catch (err) {
        log.warn({ event: 'dip_store_text_read_failed', path, err: err.message });
        throw new UpstreamError(`DIP store read failed: ${err.message}`);
    }
}

/*
 * Reachability + credential probe for the Services Health page: list one
 * key under the prefix (an empty folder still counts as reachable).
 * Bounded by DIP_STORE_TIMEOUT_MS in total, retries included. Returns a
 * boolean and never throws, like duracloud.ping().
 */
async function ping() {
    if (!is_configured()) return false;
    try {
        const { bucket, prefix } = parse_location(cfg().location);
        await client().send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }),
            { abortSignal: AbortSignal.timeout(cfg().timeout_ms) }
        );
        return true;
    } catch (err) {
        log.warn({ event: 'dip_store_ping_failed', err: err.message });
        return false;
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
    parse_location,
    key_for,
    mets_path,
    head,
    get_stream,
    fetch_text,
    ping,
    _client_options: client_options,
    _set_client,
    _reset,
};
