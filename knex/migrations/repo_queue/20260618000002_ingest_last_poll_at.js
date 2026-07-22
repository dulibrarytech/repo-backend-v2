'use strict';

/*
 * Heartbeat timestamp for the long-running Archivematica transfer/ingest +
 * DuraCloud-wait polls. The worker writes it on every in-progress poll so
 * the dashboard can show "checked Ns ago" and staff can tell a slow-but-
 * working stage from a stalled one — avoiding premature cancels on large
 * (~35GB) packages. Stored as epoch milliseconds (bigInteger) so the
 * relative "ago" math needs no timezone parsing. Written with NO status,
 * so it produces no event-log churn.
 * 
 * hasColumn guard so re-running is safe.
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (!(await knex.schema.hasColumn(tables.ingest_queue, 'last_poll_at'))) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.bigInteger('last_poll_at').nullable();
        });
    }
};

exports.down = async function down(knex) {
    if (await knex.schema.hasColumn(tables.ingest_queue, 'last_poll_at')) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.dropColumn('last_poll_at');
        });
    }
};
