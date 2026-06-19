'use strict';

// Byte-progress columns on tbl_ingest_queue so the dashboard can show an
// accurate upload % during the Archivematica SFTP push (Stage 2 / UPLOADING),
// instead of a static "UPLOADING" for hours on large (~35GB) packages.
//
//   - bytes_uploaded : bytes confirmed on the AM SFTP so far. The worker
//                      persists this each upload-status poll from the curation
//                      API's check_sftp (remote_package_size_bytes).
//   - total_bytes    : total bytes to upload for this package's collection
//                      staging dir (curation check_sftp local_package_size_bytes).
//
// Both default to 0; a 0 total means "unknown" and the row falls back to the
// file-count readout. bigInteger because a package can exceed 2GB.
//
// hasColumn guards so re-running against a partially-migrated or legacy DB
// is safe.

const tables = require('../../../config/db_tables');

exports.up = async function up(knex) {
    if (!(await knex.schema.hasColumn(tables.ingest_queue, 'bytes_uploaded'))) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.bigInteger('bytes_uploaded').notNullable().defaultTo(0);
        });
    }
    if (!(await knex.schema.hasColumn(tables.ingest_queue, 'total_bytes'))) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.bigInteger('total_bytes').notNullable().defaultTo(0);
        });
    }
};

exports.down = async function down(knex) {
    if (await knex.schema.hasColumn(tables.ingest_queue, 'bytes_uploaded')) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.dropColumn('bytes_uploaded');
        });
    }
    if (await knex.schema.hasColumn(tables.ingest_queue, 'total_bytes')) {
        await knex.schema.alterTable(tables.ingest_queue, (t) => {
            t.dropColumn('total_bytes');
        });
    }
};
