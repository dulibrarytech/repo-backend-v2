'use strict';

// DuraCloud space-usage helper for the stats page.
//
// Two upstream calls (DIP + AIP) against AM's Storage Service API.
// Each call can take 1-3s on a healthy AM, longer when AM is under
// load. We:
//   - Issue them in parallel (Promise.all) so the slowest one bounds
//     latency, not the sum.
//   - Cache the result for `CACHE_TTL_MS` (longer than the regular
//     30s stats cache) because storage usage moves on the order of
//     hours, not seconds, and the HTTP cost is meaningful.
//   - Treat either call returning null (AM unreachable, missing
//     storage UUID, transport error) as a partial result — the cards
//     render '—' for the missing value, the dashboard doesn't break.
//
// The HTMX partial that renders these cards lives in
// views/dashboard/partials/stats_duracloud.ejs and is loaded by the
// stats page AFTER the main paint so a slow AM doesn't gate the
// rest of the page.

const archivematica = require('../libs/archivematica');
const log = require('../libs/log');

const CACHE_TTL_MS = 60_000;
let cached = null; // { at: <ms>, value: {dip_bytes, aip_bytes, total_bytes, ok, error?} }

async function usage() {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.value;
    }
    const value = await _fetch();
    cached = { at: Date.now(), value };
    return value;
}

async function _fetch() {
    let dip_bytes = null;
    let aip_bytes = null;
    let error = null;

    if (!archivematica.is_storage_configured()) {
        return {
            dip_bytes: null,
            aip_bytes: null,
            total_bytes: null,
            ok: false,
            error: 'AM storage API not configured',
        };
    }

    try {
        const [dip, aip] = await Promise.all([
            archivematica.get_dip_storage_usage().catch((err) => {
                log.warn({ event: 'stats_dip_usage_failed', err: err.message });
                return null;
            }),
            archivematica.get_aip_storage_usage().catch((err) => {
                log.warn({ event: 'stats_aip_usage_failed', err: err.message });
                return null;
            }),
        ]);
        dip_bytes = _coerce_bytes(dip);
        aip_bytes = _coerce_bytes(aip);
    } catch (err) {
        // Shouldn't happen — the inner catches handle per-call errors —
        // but be defensive against future refactors.
        error = err.message;
        log.warn({ event: 'stats_duracloud_usage_failed', err: err.message });
    }

    const total_bytes =
        dip_bytes !== null && aip_bytes !== null ? dip_bytes + aip_bytes : null;
    const ok = dip_bytes !== null && aip_bytes !== null && !error;
    return {
        dip_bytes,
        aip_bytes,
        total_bytes,
        ok,
        error,
    };
}

function _coerce_bytes(raw) {
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

// Test-only — clear the cache between cases.
function _reset() {
    cached = null;
}

module.exports = {
    usage,
    _reset,
    CACHE_TTL_MS,
};
