'use strict';

/*
 * Kaltura service — Promise-based wrapper around the `kaltura-client`
 * SDK. The legacy ingest-service's service module mixes callback and
 * Promise APIs and uses `setInterval` for batch polling; v2 returns
 * awaitable Promises everywhere so the controller can use a plain
 * for-loop and the worker can apply normal cancellation semantics.
 * 
 * Responsibilities:
 *   - start_session()              — mint a Kaltura session (KS)
 *   - search_metadata(term, ks)    — eSearch by EXACT_MATCH on filename
 *   - get_public_video_data(...)   — list custom-metadata XML for an
 *                                     entry id (used by the legacy
 *                                     export path; parsed via xml2js)
 *   - get_video_search_data(...)   — eSearch by entry id (tags, desc)
 *   - get_file_format(entry_id)    — list flavor assets to find source
 *   - get_categories(category_id)  — resolve category metadata
 *   - list_entry_categories(...)   — list categories assigned to entry
 * 
 * Each call has a wall-clock timeout independent of the SDK's built-in
 * HTTP timeout — the SDK's internal retry policy can extend a single
 * call past 60s, which the v2 ingest worker won't tolerate. We race
 * against a fresh setTimeout per call and surface UpstreamError when
 * the timeout wins.
 */

const kaltura = require('kaltura-client');
const XML_PARSER = require('xml2js');

const config = require('./config');
const log = require('../libs/log');
const { UpstreamError, ValidationError } = require('../libs/errors');

const DEFAULT_SESSION_EXPIRY_S = 24 * 60 * 60;
const DEFAULT_SESSION_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

/*
 * Build a fresh SDK client per call. The SDK's Configuration object
 * carries per-call state (notably the KS), so reusing one across
 * requests is a footgun — different callers would clobber each other's
 * `setKs` value. The SDK object construction is cheap (no network).
 */
function _make_client() {
    const cfg = new kaltura.Configuration();
    return new kaltura.Client(cfg);
}

/*
 * Wrap an SDK `.execute()` promise with a wall-clock timeout. The SDK's
 * own timeout is configurable but messy to plumb through every call —
 * this is the unified guard so all upstream calls are time-bounded.
 */
function _with_timeout(promise, ms, op) {
    const timeout = new Promise((_, reject) => {
        const t = setTimeout(
            () => reject(new UpstreamError(`Kaltura ${op} timed out after ${ms}ms`)),
            ms
        );
        if (t.unref) t.unref();
    });
    return Promise.race([promise, timeout]);
}

/*
 * Sanitize a free-form search term before sending it to Kaltura's
 * eSearch. Strips ASCII control chars and the punctuation that
 * Kaltura's query parser treats as special; caps length so a runaway
 * caller can't push a 1MB string upstream. Whitespace is preserved
 * — Kaltura tokenizes on it.
 */
function _sanitize_term(term) {
    if (typeof term !== 'string') {
        throw new ValidationError('Search term must be a string');
    }
    const trimmed = term.trim();
    if (trimmed.length === 0) {
        throw new ValidationError('Search term cannot be empty');
    }
    return trimmed
        .replace(/[<>"'\\]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '')
        .slice(0, 256);
}

// --- Session minting -------------------------------------------------

/*
 * Start a Kaltura admin session and return the KS string. The
 * controller calls this once per request and threads it into the
 * per-package metadata lookups.
 */
async function start_session() {
    if (!config.is_configured()) {
        throw new UpstreamError('Kaltura is not configured');
    }
    const cfg = config.get();
    const client = _make_client();
    const type = kaltura.enums.SessionType.USER;
    /*
     * Empty privileges string maps to the SDK's default privilege set.
     * The legacy code passed SessionType.ADMIN here, which is wrong —
     * the privileges param is a comma-separated string, not an enum.
     * The wrong arg works on the upstream because Kaltura treats any
     * unrecognized privilege as "no extra grants", but we'd rather
     * pass the API-correct empty string and rely on `type=USER` +
     * user_id=admin to grant the actual permissions.
     */
    const privileges = '';
    const promise = kaltura.services.session
        .start(
            cfg.secret_key,
            cfg.user_id,
            type,
            cfg.partner_id,
            cfg.session_expiry_s || DEFAULT_SESSION_EXPIRY_S,
            privileges
        )
        .execute(client);
    const ks = await _with_timeout(
        promise,
        cfg.session_timeout_ms || DEFAULT_SESSION_TIMEOUT_MS,
        'session.start'
    );
    if (typeof ks !== 'string' || ks.length === 0) {
        throw new UpstreamError('Kaltura session.start returned empty KS');
    }
    return ks;
}

// --- Metadata lookups ------------------------------------------------

/*
 * eSearch by EXACT_MATCH against the supplied term. The term is
 * typically a filename ("X123.mp4"); the controller also retries
 * against the filename minus its extension if the first call returns
 * totalCount=0.
 * 
 * Returns the SDK's parsed response object — callers extract
 * `result.totalCount` and `result.objects[*].object.id` themselves
 * (see controller._extract_entry_ids).
 */
async function search_metadata(term, ks) {
    if (!ks || typeof ks !== 'string') {
        throw new ValidationError('Kaltura session (ks) is required');
    }
    const safe = _sanitize_term(term);
    const cfg = config.get();
    const client = _make_client();
    client.setKs(ks);

    const params = new kaltura.objects.ESearchEntryParams();
    params.orderBy = new kaltura.objects.ESearchOrderBy();
    const op = new kaltura.objects.ESearchEntryOperator();
    const item = new kaltura.objects.ESearchUnifiedItem();
    item.itemType = kaltura.enums.ESearchItemType.EXACT_MATCH;
    item.searchTerm = safe;
    op.searchItems = [item];
    params.searchOperator = op;
    params.aggregations = new kaltura.objects.ESearchAggregation();

    const pager = new kaltura.objects.Pager();

    try {
        return await _with_timeout(
            kaltura.services.eSearch.searchEntry(params, pager).execute(client),
            cfg.search_timeout_ms || DEFAULT_SEARCH_TIMEOUT_MS,
            'eSearch.searchEntry'
        );
    } catch (err) {
        if (err instanceof UpstreamError) throw err;
        log.warn({ event: 'kaltura_search_metadata_failed', err: err.message });
        throw new UpstreamError(`Kaltura search_metadata failed: ${err.message}`);
    }
}

/*
 * --- Legacy export-path helpers --------------------------------------
 * 
 * The functions below back the legacy /api/v1/kaltura/export flow that
 * drains tbl_exports row-by-row, hydrates each row with metadata, and
 * writes back. The new package-queue flow (queue_kaltura_packages,
 * process_queue in controller.js) does NOT use these — they're kept
 * because the legacy export endpoint is still exposed and may have
 * admin scripts pointed at it. New callers should prefer the queue
 * flow.
 */

async function get_public_video_data(entry_id, ks) {
    if (!ks || typeof ks !== 'string') {
        throw new ValidationError('Kaltura session (ks) is required');
    }
    const cfg = config.get();
    if (!cfg.public_video_metadata_profile_id) {
        throw new ValidationError(
            'KALTURA_PUBLIC_VIDEO_METADATA_PROFILE_ID is required for get_public_video_data'
        );
    }
    const client = _make_client();
    client.setKs(ks);
    const filter = new kaltura.objects.MetadataFilter();
    filter.objectIdEqual = entry_id;
    filter.metadataProfileIdEqual = cfg.public_video_metadata_profile_id;
    const pager = new kaltura.objects.FilterPager();
    try {
        return await _with_timeout(
            kaltura.services.metadata.listAction(filter, pager).execute(client),
            cfg.search_timeout_ms || DEFAULT_SEARCH_TIMEOUT_MS,
            'metadata.listAction'
        );
    } catch (err) {
        if (err instanceof UpstreamError) throw err;
        log.warn({ event: 'kaltura_get_public_video_data_failed', err: err.message });
        throw new UpstreamError(`Kaltura get_public_video_data failed: ${err.message}`);
    }
}

async function get_video_search_data(entry_id, ks) {
    if (!ks || typeof ks !== 'string') {
        throw new ValidationError('Kaltura session (ks) is required');
    }
    const safe = _sanitize_term(entry_id);
    return search_metadata(safe, ks);
}

async function get_file_format(entry_id, ks) {
    if (!ks || typeof ks !== 'string') {
        throw new ValidationError('Kaltura session (ks) is required');
    }
    const cfg = config.get();
    const client = _make_client();
    client.setKs(ks);
    const filter = new kaltura.objects.AssetFilter();
    filter.entryIdEqual = entry_id;
    const pager = new kaltura.objects.FilterPager();
    try {
        return await _with_timeout(
            kaltura.services.flavorAsset.listAction(filter, pager).execute(client),
            cfg.search_timeout_ms || DEFAULT_SEARCH_TIMEOUT_MS,
            'flavorAsset.listAction'
        );
    } catch (err) {
        if (err instanceof UpstreamError) throw err;
        log.warn({ event: 'kaltura_get_file_format_failed', err: err.message });
        throw new UpstreamError(`Kaltura get_file_format failed: ${err.message}`);
    }
}

async function get_category(category_id, ks) {
    if (!ks || typeof ks !== 'string') {
        throw new ValidationError('Kaltura session (ks) is required');
    }
    const cfg = config.get();
    const client = _make_client();
    client.setKs(ks);
    try {
        return await _with_timeout(
            kaltura.services.category.get(category_id).execute(client),
            cfg.search_timeout_ms || DEFAULT_SEARCH_TIMEOUT_MS,
            'category.get'
        );
    } catch (err) {
        if (err instanceof UpstreamError) throw err;
        log.warn({ event: 'kaltura_get_category_failed', err: err.message });
        throw new UpstreamError(`Kaltura get_category failed: ${err.message}`);
    }
}

async function list_entry_categories(entry_id, ks) {
    if (!ks || typeof ks !== 'string') {
        throw new ValidationError('Kaltura session (ks) is required');
    }
    const cfg = config.get();
    const client = _make_client();
    client.setKs(ks);
    const filter = new kaltura.objects.CategoryEntryFilter();
    filter.entryIdEqual = entry_id;
    const pager = new kaltura.objects.FilterPager();
    try {
        return await _with_timeout(
            kaltura.services.categoryEntry.listAction(filter, pager).execute(client),
            cfg.search_timeout_ms || DEFAULT_SEARCH_TIMEOUT_MS,
            'categoryEntry.listAction'
        );
    } catch (err) {
        if (err instanceof UpstreamError) throw err;
        log.warn({ event: 'kaltura_list_entry_categories_failed', err: err.message });
        throw new UpstreamError(`Kaltura list_entry_categories failed: ${err.message}`);
    }
}

/*
 * Parse the XML payload returned by metadata.listAction. The schema
 * is fixed by the configured profile; we extract just the two fields
 * the legacy code persisted (ReferenceID, OriginalFileName).
 */
async function parse_public_video_xml(xml) {
    if (!xml || typeof xml !== 'string') return null;
    const parser = new XML_PARSER.Parser({ explicitArray: false });
    try {
        const json = await parser.parseStringPromise(xml);
        const md = json && json.metadata ? json.metadata : null;
        if (!md) return null;
        return {
            reference_id: md.ReferenceID ? String(md.ReferenceID) : null,
            original_filename: md.OriginalFileName ? String(md.OriginalFileName) : null,
        };
    } catch (err) {
        log.warn({ event: 'kaltura_xml_parse_failed', err: err.message });
        return null;
    }
}

module.exports = {
    start_session,
    search_metadata,
    get_public_video_data,
    get_video_search_data,
    get_file_format,
    get_category,
    list_entry_categories,
    parse_public_video_xml,
    /*
     * Exposed for tests so they can exercise sanitization without
     * touching the SDK.
     */
    _sanitize_term,
};
