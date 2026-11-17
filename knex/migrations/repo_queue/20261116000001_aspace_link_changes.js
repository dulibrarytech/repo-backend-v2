'use strict';

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (await knex.schema.hasTable(tables.aspace_link_changes)) return;

    await knex.schema.createTable(tables.aspace_link_changes, (t) => {
        t.increments('id').primary();
        t.string('record_uri', 255).notNullable();
        t.string('uri', 255).notNullable();
        t.string('field', 40).notNullable();
        t.string('action', 20).notNullable();
        t.text('previous', 'text').nullable();
        t.text('value', 'text').nullable();
        t.text('pids', 'text').nullable();
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.index(['record_uri']);
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists(tables.aspace_link_changes);
};
