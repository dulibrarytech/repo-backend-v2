'use strict';

// Auth-specific DB queries against tbl_users. Distinct from users/model.js
// so the auth flow doesn't accidentally expose admin-only operations and
// vice versa.
//
// Token column ("refresh token" in legacy terms) holds a per-user opaque
// string set on login and cleared (set to "0") on logout.

const { randomUUID } = require('node:crypto');
const { db } = require('../config/db');
const tables = require('../config/db_tables');

// Returns the row for a given du_id if active, else undefined.
async function find_active_user(du_id) {
    return db()(tables.users)
        .select('id', 'du_id', 'email', 'first_name', 'last_name', 'is_active', 'token')
        .where({ du_id, is_active: 1 })
        .first();
}

async function find_by_id(id) {
    return db()(tables.users)
        .select('id', 'du_id', 'email', 'first_name', 'last_name', 'is_active', 'token')
        .where({ id: Number.parseInt(id, 10) })
        .first();
}

// Stamp a fresh refresh token. Called on successful login. Returns the
// new token value so the controller can include it in the response.
async function rotate_refresh_token(user_id) {
    const token = randomUUID();
    const affected = await db()(tables.users)
        .where({ id: Number.parseInt(user_id, 10), is_active: 1 })
        .update({ token });
    if (affected === 0) {
        throw new Error(`rotate_refresh_token: user ${user_id} not found or inactive`);
    }
    return token;
}

// Match a (user_id, refresh_token) pair. Used by token refresh flow.
async function verify_refresh_token(user_id, token) {
    if (!token || token === '0') return false;
    const row = await db()(tables.users)
        .select('id')
        .where({ id: Number.parseInt(user_id, 10), token, is_active: 1 })
        .first();
    return Boolean(row);
}

// Clear (zero out) the stored refresh token. Called on logout.
async function clear_refresh_token(user_id) {
    const affected = await db()(tables.users)
        .where({ id: Number.parseInt(user_id, 10) })
        .update({ token: '0' });
    return { cleared: affected > 0 };
}

module.exports = {
    find_active_user,
    find_by_id,
    rotate_refresh_token,
    verify_refresh_token,
    clear_refresh_token,
};
