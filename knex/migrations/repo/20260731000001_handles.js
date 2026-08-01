'use strict';

/*
 * tbl_handles — local record of handles minted through the Admin Utils
 * handles view.
 *
 * WHY THIS TABLE HAS TO EXIST
 *
 * The 10176 prefix cannot be enumerated: allow_list_hdls is off on the DU
 * handle server, so `GET /api/handles?prefix=10176` answers "That prefix
 * doesn't live here" and there is no remote listing. Handles attached to
 * objects are still discoverable through tbl_objects.handle — but the
 * handles this view mints are deliberately NOT tied to repository records
 * (they may point at exhibits, finding aids, LibGuides). A handle minted
 * and not recorded here would therefore be invisible everywhere, forever,
 * which is exactly the "minted by accident" case the delete feature exists
 * to clean up.
 *
 * It is also the audit trail. Minting runs under prefix-admin authority —
 * the highest-privilege action the application can take — so who minted
 * what, when, and why belongs on record.
 *
 * Rows are never hard-deleted. A removed handle keeps its row with
 * status='deleted' plus deleted_by/deleted_at.
 *
 * status: pending  — row written, mint not yet confirmed
 *         minted   — exists on the handle server
 *         failed   — mint attempted and refused (message holds why)
 *         deleting — delete in flight
 *         deleted  — removed from the handle server
 *
 * See repo/REPOV2_HANDLES_ADMIN_PLAN.md.
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (await knex.schema.hasTable(tables.handles)) return;

    await knex.schema.createTable(tables.handles, (t) => {
        t.increments('id').primary();
        /* "10176/<uuid>" — the qualified handle, unique across the prefix */
        t.string('handle', 255).notNullable().unique();
        t.string('suffix', 64).notNullable();
        t.string('target_url', 2048).notNullable();
        t.string('note', 500).nullable();
        t.string('status', 20).notNullable().defaultTo('pending');
        /*
         * Last message from the handle server for a failed mint or delete.
         * Kept so an operator can see WHY without going to the logs.
         */
        t.string('message', 500).nullable();
        t.string('created_by', 64).notNullable().defaultTo('');
        t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        t.string('deleted_by', 64).nullable();
        t.timestamp('deleted_at').nullable();
        /*
         * Set if the handle is later attached to a repository record. The
         * delete guard does NOT trust this alone — it re-checks tbl_objects
         * live, because a handle can be linked after it was minted and a
         * stored flag would go stale.
         */
        t.string('linked_pid', 64).nullable();

        t.index(['status'], 'idx_handles_status');
        t.index(['created_by'], 'idx_handles_created_by');
        t.index(['suffix'], 'idx_handles_suffix');
    });
};

exports.down = async function down(knex) {
    if (await knex.schema.hasTable(tables.handles)) {
        await knex.schema.dropTable(tables.handles);
    }
};
