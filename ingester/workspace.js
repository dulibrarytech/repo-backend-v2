'use strict';

/*
 * Workspace orchestration for the v2 ingest dashboard.
 * 
 * Three pre-ingest dashboard pages share this module:
 * 
 *   - Make Digital Objects (scope='unprocessed')   — folders lacking uri.txt
 *   - ASpace Description QA (scope='processed')    — folders with uri.txt
 *   - Packaging and Ingesting (scope='processed')  — same data, different action
 * 
 * Each page calls `list_workspace({ scope, q, exclude_qa_passed })`
 * which queries the curation-service AStools endpoint and shapes the
 * folders list for the workspace-table partial.
 * 
 * Action helpers (run_make_digital_objects, run_qa_check,
 * submit_to_ingest, revert_to_mdo) encapsulate the per-action
 * workflow so the dashboard controller stays thin.
 * 
 * QA-passed state lives in tbl_ingest_jobs (the job-history table
 * the dashboard already records per workflow action against). We
 * query it on every list_workspace call rather than caching, so:
 *   - the marker survives process restarts (formerly an in-memory
 *     Set that wiped on reboot),
 *   - re-running MDO on a previously-QA'd folder auto-unhides it
 *     (its newest job is now MDO, not QA — see
 *     jobs.get_qa_passed_folders for the semantics).
 */

const astools_default = require('../ingester/libs/astools');
const structure_flags = require('./libs/structure_flags');
const validator_default = require('./libs/aspace_validator');
const aspace_default = require('../libs/archivesspace');
const model_default = require('./model');
const jobs_default = require('./jobs');
const app_config = require('../config/app');
const log = require('../libs/log');
const collection_provision = require('../repository/collection_provision');

/*
 * --- Collection-resource gate (pre-flight for submit_to_ingest) -----
 * 
 * A folder name like `new_U358_LDT_TEST_Collection-resources_1204`
 * carries the ArchivesSpace resource ID in its last `-` segment:
 * `resources_1204` → `/repositories/<repo_id>/resources/1204`.
 * 
 * The gate runs once at submit time and answers two questions:
 *   1. Is the AS resource real? (Halt + alert if not.)
 *   2. Does the local repository have a corresponding collection?
 *      (Auto-create from the AS record if missing.)
 * 
 * This mirrors the v1 ingest-service's start_ingest() pre-flight.
 * It runs BEFORE queue_packages so a failed gate means zero queue
 * rows are inserted — recovering from a partial submit is harder
 * than refusing to start one.
 */

/*
 * Parse the AS resource URI from the folder name's last `-` segment.
 * Accepted shapes (matches the v1 convention):
 *   `<anything>-resources_<digits>`        → /repositories/<n>/resources/<digits>
 *   `<anything>-archival_objects_<digits>` → /repositories/<n>/archival_objects/<digits>
 * 
 * Throws ValidationError on unparseable input — the controller
 * surfaces it as a sev-error action card so staff sees the cause
 * immediately ("Could not parse resource ID from folder name").
 */
function _parse_resource_uri(folder) {
    if (!folder || typeof folder !== 'string') {
        throw new Error('folder is required to parse a resource URI');
    }
    const tail = folder.split('-').pop();
    const match = /^(resources|archival_objects)_(\d+)$/.exec(tail);
    if (!match) {
        throw new Error(
            `Could not parse resource ID from folder name "${folder}" — ` +
                `expected the last "-" segment to be ` +
                `"resources_<N>" or "archival_objects_<N>"`
        );
    }
    const [, kind, id] = match;
    const repo_id = app_config().archivespace.repository_id || '2';
    return `/repositories/${repo_id}/${kind}/${id}`;
}

/*
 * Resolve the local collection for a folder. Outcomes:
 *   { ok: true,  collection_pid, created }  — existed (created:false) OR just created
 *   { ok: false, error }                    — folder unparseable OR AS fetch failed
 * 
 * Parses the folder's last "-" segment into the resource URI, then defers
 * the find-or-create (local lookup → AS fetch → handle mint → insert) to the
 * shared repository/collection_provision helper, which the dashboard "create
 * collection" flow also uses. Ingest collections are top-level (no parent).
 */
async function _ensure_collection_exists(folder, deps = {}) {
    let uri;
    try {
        uri = _parse_resource_uri(folder);
    } catch (err) {
        return { ok: false, error: err.message };
    }
    const result = await collection_provision.provision_collection({ uri }, deps);
    if (result.ok && result.created) {
        // Preserve the ingest-specific audit event (carries the folder).
        log.info({
            event: 'collection_auto_created',
            folder,
            uri,
            pid: result.collection_pid,
            handle: result.handle || null,
        });
    }
    return result;
}

/*
 * --- list_workspace --------------------------------------------------
 * 
 * `scope`:
 *   'unprocessed' — folders where ZERO packages have uri.txt
 *   'processed'   — folders where AT LEAST ONE package has uri.txt
 * 
 * Returns `{ folders: [{ name, packages: [...], packages_error?: string }, ...],
 *   total_folders, total_packages, q }`
 * 
 * The curation-service may return either a flat folder array or a
 * `{ folders: [...] }` envelope depending on the build — we tolerate
 * both. Packages per folder come from a follow-up call per folder so
 * we can flag which ones have uri.txt vs not.
 */
async function list_workspace(opts = {}) {
    const astools = opts.astools || astools_default;
    const jobs = opts.jobs || jobs_default;
    const scope = opts.scope || 'unprocessed';
    const q = (opts.q || '').trim().toLowerCase();
    const exclude_qa_passed = opts.exclude_qa_passed === true;

    /*
     * Resolve the qa-passed set from tbl_ingest_jobs once per
     * request. Cheap (one indexed SELECT, capped at the lifetime
     * history of the job table — thousands of rows max in steady
     * state). The ASpace QA view is the only caller that opts in
     * via `exclude_qa_passed: true`; other views skip the query.
     */
    let qa_passed_set = null;
    if (exclude_qa_passed) {
        try {
            qa_passed_set = await jobs.get_qa_passed_folders();
        } catch (err) {
            log.warn({ event: 'qa_passed_lookup_failed', err: err.message });
            qa_passed_set = new Set();
        }
    }

    if (!astools.is_configured()) {
        return {
            folders: [],
            total_folders: 0,
            total_packages: 0,
            q: opts.q || '',
            error: 'ASTools service is not configured',
        };
    }

    /*
     * The curation-service has TWO endpoints — /workspace returns
     * folders without uri.txt; /processed returns folders with uri.txt.
     * Pick the right one based on scope so the server does the
     * classification (it's the source of truth — package names alone
     * don't tell us about uri.txt presence). No client-side filtering
     * needed beyond search + qa-passed marker.
     */
    let entries = [];
    const endpoint_name = scope === 'processed' ? 'list_processed' : 'list_workspace';
    try {
        const res =
            scope === 'processed' ? await astools.list_processed() : await astools.list_workspace();
        if (res.status !== 200) {
            return {
                folders: [],
                total_folders: 0,
                total_packages: 0,
                q: opts.q || '',
                error: `ASTools ${endpoint_name} HTTP ${res.status}`,
            };
        }
        entries = _normalize_workspace_entries(res.data);
    } catch (err) {
        return {
            folders: [],
            total_folders: 0,
            total_packages: 0,
            q: opts.q || '',
            error: err.message,
        };
    }

    /*
     * Resolve each folder's package list. The structure-QA build of the
     * curation-service embeds packages + structure_errors directly in
     * the /workspace entries, so no follow-up call is needed — that
     * removes the old N+1 round-trip pattern for the MDO view. Entries
     * without embedded packages (the /processed feed, or an older
     * curation-service) fall back to the per-folder fetch, kept serial
     * to avoid hammering the service — staff page sizes are small.
     */
    const folders = [];
    let total_packages = 0;
    for (const entry of entries) {
        const name = entry.name;
        if (q && !name.toLowerCase().includes(q)) continue;
        if (qa_passed_set && qa_passed_set.has(name)) continue;

        let package_names;
        let packages_error;
        let flags = Array.isArray(entry.structure_errors) ? entry.structure_errors : [];
        /*
         * Size source depends on the path: the MDO view's /workspace
         * entries carry total_bytes inline; the QA / Packaging views
         * start from bare folder names and get it from the per-batch
         * folder-state fetch below (2026-07-30 — the Size column was
         * blank on those views until then).
         */
        let total_bytes = Number.isFinite(entry.total_bytes) ? entry.total_bytes : null;
        if (Array.isArray(entry.packages)) {
            package_names = entry.packages.map((p) =>
                typeof p === 'string' ? p : p && p.name
            ).filter(Boolean);
        } else {
            const folder = await _fetch_folder_state(astools, name);
            package_names = folder.packages.map((p) => p.name);
            packages_error = folder.packages_error;
            if (Array.isArray(folder.structure_errors)) {
                flags = folder.structure_errors;
            }
            if (Number.isFinite(folder.total_bytes)) {
                total_bytes = folder.total_bytes;
            }
        }

        folders.push({
            name,
            packages: package_names,
            packages_error,
            structure_errors: flags,
            /*
             * Pre-rendered for the view: plain-English notices (wording
             * owned by libs/structure_flags) and the blocked bit that
             * disables the Make Digital Objects action. Both are also
             * enforced server-side in run_make_digital_objects /
             * submit_to_ingest — the view state is affordance, not the
             * gate.
             */
            structure_notices: structure_flags.format_structure_errors(flags, name),
            blocked: structure_flags.has_blocking_errors(flags),
            /*
             * Batch size from the curation scan (null when the scan
             * couldn't read the folder, or on legacy responses that
             * pre-date the field). The view renders a Size column and
             * a "Large batch" advisory above the threshold.
             */
            total_bytes,
        });
        total_packages += package_names.length;
    }

    return {
        folders,
        total_folders: folders.length,
        total_packages,
        q: opts.q || '',
    };
}

/*
 * The curation-service wraps every successful list response as
 * `{ result: [...], errors: [] }` (note the singular `result`). Some
 * older mocks / staging builds returned a bare array or a `folders`
 * envelope, so we accept all three shapes to keep tests + dev mocks
 * working without forcing a server rev.
 *
 * Entry shapes accepted:
 *   'name'                                        — legacy flat string
 *   { name }                                      — object without QA data
 *   { name, packages, processed, structure_errors } — structure-QA build;
 *     packages/structure_errors are carried through so list_workspace can
 *     skip the per-folder fetch and render QA flags.
 */
function _normalize_workspace_entries(data) {
    let raw = null;
    if (Array.isArray(data)) raw = data;
    else if (data && Array.isArray(data.result)) raw = data.result;
    else if (data && Array.isArray(data.folders)) raw = data.folders;
    else if (data && Array.isArray(data.results)) raw = data.results;
    if (!raw) return [];
    return raw
        .map((entry) => {
            if (typeof entry === 'string') return { name: entry };
            if (entry && typeof entry === 'object') {
                const name = entry.name || entry.folder || null;
                if (!name) return null;
                const normalized = { name };
                if (Array.isArray(entry.packages)) normalized.packages = entry.packages;
                if (Array.isArray(entry.structure_errors)) {
                    normalized.structure_errors = entry.structure_errors;
                }
                /*
                 * Batch size from the structure-QA scan. Carried
                 * through explicitly — this normalizer WHITELISTS
                 * fields, so a new response field is invisible to
                 * list_workspace until it's added here (total_bytes
                 * was silently dropped at first; the Size column
                 * rendered dashes against a healthy API).
                 */
                if (Number.isFinite(entry.total_bytes)) {
                    normalized.total_bytes = entry.total_bytes;
                }
                return normalized;
            }
            return null;
        })
        .filter(Boolean);
}

/*
 * Resolve a folder's package list. The curation-service response is
 * `{ result: ['pkg-A', 'pkg-B', ...], errors: [] }`. We also accept
 * a few legacy shapes (`{packages: ...}`, bare array, object-with-name
 * entries) so test mocks + older mock servers don't have to track the
 * canonical shape.
 */
async function _fetch_folder_state(astools, name) {
    try {
        const res = await astools.list_packages(name);
        if (res.status !== 200 || !res.data) {
            return { name, packages: [], packages_error: `HTTP ${res.status}` };
        }
        const arr = _extract_package_array(res.data);
        if (arr === null) {
            return { name, packages: [], packages_error: 'unexpected response shape' };
        }
        /*
         * The structure-QA build piggybacks `processed` (package names
         * with uri.txt) and `structure_errors` on this response. Both
         * are optional — older curation-services simply don't send them.
         */
        const processed = new Set(
            Array.isArray(res.data && res.data.processed) ? res.data.processed : []
        );
        return {
            name,
            packages: arr.map((p) => {
                const pkg_name = typeof p === 'string' ? p : p && p.name;
                return {
                    name: pkg_name,
                    has_uri_txt:
                        processed.has(pkg_name) ||
                        (typeof p === 'object' && p ? !!p.has_uri_txt : false),
                };
            }),
            structure_errors:
                res.data && Array.isArray(res.data.structure_errors)
                    ? res.data.structure_errors
                    : undefined,
            /*
             * Batch size piggybacked on the same scan (2026-07-30).
             * Optional — older curation-services don't send it.
             */
            total_bytes: Number.isFinite(res.data && res.data.total_bytes)
                ? res.data.total_bytes
                : null,
        };
    } catch (err) {
        return { name, packages: [], packages_error: err.message };
    }
}

/*
 * Server-side structure gate shared by run_make_digital_objects and
 * submit_to_ingest. Fetches the folder's structure flags and refuses
 * when any error-severity flag is present — the disabled buttons in
 * the view are affordance only; this is the enforcement.
 *
 * Fails OPEN on transport errors or older curation-services that don't
 * report flags: the actions were possible before this gate existed, and
 * the curation-service still validates paths itself. Returns null when
 * clear to proceed, or { error, structure_errors } when blocked.
 */
async function _structure_gate(astools, folder) {
    let flags = [];
    try {
        const res = await astools.list_packages(folder);
        if (res.status === 200 && res.data && Array.isArray(res.data.structure_errors)) {
            flags = res.data.structure_errors;
        }
    } catch (err) {
        log.warn({ event: 'structure_gate_unavailable', folder, err: err.message });
        return null;
    }
    if (!structure_flags.has_blocking_errors(flags)) return null;
    const notices = structure_flags
        .format_structure_errors(flags, folder)
        .filter((n) => n.severity === 'error')
        .map((n) => n.text);
    return {
        error:
            `The folder structure of "${folder}" has problems that must be ` +
            `fixed first: ${notices.join(' ')}`,
        structure_errors: flags,
    };
}

function _extract_package_array(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return null;
    if (Array.isArray(data.result)) return data.result;
    if (Array.isArray(data.packages)) return data.packages;
    if (Array.isArray(data.results)) return data.results;
    return null;
}

// --- Actions ---------------------------------------------------------

async function run_make_digital_objects(folder, deps = {}) {
    const astools = deps.astools || astools_default;
    if (!astools.is_configured()) {
        return { ok: false, status: 0, error: 'ASTools is not configured' };
    }
    const gate = await _structure_gate(astools, folder);
    if (gate) {
        log.warn({ event: 'workspace_mdo_blocked_structure', folder });
        return { ok: false, status: 422, error: gate.error, structure_errors: gate.structure_errors };
    }
    try {
        const res = await astools.make_digital_objects(folder);
        return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            body: res.data,
        };
    } catch (err) {
        log.warn({ event: 'workspace_mdo_failed', folder, err: err.message });
        return { ok: false, status: 0, error: err.message };
    }
}

async function revert_to_mdo(folder, deps = {}) {
    const astools = deps.astools || astools_default;
    if (!astools.is_configured()) {
        return { ok: false, status: 0, error: 'ASTools is not configured' };
    }
    try {
        const res = await astools.revert_to_mdo(folder);
        /*
         * No explicit qa-passed clearing needed any more: revert
         * removes uri.txt from every package, which drops the folder
         * off the curation-service /processed feed (source of the
         * QA view), so it disappears regardless of marker state.
         * If the folder later re-enters /processed via a fresh MDO
         * run, that MDO job becomes the most-recent for the folder
         * and naturally invalidates the prior SUCCESSFUL QA marker
         * (see jobs.get_qa_passed_folders).
         */
        return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            body: res.data,
        };
    } catch (err) {
        log.warn({ event: 'workspace_revert_failed', folder, err: err.message });
        return { ok: false, status: 0, error: err.message };
    }
}

/*
 * run_qa_check: for each package in `folder`, read uri.txt → fetch the
 * AS record → run validator. Returns a per-package result array so
 * the dashboard can render a tabbed card. Read-only: no state changes.
 */
async function run_qa_check(folder, deps = {}) {
    const astools = deps.astools || astools_default;
    const aspace = deps.aspace || aspace_default;
    const validator = deps.validator || validator_default;

    if (!astools.is_configured()) {
        return { ok: false, packages: [], error: 'ASTools is not configured' };
    }
    if (!aspace.is_configured()) {
        return { ok: false, packages: [], error: 'ArchivesSpace is not configured' };
    }

    // List packages first.
    let folder_state;
    try {
        folder_state = await _fetch_folder_state(astools, folder);
    } catch (err) {
        return { ok: false, packages: [], error: err.message };
    }
    if (folder_state.packages_error) {
        return { ok: false, packages: [], error: folder_state.packages_error };
    }
    if (folder_state.packages.length === 0) {
        return { ok: true, packages: [], error: null };
    }

    /*
     * One AS session for the whole batch — much cheaper than a fresh
     * session per package. We don't bother refreshing on 401 here
     * because the worker only validates a handful of packages per
     * request; the session won't expire mid-loop.
     */
    let token;
    try {
        token = await aspace.get_session_token();
    } catch (err) {
        return { ok: false, packages: [], error: `ArchivesSpace login failed: ${err.message}` };
    }

    const results = [];
    let all_ok = true;
    for (const pkg of folder_state.packages) {
        const result = await _validate_package(folder, pkg.name, {
            astools,
            aspace,
            validator,
            token,
        });
        if (!result.ok) all_ok = false;
        results.push(result);
    }

    // Best-effort logout.
    aspace.destroy_session_token(token).catch(() => {});

    return { ok: all_ok, packages: results, error: null };
}

async function _validate_package(folder, pkg_name, { astools, aspace, validator, token }) {
    // Step 1 — read uri.txt to learn the AS URI for this package.
    let uri = null;
    try {
        const res = await astools.get_uri(folder, pkg_name);
        if (res.status === 404) {
            return { name: pkg_name, uri: null, ok: false, errors: ['uri.txt missing'] };
        }
        if (res.status !== 200) {
            return {
                name: pkg_name,
                uri: null,
                ok: false,
                errors: [`uri.txt fetch HTTP ${res.status}`],
            };
        }
        /*
         * Canonical curation-service shape is `{result:{uris:[...]}}`,
         * but we also tolerate legacy bare strings + `{uri}` envelopes —
         * _extract_uri handles all of those.
         */
        uri = _extract_uri(res);
        if (!uri) {
            return { name: pkg_name, uri: null, ok: false, errors: ['uri.txt is empty'] };
        }
    } catch (err) {
        return { name: pkg_name, uri: null, ok: false, errors: [err.message] };
    }

    // Step 2 — fetch the AS record.
    let metadata;
    try {
        const res = await aspace.get_record(uri, token);
        if (res.status !== 200 || !res.data) {
            return {
                name: pkg_name,
                uri,
                ok: false,
                errors: [`ArchivesSpace record HTTP ${res.status}`],
            };
        }
        metadata = res.data;
    } catch (err) {
        return { name: pkg_name, uri, ok: false, errors: [`fetch failed: ${err.message}`] };
    }

    // Step 3 — run the validator.
    const errors = validator.validate_record(metadata);
    return {
        name: pkg_name,
        uri,
        ok: errors.length === 0,
        errors,
    };
}

/*
 * submit_to_ingest: queue one package per archival object in the folder.
 * The actual ingest pipeline runs against the new queue rows; this
 * helper just enqueues them.
 */
async function submit_to_ingest(folder, actor, deps = {}) {
    const astools = deps.astools || astools_default;
    const model = deps.model || model_default;

    if (!astools.is_configured()) {
        return { ok: false, error: 'ASTools is not configured' };
    }

    /*
     * PRE-FLIGHT GATES — run before any queue inserts. If either
     * fails, no queue rows are created and submit_to_ingest returns
     * a sev-error envelope for the dashboard to render.
     *
     * 1. Structure gate: loose files / empty or nested packages in
     *    the batch would crash or corrupt the ready-stage pipeline —
     *    refuse with the same staff wording the list views show.
     * 2. Collection gate: see _ensure_collection_exists.
     */
    const structure_block = await _structure_gate(astools, folder);
    if (structure_block) {
        log.warn({ event: 'workspace_submit_blocked_structure', folder });
        return { ok: false, error: structure_block.error };
    }
    const gate = await _ensure_collection_exists(folder, deps);
    if (!gate.ok) {
        return { ok: false, error: gate.error };
    }

    let folder_state;
    try {
        folder_state = await _fetch_folder_state(astools, folder);
    } catch (err) {
        return { ok: false, error: err.message };
    }
    if (folder_state.packages_error) {
        return { ok: false, error: folder_state.packages_error };
    }
    if (folder_state.packages.length === 0) {
        return { ok: false, error: 'No packages in folder' };
    }

    /*
     * We need a URI per package to set metadata_uri on the queue row;
     * pull each from uri.txt. If any package is missing uri.txt the
     * batch is rejected — the QA view should have caught that earlier.
     */
    const rows = [];
    for (const pkg of folder_state.packages) {
        const res = await astools.get_uri(folder, pkg.name).catch(() => null);
        const uri = _extract_uri(res);
        if (!uri) {
            return {
                ok: false,
                error: `Package ${pkg.name} is missing uri.txt — cannot submit`,
            };
        }
        rows.push({
            batch: folder,
            package: pkg.name,
            /*
             * The column's name is the truth: this is the local
             * collection mirror's PID (a UUID), resolved by the
             * pre-flight gate above. Three uses downstream:
             * 
             *   1. Stage 2 (upload) passes this to the curation-API
             *      as the `uuid` query param for move_to_ingest /
             *      move_to_sftp. The AM SFTP host ends up with one
             *      `<sftp_path>/<collection_pid>/<package>/` per
             *      package, all rooted at the SAME collection_pid
             *      directory (matches v1's collection-shared layout
             *      — see ingest_service.js:508 in v1).
             *   2. Stage 5 (repository build) reads it to populate
             *      is_member_of_collection on the new object row —
             *      no folder-name parsing needed downstream.
             *   3. The rollback / return-to-packaging path passes
             *      it to clean_up_sftp + move-from-ingest-to-ready
             *      so the right SFTP folder is found.
             * 
             * The human-readable folder name still lives in `batch`
             * for traceability.
             * 
             * Note on UUID minting: collection_pid is minted ONCE
             * per collection by the pre-flight gate — fresh
             * randomUUID() ONLY when no local mirror exists for the
             * AS resource URI. Existing collections reuse their PID,
             * so sibling submits land in the same SFTP folder.
             */
            collection_uuid: gate.collection_pid,
            metadata_uri: uri,
        });
    }

    try {
        const ids = await model.queue_packages(rows, { actor: actor || 'staff' });
        /*
         * No explicit qa-passed clearing here: the controller
         * records a `packaging_and_ingesting` job for this folder
         * around this call, and that job (newer than any prior QA
         * pass) naturally invalidates the qa-passed status via
         * jobs.get_qa_passed_folders' "latest job per folder" rule.
         */
        return { ok: true, queue_ids: ids, count: ids.length };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/*
 * Extract a single AS URI from a /workspace/uri response. The canonical
 * curation-service shape is:
 *   { result: { uris: ['<uri>'], files: ['uri.txt', ...] }, errors: [] }
 * — uris may be empty if the file doesn't exist. We also fall back to
 * legacy shapes (bare string, {uri}, {value}) so test mocks stay simple.
 */
function _extract_uri(res) {
    if (!res || res.status !== 200 || !res.data) return null;
    if (typeof res.data === 'string') return res.data.trim() || null;
    if (typeof res.data !== 'object') return null;
    // Canonical: result.uris[0]
    if (res.data.result && Array.isArray(res.data.result.uris)) {
        const v = String(res.data.result.uris[0] || '').trim();
        if (v) return v;
    }
    // Canonical (string-result): result is the URI string itself.
    if (typeof res.data.result === 'string') {
        const v = res.data.result.trim();
        if (v) return v;
    }
    // Legacy / test-mock shapes.
    const fallback = String(res.data.uri || res.data.value || '').trim();
    return fallback || null;
}

/*
 * (Earlier versions of this file maintained an in-process Set of
 * qa-passed folder names plus mark_/clear_/test-reset helpers. That
 * machinery was replaced by jobs.get_qa_passed_folders, which reads
 * tbl_ingest_jobs. The marker now survives process restart and
 * auto-invalidates when a more recent MDO/submit/revert job lands
 * for the same folder — see list_workspace and the file's header
 * comment for the contract.)
 */

module.exports = {
    list_workspace,
    run_make_digital_objects,
    run_qa_check,
    revert_to_mdo,
    submit_to_ingest,
};
