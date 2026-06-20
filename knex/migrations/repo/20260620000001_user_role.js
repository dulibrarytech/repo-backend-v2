'use strict';

// RBAC Phase 1 — add a `role` column to tbl_users.
//
// repov2 had authentication but no authorization: any logged-in user could
// do anything (drop the ES index, delete objects, manage users). This adds
// the role that the permission layer (auth/rbac.js) checks. Roles:
// 'viewer' | 'staff' | 'admin' (see auth/rbac.js for the role→permission map).
//
// Rollout safety — backfill EXISTING users to 'admin':
//   Every current user can already do everything today, so backfilling them
//   to 'admin' preserves their access at cutover (no lockout, and no chicken-
//   and-egg of "who makes the first admin"). Admins then downgrade staff /
//   viewers deliberately via the user-management UI. NEW users created after
//   this migration get the least-privilege 'staff' default below.
//
// hasColumn-guarded so re-running (or running against the existing prod
// tbl_users) is a no-op. tbl_users is in the repo DB → migrations/repo/.

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (await knex.schema.hasColumn(tables.users, 'role')) return;
    await knex.schema.alterTable(tables.users, (t) => {
        t.string('role', 50).notNullable().defaultTo('staff');
    });
    // One-time preserve-access backfill (existing rows only; the column add
    // above already gave them the 'staff' default, this lifts them to admin).
    await knex(tables.users).update({ role: 'admin' });
};

exports.down = async function down(knex) {
    if (await knex.schema.hasColumn(tables.users, 'role')) {
        await knex.schema.alterTable(tables.users, (t) => t.dropColumn('role'));
    }
};
