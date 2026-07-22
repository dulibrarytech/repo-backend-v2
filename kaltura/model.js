'use strict';

/*
 * Kaltura model — knex CRUD on the two Kaltura queue tables in the
 * repo_queue database.
 * 
 *   tbl_kaltura_package_queue
 *     id INT PK
 *     package VARCHAR(255)   — archival package name
 *     files LONGTEXT         — JSON-stringified array of filenames
 *     is_processed TINYINT   — 0 = waiting, 1 = drained
 * 
 *   tbl_kaltura_ids
 *     id INT PK
 *     package VARCHAR(255)
 *     file VARCHAR(255)
 *     entry_id VARCHAR(255)  — single id, JSON array string (multi),
 *                              or '0_0' (no match)
 *     status TINYINT         — 0 = not found, 1 = single match, 2 = multi-match
 *     message VARCHAR(255)
 * 
 * All writes go through this module so callers don't depend on the
 * physical table names — config/db_tables.js owns those.
 */

const { db_queue } = require('../config/db');
const tables = require('../config/db_tables');
const { ValidationError } = require('../libs/errors');
const log = require('../libs/log');

const QUEUE = tables.kaltura_package_queue;
const IDS = tables.kaltura_ids;

// --- Queue table -----------------------------------------------------

/*
 * Bulk-insert N packages into the kaltura queue. Each row's `files`
 * is JSON-stringified so it round-trips through the LONGTEXT column.
 * Returns the count of rows we asked the DB to insert.
 * 
 * Caller responsibility:
 *   - `packages` shape: `[{ package, files: [string, ...] }, ...]`
 *   - `files` may already be a string (JSON-encoded); we tolerate
 *     both shapes to match the legacy controller contract.
 */
async function queue_packages(packages) {
    if (!Array.isArray(packages) || packages.length === 0) {
        throw new ValidationError('packages must be a non-empty array');
    }
    const rows = packages.map((p, i) => {
        if (!p || typeof p !== 'object') {
            throw new ValidationError(`packages[${i}] must be an object`);
        }
        if (!p.package || typeof p.package !== 'string') {
            throw new ValidationError(`packages[${i}].package must be a non-empty string`);
        }
        const files = Array.isArray(p.files)
            ? JSON.stringify(p.files)
            : typeof p.files === 'string'
              ? p.files
              : '[]';
        return {
            package: p.package,
            files,
            is_processed: 0,
        };
    });
    const knex = db_queue();
    await knex(QUEUE).insert(rows);
    return { count: rows.length };
}

/*
 * Peek at the next unprocessed queue row. Returns null when the queue
 * is drained; the caller uses that as the loop-exit condition.
 */
async function get_next_package() {
    const row = await db_queue()(QUEUE).where({ is_processed: 0 }).orderBy('id', 'asc').first();
    return row || null;
}

/*
 * Flip a queue row to is_processed=1. Idempotent — the second call
 * returns affected=0 which the caller ignores. We update by package
 * name (not id) to match the legacy controller's call site, but the
 * callers should pass the canonical id whenever they have it.
 */
async function mark_package_processed(package_name) {
    if (!package_name) throw new ValidationError('package_name is required');
    const affected = await db_queue()(QUEUE)
        .where({ package: package_name })
        .update({ is_processed: 1 });
    return { affected };
}

/*
 * List all queue rows that haven't been drained. Used by the
 * /api/v1/kaltura/queue read endpoint.
 */
async function list_pending_packages() {
    return db_queue()(QUEUE).where({ is_processed: 0 }).orderBy('id', 'asc');
}

// --- IDs table -------------------------------------------------------

/*
 * Bulk-insert resolved {file, entry_id} pairs. Each row carries the
 * status enum (0/1/2) and a human-readable message so staff can
 * scan the table directly. Empty input is a no-op (returns count=0)
 * — saves the caller a guard at every call site.
 */
async function save_entry_ids(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return { count: 0 };
    }
    const sanitized = rows.map((r, i) => {
        if (!r || typeof r !== 'object') {
            throw new ValidationError(`rows[${i}] must be an object`);
        }
        if (typeof r.package !== 'string' || typeof r.file !== 'string') {
            throw new ValidationError(`rows[${i}] must have string package + file`);
        }
        return {
            package: r.package,
            file: r.file,
            entry_id: r.entry_id !== null && r.entry_id !== undefined ? String(r.entry_id) : '0_0',
            status: Number.isFinite(r.status) ? r.status : 0,
            message: r.message ? String(r.message).slice(0, 255) : null,
        };
    });
    const knex = db_queue();
    await knex(IDS).insert(sanitized);
    return { count: sanitized.length };
}

/*
 * List every resolved entry id, newest first. Powers the
 * /api/v1/kaltura/queue/entry_ids read endpoint.
 */
async function list_entry_ids() {
    return db_queue()(IDS).orderBy('id', 'desc');
}

/*
 * Look up the kaltura_id for a single archival file. Used by the
 * repository stage (post-AM) when it builds the parts array — each
 * part may have an associated kaltura entry id resolved earlier in
 * the workflow. Returns null when no row exists (the file isn't a
 * kaltura asset) or the row has status=0 (lookup failed).
 */
async function get_entry_id_for_file(package_name, file) {
    if (!package_name || !file) return null;
    const row = await db_queue()(IDS)
        .where({ package: package_name, file, status: 1 })
        .first();
    return row && row.entry_id ? row.entry_id : null;
}

// --- Maintenance -----------------------------------------------------

/*
 * Hard-delete both tables. Staff trigger this from the admin queue UI
 * when they want to retry a botched batch from scratch. We delete the
 * IDs first so a partial failure leaves an empty IDs table + a populated
 * queue table — re-running the controller is then a clean retry.
 */
async function clear_queue() {
    const knex = db_queue();
    const ids_count = await knex(IDS).del();
    const queue_count = await knex(QUEUE).del();
    log.info({
        event: 'kaltura_queue_cleared',
        ids: ids_count,
        queue: queue_count,
    });
    return { ids: ids_count, queue: queue_count };
}

module.exports = {
    queue_packages,
    get_next_package,
    mark_package_processed,
    list_pending_packages,
    save_entry_ids,
    list_entry_ids,
    get_entry_id_for_file,
    clear_queue,
};
