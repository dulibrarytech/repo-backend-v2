'use strict';

// Audit log of state transitions on tbl_ingest_queue. Every change
// to `pipeline_state` is paired with an insert here so staff can
// timeline a package's path through the pipeline + see when an
// error first appeared. The dashboard's row-detail view renders
// this table chronologically.
//
// Why a separate table (instead of e.g. JSON history column on the
// queue row): events accumulate quickly (5+ per successful package,
// dozens for failures) and we want to query them independently — e.g.
// "show me every transition into AS_METADATA_DRIFT this week" or
// "show the timeline for package X" — without rewriting the queue
// row each time. Separate table is the boring correct choice.
//
// Columns:
//   id           — surrogate primary key.
//   queue_id     — FK to tbl_ingest_queue.id. No DB-level foreign-key
//                   constraint because we keep the events table even
//                   after a queue row is deleted (audit trail survives
//                   purges). The app enforces referential integrity at
//                   write time.
//   from_state   — pipeline_state before the change. Null for the very
//                   first event on a row (creation).
//   to_state     — pipeline_state after the change. NOT NULL.
//   event_type   — 'state_change' (the common case), 'error' (status
//                   set + error column populated), 'staff_action'
//                   (rollback, reset, etc. issued from the dashboard).
//                   String, not enum, so adding a new type later is
//                   a no-DB-change addition.
//   actor        — who/what made the change. 'system' for worker-
//                   driven transitions, '<du_id>' for staff actions.
//   payload      — optional JSON for additional context (error
//                   message, staff comment, microservice name).
//                   Stored as text to stay portable across MariaDB +
//                   SQLite (no native JSON type in older sqlite
//                   builds; new ones have it but we don't depend).
//   created_at   — when the event happened. Indexed for timeline
//                   queries.

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (await knex.schema.hasTable(tables.ingest_events)) return;
    await knex.schema.createTable(tables.ingest_events, (t) => {
        t.increments('id').primary();
        t.integer('queue_id').notNullable();
        t.string('from_state', 100).nullable();
        t.string('to_state', 100).notNullable();
        t.string('event_type', 50).notNullable().defaultTo('state_change');
        t.string('actor', 255).notNullable().defaultTo('system');
        t.text('payload', 'text').nullable();
        t.timestamp('created_at').defaultTo(knex.fn.now());

        // Two query shapes the dashboard needs efficiently:
        //   1. Timeline for one package: WHERE queue_id = ? ORDER BY id
        //   2. Recent activity across packages: ORDER BY created_at DESC LIMIT N
        t.index(['queue_id', 'id']);
        t.index(['created_at']);
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists(tables.ingest_events);
};
