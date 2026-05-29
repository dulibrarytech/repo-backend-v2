'use strict';

// Schema bootstrap for tests + first-time setup.
//
// The authoritative schema lives in knex migrations under
// /knex/migrations/{repo,repo_queue}/. This module is a thin wrapper
// that runs those migrations against a knex instance — used by tests
// (against in-memory sqlite) and by anyone who wants to bring a fresh
// DB up to current head programmatically.
//
// Why not call `knex migrate:latest` from the CLI for tests? Because
// tests pass their own knex instance (the test pool that points at
// SQLite). The CLI builds its own connection from knexfile.js, which
// is mysql2-only. Using knex.migrate.latest() with a `directory`
// override lets us share the migration files between both paths.
//
// New schema changes:
//   - DO add a new migration file to /knex/migrations/{repo,repo_queue}/
//     with a fresh timestamp (e.g. via `npm run migrate:make:repo`).
//   - DO NOT edit existing migration files once they've been applied
//     anywhere — that silently desyncs envs.

const path = require('node:path');

const REPO_DIR = path.join(__dirname, '..', 'knex', 'migrations', 'repo');
const QUEUE_DIR = path.join(__dirname, '..', 'knex', 'migrations', 'repo_queue');

// Run all pending migrations for the repo DB. Idempotent: knex tracks
// applied migrations in the knex_migrations table; running on an
// already-current DB is a no-op.
async function create_repo_schema(knex) {
    await knex.migrate.latest({ directory: REPO_DIR });
}

async function create_queue_schema(knex) {
    await knex.migrate.latest({ directory: QUEUE_DIR });
}

// Roll back the LAST applied migration batch for the named DB.
// Mostly useful in dev / tests; production rollbacks are usually
// done with explicit migration files (a "down" migration that's
// itself an "up").
async function rollback_repo_schema(knex) {
    await knex.migrate.rollback({ directory: REPO_DIR });
}

async function rollback_queue_schema(knex) {
    await knex.migrate.rollback({ directory: QUEUE_DIR });
}

// drop_all is the nuclear option — explicitly drop a list of named
// tables. Kept for tests that want to wipe the DB without going
// through the migration's down (which would also drop knex_migrations
// indirectly via the lifecycle). Use sparingly.
async function drop_all(knex, table_names) {
    for (const name of table_names) {
        const has = await knex.schema.hasTable(name);
        if (has) await knex.schema.dropTable(name);
    }
}

module.exports = {
    create_repo_schema,
    create_queue_schema,
    rollback_repo_schema,
    rollback_queue_schema,
    drop_all,
};
