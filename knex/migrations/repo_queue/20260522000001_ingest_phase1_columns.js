'use strict';

/*
 * Phase 1 of the ingest port: add the canonical state machine columns
 * to tbl_ingest_queue.
 * 
 * Background: the original v1 schema had only `status` (free-form text).
 * Mid-life, v1 added a "Phase 1 enhancement" with three companion
 * columns + an audit log table. This migration brings v2's schema to
 * the same shape so the staff dashboard can color-code rows by
 * severity and surface a suggested_action without parsing free text.
 * 
 *   - pipeline_state: canonical authoritative state. Kept in sync with
 *     `status` by the model layer — the dashboard reads pipeline_state.
 *     The split was originally for v1 backward compat; we keep both so
 *     queue rows imported from a v1 dump (should that ever happen) line
 *     up column-for-column.
 *   - severity: INFO | WARN | ERROR | FATAL. Auto-populated by the
 *     model from state_metadata.js whenever a status is written, unless
 *     the caller passes an explicit override.
 *   - suggested_action: free-text staff guidance, also auto-populated.
 *   - updated: timestamp of last write. App-level (not DB triggers) so
 *     we stay portable across MariaDB + SQLite.
 * 
 * hasColumn guards so this migration is safe to run against either
 * a fresh v2 schema OR a legacy v1 production DB that already has
 * some of these columns. The mirroring backfill at the bottom is a
 * no-op if pipeline_state was already populated.
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (!(await knex.schema.hasColumn(tables.ingest_queue, 'pipeline_state'))) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.string('pipeline_state', 100).nullable();
        });
    }
    if (!(await knex.schema.hasColumn(tables.ingest_queue, 'severity'))) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.string('severity', 20).nullable();
        });
    }
    if (!(await knex.schema.hasColumn(tables.ingest_queue, 'suggested_action'))) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.text('suggested_action', 'text').nullable();
        });
    }
    if (!(await knex.schema.hasColumn(tables.ingest_queue, 'updated'))) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.timestamp('updated').defaultTo(knex.fn.now());
        });
    }

    /*
     * Backfill pipeline_state from status for any rows that pre-date
     * this migration. Cheap and idempotent (rows where the two already
     * match are unaffected). Wrapped in a try/catch because on a brand
     * new DB the table might be empty + the UPDATE could no-op cleanly,
     * but we don't want a backfill error blocking the schema change.
     */
    try {
        await knex(tables.ingest_queue)
            .whereNull('pipeline_state')
            .update({ pipeline_state: knex.ref('status') });
    } catch (err) {
        /*
         * Log + continue. The columns exist; that's what matters.
         * Any subsequent model.update_queue call will populate the
         * missing field as soon as the row is touched.
         */
        console.warn('[migration 20260522000001] pipeline_state backfill failed: ' + err.message);
    }
};

exports.down = async function down(knex) {
    /*
     * Drop in reverse order. We don't unmirror data — if you're rolling
     * back, status still holds the canonical value.
     */
    await knex.schema.alterTable(tables.ingest_queue, (t) => {
        if (knex.schema.hasColumn(tables.ingest_queue, 'updated')) t.dropColumn('updated');
        if (knex.schema.hasColumn(tables.ingest_queue, 'suggested_action'))
            t.dropColumn('suggested_action');
        if (knex.schema.hasColumn(tables.ingest_queue, 'severity')) t.dropColumn('severity');
        if (knex.schema.hasColumn(tables.ingest_queue, 'pipeline_state'))
            t.dropColumn('pipeline_state');
    });
};
