#!/usr/bin/env node
'use strict';

/*
 * Backfill https handles: rewrite legacy http://hdl.handle.net/ handle
 * URLs to https:// in the DATA, making the render-time rewrite
 * (libs/object_projection secure_handle, added 2026-07-28) redundant.
 *
 * Touches, per row of tbl_objects:
 *
 *   handle column                 — http → https when it is a
 *                                   hdl.handle.net URL
 *   display_record.handle         — the projection copy the indexer
 *                                   ships to Elasticsearch (and the
 *                                   public frontend reads)
 *   display_record.display_record.handle — defensive: rewritten if a
 *                                   nested copy exists (none observed
 *                                   in the current corpus)
 *
 * Junk handle values (v1-era mint-failure error strings, bare pids,
 * test values — 8 rows as of 2026-07-28) are REPORTED but never
 * modified; decide per-row whether to re-mint via the handle service
 * or null the column.
 *
 * DRY-RUN by default: prints counts + samples, writes nothing. Only
 * with --execute does it UPDATE. Idempotent — a rewritten row no
 * longer matches, so re-running after a partial run finishes the
 * remainder and a full re-run is a no-op. Updated rows get
 * is_indexed=0 so the indexer worker re-projects them to ES on its
 * normal ticks (expect the indexer admin Dirty count to spike to
 * ~the updated-row count and drain; no manual reindex needed, but the
 * app + indexer must be RUNNING for the ES side to catch up).
 *
 * Usage:
 *   node scripts/backfill_https_handles.js              # dry-run
 *   node scripts/backfill_https_handles.js --execute    # write
 *   node scripts/backfill_https_handles.js --pids a,b   # restrict
 */

const { db, destroy_all } = require('../config/db');
const tables = require('../config/db_tables');
const log = require('../libs/log');
const { secure_handle } = require('../libs/object_projection');

const BATCH = 500;

function parse_args(argv) {
    const o = { execute: false, pids: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--execute') o.execute = true;
        else if (a === '--pids') o.pids = String(argv[++i] || '').split(',').filter(Boolean);
        else throw new Error(`unknown arg: ${a}`);
    }
    return o;
}

/*
 * A "junk" handle is a non-empty value that isn't a URL at all —
 * stored error strings, bare pids, test values. http URLs on OTHER
 * hosts are not junk (secure_handle simply leaves them alone).
 */
function is_junk_handle(value) {
    return typeof value === 'string' && value !== '' && !/^https?:\/\//i.test(value);
}

/*
 * Compute the rewrite for one row. Pure — returns
 * { new_handle, new_display_record, changes[] } where each is null
 * when that piece needs no update. `changes` names what moved:
 * 'handle_column', 'display_record'.
 */
function rewrite_row(handle, display_record_raw) {
    const changes = [];

    let new_handle = null;
    if (typeof handle === 'string' && handle !== '') {
        const rewritten = secure_handle(handle);
        if (rewritten !== handle) {
            new_handle = rewritten;
            changes.push('handle_column');
        }
    }

    let new_display_record = null;
    if (display_record_raw) {
        let dr = null;
        try {
            dr =
                typeof display_record_raw === 'string'
                    ? JSON.parse(display_record_raw)
                    : display_record_raw;
        } catch (_e) {
            dr = null; // corrupt JSON — column-only rewrite still applies
        }
        if (dr && typeof dr === 'object') {
            let dirty = false;
            if (typeof dr.handle === 'string' && dr.handle !== '') {
                const rewritten = secure_handle(dr.handle);
                if (rewritten !== dr.handle) {
                    dr.handle = rewritten;
                    dirty = true;
                }
            }
            const inner = dr.display_record;
            if (inner && typeof inner === 'object' && typeof inner.handle === 'string' && inner.handle !== '') {
                const rewritten = secure_handle(inner.handle);
                if (rewritten !== inner.handle) {
                    inner.handle = rewritten;
                    dirty = true;
                }
            }
            if (dirty) {
                new_display_record = JSON.stringify(dr);
                changes.push('display_record');
            }
        }
    }

    return { new_handle, new_display_record, changes };
}

async function main() {
    const args = parse_args(process.argv);
    const OBJECTS = tables.objects;

    /*
     * All rows, collections included — collections carry handles too.
     * Soft-deleted rows included on purpose: their data should be
     * consistent if they're ever restored, and is_indexed=0 on an
     * ineligible row is a no-op for ES.
     */
    let q = db()(OBJECTS).select('id', 'pid', 'handle', 'display_record');
    if (args.pids) q = q.whereIn('pid', args.pids);
    const rows = await q;

    const counts = {
        rows: rows.length,
        updated: 0,
        handle_column: 0,
        display_record: 0,
        corrupt_json: 0,
        unchanged: 0,
    };
    const junk = [];
    const samples = [];

    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        for (const row of batch) {
            if (is_junk_handle(row.handle)) {
                junk.push({ pid: row.pid, handle: String(row.handle).slice(0, 80) });
            }
            if (row.display_record && typeof row.display_record === 'string') {
                try {
                    JSON.parse(row.display_record);
                } catch (_e) {
                    counts.corrupt_json++;
                }
            }

            const { new_handle, new_display_record, changes } = rewrite_row(
                row.handle,
                row.display_record
            );
            if (changes.length === 0) {
                counts.unchanged++;
                continue;
            }
            counts.updated++;
            for (const c of changes) counts[c]++;
            if (samples.length < 5) samples.push({ pid: row.pid, changes });

            if (args.execute) {
                const update = { is_indexed: 0 };
                if (new_handle) update.handle = new_handle;
                if (new_display_record) update.display_record = new_display_record;
                await db()(OBJECTS).where({ id: row.id }).update(update);
            }
        }
        log.info({
            event: 'https_handle_backfill_progress',
            scanned: Math.min(i + BATCH, rows.length),
            of: rows.length,
            updated: counts.updated,
        });
    }

    console.log(`\n${args.execute ? 'EXECUTED' : 'DRY-RUN'}`);
    console.log('rows scanned:            ', counts.rows);
    console.log(`rows ${args.execute ? 'updated' : 'needing update'}:  `, counts.updated);
    console.log('  handle column:         ', counts.handle_column);
    console.log('  display_record copy:   ', counts.display_record);
    console.log('already https/no handle: ', counts.unchanged);
    console.log('corrupt JSON (skipped):  ', counts.corrupt_json);
    console.log('sample:                  ', JSON.stringify(samples));
    if (junk.length > 0) {
        console.log(`\nJUNK handle values (${junk.length} rows) — NOT modified; fix manually`);
        console.log('(re-mint via the handle service, or null the column):');
        for (const j of junk) console.log(`  ${j.pid}  ${JSON.stringify(j.handle)}`);
    }
    if (!args.execute && counts.updated > 0) {
        console.log(
            '\nRe-run with --execute to write. Updated rows get is_indexed=0 — the\n' +
                'indexer worker re-projects them to ES on its normal ticks (watch the\n' +
                'indexer admin page Dirty count drain).'
        );
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
            console.error(err);
            return destroy_all().then(() => process.exit(1));
        });
}

module.exports = { parse_args, is_junk_handle, rewrite_row };
