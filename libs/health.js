'use strict';

// Aggregated health snapshot. Each "check" is an async function that
// returns `{ ok: true }` or `{ ok: false, error: '...' }`. The endpoint
// in config/express.js calls report() and returns 200 if every check is
// ok, else 503.
//
// Phase 1 ships the registry only — the DB and Elasticsearch checks
// land in Phase 4 when those configs exist. New checks register via
// `register(name, fn)`.

const checks = new Map();

function register(name, fn) {
    if (typeof fn !== 'function') {
        throw new TypeError(`Health check "${name}" must be a function`);
    }
    checks.set(name, fn);
}

function unregister(name) {
    checks.delete(name);
}

function clear() {
    checks.clear();
}

async function report() {
    const entries = await Promise.all(
        Array.from(checks.entries()).map(async ([name, fn]) => {
            try {
                const result = await fn();
                if (result && result.ok === true) return [name, { ok: true }];
                return [
                    name,
                    {
                        ok: false,
                        error: (result && result.error) || 'check returned not-ok',
                    },
                ];
            } catch (err) {
                return [name, { ok: false, error: err.message }];
            }
        })
    );
    const components = Object.fromEntries(entries);
    const ok = entries.every(([, v]) => v.ok);
    return { ok, components };
}

module.exports = { register, unregister, clear, report };
