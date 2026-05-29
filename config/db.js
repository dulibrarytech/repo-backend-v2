'use strict';

// Two-pool DB layer.
//
//   db()       — knex instance for the `repo` schema (tbl_objects, tbl_users)
//   db_queue() — knex instance for the `repo_queue` schema (queue + jobs)
//
// In production, both use mysql2 with explicit pool sizing (pre-empts the
// "wait, why are we leaking connections?" failure mode the legacy app had —
// see MODERNIZATION_PLAN §4.2 and the ingest-service's existing config).
//
// In test (NODE_ENV=test), both fall back to a sqlite-in-memory pool via
// better-sqlite3. Each test process gets its own clean store; integration
// tests call `migrate()` to materialize the schema.

const knex = require('knex');
const log = require('../libs/log');

const POOL = {
    min: 2,
    max: 10,
    acquireTimeoutMillis: 30_000,
    createTimeoutMillis: 30_000,
    idleTimeoutMillis: 30_000,
};

function require_env(name) {
    const v = process.env[name];
    if (!v) throw new Error(`DB env missing: ${name}`);
    return v;
}

function build_mysql(env_prefix) {
    return knex({
        client: 'mysql2',
        connection: {
            host: require_env(`${env_prefix}_HOST`),
            port: Number.parseInt(process.env[`${env_prefix}_PORT`] || '3306', 10),
            user: require_env(`${env_prefix}_USER`),
            password: require_env(`${env_prefix}_PASSWORD`),
            database: require_env(`${env_prefix}_NAME`),
            timezone: '+00:00',
            charset: 'utf8mb4',
        },
        pool: POOL,
    });
}

function build_sqlite() {
    return knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
        // No pool: better-sqlite3 is synchronous; knex wraps it as a
        // single connection. Set min/max to 1 to make that explicit.
        pool: { min: 1, max: 1 },
    });
}

let _db = null;
let _db_queue = null;

function db() {
    if (_db) return _db;
    _db = process.env.NODE_ENV === 'test' ? build_sqlite() : build_mysql('DB');
    log.debug({ event: 'db_pool_init', pool: 'repo' });
    return _db;
}

function db_queue() {
    if (_db_queue) return _db_queue;
    _db_queue = process.env.NODE_ENV === 'test' ? build_sqlite() : build_mysql('DB_QUEUE');
    log.debug({ event: 'db_pool_init', pool: 'repo_queue' });
    return _db_queue;
}

// Tear down both pools. Idempotent. Used by the entry-point shutdown
// hook and by test cleanup.
async function destroy_all() {
    const errors = [];
    for (const [name, get] of [
        ['repo', () => _db],
        ['repo_queue', () => _db_queue],
    ]) {
        const instance = get();
        if (instance) {
            try {
                await instance.destroy();
                log.debug({ event: 'db_pool_destroyed', pool: name });
            } catch (err) {
                errors.push({ pool: name, err });
            }
        }
    }
    _db = null;
    _db_queue = null;
    if (errors.length > 0) {
        const messages = errors.map((e) => `${e.pool}: ${e.err.message}`).join('; ');
        throw new Error(`DB shutdown errors: ${messages}`);
    }
}

// Internal — for tests only. Swap in a custom knex instance (e.g. an
// isolated sqlite pool per test file) without rewiring callers.
function _set_for_test({ repo, repo_queue } = {}) {
    if (repo !== undefined) _db = repo;
    if (repo_queue !== undefined) _db_queue = repo_queue;
}

module.exports = {
    db,
    db_queue,
    destroy_all,
    _set_for_test,
};
