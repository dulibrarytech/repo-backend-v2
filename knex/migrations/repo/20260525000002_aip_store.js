'use strict';

/*
 * tbl_aip_store — preservation tier tracking.
 * 
 * Two histories converge in this table:
 * 
 *   1. Legacy migration (~20.8k rows pre-existing in production).
 *      A one-time job (digitaldu-backend-ingest-service_latest/
 *      migration/model.js) copied AIPs from DuraCloud to Wasabi S3
 *      and inserted a row per success/failure here. Columns it
 *      writes: uuid, aip, aip_legacy, downloaded, message, is_migrated.
 *      is_migrated codes: 2=NOT_FOUND, 3=REQUEST_FAILED, 5=migrated_ok.
 * 
 *   2. v2 ingest Stage 6 (this migration + ingester/stages/aip_store.js).
 *      A new stage in the v2 ingest worker that fires AFTER Stage 5
 *      finalizes the repository record. It calls the curation API
 *      (which owns the Wasabi credentials and the upload code) to
 *      copy the AM-produced AIP from AM Storage Service into Wasabi,
 *      then inserts a row here with the canonical key + size + when.
 *      is_migrated codes added: 6=ingest_copy_ok, 7=ingest_copy_failed.
 * 
 * Schema choices:
 *   - The table itself uses hasTable() so it's idempotent across:
 *       fresh sqlite test DB                 → creates everything
 *       legacy production MariaDB (~20k rows) → only the ALTER runs
 *   - All new columns are nullable / defaultable so existing rows
 *     don't need backfill. The legacy columns (aip_legacy, message,
 *     downloaded, is_migrated) stay verbatim — they're audit metadata
 *     for the one-time migration and remain useful forever.
 *   - source column distinguishes provenance ('legacy_migration' vs
 *     'ingest_v2'). Existing rows are NULL meaning "unknown" /
 *     pre-source-column. Dashboard treats NULL as legacy_migration
 *     for display purposes.
 *   - next_attempt_at mirrors the metadata-refresh queue's backoff
 *     column (knex/migrations/repo_queue/20260525000001_metadata_queue
 *     _next_attempt_at.js). Stage 6 stamps it on copy failures so a
 *     transient Wasabi outage doesn't get retried back-to-back.
 * 
 * Indexes:
 *   - PK on id (auto)
 *   - (uuid)            — primary join into tbl_objects.pid, and
 *                         "does this PID already have an AIP store
 *                         row?" idempotency check in Stage 6.
 *   - (source, copied_at) — dashboard's "show me v2 ingest-time rows
 *                           sorted by recency" query.
 *   - (is_migrated)     — dashboard's "show me failed rows" filter.
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    // ---- Create on fresh DBs (sqlite tests, fresh dev installs) ----
    if (!(await knex.schema.hasTable(tables.aip_store))) {
        await knex.schema.createTable(tables.aip_store, (t) => {
            t.increments('id').primary();
            /*
             * Repository PID (joins tbl_objects.pid). Legacy column —
             * kept varchar(255) for backwards compatibility with the
             * existing 20k rows.
             */
            t.string('uuid', 255).notNullable().defaultTo('');
            /*
             * Wasabi object key (filename only in the legacy schema —
             * bucket/prefix derived from env). We KEEP that semantic
             * for legacy rows; new v2 rows ALSO populate wasabi_bucket
             * + wasabi_key below for the canonical key including any
             * prefix the curation service writes.
             */
            t.string('aip', 255).notNullable().defaultTo('');
            /*
             * Old DuraCloud shard path (preserved for audit; unused
             * by v2 code).
             */
            t.string('aip_legacy', 255).notNullable().defaultTo('');
            /*
             * How many times the AIP has been downloaded via the
             * dashboard. Incremented by /dashboard/aips/:id/download.
             */
            t.integer('downloaded').notNullable().defaultTo(0);
            /*
             * Free-text status note for legacy rows (NULL, NOT_FOUND,
             * REQUEST_FAILED). v2 rows use the new error column below
             * for richer diagnostics but may also write a short
             * message here for the dashboard summary.
             */
            t.string('message', 255).nullable();
            /*
             * Legacy status code. Values in use:
             *   0 — initial (default)
             *   2 — legacy migration: NOT_FOUND
             *   3 — legacy migration: REQUEST_FAILED
             *   5 — legacy migration: migrated_ok
             *   6 — v2 ingest: copied_ok
             *   7 — v2 ingest: copy_failed
             */
            t.tinyint('is_migrated').notNullable().defaultTo(0);
        });
    }

    /*
     * ---- Additive columns (idempotent on existing prod table) ----
     * 
     * Each column is guarded so re-running the migration on a DB
     * where some columns already exist is a no-op. Mirrors the
     * pattern in 20260522000004_metadata_refresh_batches.js.
     */
    const has_bucket = await knex.schema.hasColumn(tables.aip_store, 'wasabi_bucket');
    const has_key = await knex.schema.hasColumn(tables.aip_store, 'wasabi_key');
    const has_bytes = await knex.schema.hasColumn(tables.aip_store, 'bytes');
    const has_copied_at = await knex.schema.hasColumn(tables.aip_store, 'copied_at');
    const has_source = await knex.schema.hasColumn(tables.aip_store, 'source');
    const has_next_attempt = await knex.schema.hasColumn(tables.aip_store, 'next_attempt_at');
    const has_attempts = await knex.schema.hasColumn(tables.aip_store, 'attempts');
    const has_error = await knex.schema.hasColumn(tables.aip_store, 'error');
    const has_aip_uuid = await knex.schema.hasColumn(tables.aip_store, 'aip_uuid');
    if (
        !(
            has_bucket &&
            has_key &&
            has_bytes &&
            has_copied_at &&
            has_source &&
            has_next_attempt &&
            has_attempts &&
            has_error &&
            has_aip_uuid
        )
    ) {
        await knex.schema.alterTable(tables.aip_store, (t) => {
            if (!has_aip_uuid) {
                /*
                 * Archivematica's AIP UUID — separate from the
                 * repository pid (uuid). Stage 6 needs both: aip_uuid
                 * tells AM Storage Service which file to download;
                 * uuid is what we join on for the dashboard view.
                 */
                t.string('aip_uuid', 36).nullable();
            }
            if (!has_bucket) {
                /*
                 * Snapshot of the Wasabi bucket at copy time. If the
                 * operator ever rotates buckets, old rows still point
                 * at the right place.
                 */
                t.string('wasabi_bucket', 255).nullable();
            }
            if (!has_key) {
                /*
                 * Full S3 key INCLUDING any prefix. Legacy rows' `aip`
                 * column stored the basename only; new code writes the
                 * full key here so presigned URLs work cleanly.
                 */
                t.string('wasabi_key', 512).nullable();
            }
            if (!has_bytes) {
                /*
                 * AIP size in bytes. Used for the dashboard size
                 * column and as a sanity check on retries (if the
                 * remote key already exists at the expected size,
                 * skip the upload).
                 */
                t.bigInteger('bytes').nullable();
            }
            if (!has_copied_at) {
                /*
                 * When the v2 copy succeeded. NULL for legacy rows
                 * (they have no per-row timestamp; the whole migration
                 * ran over a few weeks).
                 */
                t.timestamp('copied_at').nullable();
            }
            if (!has_source) {
                /*
                 * Provenance label. Free string so future flows can
                 * add their own values without a schema change.
                 * Conventional values: 'legacy_migration', 'ingest_v2'.
                 * NULL = pre-this-migration row.
                 */
                t.string('source', 50).nullable();
            }
            if (!has_attempts) {
                // Stage 6 retry counter. Mirrors metadata_update_queue.
                t.integer('attempts').notNullable().defaultTo(0);
            }
            if (!has_next_attempt) {
                /*
                 * Backoff for Stage 6 retries. Mirrors the same
                 * semantic added to tbl_metadata_update_queue by
                 * 20260525000001_metadata_queue_next_attempt_at.
                 */
                t.timestamp('next_attempt_at').nullable();
            }
            if (!has_error) {
                /*
                 * Last error message (truncated to 1000 chars by the
                 * model). Stage 6's failure path writes this; the
                 * dashboard surfaces it for failed rows.
                 */
                t.string('error', 1000).nullable();
            }
        });
    }

    /*
     * ---- Indexes (idempotent via try/catch on duplicate-key error) ----
     * 
     * knex doesn't expose "create index if not exists" portably.
     * Same pattern as 20260522000004_metadata_refresh_batches.js.
     */
    const idx_attempts = [
        /*
         * Primary lookup: "is this PID already in the AIP store?"
         * Used by Stage 6 idempotency + dashboard joins.
         */
        ['uuid'],
        // Dashboard "v2 ingest-time, newest first".
        ['source', 'copied_at'],
        // Dashboard "show me failed rows" filter.
        ['is_migrated'],
    ];
    for (const cols of idx_attempts) {
        const name = `idx_${tables.aip_store}_${cols.join('_')}`;
        try {
            await knex.raw(
                `CREATE INDEX ${name} ON ${tables.aip_store} (${cols.join(', ')})`
            );
        } catch (err) {
            // Index already exists — fine. Anything else, surface it.
            if (!/duplicate key|already exists/i.test(err.message)) throw err;
        }
    }
};

exports.down = async function down(knex) {
    /*
     * Drop the indexes we added (best-effort — index may not exist if
     * up was partial). Then drop the additive columns. We DO NOT
     * drop the table itself on down because legacy production rows
     * would be lost; treat the table as an upstream contract.
     */
    const idx_names = [
        `idx_${tables.aip_store}_uuid`,
        `idx_${tables.aip_store}_source_copied_at`,
        `idx_${tables.aip_store}_is_migrated`,
    ];
    for (const name of idx_names) {
        try {
            await knex.raw(`DROP INDEX ${name} ON ${tables.aip_store}`);
        } catch {
            // Tolerate missing index.
        }
    }
    const cols = [
        'aip_uuid',
        'wasabi_bucket',
        'wasabi_key',
        'bytes',
        'copied_at',
        'source',
        'attempts',
        'next_attempt_at',
        'error',
    ];
    const present = [];
    for (const c of cols) {
        if (await knex.schema.hasColumn(tables.aip_store, c)) present.push(c);
    }
    if (present.length > 0) {
        await knex.schema.alterTable(tables.aip_store, (t) => {
            for (const c of present) t.dropColumn(c);
        });
    }
};
