'use strict';

// Job-history table — one row per workflow ACTION (Make Digital Objects,
// ASpace Description QA, Submit to Ingest). Distinct from:
//
//   - tbl_ingest_queue   — per-package state machine driving the 5-stage
//                          Archivematica pipeline
//   - tbl_ingest_events  — append-only audit trail of per-row state
//                          transitions
//
// This table sits ABOVE both. Staff browse it from the Job History
// dashboard page to see "what did we do across the workspace, by
// whom, when, with what outcome." Columns mirror the screenshot the
// staff supplied for this feature:
//
//   Job ID | Job Type | Status | Collection Folder | Packages | Job Run By | Date
//
// One row per action submission. `packages` is a JSON array of
// archival-package names captured at job-time so we don't have to
// re-list against the curation-service when rendering history (and
// so a folder rename later doesn't rewrite the past). `actor_name`
// is denormalized from tbl_users.first_name/last_name at write time
// — the history view never joins across databases.
//
// Indexes:
//   - (created desc) for the default "most recent first" listing
//   - (job_type, created) for filtering by job type
//   - (collection_folder, created) for filtering by folder

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (await knex.schema.hasTable(tables.ingest_jobs)) return;
    await knex.schema.createTable(tables.ingest_jobs, (t) => {
        t.increments('id').primary();
        // Surrogate UUID — staff-facing identifier shown in the table.
        t.string('job_uuid', 36).notNullable();
        // Workflow action that produced this row. One of:
        //   'make_digital_objects'
        //   'archivesspace_description_qa'
        //   'packaging_and_ingesting'
        // We store the v1-compatible names so a future export of this
        // table reads cleanly against legacy job dumps.
        t.string('job_type', 50).notNullable();
        // Terminal outcome: 'SUCCESSFUL' | 'FAILED'. We don't store
        // 'IN_PROGRESS' here — the workflow actions are blocking
        // round-trips with the curation-service; the row is written
        // once we have a final outcome.
        t.string('status', 20).notNullable();
        t.string('collection_folder', 255).notNullable();
        // JSON-encoded array of package names. TEXT to stay portable
        // across MariaDB + SQLite (older sqlite builds lack JSON).
        t.text('packages', 'text').nullable();
        // Actor identity at job time. Two columns:
        //   actor     — du_id / email (machine-readable)
        //   actor_name — first + last from tbl_users at write time
        //                (human-readable; "Elizabeth Ferguson")
        // We denormalize so the list view is one indexed SELECT —
        // no cross-DB join.
        t.string('actor', 255).notNullable().defaultTo('');
        t.string('actor_name', 255).notNullable().defaultTo('');
        // Free-text error captured when status='FAILED'. Truncated
        // by the model to 1000 chars to keep row size sane.
        t.text('error', 'text').nullable();
        t.timestamp('created').defaultTo(knex.fn.now());

        // Default listing: ORDER BY created DESC LIMIT N — needs an
        // index on created. The composite indexes below cover the
        // staff filters (type + folder).
        t.index(['created']);
        t.index(['job_type', 'created']);
        t.index(['collection_folder', 'created']);
        // Unique per job_uuid so a retry of the same logical action
        // doesn't accidentally create twin rows (the recorder
        // generates a fresh uuid per call, but the constraint
        // protects us if someone reuses one).
        t.unique(['job_uuid']);
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists(tables.ingest_jobs);
};
