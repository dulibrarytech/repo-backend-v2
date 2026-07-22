'use strict';

/*
 * tbl_kaltura_package_queue + tbl_kaltura_ids — kaltura ingest queue.
 * 
 * Both tables ship in legacy production (see repo_queue-schema.sql);
 * the hasTable guards make this migration a no-op there. Fresh installs
 * get the tables created with v2's shape (column types match the
 * legacy schema exactly so a future cutover doesn't drift).
 * 
 *   tbl_kaltura_package_queue — one row per submitted archival package.
 *     The controller drains rows in FIFO order, looks each file up,
 *     persists the {file, entry_id} pairs into tbl_kaltura_ids, then
 *     flips is_processed=1.
 * 
 *   tbl_kaltura_ids — resolved {package, file, entry_id} triples.
 *     status enum:
 *       0 — no match (entry_id='0_0', message explains)
 *       1 — exactly one match (entry_id is the Kaltura id)
 *       2 — multiple matches (entry_id is a JSON array of ids)
 * 
 * No FK between the tables — staff occasionally clear one without the
 * other from the admin UI, and the linkage is by package name (string)
 * rather than queue id.
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable(tables.kaltura_package_queue))) {
        await knex.schema.createTable(tables.kaltura_package_queue, (t) => {
            t.increments('id').primary();
            t.string('package', 255).nullable();
            t.text('files', 'longtext').nullable();
            t.boolean('is_processed').notNullable().defaultTo(false);
            /*
             * Composite index: the controller's get_next_package query
             * is "WHERE is_processed=0 ORDER BY id ASC LIMIT 1". The
             * index makes that an instant lookup even when the table
             * has thousands of completed rows.
             */
            t.index(['is_processed', 'id']);
        });
    }

    if (!(await knex.schema.hasTable(tables.kaltura_ids))) {
        await knex.schema.createTable(tables.kaltura_ids, (t) => {
            t.increments('id').primary();
            t.string('file', 255).nullable();
            t.string('entry_id', 255).nullable();
            t.string('package', 255).nullable();
            t.tinyint('status').nullable();
            t.string('message', 255).nullable();
            /*
             * Stage 5 (repository build) looks rows up by (package,
             * file) when stamping kaltura_id onto a part. The index
             * makes that a single-row read.
             */
            t.index(['package', 'file']);
        });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists(tables.kaltura_ids);
    await knex.schema.dropTableIfExists(tables.kaltura_package_queue);
};
