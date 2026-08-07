'use strict';

/*
 * Workspace orchestration for the v2 ingest dashboard.
 *
 * Three pre-ingest pages share this module:
 *
 *   - Make Digital Objects (scope='unprocessed')   — folders lacking uri.txt
 *   - ASpace Description QA (scope='processed')    — folders with uri.txt
 *   - Packaging and Ingesting (scope='processed')  — same data, different action
 *
 * Each calls list_workspace({ scope, q, exclude_qa_passed }), which queries the
 * curation-service AStools endpoint and shapes the folder list for the
 * workspace-table partial. The action helpers (run_make_digital_objects,
 * run_qa_check, submit_to_ingest, revert_to_mdo) hold the per-action workflow
 * so the dashboard controller stays thin.
 *
 * QA-passed state lives in tbl_ingest_jobs and is read through
 * jobs.get_qa_passed_folders on every list_workspace call, never cached.
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
const kaltura_controller = require('../kaltura/controller');
const kaltura_config = require('../kaltura/config');

/*
 * Default Kaltura collaborator for run_make_digital_objects. Kept as a
 * two-method facade so tests inject a plain object instead of stubbing
 * the controller + config modules.
 */
const kaltura_default = {
    is_configured: () => kaltura_config.is_configured(),
    resolve_packages: (packages) => kaltura_controller.resolve_packages(packages),
};

/*
 * --- Collection-resource gate (pre-flight for submit_to_ingest) -----
 *
 * A folder name like `new_U358_LDT_TEST_Collection-resources_1204` carries the
 * ArchivesSpace resource ID in its last `-` segment. The gate runs once at
 * submit time, BEFORE queue_packages, and answers two questions:
 *   1. Is the AS resource real? Halt and alert if not.
 *   2. Does a local collection mirror exist? Auto-create it if not.
 */

/*
 * The AS resource URI parsed from the folder name's last `-` segment:
 *   `<anything>-resources_<digits>`        → /repositories/<n>/resources/<digits>
 *   `<anything>-archival_objects_<digits>` → /repositories/<n>/archival_objects/<digits>
 *
 * Throws on unparseable input; the controller renders that as a sev-error
 * action card.
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
 * Resolve the local collection for a folder:
 *   { ok: true,  collection_pid, created }  — existed (created:false) or created
 *   { ok: false, error }                    — unparseable folder or AS fetch failed
 *
 * The find-or-create (local lookup → AS fetch → handle mint → insert) is
 * delegated to repository/collection_provision, shared with the dashboard's
 * "create collection" flow. Ingest collections are top-level.
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
        // Ingest-specific audit event — carries the folder name.
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
 * Returns { folders: [{ name, packages, packages_error?, structure_errors,
 * structure_notices, blocked, total_bytes }, ...], total_folders,
 * total_packages, q }, or the same shape with an `error` string and empty
 * folders when the curation-service is unconfigured or answers non-200.
 */
async function list_workspace(opts = {}) {
    const astools = opts.astools || astools_default;
    const jobs = opts.jobs || jobs_default;
    const scope = opts.scope || 'unprocessed';
    const q = (opts.q || '').trim().toLowerCase();
    const exclude_qa_passed = opts.exclude_qa_passed === true;

    /*
     * One indexed SELECT per request, only for callers passing
     * exclude_qa_passed (the ASpace QA view). Falls back to an empty Set on
     * error, which hides nothing.
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
     * Two curation-service endpoints: /workspace returns folders without
     * uri.txt, /processed those with it. The server classifies — package names
     * alone say nothing about uri.txt presence — so the only client-side
     * filtering left is the search term and the qa-passed marker.
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
     * Entries that embed packages + structure_errors (the structure-QA build's
     * /workspace feed) need no follow-up call. The rest — /processed, or an
     * older curation-service — fall back to a per-folder fetch, kept serial.
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
         * Inline on the /workspace feed; otherwise it comes from the
         * folder-state fetch below.
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
             * Pre-rendered for the view: plain-English notices (wording owned
             * by libs/structure_flags) and the bit that disables Make Digital
             * Objects. Affordance only — _structure_gate is the enforcement.
             */
            structure_notices: structure_flags.format_structure_errors(flags, name),
            blocked: structure_flags.has_blocking_errors(flags),
            /*
             * Batch size from the curation scan; null when the scan could not
             * read the folder or the response pre-dates the field. Drives the
             * Size column and the "Large batch" advisory.
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
 * Normalize a list response to `[{ name, packages?, structure_errors?,
 * total_bytes? }]`.
 *
 * Envelopes accepted: a bare array, `{ result: [...] }` (canonical, note the
 * singular), `{ folders: [...] }`, `{ results: [...] }`.
 *
 * Entries accepted:
 *   'name'                                          — legacy flat string
 *   { name }                                        — object without QA data
 *   { name, packages, processed, structure_errors } — structure-QA build
 *
 * This WHITELISTS fields: a new response field stays invisible to
 * list_workspace until it is added here.
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
                // Batch size from the structure-QA scan.
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
 * A folder's package list, as { name, packages: [{ name, has_uri_txt }],
 * packages_error?, structure_errors?, total_bytes }. Never throws — transport
 * failures come back as packages_error.
 *
 * The canonical response is `{ result: ['pkg-A', ...], errors: [] }`; a few
 * legacy shapes are also accepted so older mocks keep working.
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
        // `processed` lists package names with uri.txt. Optional.
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
            // Piggybacked on the same scan. Optional.
            total_bytes: Number.isFinite(res.data && res.data.total_bytes)
                ? res.data.total_bytes
                : null,
        };
    } catch (err) {
        return { name, packages: [], packages_error: err.message };
    }
}

/*
 * Server-side structure gate, shared by run_make_digital_objects and
 * submit_to_ingest. Returns null when clear to proceed, or
 * { error, structure_errors } when any error-severity flag is present.
 *
 * Fails OPEN on transport errors and against curation-services that do not
 * report flags.
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

/*
 * --- Kaltura media detection (Make Digital Objects) -----------------
 *
 * Streaming masters live in Kaltura, and MDO is the step that writes
 * each file's Kaltura entry id into ArchivesSpace (the component's
 * "Identifier" field) — that id later flows into the repository record
 * via the exporter at ingest Stage 1. Files are treated as
 * Kaltura-hosted by extension; the set mirrors the formats DU sends to
 * Kaltura (matching the MIME families Stage 5 treats as streamed).
 */
const KALTURA_MEDIA_EXTENSIONS = new Set([
    // video
    'mp4', 'mov', 'm4v', 'avi', 'mkv', 'mpg', 'mpeg', 'wmv',
    // audio
    'wav', 'mp3', 'm4a', 'flac', 'ogg', 'aiff', 'aif', 'wma',
]);

function _is_kaltura_media(filename) {
    if (typeof filename !== 'string') return false;
    const dot = filename.lastIndexOf('.');
    if (dot <= 0) return false;
    return KALTURA_MEDIA_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}

/*
 * Enumerate the folder's audio/video files, one entry per package:
 *   { ok: true,  media: [{ package, files: [...] }, ...] }
 *   { ok: false, error }   — enumeration failed part-way
 *
 * Failure semantics are deliberately split:
 *   - If the package LIST can't be fetched at all, the caller proceeds
 *     without Kaltura (fail open, like the structure gate) — the MDO
 *     call itself will surface a curation-service outage loudly.
 *   - If the list succeeded but a per-package file fetch fails, we
 *     BLOCK: the service is demonstrably up, so proceeding could
 *     silently skip a media file — the exact defect this path exists
 *     to prevent (see notes/MDO_KALTURA_WORKFLOW_NOTES.md).
 */
async function _collect_kaltura_media(astools, folder) {
    let folder_state;
    try {
        folder_state = await _fetch_folder_state(astools, folder);
    } catch (err) {
        folder_state = { packages: [], packages_error: err.message };
    }
    if (folder_state.packages_error) {
        log.warn({
            event: 'workspace_mdo_kaltura_enum_unavailable',
            folder,
            err: folder_state.packages_error,
        });
        return { ok: true, media: [] };
    }

    const media = [];
    for (const pkg of folder_state.packages) {
        if (!pkg || !pkg.name) continue;
        let res;
        try {
            res = await astools.get_uri(folder, pkg.name);
        } catch (err) {
            log.warn({
                event: 'workspace_mdo_kaltura_enum_failed',
                folder,
                package: pkg.name,
                err: err.message,
            });
            return {
                ok: false,
                error:
                    `Could not check "${pkg.name}" for audio/video files, so Make ` +
                    `Digital Objects was not started. Try again in a minute; if this ` +
                    `keeps happening, contact LDT.`,
            };
        }
        const files =
            res && res.status === 200 && res.data && res.data.result &&
            Array.isArray(res.data.result.files)
                ? res.data.result.files
                : [];
        const media_files = files.filter(_is_kaltura_media);
        if (media_files.length > 0) {
            media.push({ package: pkg.name, files: media_files });
        }
    }
    return { ok: true, media };
}

/*
 * Turn non-resolving Kaltura rows into one staff-actionable message per
 * file. The row messages ("File does not have an Entry ID…", "File has
 * more than 1 Entry ID…") come from kaltura/controller._resolve_file.
 */
function _format_kaltura_failures(rows) {
    return rows.map((r) => `${r.package}/${r.file}: ${r.message || 'could not be matched in Kaltura.'}`);
}

// --- Actions ---------------------------------------------------------

async function run_make_digital_objects(folder, deps = {}) {
    const astools = deps.astools || astools_default;
    const kaltura = deps.kaltura || kaltura_default;
    if (!astools.is_configured()) {
        return { ok: false, status: 0, error: 'ASTools is not configured' };
    }
    const gate = await _structure_gate(astools, folder);
    if (gate) {
        log.warn({ event: 'workspace_mdo_blocked_structure', folder });
        return { ok: false, status: 422, error: gate.error, structure_errors: gate.structure_errors };
    }

    /*
     * Kaltura pre-flight: resolve every audio/video file to its entry id
     * BEFORE running MDO, and refuse to run when any media file cannot be
     * resolved. A partial run would create AS components with no
     * Identifier, and nothing downstream heals that silently — staff fix
     * the Kaltura entry, then simply re-run this action.
     */
    const enumeration = await _collect_kaltura_media(astools, folder);
    if (!enumeration.ok) {
        return { ok: false, status: 422, error: enumeration.error };
    }

    let kaltura_files = null;
    if (enumeration.media.length > 0) {
        if (!kaltura.is_configured()) {
            return {
                ok: false,
                status: 422,
                error:
                    `"${folder}" contains audio/video files, but the Kaltura ` +
                    `connection is not set up on this server, so their Kaltura IDs ` +
                    `cannot be attached. Contact LDT before running Make Digital ` +
                    `Objects on this folder.`,
            };
        }
        let rows;
        try {
            rows = await kaltura.resolve_packages(enumeration.media);
        } catch (err) {
            log.warn({ event: 'workspace_mdo_kaltura_resolve_failed', folder, err: err.message });
            return {
                ok: false,
                status: 422,
                error:
                    `Looking up Kaltura IDs for "${folder}" failed (${err.message}). ` +
                    `Make Digital Objects was not started — try again in a minute; ` +
                    `if this keeps happening, contact LDT.`,
            };
        }

        /*
         * Every enumerated media file must come back as exactly one
         * status=1 row. Anything else — no match, multi-match, or a file
         * the resolver never reported on — blocks the run.
         */
        const resolved = new Map();
        for (const row of rows || []) {
            if (row && row.status === 1 && row.entry_id) {
                resolved.set(`${row.package}\n${row.file}`, row.entry_id);
            }
        }
        const failures = [];
        for (const pkg of enumeration.media) {
            for (const file of pkg.files) {
                if (!resolved.has(`${pkg.package}\n${file}`)) {
                    const row = (rows || []).find(
                        (r) => r && r.package === pkg.package && r.file === file
                    );
                    failures.push(
                        row || {
                            package: pkg.package,
                            file,
                            message: 'No result came back from the Kaltura lookup.',
                        }
                    );
                }
            }
        }
        if (failures.length > 0) {
            log.warn({
                event: 'workspace_mdo_blocked_kaltura',
                folder,
                failures: failures.length,
            });
            return {
                ok: false,
                status: 422,
                error:
                    `${failures.length} audio/video file(s) in "${folder}" could not ` +
                    `be matched to a single Kaltura entry, so Make Digital Objects ` +
                    `was not started. Fix each file in Kaltura, then run this step ` +
                    `again: ${_format_kaltura_failures(failures).join(' ')}`,
                kaltura_failures: failures,
            };
        }

        kaltura_files = [];
        for (const pkg of enumeration.media) {
            for (const file of pkg.files) {
                kaltura_files.push({
                    package: pkg.package,
                    file,
                    entry_id: resolved.get(`${pkg.package}\n${file}`),
                });
            }
        }
    }

    try {
        const res = kaltura_files
            ? await astools.make_digital_objects(folder, {
                  is_kaltura: 1,
                  files: kaltura_files,
              })
            : await astools.make_digital_objects(folder);
        const result = {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            body: res.data,
        };
        if (kaltura_files && result.ok) {
            result.kaltura = { attached: kaltura_files.length };
        }
        return result;
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
         * No qa-passed clearing needed: revert removes uri.txt from every
         * package, dropping the folder off the /processed feed the QA view
         * reads.
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
     * One AS session for the whole batch. No 401 refresh: a QA run validates a
     * handful of packages, so the session cannot expire mid-loop.
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
 * Queue one row per archival-object package in the folder. The pipeline then
 * runs against those rows; this only enqueues them.
 */
async function submit_to_ingest(folder, actor, deps = {}) {
    const astools = deps.astools || astools_default;
    const model = deps.model || model_default;

    if (!astools.is_configured()) {
        return { ok: false, error: 'ASTools is not configured' };
    }

    /*
     * PRE-FLIGHT GATES, before any queue insert. Either failing means zero
     * queue rows and a sev-error envelope for the dashboard to render.
     *
     * 1. Structure gate — refuses with the same wording the list views show.
     * 2. Collection gate — see _ensure_collection_exists.
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
     * metadata_uri comes from each package's uri.txt. A package missing one
     * rejects the whole batch; the QA view should have caught it earlier.
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
             * The local collection mirror's PID (a UUID), not a folder name.
             * Read downstream by Stage 2 (the curation-API `uuid` param),
             * Stage 5 (is_member_of_collection on the new object row), and the
             * rollback path (to find the right SFTP folder). The
             * human-readable folder name stays in `batch`.
             */
            collection_uuid: gate.collection_pid,
            metadata_uri: uri,
        });
    }

    try {
        const ids = await model.queue_packages(rows, { actor: actor || 'staff' });
        /*
         * No qa-passed clearing needed: the controller records a
         * packaging_and_ingesting job around this call, and
         * get_qa_passed_folders keys off the latest job per folder.
         */
        return { ok: true, queue_ids: ids, count: ids.length };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/*
 * A single AS URI from a /workspace/uri response, or null. The canonical shape
 * is { result: { uris: ['<uri>'], files: [...] }, errors: [] }, where uris is
 * empty when the file does not exist. Legacy shapes (bare string, {uri},
 * {value}) are also accepted.
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

module.exports = {
    list_workspace,
    run_make_digital_objects,
    run_qa_check,
    revert_to_mdo,
    submit_to_ingest,
};
