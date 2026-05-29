'use strict';

// Registers liveness checks for each DB pool against the health registry
// from libs/health. Called once at boot from config/express.js so the
// /health endpoint reports both pools' state.
//
// Each check runs a 1-row query with a 1s timeout. Fails fast — we'd
// rather a 503 than a 30s acquire-timeout hanging the LB.

const health = require('../libs/health');
const { db, db_queue } = require('./db');

async function ping(knex_instance) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ping timeout')), 1000).unref()
    );
    await Promise.race([knex_instance.raw('SELECT 1 as one'), timeout]);
    return { ok: true };
}

function register_all() {
    health.register('db_repo', () => ping(db()));
    health.register('db_repo_queue', () => ping(db_queue()));
}

module.exports = { register_all };
