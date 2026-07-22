'use strict';

/*
 * Initial schema for the `repo_queue` database — tbl_ingest_queue +
 * tbl_metadata_update_queue.
 * 
 * Idempotency notes specific to repo_queue:
 * 
 *   - tbl_ingest_queue ships in legacy production (created from
 *     /repo_queue-schema.sql). hasTable guards make this migration
 *     a no-op there. New deploys get a fresh table with v2's shape.
 * 
 *   - tbl_metadata_update_queue ALSO ships in legacy production, but
 *     WITHOUT the composite (batch_uuid, is_complete, id) index that
 *     v2's metadata worker hot-path expects. The initial migration
 *     creates the table with the index on fresh installs. To add
 *     the index to a legacy production DB AFTER baseline, write a
 *     follow-up migration (something like 20260101000002_add_metadata_queue_indexes.js)
 *     using knex.raw('CREATE INDEX IF NOT EXISTS …') so it's
 *     idempotent on legacy + fresh.
 * 
 * See knex/migrations/repo/20260101000001_initial.js for the broader
 * migration-file rules (don't edit after deploy, add new files for
 * changes, etc.).
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable(tables.ingest_queue))) {
        await knex.schema.createTable(tables.ingest_queue, (t) => {
            t.increments('id').primary();
            t.string('status', 100).notNullable().defaultTo('PENDING');
            t.string('batch', 255).notNullable().defaultTo('PENDING');
            t.string('package', 255).notNullable().defaultTo('PENDING');
            t.string('collection_uuid', 255).notNullable().defaultTo('PENDING');
            t.string('batch_size', 255).notNullable().defaultTo('PENDING');
            t.integer('file_count').notNullable().defaultTo(0);
            t.string('metadata_uri', 100).defaultTo('PENDING');
            t.text('metadata', 'longtext').nullable();
            t.string('transfer_folder', 255).notNullable().defaultTo('PENDING');
            t.string('transfer_uuid', 255).notNullable().defaultTo('PENDING');
            t.string('sip_uuid', 255).notNullable().defaultTo('PENDING');
            t.string('dip_path', 255).defaultTo('PENDING');
            t.text('file_data', 'longtext').nullable();
            t.text('master_data', 'longtext').nullable();
            t.text('object_parts', 'longtext').nullable();
            t.text('transcript_data', 'longtext').nullable();
            t.text('index_record', 'longtext').nullable();
            t.string('handle', 255).defaultTo('');
            t.string('micro_service', 255).defaultTo('PENDING');
            t.text('error', 'longtext').nullable();
            t.boolean('is_complete').defaultTo(false);
            t.timestamp('created').defaultTo(knex.fn.now());
            t.string('job_uuid', 255).notNullable().defaultTo('0');
        });
    }

    /*
     * tbl_metadata_update_queue:
     *   Status lifecycle: PENDING → IN_PROGRESS → RECORD_UPDATED →
     *   COMPLETE | CANCELLED. The composite (batch_uuid, is_complete,
     *   id) index serves the worker's claim query; (status,
     *   is_complete) supports the orphan-recovery scan that runs on
     *   worker boot. See metadata/model.js for query shapes.
     */
    if (!(await knex.schema.hasTable(tables.metadata_update_queue))) {
        await knex.schema.createTable(tables.metadata_update_queue, (t) => {
            t.increments('id').primary();
            t.string('batch_uuid', 255).notNullable().defaultTo('0');
            t.string('uuid', 255).notNullable();
            t.string('uri', 255).notNullable().defaultTo('');
            t.string('status', 255).notNullable().defaultTo('PENDING');
            t.string('update_type', 100).defaultTo('PENDING');
            t.text('error', 'longtext').nullable();
            t.boolean('is_updated').notNullable().defaultTo(false);
            t.boolean('is_indexed').notNullable().defaultTo(false);
            t.boolean('is_complete').notNullable().defaultTo(false);
            t.timestamp('date_updated').defaultTo(knex.fn.now());
            t.index(['batch_uuid', 'is_complete', 'id']);
            t.index(['status', 'is_complete']);
        });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists(tables.metadata_update_queue);
    await knex.schema.dropTableIfExists(tables.ingest_queue);
};
