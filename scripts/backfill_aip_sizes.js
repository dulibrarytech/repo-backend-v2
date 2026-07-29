#!/usr/bin/env node
'use strict';

/*
 * Backfill tbl_aip_store.bytes from the Wasabi AIP-store inventory.
 *
 * The ~20.9k legacy_migration rows came from the v1 DuraCloud→Wasabi
 * audit records, which never carried file sizes — so the AIPs
 * dashboard Size column renders "—" for all of them. The sizes exist
 * in Wasabi object metadata; this script reads them back in bulk:
 *
 *   1. Page through GET /api/v2/aip/list-objects on the curation API
 *      (one flat inventory listing — ~21 pages of 1000, seconds, no
 *      per-object round-trips, no data transfer).
 *   2. For every tbl_aip_store row with no bytes, resolve its Wasabi
 *      key the same way the download flow does
 *      (aip_store_model.derive_wasabi_key: wasabi_key → aip →
 *      basename(aip_legacy)) and look it up in the inventory —
 *      exact key first, basename fallback for prefix-shape drift.
 *   3. UPDATE bytes for matches.
 *
 * Sizes only — this does NOT verify checksums or touch is_indexed
 * (AIP rows aren't projected to ES). Rows whose key isn't in the
 * inventory are reported: they're candidates for the orphan/backfill
 * verification flows, not for this script.
 *
 * DRY-RUN by default; --execute writes. Idempotent — already-sized
 * rows are never selected, so re-runs only touch what's still empty.
 *
 * Usage:
 *   node scripts/backfill_aip_sizes.js              # dry-run
 *   node scripts/backfill_aip_sizes.js --execute    # write
 *
 * Requires CURATION_API + CURATION_API_KEY in .env (the same config
 * the dashboard download flow uses) and the curation service
 * reachable.
 */

const axios = require('axios');
const { db, destroy_all } = require('../config/db');
const tables = require('../config/db_tables');
const app_config = require('../config/app');
const log = require('../libs/log');
const { derive_wasabi_key } = require('../repository/aip_store_model');

function parse_args(argv) {
    const o = { execute: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--execute') o.execute = true;
        else throw new Error(`unknown arg: ${a}`);
    }
    return o;
}

function basename(key) {
    const parts = String(key).split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
}

/*
 * Fetch the full flat AIP-store inventory as { by_key, by_basename,
 * ambiguous_basenames, total }. Basenames that map to more than one
 * key are dropped from by_basename (matching on them would be a
 * guess) and counted instead.
 */
async function fetch_inventory(cfg) {
    const base = cfg.url.replace(/\/+$/, '');
    const by_key = new Map();
    const by_basename = new Map();
    const ambiguous = new Set();
    let token = null;
    let pages = 0;

    do {
        const res = await axios.get(`${base}/api/v2/aip/list-objects`, {
            params: token ? { token } : {},
            headers: { 'X-API-Key': cfg.api_key },
            timeout: cfg.timeout_ms || 30000,
        });
        const data = res.data || {};
        if (data.ok !== true) {
            throw new Error(`list-objects returned ok=false: ${data.error || 'unknown'}`);
        }
        for (const o of data.objects || []) {
            if (!o || typeof o.key !== 'string' || !Number.isFinite(o.size)) continue;
            by_key.set(o.key, o.size);
            const b = basename(o.key);
            if (!b) continue;
            if (ambiguous.has(b)) continue;
            if (by_basename.has(b) && by_basename.get(b) !== o.size) {
                by_basename.delete(b);
                ambiguous.add(b);
            } else {
                by_basename.set(b, o.size);
            }
        }
        token = data.next_token || null;
        pages++;
        log.info({ event: 'aip_size_inventory_page', pages, objects: by_key.size });
    } while (token);

    return { by_key, by_basename, ambiguous, pages, total: by_key.size };
}

/*
 * Resolve a row's size from the inventory. Pure — exported for tests.
 * Tries the derived key exactly, then with the common 'aip-store/'
 * prefix stripped/added, then the bare basename (only when
 * unambiguous).
 */
function resolve_size(row, by_key, by_basename) {
    const derived = derive_wasabi_key(row);
    if (!derived) return null;
    const candidates = [derived];
    if (derived.startsWith('aip-store/')) candidates.push(derived.slice('aip-store/'.length));
    else candidates.push(`aip-store/${derived}`);
    for (const c of candidates) {
        if (by_key.has(c)) return by_key.get(c);
    }
    const b = basename(derived);
    if (b && by_basename.has(b)) return by_basename.get(b);
    return null;
}

async function main() {
    const args = parse_args(process.argv);
    const cfg = app_config().curation_api;
    if (!cfg || !cfg.url || !cfg.api_key) {
        throw new Error('CURATION_API / CURATION_API_KEY not configured in .env');
    }

    console.log(`Fetching AIP-store inventory from ${cfg.url} …`);
    const inv = await fetch_inventory(cfg);
    console.log(
        `inventory: ${inv.total} objects in ${inv.pages} pages` +
            (inv.ambiguous.size > 0
                ? ` (${inv.ambiguous.size} ambiguous basenames excluded from fallback matching)`
                : '')
    );

    const rows = await db()(tables.aip_store)
        .select('id', 'uuid', 'aip', 'aip_legacy', 'wasabi_key', 'bytes')
        .where(function () {
            this.whereNull('bytes').orWhere('bytes', 0);
        });

    const counts = { missing_bytes: rows.length, matched: 0, no_key: 0, not_in_inventory: 0 };
    const unmatched_sample = [];

    for (const row of rows) {
        const size = resolve_size(row, inv.by_key, inv.by_basename);
        if (size === null) {
            if (!derive_wasabi_key(row)) counts.no_key++;
            else {
                counts.not_in_inventory++;
                if (unmatched_sample.length < 10) {
                    unmatched_sample.push({ id: row.id, key: derive_wasabi_key(row) });
                }
            }
            continue;
        }
        counts.matched++;
        if (args.execute) {
            await db()(tables.aip_store).where({ id: row.id }).update({ bytes: size });
        }
    }

    console.log(`\n${args.execute ? 'EXECUTED' : 'DRY-RUN'}`);
    console.log('rows without bytes:        ', counts.missing_bytes);
    console.log(`rows ${args.execute ? 'updated' : 'matched'}:  `, counts.matched);
    console.log('no derivable key (orphans):', counts.no_key);
    console.log('key not in inventory:      ', counts.not_in_inventory);
    if (unmatched_sample.length > 0) {
        console.log('unmatched sample:          ', JSON.stringify(unmatched_sample));
        console.log(
            '(keys not in the Wasabi inventory — candidates for the AIP\n' +
                ' backfill/orphan verification flows, not for this script)'
        );
    }
    if (!args.execute && counts.matched > 0) {
        console.log('\nRe-run with --execute to write.');
    }
}

if (require.main === module) {
    /*
     * Load .env relative to the repo root, matching am_orphans.js — the
     * script may be run from scripts/ or anywhere, and dotenv otherwise
     * resolves against cwd.
     */
    require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
    main()
        .then(() => destroy_all())
        .catch((err) => {
            console.error(err.message || err);
            return destroy_all().then(() => process.exit(1));
        });
}

module.exports = { parse_args, basename, resolve_size };
