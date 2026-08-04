'use strict';

/*
 * Backfill thin display_record envelopes to the fat v1 contract.
 *
 * The 2026-07-30..08-04 v2 ingests stored a thin 5-key envelope
 * ({title, abstract, handle, display_record, parts}) with two un-merged
 * parts copies, losing the denormalized top level, the per-part
 * kaltura_id, and (via the METS positional-mime bug) assigning wrong or
 * null MIMEs. See repo/REPOV2_DISPLAY_RECORD_FINDINGS.md.
 *
 * This script rebuilds each affected row's display_record via
 * libs/display_envelope.build_envelope — the same builder ingest and the
 * metadata-refresh worker now use — from data already in the row:
 *
 *   - metadata:       the `mods` column (bare ASpace record)
 *   - DuraCloud paths: the old envelope's top-level METS/DIP parts
 *   - identity:       the row's own columns
 *
 * No ASpace or DuraCloud calls are made. Column repairs ride along:
 * mime_type / file_name are set from the merged master part when they
 * differ (never nulled), thumbnail only when the column is empty, and
 * compound_parts is populated for compounds. is_updated=1 is set so the
 * indexer re-projects any already-published row.
 *
 * Selection: is_active=1 rows whose display_record has no top-level
 * `pid` — exactly the thin-envelope population. Already-fat rows are
 * re-guarded per row, so the script is idempotent: a second run finds
 * nothing to do.
 *
 * Usage:
 *   node scripts/backfill_display_records.js                 # dry run (default)
 *   node scripts/backfill_display_records.js --execute
 *   node scripts/backfill_display_records.js --pids <pid>[,<pid>]
 *
 * Rehearsal against a prod snapshot: point the env at the imported copy,
 * e.g. `DB_NAME=repov2_prod_0804 node scripts/backfill_display_records.js`.
 * No new dependencies — runs on the deployed checkout's existing
 * node_modules.
 */

const path = require('node:path');
const display_envelope = require('../libs/display_envelope');

function parse_args(argv) {
    const o = { execute: false, pids: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--execute') o.execute = true;
        else if (a === '--pids') {
            o.pids = String(argv[++i] || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
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

/*
 * Decide one row. Pure — no I/O — so the dry run exercises exactly what
 * the real run writes, and the unit tests can feed rows straight in.
 *
 * Returns { action: 'skip', reason } or { action: 'update', updates,
 * notes } where `updates` is the tbl_objects patch and `notes` is the
 * human-readable dry-run summary.
 */
function plan_row(row) {
    if (!row || !row.pid) return { action: 'skip', reason: 'no_pid' };
    if (row.object_type === 'collection') {
        // Collections have their own envelope writer (create_collection).
        return { action: 'skip', reason: 'collection' };
    }

    const old_envelope = parse_json(row.display_record);
    if (!old_envelope) return { action: 'skip', reason: 'display_record_unparsable' };
    // Idempotency guard — a fat envelope already carries its pid.
    if (old_envelope.pid !== undefined) return { action: 'skip', reason: 'already_fat' };

    // The bare ASpace record: mods column first, envelope's inner copy as fallback.
    const metadata = parse_json(row.mods) || old_envelope.display_record || null;
    if (!metadata || typeof metadata !== 'object' || !metadata.title) {
        return { action: 'skip', reason: 'no_metadata' };
    }

    /*
     * DuraCloud paths come from the thin envelope's top-level METS/DIP
     * list. A thin envelope without one (never observed in the affected
     * population) rebuilds metadata-only — parts keep order/title/MIME
     * but no object/thumbnail paths, flagged in notes.
     */
    const dip_parts = display_envelope.is_dip_parts(old_envelope.parts) ? old_envelope.parts : [];

    const built = display_envelope.build_envelope({
        pid: row.pid,
        is_member_of_collection: row.is_member_of_collection,
        handle: row.handle,
        is_published: row.is_published,
        is_compound: row.is_compound,
        metadata,
        dip_parts,
    });

    /*
     * A custom-uploaded thumbnail lives in the column as an absolute URL
     * (set_thumbnail); keep it authoritative in the rebuilt envelope.
     */
    if (typeof row.thumbnail === 'string' && /^https?:\/\//i.test(row.thumbnail)) {
        built.envelope.thumbnail = row.thumbnail;
    }

    const updates = {
        display_record: JSON.stringify(built.envelope),
        compound_parts: built.compound_parts,
        is_updated: 1,
    };
    const notes = {
        title: built.envelope.title,
        parts: built.envelope.display_record.parts.length,
        entry_id: built.envelope.entry_id || null,
        no_paths: dip_parts.length === 0,
    };

    // Column repairs: fill/correct, never null-out.
    if (built.mime_type && built.mime_type !== row.mime_type) {
        updates.mime_type = built.mime_type;
        notes.mime = `${row.mime_type || '(null)'} -> ${built.mime_type}`;
    }
    if (built.file_name && built.file_name !== row.file_name) {
        updates.file_name = built.file_name;
        notes.file_name = `${row.file_name || '(null)'} -> ${built.file_name}`;
    }
    if (!row.thumbnail && built.thumbnail) {
        updates.thumbnail = built.thumbnail;
        notes.thumbnail = 'filled';
    }

    return { action: 'update', updates, notes };
}

/* The thin-envelope population; --pids narrows it further. */
async function select_candidates(db, tables, pids) {
    const q = db(tables.objects)
        .select(
            'pid',
            'is_member_of_collection',
            'handle',
            'thumbnail',
            'mime_type',
            'file_name',
            'object_type',
            'is_published',
            'is_compound',
            'mods',
            'display_record'
        )
        .where('is_active', 1)
        .whereRaw('JSON_VALID(display_record)')
        .whereRaw("NOT JSON_CONTAINS_PATH(display_record, 'one', '$.pid')");
    if (pids && pids.length > 0) q.whereIn('pid', pids);
    return q;
}

async function run(args, deps = {}) {
    /*
     * Lazy-required so unit tests can drive run() with injected deps and
     * no database env. dotenv is loaded in the CLI entry, not here.
     */
    const { db, destroy_all } = deps.db_module || require('../config/db');
    const tables = deps.tables || require('../config/db_tables');
    const select = deps.select_candidates || select_candidates;

    const rows = await select(db(), tables, args.pids);
    const counts = { update: 0, skip: 0 };
    const results = [];

    for (const row of rows) {
        const plan = plan_row(row);
        results.push({ pid: row.pid, ...plan });
        if (plan.action === 'update') {
            counts.update++;
            const label = args.execute ? 'UPDATE' : 'would update';
            console.log(
                `${label} ${row.pid} parts=${plan.notes.parts}` +
                    (plan.notes.entry_id ? ` entry_id=${plan.notes.entry_id}` : '') +
                    (plan.notes.mime ? ` mime: ${plan.notes.mime}` : '') +
                    (plan.notes.file_name ? ` file_name: ${plan.notes.file_name}` : '') +
                    (plan.notes.thumbnail ? ' thumbnail: filled' : '') +
                    (plan.notes.no_paths ? ' WARN: no DuraCloud paths in source' : '') +
                    ` | ${plan.notes.title}`
            );
            if (args.execute) {
                await db()(tables.objects).where({ pid: row.pid }).update(plan.updates);
            }
        } else {
            counts.skip++;
            console.log(`skip   ${row.pid} (${plan.reason})`);
        }
    }

    console.log(
        `\n${args.execute ? 'Updated' : 'Would update'} ${counts.update} row(s), ` +
            `skipped ${counts.skip}.` +
            (args.execute ? '' : ' Re-run with --execute to apply.')
    );

    if (!deps.db_module) await destroy_all();
    return { counts, results };
}

module.exports = { parse_args, plan_row, select_candidates, run };

if (require.main === module) {
    /*
     * Load .env exactly like the app boot does, so DB creds resolve when
     * launched outside npm scripts (required vars like TOKEN_SECRET are
     * read lazily and stay unset-tolerant here).
     */
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
