'use strict';

/*
 * Public API controllers — thin wrappers around api/model. Each
 * handler builds the request context (the thumbnail-URL maker
 * closure), calls the model, and serializes the result.
 * 
 * Responses are JSON for the data endpoints. Thumbnail proxy
 * streams binary bytes (image/jpeg) or falls back to the SVG
 * placeholder. All routes are unauthenticated.
 */

const fs = require('node:fs');
const path = require('node:path');

const app_config = require('../config/app');
const log = require('../libs/log');
const { create_model, make_thumbnail_url_for } = require('./model');
const tn_service = require('../libs/tn_service');
const duracloud = require('../libs/duracloud');
const projection = require('../libs/object_projection');
const repo_model = require('../repository/model');
const { NotFoundError } = require('../libs/errors');

/*
 * Shared model instance. Tests construct their own via create_model
 * with an injected ES client.
 */
const model = create_model();

const THUMBNAIL_PLACEHOLDER = path.join(
    __dirname,
    '..',
    'public',
    'images',
    'thumbnail-missing.svg'
);

/*
 * Standard response shape for JSON endpoints. Pulls request_id from
 * the request (set by libs/request_id) so consumers can include it
 * in bug reports.
 */
function send_json(req, res, status, body, { max_age = 300 } = {}) {
    res.status(status);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', `public, max-age=${max_age}`);
    res.set('X-Request-Id', req.id || '');
    res.json(body);
}

function send_thumbnail_placeholder(res) {
    res.status(200);
    res.set('Content-Type', 'image/svg+xml');
    /*
     * Shorter cache than real thumbnails — if a record's thumbnail
     * becomes available later, we want to pick it up reasonably
     * quickly. 60s mirrors the dashboard's placeholder behavior.
     */
    res.set('Cache-Control', 'public, max-age=60');
    fs.createReadStream(THUMBNAIL_PLACEHOLDER).pipe(res);
}

/*
 * GET /api/v1/health — public, lightweight. Doesn't probe ES (that
 * would let unauthenticated callers DDoS the cluster); just confirms
 * the API process is alive.
 */
async function health(req, res) {
    send_json(
        req,
        res,
        200,
        {
            status: 'ok',
            service: 'public-api',
            version: app_config().version,
        },
        { max_age: 0 }
    );
}

// GET /api/v1/search?q=&page=&page_size=&object_type=&is_compound=&subject=&collection=&sort=
async function search(req, res) {
    const make = (pid) => make_thumbnail_url_for(req, pid);
    const result = await model.search(req.query, { make_thumbnail_url: make });
    send_json(req, res, 200, result);
}

// GET /api/v1/objects/:pid
async function get_object(req, res) {
    const make = (pid) => make_thumbnail_url_for(req, pid);
    const result = await model.get(req.params.pid, { make_thumbnail_url: make });
    if (!result) {
        throw new NotFoundError(`Object ${req.params.pid} not found`);
    }
    send_json(req, res, 200, result);
}

// GET /api/v1/collections
async function list_collections(req, res) {
    const make = (pid) => make_thumbnail_url_for(req, pid);
    const result = await model.list_collections(req.query, { make_thumbnail_url: make });
    send_json(req, res, 200, result);
}

/*
 * GET /api/v1/objects/:pid/thumbnail
 * 
 * Public thumbnail proxy. Same TN-first/DC-fallback chain as the
 * dashboard's auth-gated handler, but gated on the ES index's
 * published flag instead of just "row exists". A row that's been
 * suppressed but is still in tbl_objects shouldn't leak its
 * thumbnail to public callers.
 * 
 * We use the ES index (via model.is_eligible) as the source of
 * truth for "is this public?" because the index already encodes
 * the eligibility rule and any consistency lag has already been
 * reconciled by the indexer worker.
 */
async function get_thumbnail(req, res) {
    const pid = req.params.pid;
    /*
     * Eligibility gate. If the row isn't in the ES index, it's
     * either not published, soft-deleted, or unknown — all three
     * map to placeholder for public callers.
     */
    const eligible = await model.is_eligible(pid);
    if (!eligible) return send_thumbnail_placeholder(res);

    /*
     * We still need the row's stored thumbnail value to decide
     * between uploaded-URL redirect / TN / DC. The ES doc has
     * `thumbnail` (the stored value) on the projected doc — read
     * it directly from the DB so we never serve a thumbnail that
     * disagrees with the live publish state.
     */
    let row;
    try {
        row = await repo_model.get(pid);
    } catch {
        return send_thumbnail_placeholder(res);
    }
    const enriched = projection.enrich(row);
    const stored = enriched.thumbnail_raw;

    // Case 1: uploaded thumbnail / CDN URL.
    if (stored && /^https?:\/\//i.test(stored)) {
        res.set('Cache-Control', 'public, max-age=3600');
        return res.redirect(302, stored);
    }

    // Case 2: TN service.
    if (tn_service.is_configured()) {
        try {
            const buffer = await tn_service.get_thumbnail(pid);
            res.status(200);
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=3600');
            return res.end(buffer);
        } catch {
            // Fall through to DC.
        }
    }

    // Case 3: DuraCloud fallback.
    if (stored && duracloud.is_configured()) {
        let upstream;
        try {
            upstream = await duracloud.get_thumbnail_stream(stored);
        } catch {
            return send_thumbnail_placeholder(res);
        }
        if (upstream.status === 200 && upstream.data) {
            res.status(200);
            res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=3600');
            upstream.data.pipe(res);
            upstream.data.on('error', () => {
                if (!res.headersSent) send_thumbnail_placeholder(res);
                else res.end();
            });
            return;
        }
    }

    // Case 4: nothing worked.
    return send_thumbnail_placeholder(res);
}

/*
 * Light-touch logging for the JSON endpoints so operators can see
 * public-API traffic shape without the noise of static-asset hits.
 * Note: this is fired AFTER the response, in the next-tick, so it
 * doesn't add latency.
 */
function log_request(req, res, next) {
    res.on('finish', () => {
        /*
         * Skip the thumbnail route (high-volume image traffic) and
         * health (noise from monitoring).
         */
        if (req.path.endsWith('/health')) return;
        if (req.path.includes('/thumbnail')) return;
        log.info({
            event: 'public_api_request',
            method: req.method,
            path: req.path,
            status: res.statusCode,
            request_id: req.id,
        });
    });
    next();
}

module.exports = {
    health,
    search,
    get_object,
    list_collections,
    get_thumbnail,
    log_request,
};
