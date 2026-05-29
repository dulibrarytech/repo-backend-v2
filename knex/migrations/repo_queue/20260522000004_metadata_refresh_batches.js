'use strict';

// System-wide metadata refresh — adds the columns the existing
// per-row queue needs to participate in a long-running batch
// (priority, attempts, dead-letter accounting), plus a new
// `tbl_metadata_refresh_batches` rollup table that surfaces a
// human-readable history of past refreshes for the admin UI.
//
// Why a separate table for the batch rollup (not just an `is_system`
// column on queue rows): a batch's lifecycle is independent of any
// single row. A batch is in-progress while its cursor is advancing
// (rows may not even exist yet — the producer enqueues them paced),
// then becomes "completed" once cursor passes the last pid AND all
// claimed rows are terminal. Keeping that state on a single row
// avoids the "scan a million queue rows to compute the batch's
// status" trap.
//
// Idempotency: this migration uses hasTable + hasColumn guards so a
// re-run is a no-op. Both surfaces ship in fresh installs only — the
// columns being added to tbl_metadata_update_queue are non-NOT-NULL
// with sane defaults, so legacy rows survive without backfill.

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    // ---- tbl_metadata_update_queue additions ----
    // priority: smaller = run first. On-demand rows default 0,
    //   system-refresh producer enqueues at 5. Worker orders by
    //   (priority ASC, id ASC) so on-demand always preempts bulk.
    // attempts: incremented on per-row failure. At >= max_attempts
    //   the row's status flips to DEAD_LETTERED (not FAILED — failed
    //   is the legacy terminal we map "unrecoverable on first try" to;
    //   dead-lettered means "tried N times and gave up").
    // last_error: most recent error string, capped by the model to a
    //   sane size. Useful in the admin page when investigating a
    //   dead-letter set without trawling logs.
    const has_priority = await knex.schema.hasColumn(tables.metadata_update_queue, 'priority');
    const has_attempts = await knex.schema.hasColumn(tables.metadata_update_queue, 'attempts');
    const has_last_error = await knex.schema.hasColumn(tables.metadata_update_queue, 'last_error');
    if (!has_priority || !has_attempts || !has_last_error) {
        await knex.schema.alterTable(tables.metadata_update_queue, (t) => {
            if (!has_priority) {
                // smallint range 0..255 is plenty (we use 0 + 5 today,
                // future scopes might add 10/15). Default 0 keeps the
                // existing rows priority-equal to on-demand work.
                t.integer('priority').notNullable().defaultTo(0);
            }
            if (!has_attempts) {
                t.integer('attempts').notNullable().defaultTo(0);
            }
            if (!has_last_error) {
                t.text('last_error', 'text').nullable();
            }
        });
    }

    // Composite index on (priority, id) so the worker's ordered
    // claim scan doesn't filesort the table. The existing
    // (batch_uuid, is_complete, id) and (status, is_complete)
    // indexes are still right for their respective queries; this is
    // additive.
    //
    // knex.schema doesn't expose "index if not exists" portably, so
    // we go through raw SQL with a try/catch on the "duplicate key"
    // error. Both MariaDB (errno 1061) and SQLite (already-exists)
    // surface as plain Errors we can ignore.
    try {
        await knex.raw(
            `CREATE INDEX idx_${tables.metadata_update_queue}_priority_id ON ${tables.metadata_update_queue} (priority, id)`
        );
    } catch (err) {
        // Index already exists — fine. Anything else, surface it.
        if (!/duplicate key|already exists/i.test(err.message)) throw err;
    }

    // ---- tbl_metadata_refresh_batches ----
    if (!(await knex.schema.hasTable(tables.metadata_refresh_batches))) {
        await knex.schema.createTable(tables.metadata_refresh_batches, (t) => {
            t.increments('id').primary();
            // Public UUID — matches the per-row batch_uuid stamped
            // on tbl_metadata_update_queue rows for this batch.
            t.string('batch_uuid', 36).notNullable();
            // Lifecycle:
            //   'running'   — producer is enqueuing OR rows still pending
            //   'completed' — cursor done, every row terminal (success
            //                 + failed + dead-lettered)
            //   'cancelled' — operator pressed Cancel; producer stopped
            //                 and unclaimed rows deleted
            //   'failed'    — terminal error in the producer itself
            //                 (rare: DB outage mid-enqueue, etc.)
            t.string('status', 20).notNullable().defaultTo('running');
            // Aggregate counts updated by the worker as rows terminate.
            // total is set by the producer once it finishes enqueuing.
            t.integer('total').notNullable().defaultTo(0);
            t.integer('succeeded').notNullable().defaultTo(0);
            t.integer('failed').notNullable().defaultTo(0);
            t.integer('dead_lettered').notNullable().defaultTo(0);
            // Pagination cursor for the producer. NULL means "haven't
            // started enqueuing yet"; a value of X means "next batch
            // starts at tbl_objects.id > X". The producer captures the
            // ceiling once at batch start so the cursor terminates
            // even if new rows arrive in tbl_objects mid-refresh.
            t.integer('cursor_id').nullable();
            // Set true once the producer has finished enqueuing every
            // pid in scope (cursor reached the ceiling captured at
            // start, OR cancel was requested). The worker only
            // transitions the batch to 'completed' once this is true
            // AND succeeded+failed+dead_lettered === total. The pair
            // prevents a "false done" transition mid-enqueue if all
            // currently-queued rows happen to terminate before the
            // producer enqueues more.
            t.boolean('enqueue_complete').notNullable().defaultTo(false);
            // Set true to ask the producer to stop and the controller
            // to delete pending rows for this batch.
            t.boolean('cancel_requested').notNullable().defaultTo(false);
            // Captured at start so the admin page can show "this
            // batch ran with the transformer on" — and so the
            // pre-flight guard in the controller can refuse a new
            // batch with a different flag without an explicit
            // confirmation.
            t.string('transformer_flag', 10).notNullable().defaultTo('');
            t.string('transformer_version', 50).notNullable().defaultTo('');
            // Actor identity at batch-start time. Matches the
            // ingest_jobs convention — du_id + denormalized name.
            t.string('actor', 255).notNullable().defaultTo('');
            t.string('actor_name', 255).notNullable().defaultTo('');
            t.timestamp('started_at').defaultTo(knex.fn.now());
            // Null until producer + worker drain. Set on transition to
            // any terminal status (completed/cancelled/failed).
            t.timestamp('finished_at').nullable();
            t.unique(['batch_uuid']);
            t.index(['status', 'started_at']);
        });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists(tables.metadata_refresh_batches);
    try {
        await knex.raw(
            `DROP INDEX idx_${tables.metadata_update_queue}_priority_id ON ${tables.metadata_update_queue}`
        );
    } catch {
        // index may not exist on rollback — ignore
    }
    const has_priority = await knex.schema.hasColumn(tables.metadata_update_queue, 'priority');
    const has_attempts = await knex.schema.hasColumn(tables.metadata_update_queue, 'attempts');
    const has_last_error = await knex.schema.hasColumn(tables.metadata_update_queue, 'last_error');
    if (has_priority || has_attempts || has_last_error) {
        await knex.schema.alterTable(tables.metadata_update_queue, (t) => {
            if (has_priority) t.dropColumn('priority');
            if (has_attempts) t.dropColumn('attempts');
            if (has_last_error) t.dropColumn('last_error');
        });
    }
};
