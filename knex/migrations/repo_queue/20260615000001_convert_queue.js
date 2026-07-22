'use strict';

/*
 * TIFF→JPG derivative conversion — queue + batch rollup.
 * 
 * Mirrors the metadata-refresh shape: a small `tbl_convert_batches`
 * rollup row per run (collection-wide or single-object), and one
 * `tbl_convert_queue` work row per object. A long-running, single-
 * concurrency worker (convert/worker.js) drains the queue paced at
 * CONVERT_SERVICE_DELAY_MS between requests — the remote DU convert
 * service (libspec02) is fragile under load, so we deliberately POST
 * one object at a time with a cooldown, exactly like the legacy
 * post_tiff_convert.py script this replaces.
 * 
 * Why a queue table rather than an in-memory loop: a collection batch
 * can be hundreds of objects at ~20s each (well over an hour). The
 * queue makes the run resumable across restarts, observable in the
 * dashboard, and retryable per row.
 * 
 * Idempotent: hasTable guards make a re-run a no-op. Lives in the
 * repo_queue schema alongside the ingest + metadata queues.
 */

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    // ---- tbl_convert_batches (rollup) ----
    if (!(await knex.schema.hasTable(tables.convert_batches))) {
        await knex.schema.createTable(tables.convert_batches, (t) => {
            t.increments('id').primary();
            /*
             * 'collection' — every eligible member of a collection.
             * 'object'     — a single object (the per-row dashboard action).
             */
            t.string('scope_type', 20).notNullable().defaultTo('collection');
            /*
             * Exactly one identifies the scope: `collection` holds the
             * is_member_of_collection UUID, `sip_uuid` the single object.
             */
            t.string('collection', 255).nullable();
            t.string('sip_uuid', 255).nullable();
            /*
             * Row count enqueued at creation. Batches are small enough
             * (one collection at a time) that paced enqueue à la the
             * metadata producer isn't needed — we insert the whole scope
             * up front and let the worker pace the DRAIN.
             */
            t.integer('total').notNullable().defaultTo(0);
            /*
             * Actor identity at start — matches the ingest_jobs /
             * metadata_refresh_batches convention (du_id + display name).
             */
            t.string('actor', 255).notNullable().defaultTo('');
            t.string('actor_name', 255).notNullable().defaultTo('');
            t.timestamp('created_at').defaultTo(knex.fn.now());
            t.index(['created_at']);
        });
    }

    // ---- tbl_convert_queue (work rows) ----
    if (!(await knex.schema.hasTable(tables.convert_queue))) {
        await knex.schema.createTable(tables.convert_queue, (t) => {
            t.increments('id').primary();
            /*
             * Owning batch (tbl_convert_batches.id). Plain integer, not a
             * hard FK — keeps migrations driver-portable (sqlite in test)
             * and avoids FK teardown ordering constraints.
             */
            t.integer('batch_id').notNullable();
            /*
             * Denormalized object fields, captured at enqueue time from
             * tbl_objects so the worker never re-reads the repo DB.
             */
            t.string('pid', 255).nullable();
            t.string('sip_uuid', 255).nullable();
            t.string('collection', 255).nullable();
            /*
             * file_name is the stored path (the payload's full_path);
             * object_name is its basename. 1024 gives headroom over
             * tbl_objects.file_name's varchar(255) for deep paths.
             */
            t.string('file_name', 1024).nullable();
            t.string('object_name', 512).nullable();
            t.string('mime_type', 255).nullable();
            // PENDING → IN_PROGRESS → COMPLETE | FAILED.
            t.string('status', 20).notNullable().defaultTo('PENDING');
            /*
             * Per-row retry accounting. On failure the worker increments
             * attempts and returns the row to PENDING until attempts
             * reaches CONVERT_SERVICE_MAX_ATTEMPTS, then FAILED (terminal).
             */
            t.integer('attempts').notNullable().defaultTo(0);
            // Last response, captured for the dashboard / debugging.
            t.integer('http_status').nullable();
            t.text('response_body', 'text').nullable();
            t.text('last_error', 'text').nullable();
            t.timestamp('created_at').defaultTo(knex.fn.now());
            t.timestamp('updated_at').defaultTo(knex.fn.now());
            /*
             * Claim scan orders by (status, attempts, id): fresh rows
             * drain before retries, so one poison row can't head-of-line
             * block a batch.
             */
            t.index(['status', 'attempts', 'id']);
            t.index(['batch_id']);
            t.index(['sip_uuid']);
        });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists(tables.convert_queue);
    await knex.schema.dropTableIfExists(tables.convert_batches);
};
