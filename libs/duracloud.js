'use strict';

// Minimal DuraCloud client. Ports v1's libs/duracloud.js `get_thumbnail`
// with three deliberate departures:
//
//   1. Basic auth goes in a header, not in the URL. v1's pattern of
//      `https://user:pwd@host/...` works against Node's axios but is
//      deprecated in browsers and increasingly stripped by intermediate
//      proxies; the header form is portable.
//   2. Responses are streamed (axios `responseType: 'stream'`) so the
//      proxy route can pipe directly to the client without buffering
//      every image in process memory. Important under list-view load
//      where 25 rows can fan out 25 concurrent DC fetches.
//   3. URL composition is centralized in `build_endpoint` so the
//      `https://` prefix, the `dip-store/` namespace, and the
//      configured base only get assembled in one place — v1
//      scattered five copies of that string-concat through the lib.
//
// `is_configured()` lets callers cheaply skip the proxy when the
// DURACLOUD_* env vars are absent (dev / test environments) instead
// of throwing on every request.

const http_client = require('axios');
const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError } = require('./errors');

function is_configured() {
    const cfg = app_config().duracloud;
    return Boolean(cfg && cfg.api && cfg.user && cfg.password);
}

// Build the absolute URL for a dip-store-relative path. The stored
// value in tbl_objects.thumbnail is something like
//   `<dip_path>/thumbnails/<uuid>.jpg`
// and DuraCloud serves it under `https://<api>/dip-store/<tn>`.
//
// We strip any leading slashes from the tail so an accidentally
// absolute-looking path doesn't double up on the `/dip-store/` join.
function build_endpoint(tn) {
    const cfg = app_config().duracloud;
    if (!cfg.api) {
        throw new Error('DURACLOUD_API is not configured');
    }
    const api = cfg.api.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const tail = String(tn).replace(/^\/+/, '');
    return `https://${api}/dip-store/${tail}`;
}

function build_auth_header() {
    const cfg = app_config().duracloud;
    const token = Buffer.from(`${cfg.user}:${cfg.password}`, 'utf8').toString('base64');
    return `Basic ${token}`;
}

// Fetch a thumbnail as a Node stream. Returns the axios response
// object so the caller can pipe `.data` and inspect status/headers.
// Throws UpstreamError on any failure so the controller can map to a
// 502 — keeping the consumer's error path uniform.
async function get_thumbnail_stream(tn) {
    if (!is_configured()) {
        throw new UpstreamError('DuraCloud is not configured');
    }
    const cfg = app_config().duracloud;
    const endpoint = build_endpoint(tn);

    try {
        const response = await http_client.get(endpoint, {
            responseType: 'stream',
            timeout: cfg.timeout_ms,
            headers: { Authorization: build_auth_header() },
            // Don't auto-throw on 4xx/5xx — let the caller inspect the
            // status so a missing image (404) renders the placeholder
            // instead of cascading into a generic 502.
            validateStatus: () => true,
        });
        return response;
    } catch (err) {
        // Network-level errors (timeout, DNS, TLS) reach here. Log the
        // path tail (not the credentials) and re-throw as UpstreamError.
        log.warn({ tn, err: err.message }, 'duracloud thumbnail fetch failed');
        throw new UpstreamError(`DuraCloud fetch failed: ${err.message}`);
    }
}

// Fetch a text-bodied resource (METS XML, object manifests, etc.) by
// dip-store-relative path. Used by the ingest worker:
//
//   - Stage 4 (DuraCloud wait): probes the METS file to detect when
//     Archivematica's AIP has finished propagating to DuraCloud. A
//     200 means "ready"; 404 means "still waiting".
//   - Stage 5 (repository build): re-reads the METS to build the
//     tbl_objects rows.
//
// Returns `{ status, data, headers }` so the caller can branch on
// status without re-mapping. Caller passes an optional `signal` so
// the worker's shutdown can cancel an in-flight probe.
async function fetch_text(path, { signal } = {}) {
    if (!is_configured()) {
        throw new UpstreamError('DuraCloud is not configured');
    }
    const cfg = app_config().duracloud;
    const endpoint = build_endpoint(path);
    try {
        const response = await http_client.get(endpoint, {
            responseType: 'text',
            timeout: cfg.timeout_ms,
            headers: { Authorization: build_auth_header() },
            validateStatus: () => true,
            signal,
        });
        return {
            status: response.status,
            data: response.data,
            headers: response.headers,
        };
    } catch (err) {
        log.warn({ path, err: err.message }, 'duracloud text fetch failed');
        throw new UpstreamError(`DuraCloud fetch failed: ${err.message}`);
    }
}

// Build the conventional METS path for a given AIP. Archivematica's
// DIP store layout places the METS file directly under the DIP folder
// (the slash-chunked UUID folder returned by AM's get_dip_path) —
// siblings to objects/ and thumbnails/, NOT under a data/ subfolder.
// Centralized here so callers don't have to repeat the format and
// the convention has one place to evolve.
function mets_path(sip_uuid, dip_path) {
    if (!sip_uuid || !dip_path) {
        throw new Error('mets_path requires sip_uuid + dip_path');
    }
    return `${dip_path}/METS.${sip_uuid}.xml`;
}

module.exports = {
    is_configured,
    build_endpoint,
    build_auth_header,
    get_thumbnail_stream,
    fetch_text,
    mets_path,
};
