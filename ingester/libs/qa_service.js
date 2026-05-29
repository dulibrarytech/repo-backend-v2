'use strict';

// QA service HTTP client. The QA service owns the staff-facing pre-
// ingest workflow: it inspects packages in `001-ready`, lets staff
// stage them for ingest by moving them to `002-ingest`, and reports
// upload progress as files are pushed up to the Archivematica SFTP
// drop. v2's ingest worker calls a subset of these endpoints during
// the STARTING → UPLOADING stage:
//
//   - move_to_ingest(uuid, folder, package)  — fire-and-forget; QA moves
//     the folder asynchronously. We submit the request, return.
//   - move_to_sftp(uuid)                      — fire-and-forget; QA pushes
//     the staged batch to the AM SFTP source. Long-running (~30 min).
//   - sftp_upload_status(uuid, total_count)  — polled by the worker
//     until total files match expected count or UPLOAD_TIMEOUT fires.
//   - get_package_file_count(folder, package) — used pre-flight to learn
//     the count we'll later poll against.
//
// The dashboard's "browse-ready-folders" view also reads from this
// service; those calls (list-ready-folders, package-names, set-folder-
// name, check-folder-name, check-package-names, get-total-batch-size)
// are wired up for the dashboard layer but exposed here because the
// worker may need them on resume.
//
// Auth scheme is X-API-Key header (NOT query string — that's
// Archivematica). Endpoint path is the legacy `/api/v2/qa/` prefix,
// preserved so the existing QA service deployment Just Works.

const http_default = require('axios');
const app_config = require('../../config/app');
const log = require('../../libs/log');
const { UpstreamError } = require('../../libs/errors');

const QA_PATH = '/api/v2/qa/';

function is_configured() {
    const cfg = app_config().curation_api;
    return Boolean(cfg && cfg.url && cfg.api_key);
}

function build_url(endpoint, query = {}) {
    const cfg = app_config().curation_api;
    const base = cfg.url.replace(/\/+$/, '');
    const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    return qs ? `${base}${QA_PATH}${endpoint}?${qs}` : `${base}${QA_PATH}${endpoint}`;
}

function default_headers() {
    const cfg = app_config().curation_api;
    return {
        'Content-Type': 'application/json',
        'X-API-Key': cfg.api_key,
    };
}

function create_client(http = http_default) {
    return {
        is_configured,

        // --- Dashboard reads ------------------------------------------------

        // List all packages staff have flagged as ready to ingest.
        async list_ready_folders() {
            return _get(http, build_url('list-ready-folders'), 'list_ready_folders');
        },

        async get_item_packages(collection_folder) {
            return _get(
                http,
                build_url('package-names', { folder: collection_folder }),
                'get_item_packages'
            );
        },

        async set_folder_name(folder_name) {
            return _get(
                http,
                build_url('set-collection-folder', { folder: folder_name }),
                'set_folder_name'
            );
        },

        async check_folder_name(folder_name) {
            return _get(
                http,
                build_url('check-collection-folder', { folder: folder_name }),
                'check_folder_name'
            );
        },

        async check_package_names(folder_name) {
            return _get(
                http,
                build_url('check-package-names', { folder: folder_name }),
                'check_package_names'
            );
        },

        async get_total_batch_size(folder_name) {
            return _get(
                http,
                build_url('get-total-batch-size', { folder: folder_name }),
                'get_total_batch_size'
            );
        },

        async get_package_file_count(collection_folder, archival_package) {
            return _get(
                http,
                build_url('package-file-count', {
                    folder: collection_folder,
                    package: archival_package,
                }),
                'get_package_file_count'
            );
        },

        // --- Worker calls --------------------------------------------------

        // Move a package from 001-ready into 002-ingest. QA does this
        // asynchronously; we don't wait for completion. The worker sees
        // the move land via subsequent state transitions (folder count
        // on the AM SFTP side starts climbing).
        async move_to_ingest(uuid, folder_name, archival_package) {
            const cfg = app_config().curation_api;
            return _get(
                http,
                build_url('move-to-ingest', {
                    uuid,
                    folder: folder_name,
                    package: archival_package,
                }),
                'move_to_ingest',
                cfg.timeout_ms
            );
        },

        // Push the staged batch up to Archivematica's SFTP source.
        // Legitimately long-running for big collections; the v1 timeout
        // was 30 minutes, preserved here via app_config().move_timeout_ms.
        async move_to_sftp(uuid) {
            const cfg = app_config().curation_api;
            return _get(
                http,
                build_url('move-to-sftp', { uuid }),
                'move_to_sftp',
                cfg.move_timeout_ms
            );
        },

        // The worker's polling target during UPLOADING. Returns the
        // current upload count vs expected; the worker compares against
        // total_batch_file_count and advances to UPLOAD_COMPLETE when
        // they match, or to UPLOAD_TIMEOUT after the configured window.
        async sftp_upload_status(uuid, total_batch_file_count) {
            return _get(
                http,
                build_url('upload-status', {
                    uuid,
                    total_batch_file_count,
                }),
                'sftp_upload_status'
            );
        },

        // Rollback support — undoes the move_to_ingest step by moving
        // the folder back from 002-ingest to 001-ready. Called by both
        // the rollback_pre_ingest and return_to_packaging staff actions
        // when the row halted before AM produced anything. Long-running
        // like move_to_sftp.
        //
        // The curation-API endpoint requires uuid + folder + package
        // (it moves one package at a time). Earlier v2 client only
        // passed uuid and the move silently failed with HTTP 400 —
        // queue rows landed in their terminal state but the folder
        // stayed stuck in 002-ingest. Callers MUST pass all three;
        // row.batch is the folder name and row.package is the
        // archival object directory inside it.
        //
        // Best-effort `actor` propagation: the curation-API logs it
        // at INFO for the staff audit trail. Pass `du_id` or `email`
        // from the JWT/dashboard session; never the bare ip address.
        async move_from_ingest_to_ready(uuid, folder, package_name, opts = {}) {
            const cfg = app_config().curation_api;
            const params = { uuid, folder, package: package_name };
            if (opts.actor) params.actor = opts.actor;
            return _get(
                http,
                build_url('move-from-ingest-to-ready', params),
                'move_from_ingest_to_ready',
                cfg.move_timeout_ms
            );
        },

        // After Stage 5 COMPLETE the worker archives the folder to
        // 003-ingested AND triggers the Wasabi S3 copy — both happen
        // server-side inside the curation-API's move_to_ingested
        // implementation (see digitaldu-backend-curation-service/lib/
        // archivematica_ops.py move_to_ingested + move_to_s3).
        //
        // Two query params, BOTH required by the curation route:
        //   uuid   — the per-ingest qa_uuid (row.collection_uuid;
        //            falls back to q-<row.id> for legacy rows)
        //   folder — the staff-facing folder name (row.batch). The
        //            curation route strips the `new_` prefix when
        //            placing it into 003-ingested. Passing the literal
        //            string `collection` triggers a
        //            get_collection_folder_name() lookup server-side;
        //            we never do that — we always send the real folder
        //            name so the audit log is unambiguous.
        //
        // Best-effort caller contract: a 5xx / timeout / Wasabi failure
        // MUST NOT unwind a completed ingest. The curation route always
        // returns HTTP 200 even when move_to_s3 fails (errors land in
        // the JSON body), so callers must inspect data.errors to see
        // whether Wasabi actually worked. The Stage 5 wrapper records
        // both `status` and `errors` in the COMPLETE audit payload.
        async move_to_ingested(uuid, folder) {
            const cfg = app_config().curation_api;
            return _get(
                http,
                build_url('move-to-ingested', { uuid, folder }),
                'move_to_ingested',
                cfg.move_timeout_ms
            );
        },

        // Remove a package's files + parent collection directory from
        // the Archivematica SFTP staging area. The curation-API removes:
        //
        //   <sftp_path>/<uuid>/<archival_package>/        (whole subtree)
        //   <sftp_path>/<uuid>/                           (if empty —
        //                                                  sibling
        //                                                  packages in
        //                                                  the same
        //                                                  batch keep it)
        //
        // Two callers:
        //   - Stage 5 success path: fire after COMPLETE to drop the
        //     staging copy now that AM has the AIP and DuraCloud has
        //     the DIP. Without this, the SFTP host accumulates one
        //     `<uuid>/<package>/` per successful ingest, forever.
        //   - The rollback path uses `move_from_ingest_to_ready`,
        //     which calls clean_up_sftp server-side before the local
        //     folder move. No client call needed there.
        //
        // Best-effort: a 5xx / timeout here MUST NOT unwind a completed
        // ingest. Callers wrap in try/catch and capture the outcome in
        // the audit payload. Server-side rm is idempotent — rerunning
        // on an already-empty path silently no-ops.
        async cleanup_sftp(uuid, archival_package) {
            const cfg = app_config().curation_api;
            return _get(
                http,
                build_url('cleanup_sftp', { uuid, archival_package }),
                'cleanup_sftp',
                cfg.move_timeout_ms
            );
        },

        // Health probe — confirms the service is up. Mounted at the
        // app root (NOT under /api/v2/qa/), so we build the URL by
        // hand. No auth required for health checks.
        async health() {
            const cfg = app_config().curation_api;
            const base = cfg.url.replace(/\/+$/, '');
            try {
                const res = await http.get(`${base}/health`, {
                    timeout: cfg.timeout_ms,
                    validateStatus: () => true,
                });
                return { status: res.status, data: res.data };
            } catch (err) {
                log.warn({ event: 'qa_health_failed', err: err.message });
                throw new UpstreamError(`QA service health failed: ${err.message}`);
            }
        },

        // Wasabi reachability probe — runs the curation-service's
        // boto3 head_bucket call against the configured profile +
        // bucket and returns the result. The route is auth-required
        // (X-API-Key header) and lives at /health/wasabi, NOT under
        // /api/v2/qa/, so we build the URL by hand. The endpoint
        // ALWAYS returns 200 with a JSON body whose `ok` field is
        // the actual success signal — staff dashboard cards should
        // render based on body.ok, not res.status.
        //
        // Returns { status, data } where data is shaped like:
        //   { ok: true,  bucket: 'name', error: null, elapsed_ms: 142 }
        //   { ok: false, bucket: 'name', error: 'head_bucket failed (403): ...', elapsed_ms: 87 }
        // Transport-level failure (curation unreachable) throws
        // UpstreamError so the dashboard can show a red card.
        async health_wasabi() {
            const cfg = app_config().curation_api;
            const base = cfg.url.replace(/\/+$/, '');
            try {
                const res = await http.get(`${base}/health/wasabi`, {
                    timeout: cfg.timeout_ms,
                    headers: default_headers(),
                    validateStatus: () => true,
                });
                return { status: res.status, data: res.data };
            } catch (err) {
                log.warn({ event: 'qa_health_wasabi_failed', err: err.message });
                throw new UpstreamError(`QA service /health/wasabi failed: ${err.message}`);
            }
        },
    };
}

// --- internal helpers ---------------------------------------------------

async function _get(http, url, op, override_timeout) {
    const cfg = app_config().curation_api;
    const timeout = override_timeout || cfg.timeout_ms;
    try {
        const res = await http.get(url, {
            timeout,
            headers: default_headers(),
            validateStatus: () => true,
        });
        return { status: res.status, data: res.data };
    } catch (err) {
        log.warn({ event: `qa_${op}_failed`, err: err.message });
        throw new UpstreamError(`QA service ${op} failed: ${err.message}`);
    }
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
