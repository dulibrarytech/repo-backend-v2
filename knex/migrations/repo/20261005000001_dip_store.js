'use strict';

/*
 * tbl_dip_store — one row per repository object, tracking the copy of its
 * DIP from DuraCloud Preserve to the Wasabi DIP store
 * (s3://library-repository/dip-store/).
 *
 * The curation service makes the copy: during ingest (Stage 4, mode
 * 'ingest') and for existing objects (the DIP backfill, mode 'backfill').
 * This table is how repov2 knows an object's files are in Wasabi, and what
 * the dashboard shows and retries. Rows are updated in place: a re-ingest
 * that produces a new DIP overwrites the row for that pid.
 *
 * status: pending    — copy requested, not finished
 *         copied     — every file copied and verified
 *         incomplete — the DIP isn't fully in DCP yet (retried later)
 *         failed     — retries exhausted; last_error says why
 *
 * Created empty in the DuraCloud Preserve P1 deploy; written from P2 on.
 * See repo/notes/DURACLOUD_PRESERVE_IMPLEMENTATION_PLAN.md.
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (await knex.schema.hasTable(tables.dip_store)) return;
    await knex.schema.createTable(tables.dip_store, (t) => {
        t.increments('id').primary();
        // Repository PID (joins tbl_objects.pid). One row per object.
        t.string('pid', 64).notNullable().unique();
        t.string('sip_uuid', 36).nullable();
        t.string('dip_uuid', 36).nullable();
        // Where the copy landed: bucket + DIP folder prefix (ends in '/').
        t.string('bucket', 255).nullable();
        t.string('prefix', 512).nullable();
        t.integer('files_total').nullable();
        t.bigInteger('bytes_total').nullable();
        /*
         * The DIP size Archivematica recorded, when known. The ingest-mode
         * copy refuses to start unless DCP's folder adds up to this.
         */
        t.bigInteger('expected_bytes').nullable();
        t.string('mode', 20).notNullable().defaultTo('ingest');
        t.string('status', 20).notNullable().defaultTo('pending');
        t.integer('attempts').notNullable().defaultTo(0);
        t.timestamp('next_attempt_at').nullable();
        t.string('last_error', 1000).nullable();
        t.timestamp('copied_at').nullable();
        t.timestamp('verified_at').nullable();
        t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        t.timestamp('updated_at').nullable();
        t.index(['status'], 'idx_dip_store_status');
        t.index(['mode', 'copied_at'], 'idx_dip_store_mode_copied_at');
    });
};

exports.down = async function down(knex) {
    /*
     * Drops tracking rows only. The DIP files in Wasabi are untouched, and
     * a later P2 backfill re-creates the rows (its copy is idempotent).
     */
    if (await knex.schema.hasTable(tables.dip_store)) {
        await knex.schema.dropTable(tables.dip_store);
    }
};
