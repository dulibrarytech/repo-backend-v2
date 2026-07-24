'use strict';

/*
 * Job-history model. Records workflow-level actions (Make Digital
 * Objects, ASpace Description QA, Submit to Ingest) into
 * tbl_ingest_jobs and exposes a paginated list for the dashboard
 * history view.
 * 
 * Why this is a separate table:
 * 
 *   The 5-stage worker writes per-package state into tbl_ingest_queue
 *   and per-row state transitions into tbl_ingest_events. Neither
 *   captures the "staff submitted an MDO run on this folder" event
 *   — they're both per-package. tbl_ingest_jobs sits above both with
 *   one row per action submission, which is what staff browse from
 *   the history view.
 * 
 *   Actor name is denormalized at write time (looked up in tbl_users
 *   then stored) so the list query is a single indexed SELECT — no
 *   cross-DB join required.
 */

const { randomUUID } = require('node:crypto');
const { db, db_queue } = require('../config/db');
const tables = require('../config/db_tables');
const users_model = require('../users/model');
const { ValidationError } = require('../libs/errors');

const JOBS = tables.ingest_jobs;

const JOB_TYPES = new Set([
    'make_digital_objects',
    'archivesspace_description_qa',
    'packaging_and_ingesting',
]);

const STATUSES = new Set(['SUCCESSFUL', 'FAILED']);

/*
 * Resolve a human-readable name for the audit row. The actor is
 * usually a du_id (JWT principal); we look that up in tbl_users
 * and stitch first + last into a single display string. Returns ''
 * when the user can't be resolved — better than blocking the job
 * record on a failed lookup.
 */
async function _resolve_actor_name(actor) {
    if (!actor) return '';
    /*
     * Actor strings come from the JWT principal — usually a du_id,
     * sometimes an email, occasionally `staff (ip)` for unidentified
     * sessions. Look the du_id case up in tbl_users; otherwise just
     * store the actor string unchanged (it's already human-readable).
     */
    try {
        const user = await users_model.get_by_du_id(actor).catch(() => null);
        if (user) {
            const first = user.first_name || '';
            const last = user.last_name || '';
            const combined = `${first} ${last}`.trim();
            if (combined) return combined;
            if (user.email) return user.email;
        }
    } catch {
        // Ignore — fall through.
    }
    return '';
}

/*
 * Record one job-history row. Used by the dashboard action handlers
 * (make_digital_objects_action, aspace_qa_check_action,
 * submit_ingest_action). All inputs are validated; a malformed call
 * fails loudly rather than write a corrupt row.
 * 
 * Returns the inserted job_uuid.
 */
async function record_job({
    job_type,
    status,
    collection_folder,
    packages,
    actor,
    error,
    resolved_actor_name, // optional — if caller already knows it, skip lookup
}) {
    if (!JOB_TYPES.has(job_type)) {
        throw new ValidationError(`unknown job_type: ${job_type}`);
    }
    if (!STATUSES.has(status)) {
        throw new ValidationError(`unknown status: ${status}`);
    }
    if (!collection_folder || typeof collection_folder !== 'string') {
        throw new ValidationError('collection_folder is required');
    }

    const job_uuid = randomUUID();
    const actor_name =
        typeof resolved_actor_name === 'string'
            ? resolved_actor_name
            : await _resolve_actor_name(actor);

    /*
     * Truncate the error text — staff don't need a 100KB stack trace
     * on a list view, and the column is plain TEXT (no built-in cap).
     */
    const error_text = typeof error === 'string' && error.length > 0 ? error.slice(0, 1000) : null;

    // Stringify packages as JSON. Tolerate already-stringified input.
    let packages_json = null;
    if (Array.isArray(packages)) {
        packages_json = JSON.stringify(packages);
    } else if (typeof packages === 'string' && packages.length > 0) {
        packages_json = packages;
    }

    await db_queue()(JOBS).insert({
        job_uuid,
        job_type,
        status,
        collection_folder,
        packages: packages_json,
        actor: actor || '',
        actor_name,
        error: error_text,
    });

    return job_uuid;
}

/*
 * List jobs newest-first with optional filtering. Used by the
 * dashboard history page.
 * 
 * `filters`:
 *   q                — substring match against collection_folder or packages
 *                      (packages is the JSON-array TEXT column, so a LIKE
 *                      hits the package names inside it; staff search by
 *                      folder or package, not by job id — 2026-07-24)
 *   job_type         — exact match
 *   status           — 'SUCCESSFUL' | 'FAILED'
 *   collection_folder — exact match (deep-link from a workspace row)
 * 
 * `opts`:
 *   limit, offset — default 50 / 0; limit capped at 200
 * 
 * Returns `{ rows, total, limit, offset }`. Rows have packages
 * already parsed back to an array.
 */
async function list_jobs(filters = {}, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);

    const base = db_queue()(JOBS);
    if (filters.job_type && JOB_TYPES.has(filters.job_type)) {
        base.where({ job_type: filters.job_type });
    }
    if (filters.status && STATUSES.has(filters.status)) {
        base.where({ status: filters.status });
    }
    if (filters.collection_folder) {
        base.where({ collection_folder: filters.collection_folder });
    }
    if (filters.q) {
        const needle = `%${String(filters.q).trim()}%`;
        base.where(function () {
            this.where('collection_folder', 'like', needle).orWhere('packages', 'like', needle);
        });
    }

    const [rows, count_result] = await Promise.all([
        base.clone().orderBy('created', 'desc').orderBy('id', 'desc').limit(limit).offset(offset),
        base.clone().count('* as n').first(),
    ]);

    return {
        rows: rows.map((r) => ({
            ...r,
            packages: _parse_packages(r.packages),
        })),
        total: count_result ? Number(count_result.n) : 0,
        limit,
        offset,
    };
}

/*
 * Compute the set of collection folders whose MOST RECENT job
 * (any job_type) is a SUCCESSFUL archivesspace_description_qa.
 * 
 * Semantics chosen so the ASpace QA view auto-hides folders that
 * staff has already validated, AND naturally re-shows them after
 * any subsequent activity:
 * 
 *   - Folder passes QA           → latest job is SUCCESSFUL QA      → HIDDEN
 *   - QA fails                   → latest job is FAILED QA          → shown (needs fix)
 *   - MDO re-run after QA pass   → latest job is MDO                → shown (re-verify)
 *   - Submit to ingest           → latest job is packaging_…        → shown
 *     (in practice the folder also drops off the curation-service's
 *      /processed listing once it's been submitted, so it
 *      disappears from the view regardless)
 * 
 * Implementation: pull every QA job and every NON-QA job that's
 * MORE RECENT than the QA job for the same folder. A folder is
 * qa-passed iff its newest row in this filtered set is a successful
 * QA. We do this in JS (one indexed SELECT) rather than a window
 * function so it stays portable across MariaDB + sqlite (tests).
 */
async function get_qa_passed_folders() {
    /*
     * Single query, ordered newest first. Walk and take the first
     * row per folder — that row is by definition the "most recent
     * job" for that folder.
     */
    const rows = await db_queue()(JOBS)
        .select('collection_folder', 'job_type', 'status')
        .orderBy([
            { column: 'created', order: 'desc' },
            { column: 'id', order: 'desc' },
        ]);
    const passed = new Set();
    const seen = new Set();
    for (const r of rows) {
        const folder = r.collection_folder;
        if (!folder || seen.has(folder)) continue;
        seen.add(folder);
        if (r.job_type === 'archivesspace_description_qa' && r.status === 'SUCCESSFUL') {
            passed.add(folder);
        }
    }
    return passed;
}

function _parse_packages(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'string') return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

module.exports = {
    record_job,
    list_jobs,
    get_qa_passed_folders,
    JOB_TYPES,
    STATUSES,
    _resolve_actor_name,
    /*
     * Test helper — direct access to the tables module so tests can
     * reset the table between cases without re-importing.
     */
    _table_name: JOBS,
    _db_queue: db_queue,
    _db_repo: db,
};
