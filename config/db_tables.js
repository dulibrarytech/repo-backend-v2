'use strict';

// Single source of truth for physical table names. Legacy code mapped
// these via env vars; v2 keeps that flexibility but ships sane defaults
// matching the production schema (see /repo-db-schema.sql and
// /repo_queue-schema.sql).

module.exports = {
    // repo DB
    objects: process.env.REPO_OBJECTS || 'tbl_objects',
    users: process.env.REPO_USERS || 'tbl_users',
    // tbl_aip_store — preservation tier tracking. Originally populated
    // by a one-time DuraCloud → Wasabi migration (legacy column set);
    // now also written by v2 ingest Stage 6 (additive columns). See
    // knex/migrations/repo/20260525000002_aip_store.js for the full
    // column inventory and docstring.
    aip_store: process.env.REPO_AIP_STORE || 'tbl_aip_store',

    // repo_queue DB
    ingest_queue: process.env.REPO_INGEST_QUEUE || 'tbl_ingest_queue',
    ingest_events: process.env.REPO_INGEST_EVENTS || 'tbl_ingest_events',
    ingest_jobs: process.env.REPO_INGEST_JOBS || 'tbl_ingest_jobs',
    jobs: process.env.REPO_JOBS || 'tbl_jobs',
    metadata_update_queue: process.env.REPO_METADATA_UPDATE_QUEUE || 'tbl_metadata_update_queue',
    metadata_refresh_batches:
        process.env.REPO_METADATA_REFRESH_BATCHES || 'tbl_metadata_refresh_batches',
    // TIFF→JPG conversion queue + batch rollup (convert/ subsystem).
    convert_queue: process.env.REPO_CONVERT_QUEUE || 'tbl_convert_queue',
    convert_batches: process.env.REPO_CONVERT_BATCHES || 'tbl_convert_batches',
    kaltura_ids: process.env.REPO_KALTURA_IDS || 'tbl_kaltura_ids',
    kaltura_package_queue: process.env.REPO_KALTURA_PACKAGE_QUEUE || 'tbl_kaltura_package_queue',
};
