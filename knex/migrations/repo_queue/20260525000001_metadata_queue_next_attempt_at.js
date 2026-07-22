'use strict';

/*
 * Per-row retry backoff column for tbl_metadata_update_queue.
 * 
 * Before this migration, mark_failed() flipped a row straight back to
 * PENDING and the next worker tick could re-claim it within
 * milliseconds. When ArchivesSpace is the upstream and it's already
 * under pressure (which is exactly when failures happen), an immediate
 * retry cascade kicks AS while it's down. The result we saw in
 * production: a system-refresh run that starts healthy then degrades
 * into a timeout storm after a few hours.
 * 
 * next_attempt_at fixes that by giving the model a "do not re-claim
 * before this time" hint. mark_failed sets it to now() + backoff;
 * claim_pending filters rows whose value is in the future. NULL means
 * "no backoff scheduled" — the default for freshly enqueued rows.
 * 
 * Idempotent (hasColumn guard) so re-running the migration on a DB
 * that already has the column is a no-op. No index added: the column
 * only narrows results from the existing (status, is_complete) index;
 * the working PENDING set is small enough that the extra filter is
 * cheap.
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    const has_col = await knex.schema.hasColumn(
        tables.metadata_update_queue,
        'next_attempt_at'
    );
    if (!has_col) {
        await knex.schema.alterTable(tables.metadata_update_queue, (t) => {
            /*
             * Nullable TIMESTAMP. NULL = eligible immediately. A future
             * value = wait until then before re-claiming.
             */
            t.timestamp('next_attempt_at').nullable();
        });
    }
};

exports.down = async function down(knex) {
    const has_col = await knex.schema.hasColumn(
        tables.metadata_update_queue,
        'next_attempt_at'
    );
    if (has_col) {
        await knex.schema.alterTable(tables.metadata_update_queue, (t) => {
            t.dropColumn('next_attempt_at');
        });
    }
};
