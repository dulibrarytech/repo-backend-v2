#!/usr/bin/env node
'use strict';

/*
 * Backfill display_record fields that the v2 corpus lost but the v1
 * Elasticsearch index still carries.
 *
 * Four field families are recovered (root causes: metadata refreshes over
 * the years dropped `resource_type` from the stored ArchivesSpace record,
 * a few rows lost their DIP path / Kaltura id / parts manifest, and two
 * rows have a NULL display_record column entirely):
 *
 *   type      — display_record.type      (v1 L2.type; ~3.5k rows)
 *   object    — display_record.object    (v1 L2.object; DIP master path)
 *   entry_id  — display_record.entry_id  (v1 L2.entry_id; Kaltura A/V)
 *   parts     — display_record.parts     (v1 L2.parts, only when the row
 *               has NO usable parts/compound of its own)
 *   envelope  — rows whose display_record column is NULL get the whole
 *               v1 L2 envelope verbatim
 *
 * The v1 source index docs are 3-level: _source.display_record is the L2
 * envelope this script reads. Point V1_ES_HOST at any ES holding a copy
 * of the v1 index (a local mirror works — no VPN needed at run time).
 *
 * DRY-RUN by default: prints per-family counts and a sample of planned
 * updates. Only with --execute does it UPDATE tbl_objects. Idempotent —
 * only missing fields are ever ADDED; nothing existing is overwritten.
 * Re-running after a partial run just fills what is still missing.
 * Updated rows get is_indexed=0 so the indexer worker re-projects them.
 *
 * Usage:
 *   V1_ES_HOST=http://localhost:9200 V1_ES_INDEX=repo_public_dev \
 *     node scripts/backfill_display_record_from_v1.js            # dry-run
 *   ... --execute                                                # write
 *   ... --pids <pid,pid,...>                                     # restrict
 */

const { db, destroy_all } = require('../config/db');
const tables = require('../config/db_tables');
const log = require('../libs/log');

const V1_ES_HOST = process.env.V1_ES_HOST || 'http://localhost:9200';
const V1_ES_INDEX = process.env.V1_ES_INDEX || 'repo_public_dev';
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
 * Normalize a v1 doc (either shape) to the recoverable fields.
 *
 * - 3-level (repo_public_dev): _source.display_record is the L2 envelope
 *   carrying type/object/entry_id/parts. Detected by L2-only markers —
 *   `parts` is NOT one (the raw AS record has parts too).
 * - 2-level (prod repo_public): the same fields live on _source itself,
 *   with the parts manifest at _source.parts / .compound /
 *   .display_record.parts.
 */
function v1_level2(source) {
    const src = source || {};
    const dr = src.display_record;
    if (dr && typeof dr === 'object' && (dr.type || dr.object || dr.entry_id || dr.display_record)) {
        return dr;
    }
    const inner = dr && typeof dr === 'object' ? dr : {};
    const parts = src.parts || src.compound || inner.parts;
    const out = {};
    if (typeof src.type === 'string') out.type = src.type;
    if (typeof src.object === 'string') out.object = src.object;
    if (typeof src.entry_id === 'string') out.entry_id = src.entry_id;
    if (Array.isArray(parts)) out.parts = parts;
    return out;
}

function has_usable_parts(dr) {
    const inner = dr.display_record;
    return Boolean(
        (Array.isArray(dr.parts) && dr.parts.length > 0) ||
            (Array.isArray(dr.compound) && dr.compound.length > 0) ||
            (inner &&
                typeof inner === 'object' &&
                Array.isArray(inner.parts) &&
                inner.parts.length > 0)
    );
}

/*
 * Compute the merged display_record for one row, returning
 * { merged, changes[] } — changes empty when nothing is missing or the
 * v1 doc has nothing to offer.
 */
function merge_row(row_dr, l2) {
    const changes = [];
    if (!row_dr || typeof row_dr !== 'object') {
        if (l2 && typeof l2 === 'object' && Object.keys(l2).length > 0) {
            return { merged: l2, changes: ['envelope'] };
        }
        return { merged: row_dr, changes: [] };
    }
    const merged = { ...row_dr };
    if (!merged.type && typeof l2.type === 'string' && l2.type) {
        merged.type = l2.type;
        changes.push('type');
    }
    if (!merged.object && typeof l2.object === 'string' && l2.object) {
        merged.object = l2.object;
        changes.push('object');
    }
    if (!merged.entry_id && typeof l2.entry_id === 'string' && l2.entry_id) {
        merged.entry_id = l2.entry_id;
        changes.push('entry_id');
    }
    if (!has_usable_parts(merged) && Array.isArray(l2.parts) && l2.parts.length > 0) {
        merged.parts = l2.parts;
        changes.push('parts');
    }
    return { merged, changes };
}

async function fetch_v1_docs(pids) {
    const res = await fetch(`${V1_ES_HOST}/${V1_ES_INDEX}/_mget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: pids }),
    });
    if (!res.ok) throw new Error(`v1 _mget failed: HTTP ${res.status}`);
    const data = await res.json();
    const out = new Map();
    for (const d of data.docs || []) {
        if (d.found) out.set(d._id, d._source);
    }
    return out;
}

async function main() {
    const args = parse_args(process.argv);
    const OBJECTS = tables.objects;

    let q = db()(OBJECTS)
        .select('id', 'pid', 'display_record')
        .where({ is_active: 1 })
        .andWhere('object_type', '!=', 'collection');
    if (args.pids) q = q.whereIn('pid', args.pids);
    const rows = await q;

    const counts = { rows: rows.length, v1_missing: 0, unchanged: 0, updated: 0 };
    const family_counts = {};
    const samples = [];

    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const v1 = await fetch_v1_docs(batch.map((r) => r.pid));

        for (const row of batch) {
            const src = v1.get(row.pid);
            if (!src) {
                counts.v1_missing++;
                continue;
            }
            let row_dr = null;
            if (row.display_record) {
                try {
                    row_dr =
                        typeof row.display_record === 'string'
                            ? JSON.parse(row.display_record)
                            : row.display_record;
                } catch (_e) {
                    row_dr = null; // invalid JSON column -> treat as missing envelope
                }
            }
            const { merged, changes } = merge_row(row_dr, v1_level2(src));
            if (changes.length === 0) {
                counts.unchanged++;
                continue;
            }
            counts.updated++;
            for (const c of changes) family_counts[c] = (family_counts[c] || 0) + 1;
            if (samples.length < 10) samples.push({ pid: row.pid, changes });

            if (args.execute) {
                await db()(OBJECTS)
                    .where({ id: row.id })
                    .update({ display_record: JSON.stringify(merged), is_indexed: 0 });
            }
        }
        log.info({
            event: 'backfill_progress',
            scanned: Math.min(i + BATCH, rows.length),
            of: rows.length,
            updated: counts.updated,
        });
    }

    console.log(`\n${args.execute ? 'EXECUTED' : 'DRY-RUN'} against ${V1_ES_HOST}/${V1_ES_INDEX}`);
    console.log('rows scanned:      ', counts.rows);
    console.log('not in v1 index:   ', counts.v1_missing);
    console.log('already complete:  ', counts.unchanged);
    console.log(`rows ${args.execute ? 'updated' : 'needing update'}: `, counts.updated);
    console.log('by field:          ', JSON.stringify(family_counts));
    console.log('sample:            ', JSON.stringify(samples, null, 1));
    if (!args.execute && counts.updated > 0) {
        console.log('\nRe-run with --execute to write. Updated rows get is_indexed=0.');
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

module.exports = { parse_args, v1_level2, has_usable_parts, merge_row };
