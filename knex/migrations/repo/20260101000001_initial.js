'use strict';

/*
 * Initial schema for the `repo` database — tbl_objects + tbl_users.
 * 
 * Idempotent: each createTable is gated by hasTable. This matters
 * because the v2 codebase rolled into production with the legacy v1
 * schema already in place (created from /repo-db-schema.sql), and the
 * initial migration needs to be a no-op on a DB that already has the
 * tables. The migration is recorded as applied either way; subsequent
 * migrations are linear and don't need guards.
 * 
 * New schema changes (add column, add index, alter type) go in NEW
 * migration files with timestamps after this one. Don't edit this
 * file once it's in production — that'd silently desync envs that
 * have already applied it.
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable(tables.objects))) {
        await knex.schema.createTable(tables.objects, (t) => {
            t.increments('id').primary();
            t.string('is_member_of_collection', 255).notNullable().defaultTo('');
            t.string('pid', 255).notNullable().defaultTo('');
            t.string('handle', 255).nullable();
            t.string('object_type', 50).defaultTo('object');
            t.text('mods', 'longtext').nullable();
            t.string('thumbnail', 255).nullable();
            t.string('file_name', 255).nullable();
            t.text('display_record', 'longtext').nullable();
            t.text('transcript', 'longtext').nullable();
            t.text('transcript_search', 'longtext').nullable();
            t.text('compound_parts', 'longtext').nullable();
            t.string('mods_id', 20).nullable();
            t.string('uri', 255).nullable();
            t.string('mime_type', 255).nullable();
            t.string('delete_id', 255).defaultTo('');
            t.string('checksum', 255).nullable();
            t.bigInteger('file_size').nullable();
            t.string('sip_uuid', 255).nullable();
            t.boolean('has_transcript').defaultTo(false);
            t.boolean('is_compound').notNullable().defaultTo(false);
            t.boolean('is_published').notNullable().defaultTo(false);
            t.boolean('is_restricted').notNullable().defaultTo(false);
            t.boolean('is_active').notNullable().defaultTo(true);
            t.boolean('is_complete').notNullable().defaultTo(true);
            t.boolean('is_indexed').notNullable().defaultTo(false);
            t.boolean('is_updated').defaultTo(false);
            t.timestamp('created').defaultTo(knex.fn.now());
            t.index(['is_member_of_collection']);
            t.index(['pid']);
            t.index(['object_type']);
            t.index(['sip_uuid']);
            t.index(['is_published']);
            t.index(['is_active']);
        });
    }

    if (!(await knex.schema.hasTable(tables.users))) {
        await knex.schema.createTable(tables.users, (t) => {
            t.increments('id').primary();
            t.string('du_id', 255).nullable();
            t.string('email', 255).nullable();
            t.string('first_name', 255).nullable();
            t.string('last_name', 255).nullable();
            t.string('token', 255).notNullable().defaultTo('0');
            t.boolean('is_active').defaultTo(true);
            t.timestamp('created').defaultTo(knex.fn.now());
        });
    }
};

exports.down = async function down(knex) {
    /*
     * Drop in dependency-safe order. There are no FK relationships
     * between these tables today, but the order still matters for
     * future maintainers.
     */
    await knex.schema.dropTableIfExists(tables.users);
    await knex.schema.dropTableIfExists(tables.objects);
};
