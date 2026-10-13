'use strict';

/*
 * Usage for the home page's three storage cards, which follow
 * Archivematica's storage (`store_label()` names it):
 *   - DIP_COPY_ENABLED off: the Storage Service's DuraCloud spaces, two
 *     calls (DIP + AIP) in parallel.
 *   - On: DCP's DIP and AIP locations, from curation's cached bucket-usage
 *     readout.
 * The result is cached for CACHE_TTL_MS. A value that can't be had comes
 * back null, and its card renders '—'; the DCP path also carries the
 * cache's age (computed_at) and whether curation is recalculating, for
 * the cards' hover text. The cards are
 * views/dashboard/partials/stats_duracloud.ejs, which the stats page
 * loads after the main paint.
 */

const app_config = require('../config/app');
const archivematica = require('../libs/archivematica');
const curation = require('../ingester/libs/aip_store_client');
const log = require('../libs/log');

const CACHE_TTL_MS = 60_000;
let cached = null; // { at: <ms>, value: {dip_bytes, aip_bytes, total_bytes, ok, error?} }

function on_dcp() {
    return app_config().ingest_worker.dip_copy_enabled === true;
}

/*
 * The store the cards name, for both the stats page's placeholders and
 * the partial.
 */
function store_label() {
    return on_dcp() ? 'DuraCloud Preserve' : 'DuraCloud';
}

async function usage() {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.value;
    }
    const value = on_dcp() ? await _from_dcp() : await _from_storage_service();
    cached = { at: Date.now(), value };
    return value;
}

async function _from_storage_service() {
    let dip_bytes = null;
    let aip_bytes = null;
    let error = null;

    if (!archivematica.is_storage_configured()) {
        return _result(null, null, 'AM storage API not configured');
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
        /*
         * Shouldn't happen — the inner catches handle per-call errors —
         * but be defensive against future refactors.
         */
        error = err.message;
        log.warn({ event: 'stats_duracloud_usage_failed', err: err.message });
    }

    return _result(dip_bytes, aip_bytes, error);
}

/*
 * DCP's numbers from curation's cache: `dcp_dip_store` and
 * `dcp_aip_store`, which curation adds once it has its DCP key. While it
 * is walking (or has never walked), they're missing and the cards say
 * "not measured yet"; a finished walk without them means curation isn't
 * measuring DCP at all, and the cards say that instead.
 */
async function _from_dcp() {
    if (!curation.is_configured()) {
        return _result(null, null, 'curation API not configured');
    }
    let answer = null;
    try {
        const res = await curation.bucket_usage();
        if (res.status === 200 && res.data && res.data.ok) {
            answer = res.data;
        } else {
            // A wrong key or a curation fault: in the log, not only on hover.
            log.warn({ event: 'stats_dcp_usage_refused', status: res.status });
        }
    } catch (err) {
        log.warn({ event: 'stats_dcp_usage_failed', err: err.message });
    }
    if (!answer) {
        return _result(null, null, 'DuraCloud Preserve usage unavailable');
    }
    const usage = answer.usage || null;
    const buckets = (usage && usage.buckets) || {};
    const computing = answer.computing === true;
    const dip = buckets.dcp_dip_store || {};
    const aip = buckets.dcp_aip_store || {};
    let error = dip.error || aip.error || null;
    if (!error && (dip.bytes === undefined || aip.bytes === undefined)) {
        error =
            computing || !usage
                ? 'DuraCloud Preserve usage not measured yet'
                : 'curation is not measuring DuraCloud Preserve (DCP key unset, or an older build); fix that, then Recalculate on the Services page';
    }
    return _result(_coerce_bytes(dip.bytes), _coerce_bytes(aip.bytes), error, {
        computed_at: usage ? _coerce_bytes(usage.computed_at) : null,
        computing,
    });
}

/*
 * `computed_at` is the cache's epoch (seconds) on the DCP path, null on
 * the Storage Service path, which asks live; `computing` is curation's
 * "a walk is running".
 */
function _result(dip_bytes, aip_bytes, error, { computed_at = null, computing = false } = {}) {
    const total_bytes = dip_bytes !== null && aip_bytes !== null ? dip_bytes + aip_bytes : null;
    const ok = dip_bytes !== null && aip_bytes !== null && !error;
    return {
        dip_bytes,
        aip_bytes,
        total_bytes,
        ok,
        error,
        computed_at,
        computing,
    };
}

// A non-negative number, else null: byte counts and the cache's epoch.
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
    store_label,
    _reset,
    CACHE_TTL_MS,
};
