'use strict';

/*
 * Test-database harness.
 * 
 * Tests at the integration and e2e tiers use a real sqlite-in-memory
 * knex pool (see config/db.js — NODE_ENV=test branches automatically).
 * This helper provides:
 * 
 *   setup_schema()       — materialize tbl_objects, tbl_users, queue tables
 *   reset_data()         — truncate everything (keeps schema)
 *   teardown()           — destroy the pools (called from afterAll)
 *   seed_user(overrides) — convenience for creating a test user
 *   seed_object(...)     — convenience for creating a test object
 */

const { randomUUID } = require('node:crypto');
const { db, db_queue, destroy_all } = require('../../config/db');
const tables = require('../../config/db_tables');
const schema = require('../../db/schema');

async function setup_schema() {
    await schema.create_repo_schema(db());
    await schema.create_queue_schema(db_queue());
}

async function reset_data() {
    await db()(tables.objects).del();
    await db()(tables.users).del();
    /*
     * tbl_aip_store lives in the repo DB and has no FK; truncate
     * independently. Some tests pre-seed rows here so we run this
     * every reset.
     */
    await db()(tables.aip_store).del();
    /*
     * ingest_events first — FK-by-convention into ingest_queue, must
     * not outlive its parent rows in test fixtures.
     */
    await db_queue()(tables.ingest_events).del();
    await db_queue()(tables.ingest_queue).del();
    // ingest_jobs has no FK; can truncate independently.
    await db_queue()(tables.ingest_jobs).del();
    /*
     * metadata_refresh_batches rollup; queue rows are not FK'd but
     * tests that use the system refresh leave rows behind without
     * this.
     */
    await db_queue()(tables.metadata_refresh_batches).del();
    await db_queue()(tables.metadata_update_queue).del();
    // Kaltura queue tables. No FK; truncate independently.
    await db_queue()(tables.kaltura_ids).del();
    await db_queue()(tables.kaltura_package_queue).del();
    /*
     * Convert queue + batches: ingest Stage 4b auto-enqueues TIFF
     * conversions, so stage tests leave rows behind without this.
     */
    await db_queue()(tables.convert_queue).del();
    await db_queue()(tables.convert_batches).del();
}

async function teardown() {
    await destroy_all();
}

async function seed_user(overrides = {}) {
    const row = {
        du_id: overrides.du_id || `dev-${randomUUID().slice(0, 8)}`,
        email: overrides.email || 'tester@example.com',
        first_name: overrides.first_name || 'Test',
        last_name: overrides.last_name || 'User',
        /*
         * Default test users to 'admin' so existing e2e tests that exercise
         * admin routes keep passing; RBAC tests pass an explicit role.
         */
        role: overrides.role || 'admin',
        is_active: overrides.is_active === undefined ? 1 : overrides.is_active,
        token: overrides.token || '0',
    };
    const [id] = await db()(tables.users).insert(row);
    return { id, ...row };
}

async function seed_object(overrides = {}) {
    const pid = overrides.pid || randomUUID();
    /*
     * Defaults first; overrides take precedence. Any column the caller
     * passes (file_name, mods_id, sip_uuid, etc.) flows through, which
     * is essential for search tests that need specific text in
     * searchable columns. Spread overrides then re-pin pid so an
     * explicit `{pid: undefined}` doesn't wipe it.
     */
    const row = {
        is_member_of_collection: 'codu:root',
        object_type: 'object',
        handle: `https://hdl.invalid/${pid}`,
        is_published: 0,
        is_active: 1,
        is_compound: 0,
        is_indexed: 0,
        is_restricted: 0,
        is_complete: 1,
        ...overrides,
        pid,
    };
    const [id] = await db()(tables.objects).insert(row);
    return { id, ...row };
}

/*
 * Convenience seeder for tbl_aip_store rows. Defaults match a clean
 * v2 ingest-time copy; tests override any column.
 */
async function seed_aip_store(overrides = {}) {
    const row = {
        uuid: overrides.uuid || randomUUID(),
        aip: overrides.aip || 'test-aip.7z',
        aip_legacy: '',
        downloaded: 0,
        is_migrated: 6, // v2 ingest: copied_ok
        source: 'ingest_v2',
        wasabi_bucket: 'library-repository',
        wasabi_key: 'aip-store/test-aip.7z',
        bytes: 1024,
        copied_at: new Date(),
        attempts: 0,
        ...overrides,
    };
    const [id] = await db()(tables.aip_store).insert(row);
    return { id, ...row };
}

module.exports = {
    setup_schema,
    reset_data,
    teardown,
    seed_user,
    seed_object,
    seed_aip_store,
};
