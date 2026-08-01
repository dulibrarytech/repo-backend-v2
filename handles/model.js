'use strict';

/*
 * Hand-minted handles — the model behind the Admin Utils handles view.
 *
 * Admin staff mint a small number of handles directly and remove ones minted
 * by mistake. Unlike ingest-minted handles these are NOT necessarily attached
 * to repository records: they may point at exhibits, finding aids or other DU
 * pages.
 *
 */

const crypto = require('node:crypto');
const validator = require('validator');
const { db } = require('../config/db');
const tables = require('../config/db_tables');
const app_config = require('../config/app');
const log = require('../libs/log');
const handles_client = require('../libs/handles');
const handle_writer_default = require('../libs/handle_writer');
const users_model = require('../users/model');
const { ValidationError, ConflictError, NotFoundError } = require('../libs/errors');

const MAX_PER_SUBMISSION = 5;
const MAX_NOTE = 500;
const MAX_URL = 2048;

/* Matches the value index every service-minted 10176 handle uses. */
const URL_INDEX = 2;

const STATUS = Object.freeze({
    PENDING: 'pending',
    MINTED: 'minted',
    FAILED: 'failed',
    DELETING: 'deleting',
    DELETED: 'deleted',
});

/*
 * Hosts a target may point at. Falls back to the host of HANDLE_TARGET when
 * HANDLE_ALLOWED_TARGET_HOSTS is unset, so an unconfigured deployment is
 * restricted to its own domain rather than open.
 */
function allowed_hosts() {
    const cfg = app_config().handles;
    const configured = (cfg.allowed_target_hosts || '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
    if (configured.length) return configured;

    try {
        return [new URL(cfg.target).hostname.toLowerCase()];
    } catch {
        return [];
    }
}

/*
 * Validate an operator-supplied target. Rejects anything that would let a DU
 * persistent identifier point somewhere it shouldn't — the same open-redirect
 * concern that made us drop the retired service's caller-supplied `target`.
 *
 * Note the suffix match is anchored on a dot, so "du.edu" permits
 * "digitalarchives.du.edu" but NOT "du.edu.evil.com" or "notdu.edu".
 */
function validate_target_url(value) {
    /*
     * Decode first: the sanitize middleware HTML-entity-encodes every string
     * in the body, including slashes (`/` -> `&#x2F;`). An untouched URL
     * arrives as "https:&#x2F;&#x2F;host&#x2F;path", which `new URL()` parses
     * as scheme "https", host "&", fragment "x2F;..." — so validation
     * rejected a perfectly good DU address with `host "&" is not allowed`.
     * Same decode-at-the-boundary treatment as safe_next() and the ASpace
     * URI field in dashboard/controller.js.
     *
     * Decoding is safe here because nothing is trusted afterwards: the value
     * must still parse as a URL, use https, and match the host allowlist, and
     * url.toString() percent-encodes anything exotic left in the path.
     */
    const raw = typeof value === 'string' ? validator.unescape(value).trim() : '';
    if (!raw) throw new ValidationError('Target URL is required.');
    if (raw.length > MAX_URL) {
        throw new ValidationError(`Target URL is longer than ${MAX_URL} characters.`);
    }

    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new ValidationError(`Target URL is not a valid URL: ${raw}`);
    }

    if (url.protocol !== 'https:') {
        throw new ValidationError('Target URL must use https.');
    }
    if (url.username || url.password) {
        throw new ValidationError('Target URL must not contain credentials.');
    }

    const hosts = allowed_hosts();
    if (hosts.length === 0) {
        throw new ValidationError(
            'No allowed target hosts are configured - set '
            + 'HANDLE_ALLOWED_TARGET_HOSTS or HANDLE_TARGET.'
        );
    }

    const host = url.hostname.toLowerCase();
    const permitted = hosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!permitted) {
        throw new ValidationError(
            `Target host "${host}" is not allowed. Permitted: ${hosts.join(', ')}.`
        );
    }
    return url.toString();
}

function validate_note(value) {
    /*
     * Decoded for the same reason as the target URL — otherwise an
     * apostrophe or ampersand is stored as `&#x27;` / `&amp;` and, once EJS
     * re-escapes it for output, displayed literally as that entity. Storing
     * the plain text and letting `<%= %>` escape at render time is the
     * correct division of labour.
     */
    const note = typeof value === 'string' ? validator.unescape(value).trim() : '';
    if (note.length > MAX_NOTE) {
        throw new ValidationError(`Note is longer than ${MAX_NOTE} characters.`);
    }
    return note || null;
}

function qualified(suffix) {
    const cfg = app_config().handles;
    return `${cfg.prefix.replace(/^\/+|\/+$/g, '')}/${suffix}`;
}

/*
 * Which of these handles are referenced by a repository record. One query
 * rather than per-row: tbl_objects stores the full resolver URL, so compare
 * against the same string libs/handles builds.
 */
async function linked_pids(rows) {
    if (rows.length === 0) return new Map();
    const by_url = new Map(
        rows.map((r) => [handles_client.build_handle_url(r.suffix), r.suffix])
    );
    const found = await db()(tables.objects)
        .select('pid', 'handle')
        .whereIn('handle', [...by_url.keys()]);

    const out = new Map();
    for (const row of found) {
        const suffix = by_url.get(row.handle);
        if (suffix) out.set(suffix, row.pid);
    }
    return out;
}

/*
 * Rows for the admin list, newest first, each decorated with whether a
 * repository record currently uses it and who minted it.
 */
async function list({ status = null, limit = 200 } = {}) {
    let q = db()(tables.handles).select('*').orderBy('id', 'desc').limit(limit);
    if (status) q = q.where({ status });
    const rows = await q;

    /*
     * created_by holds the du_id, which is what the JWT carries — it is the
     * unambiguous key and stays in the column. Resolve it to a name for
     * display in ONE query rather than per row, and fall back to the du_id
     * for anyone with no user record (a du_id that predates tbl_users, or a
     * name that was never filled in).
     */
    const [linked, names] = await Promise.all([
        linked_pids(rows),
        users_model.names_by_du_id(rows.map((r) => r.created_by)),
    ]);

    return rows.map((row) => ({
        ...row,
        linked_pid: linked.get(row.suffix) || row.linked_pid || null,
        resolver_url: handles_client.build_handle_url(row.suffix),
        created_by_label: names.get(String(row.created_by)) || row.created_by || '',
    }));
}

async function get(id) {
    const row = await db()(tables.handles).where({ id }).first();
    if (!row) throw new NotFoundError(`Handle record ${id} not found`);
    return row;
}

/*
 * Mint 1..MAX_PER_SUBMISSION handles.
 *
 * `entries` is [{ target_url, note }]. Blank rows are dropped by the caller
 * so the form can render a fixed number of inputs.
 *
 * All validation happens BEFORE anything is written, so a bad URL in row 4
 * does not leave rows 1-3 half-minted.
 */
async function mint(entries, { actor = '', writer = handle_writer_default } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new ValidationError('Enter at least one target URL.');
    }
    if (entries.length > MAX_PER_SUBMISSION) {
        throw new ValidationError(
            `At most ${MAX_PER_SUBMISSION} handles can be minted at once.`
        );
    }
    if (!handles_client.is_configured()) {
        throw new ValidationError(
            'Handle minting is not configured - see HANDLE_* in .env.'
        );
    }

    const prepared = entries.map((entry) => ({
        /*
         * Server-generated, never operator-supplied: guarantees the format
         * the handle server and both validation layers expect, and removes
         * any chance of a collision or of another 10176/0.
         */
        suffix: crypto.randomUUID(),
        target_url: validate_target_url(entry.target_url),
        note: validate_note(entry.note),
    }));

    /* 1. record as pending */
    const ids = [];
    for (const item of prepared) {
        const [id] = await db()(tables.handles).insert({
            handle: qualified(item.suffix),
            suffix: item.suffix,
            target_url: item.target_url,
            note: item.note,
            status: STATUS.PENDING,
            created_by: actor,
        });
        ids.push(id);
    }

    /* 2. one batched helper call — 5 handles cost one JVM start, not five */
    let results;
    try {
        ({ results } = await writer.batch(
            prepared.map((item) => ({
                op: 'create', uuid: item.suffix, index: URL_INDEX, url: item.target_url,
            }))
        ));
    } catch (err) {
        /*
         * The batch could not start at all (helper missing, key unreadable).
         * Nothing was minted; mark the rows so the operator sees why rather
         * than finding silent pending rows.
         */
        await db()(tables.handles).whereIn('id', ids).update({
            status: STATUS.FAILED,
            message: String(err.message).slice(0, 500),
        });
        throw err;
    }

    /* 3. reconcile */
    const by_suffix = new Map(results.map((r) => [r.suffix, r]));
    const out = [];
    for (let i = 0; i < prepared.length; i++) {
        const item = prepared[i];
        const result = by_suffix.get(item.suffix);
        const ok = Boolean(result && result.ok);
        await db()(tables.handles).where({ id: ids[i] }).update({
            status: ok ? STATUS.MINTED : STATUS.FAILED,
            message: ok ? null : String((result && result.message) || 'no result').slice(0, 500),
        });
        out.push({
            id: ids[i],
            handle: qualified(item.suffix),
            suffix: item.suffix,
            target_url: item.target_url,
            ok,
            message: ok ? null : (result && result.message) || 'no result',
        });
    }

    log.info({
        event: 'handles_minted',
        actor,
        requested: prepared.length,
        minted: out.filter((r) => r.ok).length,
    });
    return out;
}

/*
 * Delete one hand-minted handle.
 *
 * Guarded on a LIVE tbl_objects check rather than the stored linked_pid: a
 * handle can be attached to a record after it was minted, and a stale flag
 * would wave that through. Deleting a persistent identifier that something
 * points at is not recoverable by re-minting — the citation is already out.
 */
async function remove(id, { actor = '', writer = handle_writer_default } = {}) {
    const row = await get(id);

    if (row.status === STATUS.DELETED) {
        throw new ConflictError('That handle has already been deleted.');
    }

    const linked = await linked_pids([row]);
    if (linked.has(row.suffix)) {
        throw new ConflictError(
            `${row.handle} is in use by object ${linked.get(row.suffix)} `
            + 'and cannot be deleted here.'
        );
    }

    await db()(tables.handles).where({ id }).update({ status: STATUS.DELETING });

    let result;
    try {
        result = await writer.write('delete', row.suffix);
    } catch (err) {
        await db()(tables.handles).where({ id }).update({
            status: row.status,
            message: String(err.message).slice(0, 500),
        });
        throw err;
    }

    /*
     * 404 is success here: the end state the operator asked for is "this
     * handle does not exist", and it already doesn't.
     */
    const gone = result.status === 200 || result.status === 404;
    if (!gone) {
        await db()(tables.handles).where({ id }).update({
            status: row.status,
            message: String((result.data && result.data.message) || '').slice(0, 500),
        });
        throw new ConflictError(
            `Handle server refused the delete: ${(result.data && result.data.message) || result.status}`
        );
    }

    await db()(tables.handles).where({ id }).update({
        status: STATUS.DELETED,
        deleted_by: actor,
        deleted_at: db().fn.now(),
        message: null,
    });
    log.info({ event: 'handle_deleted', actor, handle: row.handle });
    return { id, handle: row.handle };
}

module.exports = {
    list,
    get,
    mint,
    remove,
    validate_target_url,
    validate_note,
    allowed_hosts,
    MAX_PER_SUBMISSION,
    STATUS,
};
