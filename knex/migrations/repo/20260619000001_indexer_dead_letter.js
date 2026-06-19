'use strict';

// Indexer dead-letter support on tbl_objects.
//
// The indexer has no separate queue table — the (is_updated, is_indexed)
// flags ARE the queue (see indexer/model.js). On a per-item ES failure the
// old code flipped is_updated=1 again with NO retry cap, so a permanently-
// unindexable row (e.g. a doc ES rejects on a date/mapping parse error) was
// re-claimed and re-failed every poll forever — turning a couple of bad
// rows into an endless log flood (see output/repo/repov2-modified-33).
//
// These two columns add a BOUNDED retry:
//
//   index_attempts : consecutive failed index attempts for the row.
//                    Reset to 0 on a successful index/deindex, or on any
//                    explicit reindex (admin reindex / rebuild).
//   index_error    : last failure message. NON-NULL marks the row as
//                    DEAD-LETTERED — it's over INDEXER_MAX_ATTEMPTS and is
//                    no longer auto-requeued. Surfaced on the admin indexer
//                    page ("no silent caps") and cleared on retry/reindex.
//
// Both are additive + nullable/defaulted, guarded with hasColumn so a
// re-run (or running against the ~existing production tbl_objects) is a
// no-op. Mirrors the additive pattern in 20260525000002_aip_store.js.

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    const has_attempts = await knex.schema.hasColumn(tables.objects, 'index_attempts');
    const has_error = await knex.schema.hasColumn(tables.objects, 'index_error');
    if (has_attempts && has_error) return;
    await knex.schema.alterTable(tables.objects, (t) => {
        if (!has_attempts) {
            // Consecutive failed index attempts. Default 0 so existing
            // rows need no backfill.
            t.integer('index_attempts').notNullable().defaultTo(0);
        }
        if (!has_error) {
            // Last failure message (model truncates to 1000 chars).
            // NULL = healthy; non-null = dead-lettered.
            t.text('index_error').nullable();
        }
    });
};

exports.down = async function down(knex) {
    const cols = ['index_error', 'index_attempts'];
    const present = [];
    for (const c of cols) {
        if (await knex.schema.hasColumn(tables.objects, c)) present.push(c);
    }
    if (present.length > 0) {
        await knex.schema.alterTable(tables.objects, (t) => {
            for (const c of present) t.dropColumn(c);
        });
    }
};
