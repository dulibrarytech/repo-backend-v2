'use strict';

/*
 * Build a fresh Express app for tests. The factory in config/express.js
 * can be called multiple times safely (no module-level state aside from
 * the cached app_config, which we expose a reset for).
 */

const create_app = require('../../config/express');
const app_config = require('../../config/app');

function make_app({ env = {} } = {}) {
    const saved = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        process.env[k] = env[k];
    }
    app_config._reset();
    const app = create_app();
    /*
     * Restore env after factory has captured config; cached config
     * remains for the lifetime of the returned app.
     */
    for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    return app;
}

module.exports = { make_app };
