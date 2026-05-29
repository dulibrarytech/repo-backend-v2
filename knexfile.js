'use strict';

// Knex CLI config. Two environments, one per database — `repo` (the
// main object/user store) and `repo_queue` (the ingest + metadata
// refresh queues). Each has its own migrations directory so the two
// schemas evolve independently.
//
// Usage:
//   npx knex migrate:latest --env repo
//   npx knex migrate:latest --env repo_queue
//   npx knex migrate:status --env repo
//   npx knex migrate:rollback --env repo
//   npx knex migrate:make --env repo add_foo_column
//
// Or via npm scripts (see package.json):
//   npm run migrate:repo
//   npm run migrate:queue
//   npm run migrate:all
//
// Tests don't use this file — `db/schema.js` runs the same migrations
// programmatically against the in-memory SQLite pool. Same migration
// code path, just a different driver.

require('dotenv').config();

const path = require('node:path');

function build(env_prefix, migrations_dir) {
    return {
        client: 'mysql2',
        connection: {
            host: process.env[`${env_prefix}_HOST`],
            port: Number.parseInt(process.env[`${env_prefix}_PORT`] || '3306', 10),
            user: process.env[`${env_prefix}_USER`],
            password: process.env[`${env_prefix}_PASSWORD`],
            database: process.env[`${env_prefix}_NAME`],
            timezone: '+00:00',
            charset: 'utf8mb4',
        },
        migrations: {
            directory: path.join(__dirname, 'knex', 'migrations', migrations_dir),
            // The default 'knex_migrations' table name is fine for
            // both DBs since they live in separate databases.
            tableName: 'knex_migrations',
            // Each migration runs in its own transaction by default;
            // disable per-migration if a single migration ever needs
            // DDL that doesn't play nice inside a transaction.
            disableTransactions: false,
        },
    };
}

module.exports = {
    repo: build('DB', 'repo'),
    repo_queue: build('DB_QUEUE', 'repo_queue'),
};
