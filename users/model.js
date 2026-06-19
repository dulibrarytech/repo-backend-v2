'use strict';

// User CRUD against tbl_users.
//
// Schema (see /repo-db-schema.sql):
//   id, du_id, email, first_name, last_name, token, is_active, created
//
// "Active" users are the only ones returned by list/get unless callers
// explicitly opt in with `{ include_inactive: true }`. Deletes are soft
// (set is_active = 0); hard deletes are not exposed.

const validator = require('validator');

const { db } = require('../config/db');
const tables = require('../config/db_tables');
const { NotFoundError, ValidationError, ConflictError } = require('../libs/errors');

const PUBLIC_FIELDS = ['id', 'du_id', 'email', 'first_name', 'last_name', 'is_active', 'created'];

function normalize(input) {
    const out = {};
    if (input.du_id !== undefined) out.du_id = String(input.du_id).trim();
    if (input.email !== undefined) out.email = String(input.email).trim().toLowerCase();
    if (input.first_name !== undefined) out.first_name = String(input.first_name).trim();
    if (input.last_name !== undefined) out.last_name = String(input.last_name).trim();
    if (input.is_active !== undefined) out.is_active = input.is_active ? 1 : 0;
    return out;
}

function validate_create(input) {
    const errs = [];
    if (!input.du_id) errs.push({ field: 'du_id', error: 'required' });
    if (!input.email) errs.push({ field: 'email', error: 'required' });
    else if (!validator.isEmail(input.email)) errs.push({ field: 'email', error: 'invalid' });
    if (!input.first_name) errs.push({ field: 'first_name', error: 'required' });
    if (!input.last_name) errs.push({ field: 'last_name', error: 'required' });
    if (errs.length > 0) throw new ValidationError('Invalid user payload', errs);
}

function validate_update(input) {
    const errs = [];
    if (input.email !== undefined && input.email !== '' && !validator.isEmail(input.email)) {
        errs.push({ field: 'email', error: 'invalid' });
    }
    if (Object.keys(input).length === 0) {
        errs.push({ error: 'empty patch' });
    }
    if (errs.length > 0) throw new ValidationError('Invalid user patch', errs);
}

async function list({ include_inactive = false } = {}) {
    const q = db()(tables.users).select(PUBLIC_FIELDS).orderBy('id', 'asc');
    if (!include_inactive) q.where({ is_active: 1 });
    return q;
}

async function get(id) {
    const row = await db()(tables.users)
        .select(PUBLIC_FIELDS)
        .where({ id: Number.parseInt(id, 10) })
        .first();
    if (!row) throw new NotFoundError(`User ${id} not found`);
    return row;
}

async function get_by_du_id(du_id, { include_inactive = false } = {}) {
    const q = db()(tables.users).select(PUBLIC_FIELDS).where({ du_id });
    if (!include_inactive) q.where({ is_active: 1 });
    return q.first();
}

// Build a human-readable audit "actor" label from a JWT principal
// (req.user — which carries only du_id/email/sub, NOT the name). Returns
// "First Last (du_id)" when the name resolves from the users table, else
// the du_id / email / sub alone. Used for the "Deleted by ..." reason
// stamped on Archivematica deletion requests so an admin reviewing the AM
// queue can identify the staff member by name, with the du_id as the
// unambiguous key. include_inactive so a just-deactivated-but-still-
// authenticated user is still named. NEVER throws — an audit label must
// not be able to block the action it describes.
async function actor_label(principal) {
    if (!principal) return null;
    const fallback = principal.du_id || principal.email || principal.sub || null;
    if (!principal.du_id) return fallback;
    try {
        const row = await get_by_du_id(principal.du_id, { include_inactive: true });
        const name = row ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : '';
        return name ? `${name} (${principal.du_id})` : fallback;
    } catch {
        return fallback;
    }
}

async function create(input) {
    validate_create(input);
    const row = normalize(input);
    // Duplicate du_id guard. The legacy code did this with a COUNT first;
    // a SELECT first is equally cheap here and lets us 409 cleanly.
    const existing = await db()(tables.users).where({ du_id: row.du_id }).first();
    if (existing) throw new ConflictError(`du_id "${row.du_id}" already in use`);
    if (row.is_active === undefined) row.is_active = 1;
    const [id] = await db()(tables.users).insert({ ...row, token: '0' });
    return get(id);
}

async function update(id, patch) {
    validate_update(patch);
    const row = normalize(patch);
    const affected = await db()(tables.users)
        .where({ id: Number.parseInt(id, 10) })
        .update(row);
    if (affected === 0) throw new NotFoundError(`User ${id} not found`);
    return get(id);
}

// Soft delete. Hard deletes are not exposed via the public surface — too
// many FK-ish references in queue/audit tables.
async function soft_delete(id) {
    const affected = await db()(tables.users)
        .where({ id: Number.parseInt(id, 10) })
        .update({ is_active: 0 });
    if (affected === 0) throw new NotFoundError(`User ${id} not found`);
    return { ok: true };
}

// Reactivate a previously soft-deleted user. The inverse of
// soft_delete. We don't use update() for this because update() would
// require the caller to pass `{is_active: 1}` — opening the door to
// "I sent a patch and accidentally reactivated the row" surprises.
// A dedicated function keeps the intent obvious at the call site.
async function activate(id) {
    const affected = await db()(tables.users)
        .where({ id: Number.parseInt(id, 10) })
        .update({ is_active: 1 });
    if (affected === 0) throw new NotFoundError(`User ${id} not found`);
    // get() doesn't filter by is_active — safe to call right after.
    return get(id);
}

module.exports = {
    PUBLIC_FIELDS,
    list,
    get,
    get_by_du_id,
    actor_label,
    create,
    update,
    soft_delete,
    activate,
};
