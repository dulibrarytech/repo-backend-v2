'use strict';

/*
 * Kaltura REST surface. Mounts under `${cfg.path}/api/v1/kaltura/*`
 * (see kaltura/routes.js for the mount points).
 * 
 * Endpoints + responsibilities:
 * 
 *   POST /session            → mint a Kaltura admin session, return the KS
 *   POST /metadata           → enqueue packages, drain queue, return per-file
 *                              { entry_id, status, message } triples
 *   GET  /queue              → list pending queue rows
 *   GET  /queue/entry_ids    → list resolved entry IDs (the IDs table)
 *   POST /queue/clear        → hard-reset both Kaltura queue tables
 *   POST /export             → legacy export-data flow (drains tbl_exports
 *                              row-by-row; admin scripts only — new callers
 *                              should use the /metadata flow)
 * 
 * Auth: every endpoint requires a valid JWT (require_auth, applied at
 * the route layer). The controller itself doesn't re-check.
 * 
 * All handlers throw typed errors (ValidationError, UpstreamError) so
 * the central error handler in config/express.js maps them to HTTP
 * responses. Inline try/catch is reserved for the few places we need
 * to convert SDK exceptions into UpstreamError; the rest bubble up.
 */

const service = require('./service');
const model = require('./model');
const config = require('./config');
const log = require('../libs/log');
const { ValidationError, ServiceUnavailableError } = require('../libs/errors');

/*
 * Defensive cap on the batch processing loop. The legacy controller
 * also caps at 1000 — same number here so existing batches keep
 * working. A misconfigured client can't pin the worker forever.
 */
const MAX_PACKAGES_PER_REQUEST = 1000;

/*
 * Backoff between Kaltura calls — Kaltura rate-limits aggressively
 * when hammered. The legacy controller used 500ms between packages
 * and 250ms between files; we match those values exactly so the v2
 * flow has the same upstream footprint as v1.
 */
const PACKAGE_DELAY_MS = 500;
const FILE_DELAY_MS = 250;

function _sleep(ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        if (t.unref) t.unref();
    });
}

// --- POST /api/v1/kaltura/session -------------------------------------
async function get_session(_req, res) {
    if (!config.is_configured()) {
        throw new ServiceUnavailableError('Kaltura is not configured');
    }
    const ks = await service.start_session();
    res.status(200).json({ error: false, ks });
}

/*
 * --- POST /api/v1/kaltura/metadata ------------------------------------
 * 
 * Body shape:
 *   {
 *     packages: [
 *       { package: 'object-name', files: ['file-A.mp4', 'file-B.mp4', ...] },
 *       ...
 *     ]
 *   }
 * 
 * Returns:
 *   {
 *     error: false,
 *     status: 200,
 *     message: 'Entry ID processing complete.',
 *     results: [
 *       { package, file, entry_id, status, message },
 *       ...
 *     ]
 *   }
 * 
 * The handler enqueues the packages first, then drains the queue in
 * the same request. That mirrors the legacy controller's contract; a
 * future enhancement could make the drain async (return 202 + a job
 * id) but keeping it synchronous preserves caller behavior.
 */
async function post_metadata(req, res) {
    if (!config.is_configured()) {
        throw new ServiceUnavailableError('Kaltura is not configured');
    }
    const session_from_query =
        typeof req.query.session === 'string' ? req.query.session.trim() : '';
    _validate_metadata_body(req.body);

    /*
     * Mint a session if the caller didn't supply one. The legacy
     * controller required the caller to mint + pass the KS as a query
     * param; v2 keeps that path working but also auto-mints so single-
     * shot scripts don't have to.
     */
    let ks = session_from_query;
    if (!ks) {
        ks = await service.start_session();
    }

    const results = await resolve_packages(req.body.packages, { ks });

    res.status(200).json({
        error: false,
        status: 200,
        message: 'Entry ID processing complete.',
        results,
    });
}

function _validate_metadata_body(body) {
    if (!body || typeof body !== 'object') {
        throw new ValidationError('Request body must be an object with a packages array');
    }
    if (!Array.isArray(body.packages) || body.packages.length === 0) {
        throw new ValidationError('packages must be a non-empty array');
    }
    const errors = [];
    body.packages.forEach((p, i) => {
        if (!p || typeof p !== 'object') {
            errors.push({ index: i, error: 'must be an object' });
            return;
        }
        if (typeof p.package !== 'string' || p.package.length === 0) {
            errors.push({ index: i, error: 'package is required (non-empty string)' });
        }
        if (!Array.isArray(p.files)) {
            errors.push({ index: i, error: 'files must be an array' });
        }
    });
    if (errors.length > 0) {
        throw new ValidationError('packages validation failed', errors);
    }
}

/*
 * Resolve filename→entry-id for a set of packages: scoped clear of any
 * earlier rows, enqueue, drain. Returns the flat array of
 * `{package, file, entry_id, status, message}` rows (also persisted to
 * tbl_kaltura_ids, where ingest Stage 5 reads them).
 *
 * Shared by POST /metadata and the ingest workspace's Make Digital
 * Objects action, which resolves a folder's media files before running
 * MDO so the entry IDs can be stamped into ArchivesSpace.
 *
 * `opts.ks` reuses an existing session; otherwise one is minted.
 * `opts.deps` injects {service, model, config} for tests.
 */
async function resolve_packages(packages, opts = {}) {
    const deps = opts.deps || {};
    const cfg = deps.config || config;
    const svc = deps.service || service;
    const mdl = deps.model || model;

    if (!cfg.is_configured()) {
        throw new ServiceUnavailableError('Kaltura is not configured');
    }
    _validate_metadata_body({ packages });

    const ks = opts.ks || (await svc.start_session());

    /*
     * Stage 0 — clear-on-start. Drop any earlier queue + IDs rows for
     * THIS batch's packages so a retry replaces its previous results
     * instead of appending to them. Scoped to the incoming package
     * names on purpose — a global wipe would delete entry ids that
     * in-flight ingests still read in Stage 5 (attach_kaltura_ids).
     */
    await mdl.clear_packages(packages.map((p) => p.package));

    /*
     * Stage 1 — enqueue. JSON-stringify files at insert time so the
     * LONGTEXT column round-trips cleanly.
     */
    await mdl.queue_packages(packages);

    /*
     * Stage 2 — drain. Bounded loop with the same per-package /
     * per-file backoff as the legacy controller.
     */
    return _drain_queue(ks, deps);
}

/*
 * Drain unprocessed packages from the queue. Returns a flat array of
 * `{package, file, entry_id, status, message}` results for the caller.
 */
async function _drain_queue(ks, deps = {}) {
    const mdl = deps.model || model;
    const all_results = [];
    let processed = 0;
    while (processed < MAX_PACKAGES_PER_REQUEST) {
        const pkg = await mdl.get_next_package();
        if (!pkg) break;
        const pkg_results = await _process_package(pkg, ks, deps);
        all_results.push(...pkg_results);
        processed += 1;
        if (processed < MAX_PACKAGES_PER_REQUEST) {
            await _sleep(PACKAGE_DELAY_MS);
        }
    }
    return all_results;
}

/*
 * Process a single queue row: parse its files array, look each one up,
 * persist the entry IDs, mark the row processed. The row is flipped
 * to is_processed=1 BEFORE the per-file loop so a mid-loop crash
 * doesn't leave us re-processing the same files on retry.
 */
async function _process_package(pkg, ks, deps = {}) {
    const mdl = deps.model || model;
    let files;
    try {
        files = JSON.parse(pkg.files);
    } catch (err) {
        log.warn({
            event: 'kaltura_files_parse_failed',
            package: pkg.package,
            err: err.message,
        });
        await mdl.mark_package_processed(pkg.package);
        return [];
    }
    if (!Array.isArray(files)) {
        log.warn({
            event: 'kaltura_files_not_array',
            package: pkg.package,
        });
        await mdl.mark_package_processed(pkg.package);
        return [];
    }

    await mdl.mark_package_processed(pkg.package);

    const results = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const file_results = await _resolve_file(file, pkg.package, ks, deps);
        await mdl.save_entry_ids(file_results);
        results.push(...file_results);
        if (i < files.length - 1) await _sleep(FILE_DELAY_MS);
    }
    return results;
}

/*
 * Look up a single filename in Kaltura. Strategy:
 *   1. Search by the full filename.
 *   2. If no match, search by the basename (strip the last extension —
 *      legacy code only handled `.mp4` via a 4-char trim; we use a
 *      proper lastIndexOf so .mov/.wav/.m4v all lose their extension).
 *   3. If still no match, record a status=0 placeholder.
 * 
 * Returns the array of result rows for this file (status=1 → exactly
 * one entry id; status=2 → multiple ids as a JSON array; status=0 →
 * not found).
 * 
 * `deps.service` is the kaltura service module (defaults to the real
 * import). Tests inject a stub so the SDK never runs.
 */
async function _resolve_file(file, package_name, ks, deps = {}) {
    const svc = deps.service || service;
    if (typeof file !== 'string' || file.length === 0) {
        /*
         * Empty / non-string filenames render as 'unknown' so the
         * staff-facing table doesn't have blank rows. Mirrors the
         * legacy controller's `file || 'unknown'` shortcut.
         */
        return [
            {
                package: package_name,
                file: typeof file === 'string' && file.length > 0
                    ? String(file).slice(0, 255)
                    : 'unknown',
                entry_id: '0_0',
                status: 0,
                message: 'Invalid file name.',
            },
        ];
    }

    try {
        const full = await svc.search_metadata(file, ks);
        if (full && full.totalCount > 0) {
            return _extract_entry_ids(full, file, package_name);
        }
        const basename = _basename(file);
        if (basename && basename !== file) {
            const stripped = await svc.search_metadata(basename, ks);
            if (stripped && stripped.totalCount > 0) {
                return _extract_entry_ids(stripped, file, package_name);
            }
        }
        return [
            {
                package: package_name,
                file,
                entry_id: '0_0',
                status: 0,
                message:
                    'File does not have an Entry ID. Please check Kaltura record for all required fields.',
            },
        ];
    } catch (err) {
        log.warn({
            event: 'kaltura_resolve_file_failed',
            package: package_name,
            file,
            err: err.message,
        });
        return [
            {
                package: package_name,
                file,
                entry_id: '0_0',
                status: 0,
                message: `Processing error: ${err.message}`.slice(0, 255),
            },
        ];
    }
}

function _basename(file) {
    const dot = file.lastIndexOf('.');
    if (dot <= 0) return file;
    return file.slice(0, dot);
}

/*
 * Turn an SDK eSearch response into one or more result rows. The two
 * status codes that surface from a successful upstream call:
 *   status=1 — exactly one entry id (the happy path)
 *   status=2 — multiple entry ids; entry_id is the JSON array string
 *             so staff can split + verify each one
 */
function _extract_entry_ids(response, file, package_name) {
    const objects = Array.isArray(response.objects) ? response.objects : [];
    const total = response.totalCount || 0;
    if (total <= 0 || objects.length === 0) return [];

    const ids = objects
        .map((o) => o && o.object && o.object.id)
        .filter((id) => typeof id === 'string' && id.length > 0);

    if (ids.length === 0) return [];

    if (ids.length === 1) {
        return [
            {
                package: package_name,
                file,
                entry_id: ids[0],
                status: 1,
                message: 'Success.',
            },
        ];
    }

    return [
        {
            package: package_name,
            file,
            entry_id: JSON.stringify(ids),
            status: 2,
            message: 'File has more than 1 Entry ID. Please check Kaltura record(s).',
        },
    ];
}

// --- GET /api/v1/kaltura/queue ---------------------------------------
async function get_queue(_req, res) {
    const rows = await model.list_pending_packages();
    res.status(200).json({ error: false, data: rows });
}

// --- GET /api/v1/kaltura/queue/entry_ids -----------------------------
async function get_entry_ids(_req, res) {
    const rows = await model.list_entry_ids();
    res.status(200).json({ error: false, data: rows });
}

// --- POST /api/v1/kaltura/queue/clear --------------------------------
async function clear_queue(_req, res) {
    const result = await model.clear_queue();
    res.status(200).json({ error: false, ...result });
}

module.exports = {
    get_session,
    post_metadata,
    get_queue,
    get_entry_ids,
    clear_queue,
    resolve_packages,
    /*
     * Internals exposed for tests so unit tests don't need to mock
     * the full HTTP layer to exercise the per-file resolution rules.
     */
    _resolve_file,
    _extract_entry_ids,
    _basename,
    MAX_PACKAGES_PER_REQUEST,
};
