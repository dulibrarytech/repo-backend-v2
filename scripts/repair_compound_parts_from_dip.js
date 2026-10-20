'use strict';

/*
 * Rebuild a compound object's part paths from its DIP, as Archivematica
 * recorded it.
 *
 * For still-image compounds whose display_record.display_record.parts
 * carry no DuraCloud `object` or `thumbnail`: an empty list (no pages at
 * all) or refresh-built titles {order, title, type, caption}. The
 * frontend then refuses to build a viewer ("Viewer error: Can not
 * retrieve viewer content"), and a metadata refresh can't heal it: it
 * only carries paths forward from earlier parts. Background, including
 * the first case (4cc77734, Woodstock Chronology):
 * repo/notes/REPOV2_VIEWER_ERROR_4cc77734_FINDINGS.md.
 *
 * Per row:
 *   1. Archivematica's Storage Service resolves the AIP's DIP
 *      (get_dip_path, get_dip_package): an UPLOADED DIP in the folder the
 *      row's own paths already use. Package records only; the Storage
 *      Service can't list the files of a stored DIP.
 *   2. The DIP's METS, Archivematica's file manifest, is read from the
 *      DIP store as Stage 5 does with DIP_COPY_ENABLED, and goes through
 *      the ingester's parse_mets + enrich_parts: one entry per original
 *      file, with its file UUID, name, MIME and thumbnail path.
 *   3. The METS names the originals (.tif); legacy DIPs hold .jp2 access
 *      copies (`objects/<fileUUID>-<name>.jp2`). The access extension is
 *      learned from the row's file_name, which names the master page's
 *      access copy, and applied to every page with the master's original
 *      extension.
 *   4. libs/display_envelope.merge_parts joins the row's parts with that
 *      list, as ingest and metadata refresh do: titled parts keep their
 *      order, title and caption and gain the paths; an empty list gets
 *      one part per METS file, in file-name order.
 *
 * The DIP store holds every METS and thumbnail (2026-10-15 backfill) but
 * not the .jp2 access copies, which only DuraCloud Preserve has.
 * --listing (a key list of the DIP folder) checks those as well; without
 * it they are reported as not checked, and the TIFF→JPG conversion that
 * follows is their test.
 *
 * Fails closed. Nothing is written unless every part gets an object and
 * a thumbnail, titled parts use every METS file, paths already present
 * agree, every MIME is a still image, every thumbnail exists in the DIP
 * store, and the rebuilt master part matches the row's file_name,
 * thumbnail and mime_type. All problems are reported together.
 *
 * Per row, with --execute:
 *   - display_record.display_record.parts[]  rebuilt (and a non-empty
 *                                            top-level `compound` copy)
 *   - compound_parts                         the same list
 *   - is_updated=1                           the indexer re-projects the row
 * The rest of the envelope and the file_name/thumbnail/mime_type columns
 * are left as they are. The UPDATE only applies if display_record is
 * unchanged since it was read, and a before-image is written to
 * --backup-dir first.
 *
 * Idempotent: a row whose parts all have object + thumbnail is skipped.
 * Later metadata refreshes keep the paths (metadata/worker.js
 * build_payload).
 *
 * Needs ARCHIVEMATICA_STORAGE_* and DIP_STORE_* in .env; both are checked
 * before the database is read.
 *
 * Usage:
 *   node scripts/repair_compound_parts_from_dip.js                  # dry run, all candidates
 *   node scripts/repair_compound_parts_from_dip.js --pids <pid>[,<pid>] [--listing <file>]
 *   node scripts/repair_compound_parts_from_dip.js --pids <pid> --execute --backup-dir <dir>
 *       # --backup-dir: an existing directory, outside the git checkout so
 *       # the before-image doesn't land in the repo
 * Candidates without --pids: active still-image compounds with no part
 * path in display_record.parts or the top-level compound list.
 *
 * --listing comes from DuraCloud Preserve, with curation's DCP keys
 * (bucket and prefix are in its DCP_DIP_LOCATION):
 *   aws s3 ls --recursive s3://<bucket>/<prefix><dip_path>/ > dip_keys.txt
 * Each line that contains `<dip_path>/` is read from there to the end, so
 * `aws s3 ls` output and bare key lists both work.
 *
 * After --execute: queue the TIFF→JPG conversion for each pid from the
 * dashboard, so every page has the JPG the viewer serves.
 * No new dependencies: runs on the deployed checkout's node_modules.
 */

const fs = require('node:fs');
const path = require('node:path');
const display_envelope = require('../libs/display_envelope');
const { enrich_parts } = require('../ingester/lib/repository_build');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_COPY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i;
const COLUMNS = [
    'pid',
    'is_compound',
    'mime_type',
    'file_name',
    'thumbnail',
    'display_record',
    'compound_parts',
    'is_updated',
];

function parse_args(argv) {
    const o = { pids: null, listing: null, execute: false, backup_dir: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--execute') o.execute = true;
        else if (a === '--pids') o.pids = split_pids(argv[++i]);
        else if (a === '--listing') o.listing = String(argv[++i] || '').trim();
        else if (a === '--backup-dir') o.backup_dir = String(argv[++i] || '').trim();
        else throw new Error(`unknown arg: ${a}`);
    }
    if (o.pids !== null) {
        if (o.pids.length === 0) throw new Error('--pids needs <pid>[,<pid>]');
        const bad = o.pids.filter((p) => !UUID_RE.test(p));
        if (bad.length > 0) throw new Error(`--pids must be UUIDs: ${bad.join(', ')}`);
    }
    if (o.listing === '') throw new Error('--listing needs <file>');
    if (o.execute && !o.backup_dir) throw new Error('--execute needs --backup-dir <dir>');
    return o;
}

// "A, b,a" → ['a', 'b']: trimmed, lower-cased, de-duplicated.
function split_pids(raw) {
    const list = String(raw || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    return [...new Set(list)];
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
 * "U219.03.0003.0001.00001_p001.tif" → { stem: "U219.03.0003.0001.00001_p001",
 * ext: ".tif" }. Only a real extension is split off: these names are
 * dotted identifiers, so a bare "…0001.00001_p001" keeps its last segment.
 */
const EXTENSION_RE = /\.[a-z][a-z0-9]{1,4}$/i;
function split_ext(name) {
    const s = typeof name === 'string' ? name.trim() : '';
    const m = s.match(EXTENSION_RE);
    return m ? { stem: s.slice(0, m.index), ext: m[0] } : { stem: s, ext: '' };
}

/*
 * The DIP folder, from every path the row already holds. Returns
 * { dip_path } or { error, values }; all sources must agree.
 */
function dip_path_of(row, envelope) {
    const sources = [
        row && row.file_name,
        row && row.thumbnail,
        envelope && envelope.object,
        envelope && envelope.thumbnail,
    ];
    const found = new Set();
    for (const s of sources) {
        if (typeof s !== 'string' || s === '') continue;
        for (const marker of ['/objects/', '/thumbnails/']) {
            const at = s.indexOf(marker);
            if (at > 0) {
                found.add(s.slice(0, at).replace(/^\/+/, ''));
                break;
            }
        }
    }
    if (found.size === 0) return { error: 'no_dip_path', values: [] };
    if (found.size > 1) return { error: 'dip_path_conflict', values: [...found] };
    return { dip_path: [...found][0] };
}

function has_paths(list) {
    return Array.isArray(list) && list.some((p) => p && (p.object || p.thumbnail));
}

function refuse(reason, detail = {}) {
    return { action: 'refuse', reason, detail };
}

/*
 * The checks that need only the row. Returns { action: 'checked',
 * envelope, inner, parts, dip_path } or a skip/refuse plan.
 */
function check_shape(row) {
    if (!row.is_compound) return refuse('not_compound');
    const envelope = parse_json(row.display_record);
    if (!envelope) return refuse('display_record_unparsable');
    const inner = envelope.display_record;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
        return refuse('no_inner_record');
    }
    /*
     * The indexer prefers a top-level parts list, and a top-level
     * compound list with paths, over the inner one (libs/elasticsearch.js
     * pick_parts), so either would hide the repair. A top-level parts list
     * is the thin pre-backfill envelope.
     */
    if (Array.isArray(envelope.parts) && envelope.parts.length > 0) {
        return refuse('top_level_parts_present', { count: envelope.parts.length });
    }
    if (has_paths(envelope.compound)) {
        return refuse('top_level_compound_has_paths', { count: envelope.compound.length });
    }

    const parts = Array.isArray(inner.parts) ? inner.parts.filter(Boolean) : [];
    if (parts.length > 0 && parts.every((p) => p.object && p.thumbnail)) {
        return { action: 'skip', reason: 'already_repaired' };
    }
    const found = dip_path_of(row, envelope);
    if (found.error) return refuse(found.error, { values: found.values });
    return { action: 'checked', envelope, inner, parts, dip_path: found.dip_path };
}

/*
 * The access-copy extension, learned from the one access copy the row
 * already names: file_name = `<dip>/objects/<fileUUID>-<name>.<ext>`,
 * where fileUUID is a METS file with the same name stem. Returns
 * { from, to } (from: the original's extension, lower-cased) or
 * { error, detail }.
 */
function access_rule(file_name, dip_path, dip_parts) {
    const prefix = `${dip_path}/objects/`;
    const rest =
        typeof file_name === 'string' && file_name.startsWith(prefix)
            ? file_name.slice(prefix.length)
            : '';
    const named = rest.match(ACCESS_COPY_RE);
    if (!named || named[2].includes('/')) {
        return { error: 'file_name_not_an_access_copy', detail: { file_name: file_name || '' } };
    }
    const uuid = named[1].toLowerCase();
    const master = dip_parts.find(
        (p) => p.type === 'object' && String(p.uuid).toLowerCase() === uuid
    );
    if (!master) return { error: 'master_not_in_mets', detail: { uuid } };
    const original = split_ext(master.file);
    const access = split_ext(named[2]);
    if (!original.ext || !access.ext || original.stem.toLowerCase() !== access.stem.toLowerCase()) {
        return {
            error: 'master_name_mismatch',
            detail: { mets: master.file, file_name: named[2] },
        };
    }
    return { from: original.ext.toLowerCase(), to: access.ext };
}

/*
 * The METS list as access copies: each object's path takes the access
 * extension, a missing METS MIME takes the row's (same original extension
 * as the master, so the same format), and the list is sorted by file
 * name, i.e. page order. txt sidecars pass through (merge_parts drops
 * them); files the rule can't name go to `problems` instead.
 */
function to_access_copies(dip_parts, rule, dip_path, fallback_mime, problems) {
    const out = [];
    const seen = new Set();
    for (const p of dip_parts) {
        if (p.type !== 'object') {
            out.push(p);
            continue;
        }
        const file = String(p.file || '');
        const { stem, ext } = split_ext(file);
        if (file.includes('/')) problems.nested_files.push(file);
        else if (ext.toLowerCase() !== rule.from) problems.other_extensions.push(file);
        else if (seen.has(file.toLowerCase())) problems.duplicate_files.push(file);
        else {
            seen.add(file.toLowerCase());
            out.push({
                ...p,
                mime_type: p.mime_type || fallback_mime || null,
                object: `${dip_path}/objects/${p.uuid}-${stem}${rule.to}`,
            });
        }
    }
    return out.sort((a, b) =>
        String(a.file).localeCompare(String(b.file), 'en', { numeric: true })
    );
}

/*
 * Decide one row from the row and its METS file list (parse_mets output).
 * Pure, no I/O. listing_paths: the DIP folder's keys, or null without
 * --listing. Returns { action: 'update', updates, parts, notes },
 * { action: 'skip', reason } or { action: 'refuse', reason, detail }.
 */
function plan_row(row, { mets_files, listing_paths = null } = {}) {
    const shape = check_shape(row);
    if (shape.action !== 'checked') return shape;
    const { envelope, inner, parts, dip_path } = shape;

    if (!Array.isArray(mets_files) || mets_files.length === 0) return refuse('mets_no_files');
    const dip_parts = enrich_parts(mets_files, { dip_path });
    const rule = access_rule(row.file_name, dip_path, dip_parts);
    if (rule.error) return refuse(rule.error, rule.detail);

    const problems = {
        untitled_parts: [],
        nested_files: [],
        other_extensions: [],
        duplicate_files: [],
        unmatched_titles: [],
        unused_mets_files: [],
        claimed_twice: [],
        path_conflicts: [],
        not_still_image: [],
        master_mismatch: [],
        not_in_listing: [],
    };
    /*
     * merge_parts pairs an untitled part with the next free file by
     * position; this repair matches by name only.
     */
    for (const p of parts) {
        if (!p.title) problems.untitled_parts.push(`order ${p.order}`);
    }
    const sources = to_access_copies(
        dip_parts,
        rule,
        dip_path,
        row.mime_type || envelope.mime_type,
        problems
    );
    const merged = display_envelope.merge_parts(parts, sources);

    /*
     * merge_parts returns the row's parts first, in order, then any METS
     * file none of them named.
     */
    const by_object = new Map();
    merged.forEach((m, i) => {
        const before = parts[i];
        if (before) {
            if (!m.object) {
                problems.unmatched_titles.push(m.title || `(untitled, order ${m.order})`);
            }
            for (const key of ['object', 'thumbnail']) {
                if (before[key] && before[key] !== m[key]) {
                    problems.path_conflicts.push(
                        `${m.title} ${key}: ${before[key]} → ${m[key] || '(none)'}`
                    );
                }
            }
        } else if (parts.length > 0) {
            problems.unused_mets_files.push(m.title);
        }
        if (m.object) {
            by_object.set(m.object, [...(by_object.get(m.object) || []), m.title]);
            if (!/^image\//i.test(m.type || '')) {
                problems.not_still_image.push(`${m.title} (${m.type})`);
            }
        }
    });
    for (const titles of by_object.values()) {
        if (titles.length > 1) problems.claimed_twice.push(titles.join(', '));
    }

    const master = display_envelope.pick_master_part(merged);
    const master_object = master ? master.object : null;
    if (master_object !== row.file_name) {
        problems.master_mismatch.push(
            `file_name ${row.file_name || '(empty)'} ≠ ${master_object || '(no master part)'}`
        );
    }
    if (master) {
        const thumbnail = row.thumbnail || '';
        if (thumbnail && !/^https?:\/\//i.test(thumbnail) && thumbnail !== master.thumbnail) {
            problems.master_mismatch.push(`thumbnail ${thumbnail} ≠ ${master.thumbnail}`);
        }
        const mime = String(row.mime_type || '').toLowerCase();
        if (mime && mime !== String(master.type || '').toLowerCase()) {
            problems.master_mismatch.push(`mime_type ${row.mime_type} ≠ ${master.type}`);
        }
    }

    if (listing_paths) {
        const keys = new Set(listing_paths);
        const root = `${dip_path}/`;
        for (const m of merged) {
            for (const p of [m.object, m.thumbnail]) {
                if (p && !keys.has(p)) problems.not_in_listing.push(p.slice(root.length));
            }
        }
    }

    for (const key of Object.keys(problems)) {
        if (problems[key].length === 0) delete problems[key];
    }
    if (Object.keys(problems).length > 0) return refuse('dip_mismatch', problems);

    const new_envelope = { ...envelope, display_record: { ...inner, parts: merged } };
    if (Array.isArray(envelope.compound) && envelope.compound.length > 0) {
        new_envelope.compound = merged;
    }
    return {
        action: 'update',
        updates: {
            display_record: JSON.stringify(new_envelope),
            compound_parts: JSON.stringify(merged),
            is_updated: 1,
        },
        parts: merged,
        notes: {
            title: envelope.title || inner.title || '',
            dip_path,
            parts: merged.length,
            source: parts.length > 0 ? 'titles' : 'mets',
            access: `${rule.from} → ${rule.to}`,
            objects_checked: Boolean(listing_paths),
        },
    };
}

// The --listing lines under one DIP folder, each cut to start at the folder.
function listing_paths(text, dip_path) {
    const needle = `${dip_path}/`;
    const out = [];
    for (const line of String(text).split(/\r?\n/)) {
        const at = line.indexOf(needle);
        if (at >= 0) out.push(line.slice(at).trim());
    }
    return out;
}

/*
 * Archivematica's record of the row's DIP: the AIP's related package must
 * be an UPLOADED DIP in the folder the row already uses. Returns
 * { action: 'resolved', dip_uuid } or a refuse plan.
 */
async function resolve_dip(am, pid, dip_path) {
    const aip = await am.get_dip_path(pid);
    if (aip.status !== 200) return refuse('am_aip_lookup_failed', { status: aip.status });
    if (!aip.dip_path) return refuse('am_no_related_dip');
    if (aip.dip_path !== dip_path) {
        return refuse('dip_path_mismatch', { row: dip_path, archivematica: aip.dip_path });
    }
    const dip = await am.get_dip_package(aip.dip_uuid);
    if (dip.status !== 200) {
        return refuse('am_dip_lookup_failed', { status: dip.status, dip_uuid: aip.dip_uuid });
    }
    if (dip.package_type !== 'DIP') return refuse('not_a_dip', { package_type: dip.package_type });
    if (dip.package_status !== 'UPLOADED') {
        return refuse('dip_not_uploaded', { status: dip.package_status });
    }
    return { action: 'resolved', dip_uuid: aip.dip_uuid };
}

// Titles of the parts whose thumbnail the DIP store doesn't hold.
async function missing_thumbnails(dip_store, parts) {
    const missing = [];
    for (const p of parts) {
        const res = await dip_store.head(p.thumbnail);
        if (res.status === 404) missing.push(p.title);
        else if (res.status !== 200) {
            throw new Error(`DIP store answered ${res.status} for ${p.thumbnail}`);
        }
    }
    return missing;
}

/*
 * One row through every check, the network ones included. A transport
 * error refuses the row as `<step>_error`, and the run moves on.
 */
async function plan_one(row, ctx) {
    const shape = check_shape(row);
    if (shape.action !== 'checked') return shape;
    let step = 'archivematica';
    try {
        const dip = await resolve_dip(ctx.am, row.pid, shape.dip_path);
        if (dip.action === 'refuse') return dip;

        step = 'mets';
        const res = await ctx.dip_store.fetch_text(
            ctx.dip_store.mets_path(row.pid, shape.dip_path)
        );
        if (res.status !== 200 || !res.data) {
            return refuse('mets_unavailable', { status: res.status });
        }
        const mets_files = await ctx.parse_mets(res.data, {
            sip_uuid: row.pid,
            dip_path: shape.dip_path,
        });
        const listing =
            ctx.listing_text === null ? null : listing_paths(ctx.listing_text, shape.dip_path);
        const plan = plan_row(row, { mets_files, listing_paths: listing });
        if (plan.action !== 'update') return plan;

        step = 'thumbnails';
        const missing = await missing_thumbnails(ctx.dip_store, plan.parts);
        if (missing.length > 0) return refuse('dip_mismatch', { missing_thumbnails: missing });
        plan.notes.dip_uuid = dip.dip_uuid;
        return plan;
    } catch (err) {
        return refuse(`${step}_error`, { error: err.message || String(err) });
    }
}

/*
 * --pids: those rows, whatever their state (plan_one decides). Without:
 * the active still-image compounds with no part path in either parts
 * list. MariaDB JSON functions; tests inject their own.
 */
function select_candidates(db, tables, pids) {
    const q = db(tables.objects).select(COLUMNS).where('is_active', 1);
    if (pids && pids.length > 0) return q.whereIn('pid', pids);
    return q
        .where('is_compound', 1)
        .where('mime_type', 'like', 'image/%')
        .whereRaw('JSON_VALID(display_record)')
        .whereRaw("JSON_EXTRACT(display_record, '$.display_record.parts[*].object') IS NULL")
        .whereRaw("JSON_EXTRACT(display_record, '$.compound[*].object') IS NULL");
}

function print_plan(pid, plan, args) {
    if (plan.action === 'skip') {
        console.log(`skip ${pid} (${plan.reason})`);
        return;
    }
    if (plan.action === 'refuse') {
        console.log(`refused ${pid}: ${plan.reason}`);
        for (const [key, value] of Object.entries(plan.detail || {})) {
            if (Array.isArray(value)) {
                console.log(`  ${key} (${value.length}):`);
                for (const v of value) console.log(`    ${v}`);
            } else {
                console.log(`  ${key}: ${value}`);
            }
        }
        return;
    }
    const n = plan.notes;
    const label = args.execute ? 'UPDATE' : 'would update';
    const source = n.source === 'titles' ? 'the existing titles' : 'the METS';
    console.log(`${label} ${pid} | ${n.title} | ${n.parts} part(s) from ${source}`);
    console.log(`  dip ${n.dip_path}/ (Archivematica DIP ${n.dip_uuid}, UPLOADED)`);
    console.log(
        `  access copies ${n.access} (from file_name); objects ${
            n.objects_checked
                ? 'checked against the listing'
                : 'not checked (DuraCloud Preserve only; --listing checks them)'
        }`
    );
    const root = `${n.dip_path}/`;
    const rel = (p) => (p.startsWith(root) ? p.slice(root.length) : p);
    for (const p of plan.parts) {
        console.log(
            `  ${String(p.order).padStart(4)}  ${p.title}  ${p.type}  ${rel(p.object)}  ${rel(p.thumbnail)}`
        );
    }
}

function write_backup(row, args, deps = {}) {
    const write = deps.write_file || ((f, data) => fs.writeFileSync(f, data, { flag: 'wx' }));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(args.backup_dir, `repair_compound_parts_${row.pid}_${stamp}.json`);
    const before = {
        pid: row.pid,
        taken_at: new Date().toISOString(),
        display_record: row.display_record,
        compound_parts: row.compound_parts,
        is_updated: row.is_updated,
    };
    write(file, `${JSON.stringify(before, null, 2)}\n`);
    return file;
}

async function run(args, deps = {}) {
    const { db, destroy_all } = deps.db_module || require('../config/db');
    const tables = deps.tables || require('../config/db_tables');
    const am = deps.archivematica || require('../libs/archivematica');
    const dip_store = deps.dip_store || require('../libs/dip_store');
    const parse_mets = deps.parse_mets || require('../ingester/libs/mets').parse_mets;
    const select = deps.select_candidates || select_candidates;
    const read = deps.read_file || ((f) => fs.readFileSync(f, 'utf8'));
    const is_directory =
        deps.is_directory || ((d) => fs.statSync(d, { throwIfNoEntry: false })?.isDirectory());

    // Fail before touching the database.
    if (args.execute && !is_directory(args.backup_dir)) {
        throw new Error(`--backup-dir ${args.backup_dir} is not an existing directory`);
    }
    if (!am.is_storage_configured()) {
        throw new Error(
            'Archivematica Storage Service is not configured (ARCHIVEMATICA_STORAGE_*)'
        );
    }
    if (!dip_store.is_configured()) {
        throw new Error('The DIP store is not configured (DIP_STORE_*)');
    }
    const ctx = {
        am,
        dip_store,
        parse_mets,
        listing_text: args.listing ? String(read(args.listing)) : null,
    };

    try {
        const rows = await select(db(), tables, args.pids);
        const by_pid = new Map((args.pids || []).map((pid) => [pid, []]));
        for (const row of rows) {
            const pid = String(row.pid).toLowerCase();
            by_pid.set(pid, [...(by_pid.get(pid) || []), row]);
        }

        const results = [];
        const counts = { update: 0, skip: 0, refuse: 0 };
        for (const [pid, list] of by_pid) {
            const plan =
                list.length === 1
                    ? await plan_one(list[0], ctx)
                    : refuse(list.length === 0 ? 'not_found' : 'multiple_active_rows');
            print_plan(pid, plan, args);
            const result = { pid, plan };
            if (plan.action === 'update' && args.execute) {
                const row = list[0];
                result.backup = write_backup(row, args, deps);
                console.log(`  before-image written to ${result.backup}`);
                const count = await db()(tables.objects)
                    .where({ pid: row.pid, is_active: 1 })
                    .andWhere('display_record', row.display_record)
                    .update(plan.updates);
                if (count !== 1) {
                    throw new Error(
                        `${row.pid} changed since it was read (updated ${count} rows). Re-run.`
                    );
                }
            }
            counts[plan.action]++;
            results.push(result);
        }

        const verb = args.execute ? 'updated' : 'would update';
        console.log(
            `\n${counts.update} ${verb}, ${counts.skip} skipped, ${counts.refuse} refused.`
        );
        if (counts.update > 0) {
            console.log(
                args.execute
                    ? 'The indexer re-projects updated rows on its next poll (is_updated=1).\n' +
                          'Next: queue the TIFF→JPG conversion for each updated pid from the dashboard.'
                    : 'Dry run: nothing written. Re-run with --execute --backup-dir <dir> to apply.'
            );
        }
        return { results, counts };
    } finally {
        if (!deps.db_module) await destroy_all();
    }
}

module.exports = {
    parse_args,
    split_ext,
    dip_path_of,
    access_rule,
    listing_paths,
    plan_row,
    select_candidates,
    run,
};

if (require.main === module) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    let args;
    try {
        args = parse_args(process.argv);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    run(args)
        .then(({ counts }) => {
            if (counts.refuse > 0) process.exitCode = 1;
        })
        .catch((err) => {
            console.error(err.message || err);
            process.exit(1);
        });
}
