'use strict';

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (await knex.schema.hasTable(tables.aspace_links)) return;

    await knex.schema.createTable(tables.aspace_links, (t) => {
        t.increments('id').primary();
        t.string('uri', 255).notNullable().unique();
        t.string('status', 20).notNullable().defaultTo('PENDING');
        t.string('state', 40).nullable();
        t.text('pids', 'text').nullable();
        t.text('detail', 'text').nullable();
        t.text('error', 'text').nullable();
        t.timestamp('next_attempt_at').nullable();
        t.timestamp('checked_at').nullable();
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.fn.now());
        t.index(['status', 'next_attempt_at', 'id']);
        t.index(['state']);
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists(tables.aspace_links);
};
