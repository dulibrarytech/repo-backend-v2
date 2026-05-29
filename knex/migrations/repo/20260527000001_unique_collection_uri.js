'use strict';

// Enforce uniqueness on tbl_objects(uri) for LIVE collection rows.
//
// Closes the race window in the submit-to-ingest pre-flight gate:
// two concurrent submits for the same folder both miss the find-by-uri
// lookup, both call create_collection, both succeed — without this
// index. The app-level try/catch around the insert in create_collection
// is the recovery path; this migration is what makes that path fire.
//
// Why the constraint excludes soft-deleted rows (is_active = 0):
// staff routinely delete and re-create collections at the same URI
// during testing and content reorganization. The soft-delete keeps the
// old row for audit; the new row reuses the URI. A naive UNIQUE on
// (object_type='collection', uri) would block that workflow. The real
// app invariant is "no two LIVE collections share a URI", so the
// virtual column / partial index also gates on is_active = 1.
//
// Why this is a SEPARATE migration (not the bigger 20260101 schema):
// the existing 20260101_initial migration ships in legacy production
// from /repo-db-schema.sql; it has hasTable guards that make it a
// no-op there. Adding the index belongs in a follow-up that runs
// once on the real DB.
//
// Why the migration BRANCHES on dialect:
//
//   - sqlite (tests): supports `CREATE UNIQUE INDEX ... WHERE ...`
//     natively (partial indexes). Use directly.
//
//   - MariaDB (prod): does NOT support partial unique indexes through
//     the standard ALTER TABLE syntax. The portable workaround is a
//     virtual generated column that's `uri` when the row is a live
//     collection and NULL otherwise. A plain UNIQUE on that column
//     achieves the same semantic — NULLs aren't considered duplicates,
//     so non-collection / soft-deleted rows freely share a URI.
//
//   - MySQL: same behavior as MariaDB.
//
// The two paths arrive at functionally identical constraints — staff
// can't have two LIVE `object_type='collection'` rows with the same `uri`.

const tables = require('../../../config/db_tables');

const VIRTUAL_COL = '_collection_uri_unique_v';
const INDEX_NAME = `idx_${tables.objects}_unique_collection_uri`;

function dialect(knex) {
    // knex 3.x stores the client name in client.config.client. We
    // only check the prefix because knex aliases 'sqlite3' / some
    // installs use 'better-sqlite3' — both branch the same way.
    const c = knex.client && knex.client.config && knex.client.config.client;
    if (typeof c === 'string' && /sqlite/i.test(c)) return 'sqlite';
    return 'mysql';
}

exports.up = async function up(knex) {
    if (dialect(knex) === 'sqlite') {
        // Partial unique index — native sqlite support. The filter
        // mirrors the application invariant: only LIVE collection rows
        // with a real URI are constrained.
        await knex.raw(`
            CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
            ON ${tables.objects} (uri)
            WHERE object_type = 'collection' AND uri != '' AND is_active = 1
        `);
        return;
    }

    // MariaDB / MySQL path: virtual generated column + plain UNIQUE.
    // The CASE expression evaluates to NULL when the row isn't a live
    // collection or the URI is empty; a NULL in a UNIQUE column is
    // never a duplicate, so this preserves the "only live collections
    // are constrained" semantic.
    const has_col = await knex.schema.hasColumn(tables.objects, VIRTUAL_COL);
    if (!has_col) {
        await knex.raw(`
            ALTER TABLE ${tables.objects}
            ADD COLUMN ${VIRTUAL_COL} VARCHAR(255)
                GENERATED ALWAYS AS (
                    CASE
                        WHEN object_type = 'collection' AND uri != '' AND is_active = 1
                        THEN uri
                        ELSE NULL
                    END
                ) VIRTUAL
        `);
    }
    // ADD UNIQUE INDEX is idempotent under the IF NOT EXISTS guard on
    // newer MariaDB / MySQL. Older builds may need an explicit drop
    // first; the try/catch handles that case.
    try {
        await knex.raw(`CREATE UNIQUE INDEX ${INDEX_NAME} ON ${tables.objects} (${VIRTUAL_COL})`);
    } catch (err) {
        if (!/duplicate key|already exists/i.test(err.message)) throw err;
    }
};

exports.down = async function down(knex) {
    if (dialect(knex) === 'sqlite') {
        await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        return;
    }
    try {
        await knex.raw(`DROP INDEX ${INDEX_NAME} ON ${tables.objects}`);
    } catch {
        // index may not exist on rollback
    }
    const has_col = await knex.schema.hasColumn(tables.objects, VIRTUAL_COL);
    if (has_col) {
        await knex.schema.alterTable(tables.objects, (t) => {
            t.dropColumn(VIRTUAL_COL);
        });
    }
};
