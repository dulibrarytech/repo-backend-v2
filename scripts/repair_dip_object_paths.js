'use strict';

/*
 * Repair DIP object paths on v2-ingested rows.
 *
 * The v2 ingester built part `object` paths from the METS FLocat href
 * (`objects/<original name>`), but the DuraCloud dip-store holds AM's
 * access copies as `objects/<fileUUID>-<original name>` — so every
 * published v2 image 404'd end-to-end (frontend /datastream → DuraCloud
 * → Cantaloupe → viewer). The same fileUUID names the part's
 * `thumbnails/<uuid>.jpg` derivative, which is why thumbnails worked and
 * how this script recovers the uuid for rows whose envelopes were
 * already rebuilt to the fat contract (the merged manifest doesn't carry
 * a uuid field). See repo/REPOV2_DISPLAY_RECORD_FINDINGS.md.
 *
 * Per affected row this rewrites, from data already in the row:
 *   - display_record.display_record.parts[].object  (uuid-prefixed)
 *   - display_record.object                         (master part's path)
 *   - tbl_objects.file_name                         (v1 convention: the
 *     master's FULL dip-store path — the convert service posts it
 *     verbatim, and 21.7k legacy rows agree)
 *   - compound_parts                                (re-serialized)
 *   - is_updated=1 so the indexer re-projects published rows
 *
 * Idempotent: a part whose object basename already starts with its
 * thumbnail's uuid is left alone; a second run finds nothing to do.
 * Legacy v1 rows are naturally untouched (their paths carry the prefix).
 *
 * Usage:
 *   node scripts/repair_dip_object_paths.js                 # dry run (default)
 *   node scripts/repair_dip_object_paths.js --execute
 *   node scripts/repair_dip_object_paths.js --pids <pid>[,<pid>]
 *   node scripts/repair_dip_object_paths.js --since 2026-07-01   # created-at floor
 *
 * Rehearsal against a prod snapshot: DB_NAME=<imported copy> node ...
 * No new dependencies — runs on the deployed checkout's node_modules.
 */

const path = require('node:path');
const display_envelope = require('../libs/display_envelope');

/*
 * Default created-at floor: comfortably before the 2026-07-30 cutover,
 * so the scan reads only the v2-era rows instead of all 23k envelopes.
 * --since widens or narrows it; --pids bypasses it.
 */
const DEFAULT_SINCE = '2026-07-01';

function parse_args(argv) {
    const o = { execute: false, pids: null, since: DEFAULT_SINCE };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--execute') o.execute = true;
        else if (a === '--pids') {
            o.pids = String(argv[++i] || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        } else if (a === '--since') {
            o.since = String(argv[++i] || '');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(o.since)) {
                throw new Error('--since must be YYYY-MM-DD');
            }
        } else throw new Error(`unknown arg: ${a}`);
    }
    return o;
}

function parse_json(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

// "…/thumbnails/52aafea5-….jpg" → "52aafea5-…", or null when unusable.
function uuid_from_thumbnail(thumbnail) {
    if (typeof thumbnail !== 'string' || thumbnail === '') return null;
    const base = thumbnail.slice(thumbnail.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)
        ? stem
        : null;
}

/*
 * Decide one row. Pure — no I/O. Returns { action: 'skip', reason } or
 * { action: 'update', updates, notes }.
 */
function plan_row(row) {
    if (!row || !row.pid) return { action: 'skip', reason: 'no_pid' };
    if (row.object_type === 'collection') return { action: 'skip', reason: 'collection' };

    const envelope = parse_json(row.display_record);
    if (!envelope) return { action: 'skip', reason: 'display_record_unparsable' };
    /*
     * Thin pre-consolidation envelope — its merged manifest doesn't
     * exist yet. backfill_display_records handles those (and, with the
     * current libs, produces correct paths directly).
     */
    if (envelope.pid === undefined) return { action: 'skip', reason: 'thin_run_backfill_first' };

    const inner = envelope.display_record;
    const parts = inner && Array.isArray(inner.parts) ? inner.parts : [];
    if (parts.length === 0) return { action: 'skip', reason: 'no_parts' };

    let changed = 0;
    let no_uuid = 0;
    const repaired = parts.map((p) => {
        if (!p || !p.object) return p;
        const uuid = uuid_from_thumbnail(p.thumbnail);
        if (!uuid) {
            no_uuid++;
            return p;
        }
        const fixed = display_envelope.dip_object_path({ ...p, uuid });
        if (fixed === p.object) return p;
        changed++;
        return { ...p, object: fixed };
    });
    if (changed === 0) {
        return { action: 'skip', reason: 'already_correct', notes: { no_uuid } };
    }

    const new_envelope = {
        ...envelope,
        display_record: { ...inner, parts: repaired },
    };
    /*
     * Re-derive the master-dependent values from the repaired manifest —
     * same selection as build_envelope uses at ingest time.
     */
    const master = display_envelope.pick_master_part(repaired);
    if (master) {
        new_envelope.object = master.object;
    }

    const updates = {
        display_record: JSON.stringify(new_envelope),
        is_updated: 1,
    };
    if (row.is_compound) {
        updates.compound_parts = JSON.stringify(repaired);
    }
    if (master && master.object && master.object !== row.file_name) {
        updates.file_name = master.object;
    }

    return {
        action: 'update',
        updates,
        notes: {
            title: envelope.title,
            parts_fixed: `${changed}/${parts.length}`,
            object: (master && master.object) || null,
            no_uuid,
        },
    };
}

async function select_candidates(db, tables, args) {
    const q = db(tables.objects)
        .select(
            'pid',
            'object_type',
            'is_compound',
            'file_name',
            'display_record',
            'created'
        )
        .where('is_active', 1);
    if (args.pids && args.pids.length > 0) q.whereIn('pid', args.pids);
    else q.where('created', '>=', `${args.since} 00:00:00`);
    return q;
}

async function run(args, deps = {}) {
    const { db, destroy_all } = deps.db_module || require('../config/db');
    const tables = deps.tables || require('../config/db_tables');
    const select = deps.select_candidates || select_candidates;

    const rows = await select(db(), tables, args);
    const counts = { update: 0, skip: 0 };
    const results = [];

    for (const row of rows) {
        const plan = plan_row(row);
        results.push({ pid: row.pid, ...plan });
        if (plan.action === 'update') {
            counts.update++;
            const label = args.execute ? 'UPDATE' : 'would update';
            console.log(
                `${label} ${row.pid} parts ${plan.notes.parts_fixed}` +
                    (plan.notes.no_uuid ? ` WARN ${plan.notes.no_uuid} part(s) missing uuid` : '') +
                    ` | ${plan.notes.title}`
            );
            if (args.execute) {
                await db()(tables.objects).where({ pid: row.pid }).update(plan.updates);
            }
        } else {
            counts.skip++;
            // Quiet skips for untouched rows; loud for actionable reasons.
            if (plan.reason !== 'already_correct' && plan.reason !== 'no_parts') {
                console.log(`skip   ${row.pid} (${plan.reason})`);
            }
        }
    }

    console.log(
        `\n${args.execute ? 'Updated' : 'Would update'} ${counts.update} row(s), ` +
            `skipped ${counts.skip} (scanned ${rows.length}).` +
            (args.execute ? '' : ' Re-run with --execute to apply.')
    );

    if (!deps.db_module) await destroy_all();
    return { counts, results };
}

module.exports = { parse_args, plan_row, select_candidates, run, uuid_from_thumbnail };

if (require.main === module) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    let args;
    try {
        args = parse_args(process.argv);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    run(args).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
