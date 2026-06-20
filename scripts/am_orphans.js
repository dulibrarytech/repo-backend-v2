#!/usr/bin/env node
'use strict';

// Find Archivematica AIPs with NO live reference in tbl_objects — orphaned
// preservation packages — and OPTIONALLY request their deletion in AM,
// filtered by bucket + creation year.
//
// Two modes:
//
//   REPORT (default) — READ-ONLY. GETs the AM Storage Service package list
//     (v2/file/), SELECTs sip_uuids from tbl_objects, and writes a report
//     (CSV + a `tmp_am_orphans` table in the repo DB). Never mutates AM.
//
//   DELETE (--delete) — submits AM deletion REQUESTS for bucket-A orphans
//     created in a given --year. DRY-RUN by default (prints what it WOULD
//     submit); only with --execute does it POST delete_aip requests. Even
//     then nothing is hard-deleted: AM records a deletion request that a
//     Storage Service admin must APPROVE in the AM UI. Restricted to
//     bucket A (true orphans) — never bucket B (rows that were soft-deleted
//     may be recoverable / already pending deletion).
//
// "Orphan" = an AM package whose uuid is not referenced by any *live*
// (is_active=1) tbl_objects row. Soft-deleted rows do NOT count, so:
//   A — no tbl_objects row references this uuid at all   (true orphan)
//   B — referenced ONLY by soft-deleted rows             (review first)
// Live-referenced packages (bucket C) are kept and excluded.
//
// Creation year: AM's package list has NO ingest date for legacy AIPs
// (stored_date is null; names are archival call numbers, not dates). The
// authoritative date lives in each AIP's PREMIS pointer file (METS
// CREATEDATE / premis:eventDateTime). So:
//   - --year-report and --delete resolve each bucket-A orphan's year by
//     using stored_date when present, else FETCHING the pointer file (one
//     GET per orphan, paced) and parsing the ingest year out of it.
//   - --date-field <name> overrides the package-list date field (run
//     --probe to see field names); --allow-path-year is a last resort that
//     reads a 4-digit year from current_path (off by default — unreliable).
//
// Usage:
//   node scripts/am_orphans.js --probe
//   node scripts/am_orphans.js                                   # orphan report
//   node scripts/am_orphans.js --year-report                     # bucket-A counts by ingest year (+CSV)
//   node scripts/am_orphans.js --year-report --limit 200         # sample 200 (quick)
//   node scripts/am_orphans.js --delete --year 2019             # DRY-RUN list
//   node scripts/am_orphans.js --delete --year 2019 \
//        --reason "orphan cleanup" --execute                    # SUBMIT requests
//
// Report flags     : --csv PATH | --page-size N | --package-type T | --no-table
// Year-report flags: --year-report [--pace-ms N] [--limit N] [--csv PATH]
// Delete flags     : --delete --year YYYY [--reason TEXT] [--execute]
//                    [--date-field NAME] [--allow-path-year] [--no-pointer]
//                    [--pace-ms N] [--limit N]

const fs = require('node:fs');
const path = require('node:path');

const archivematica = require('../libs/archivematica');
const projection = require('../libs/object_projection');
const { db, destroy_all } = require('../config/db');
const tables = require('../config/db_tables');
const log = require('../libs/log');

const REPORT_TABLE = 'tmp_am_orphans';
// AM package statuses already deleted / pending deletion — not actionable.
const SKIP_STATUSES = new Set(['DELETED', 'DEL_REQ']);
// Best-effort AM package date fields to auto-detect (the name varies by AM
// version). Override with --date-field once known from --probe.
const DATE_FIELD_CANDIDATES = [
    'stored_date',
    'created',
    'created_time',
    'create_time',
    'date_created',
    'creation_date',
    'modified',
    'last_modified',
];
const YEAR_RE = /\b(19\d\d|20\d\d)\b/;
const CSV_COLUMNS = [
    'sip_uuid',
    'bucket',
    'created_year',
    'year_source',
    'am_status',
    'package_type',
    'size_bytes',
    'current_location',
    'current_path',
    'title',
];
// Pacing between deletion POSTs so we don't hammer the Storage Service.
const DELETE_PACE_MS = 250;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested) — no I/O.
// ---------------------------------------------------------------------------

function parse_args(argv) {
    const o = {
        probe: false,
        csv: null,
        page_size: 250,
        package_type: 'AIP',
        write_table: true,
        // year-report / delete modes
        year_report: false,
        delete: false,
        year: null,
        reason: null,
        execute: false,
        date_field: null,
        allow_path_year: false,
        no_pointer: false,
        pace_ms: 150,
        limit: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--probe') o.probe = true;
        else if (a === '--no-table') o.write_table = false;
        else if (a === '--csv') o.csv = argv[++i];
        else if (a === '--page-size') o.page_size = Math.max(1, Number.parseInt(argv[++i], 10) || o.page_size);
        else if (a === '--package-type') o.package_type = argv[++i];
        else if (a === '--year-report') o.year_report = true;
        else if (a === '--delete') o.delete = true;
        else if (a === '--year') o.year = Number.parseInt(argv[++i], 10) || null;
        else if (a === '--reason') o.reason = argv[++i];
        else if (a === '--execute') o.execute = true;
        else if (a === '--date-field') o.date_field = argv[++i];
        else if (a === '--allow-path-year') o.allow_path_year = true;
        else if (a === '--no-pointer') o.no_pointer = true;
        else if (a === '--pace-ms') {
            const n = Number.parseInt(argv[++i], 10);
            o.pace_ms = Number.isFinite(n) && n >= 0 ? n : o.pace_ms;
        } else if (a === '--limit') {
            const n = Number.parseInt(argv[++i], 10);
            o.limit = Number.isFinite(n) && n > 0 ? n : null;
        }
    }
    return o;
}

// Is this AM package in scope for orphan analysis? Only the requested
// package_type, and not already deleted / pending deletion.
function is_actionable(pkg, package_type) {
    if (!pkg || !pkg.uuid) return false;
    if (package_type && pkg.package_type !== package_type) return false;
    if (SKIP_STATUSES.has(String(pkg.status || '').toUpperCase())) return false;
    return true;
}

function to_size(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Parse a year out of a single value (ISO date string, or any string
// containing a 19xx/20xx). Returns a number or null.
function year_from_value(v) {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v);
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t).getUTCFullYear();
    const m = s.match(YEAR_RE);
    return m ? Number(m[1]) : null;
}

// Determine an AM package's creation year + where it came from:
//   { year, source } — source is the field name, 'current_path', or null.
// Priority: explicit date_field → known candidate field → current_path.
// An explicit date_field is authoritative (no path fallback) so a typo
// fails closed rather than silently using a path year.
function extract_year(pkg, date_field) {
    if (!pkg) return { year: null, source: null };
    if (date_field) {
        const y = year_from_value(pkg[date_field]);
        return { year: y, source: y ? date_field : null };
    }
    for (const f of DATE_FIELD_CANDIDATES) {
        const val = pkg[f];
        if (val !== null && val !== undefined && val !== '') {
            const y = year_from_value(val);
            if (y) return { year: y, source: f };
        }
    }
    const m = String(pkg.current_path || '').match(YEAR_RE);
    if (m) return { year: Number(m[1]), source: 'current_path' };
    return { year: null, source: null };
}

// Parse the ingest YEAR out of an AIP's PREMIS pointer file (METS XML).
// Prefers the METS header CREATEDATE (a single authoritative ingest
// timestamp); falls back to the EARLIEST premis:eventDateTime (≈ ingest).
// Namespace-tolerant. Returns a number or null.
function parse_ingest_year(xml) {
    if (!xml || typeof xml !== 'string') return null;
    const createdate = xml.match(/CREATEDATE="([^"]+)"/i);
    if (createdate) {
        const y = year_from_value(createdate[1]);
        if (y) return y;
    }
    const events = [...xml.matchAll(/<[\w:]*eventDateTime>([^<]+)<\/[\w:]*eventDateTime>/g)].map((mm) => mm[1]);
    const years = events.map(year_from_value).filter(Boolean);
    if (years.length) return Math.min(...years);
    return null;
}

// Classify AM packages against the DB reference sets.
//   live_refs    — Set of sip_uuids with an is_active=1 row (KEEP, excluded)
//   deleted_refs — Set of sip_uuids that have rows but ALL soft-deleted
// Each orphan row carries the report columns incl. created_year/year_source
// (title is filled in later for bucket B).
function classify(packages, live_refs, deleted_refs, opts = {}) {
    const { package_type = 'AIP', date_field = null } = opts;
    const orphans = [];
    let kept = 0;
    let skipped = 0;
    for (const pkg of packages) {
        if (!is_actionable(pkg, package_type)) {
            skipped++;
            continue;
        }
        const uuid = pkg.uuid;
        if (live_refs.has(uuid)) {
            kept++; // bucket C — live-referenced, keep
            continue;
        }
        const { year, source } = extract_year(pkg, date_field);
        orphans.push({
            sip_uuid: uuid,
            bucket: deleted_refs.has(uuid) ? 'B' : 'A',
            created_year: year,
            year_source: source,
            am_status: pkg.status || null,
            package_type: pkg.package_type || null,
            size_bytes: to_size(pkg.size),
            current_location: pkg.current_location || null,
            current_path: pkg.current_path || null,
            title: null,
        });
    }
    return { orphans, kept, skipped };
}

// Pick the deletable subset: bucket A, created_year === year, dated from a
// TRUSTED source. A current_path-derived year is trusted only when
// allow_path_year is set. Optional --limit cap. Returns
// { deletions, excluded_undated, total_matched } for reporting coverage.
function select_deletions(orphans, { year, allow_path_year = false, limit = null } = {}) {
    const matched = [];
    let excluded_undated = 0;
    for (const o of orphans) {
        if (o.bucket !== 'A') continue; // bucket A ONLY
        const trusted = Boolean(o.year_source) && (allow_path_year || o.year_source !== 'current_path');
        if (!trusted || o.created_year === null || o.created_year === undefined) {
            excluded_undated++;
            continue;
        }
        if (o.created_year !== year) continue;
        matched.push(o);
    }
    const deletions = limit ? matched.slice(0, limit) : matched;
    return { deletions, excluded_undated, total_matched: matched.length };
}

function csv_cell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function to_csv(rows, columns = CSV_COLUMNS) {
    const out = [columns.join(',')];
    for (const r of rows) out.push(columns.map((c) => csv_cell(r[c])).join(','));
    return out.join('\n') + '\n';
}

function* chunked(arr, size) {
    for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

// ---------------------------------------------------------------------------
// I/O (exercised manually + against the live env, not in unit tests).
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function with_retry(fn, { tries = 3, base_delay_ms = 2000 } = {}) {
    let last;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            last = err;
            if (attempt < tries) await sleep(base_delay_ms * attempt);
        }
    }
    throw last;
}

// Paginate the full AM package list for one package_type.
async function fetch_all_packages({ package_type, page_size }) {
    const all = [];
    let offset = 0;
    for (;;) {
        const page = await with_retry(() =>
            archivematica.list_packages({ package_type, limit: page_size, offset })
        );
        if (page.status !== 200) {
            throw new Error(`AM list_packages returned HTTP ${page.status} at offset ${offset}`);
        }
        all.push(...page.objects);
        const total = page.meta && page.meta.total_count;
        offset += page.objects.length;
        log.info({ event: 'am_orphans_page', got: page.objects.length, total: total ?? null, offset });
        if (page.objects.length === 0) break;
        if (total !== null && total !== undefined && offset >= total) break;
        if (offset > 5_000_000) break; // runaway backstop
    }
    return all;
}

// Build the two reference sets in one grouped query. MAX(is_active) over a
// uuid's rows is 1 iff any row is live → live_refs; otherwise the uuid has
// rows but all are soft-deleted → deleted_refs. Excludes empty/PENDING.
async function load_reference_sets() {
    const rows = await db()(tables.objects)
        .whereNotNull('sip_uuid')
        .whereNotIn('sip_uuid', ['', 'PENDING'])
        .select('sip_uuid')
        .max({ any_live: 'is_active' })
        .groupBy('sip_uuid');
    const live_refs = new Set();
    const deleted_refs = new Set();
    for (const r of rows) {
        if (Number(r.any_live) === 1) live_refs.add(r.sip_uuid);
        else deleted_refs.add(r.sip_uuid);
    }
    return { live_refs, deleted_refs };
}

// For bucket-B orphans (referenced only by soft-deleted rows) pull a title
// from the most recent deleted row's display_record, for human review.
async function load_titles_for(sip_uuids) {
    const map = new Map();
    if (sip_uuids.length === 0) return map;
    for (const chunk of chunked(sip_uuids, 500)) {
        const rows = await db()(tables.objects)
            .whereIn('sip_uuid', chunk)
            .where('is_active', 0)
            .select('sip_uuid', 'display_record', 'id')
            .orderBy('id', 'desc');
        for (const r of rows) {
            if (map.has(r.sip_uuid)) continue; // newest row wins
            const dr = projection.parse_display_record(r.display_record);
            map.set(r.sip_uuid, (dr && dr.title) || null);
        }
    }
    return map;
}

async function write_report_table(rows) {
    await db().schema.dropTableIfExists(REPORT_TABLE);
    await db().schema.createTable(REPORT_TABLE, (t) => {
        t.increments('id').primary();
        t.string('sip_uuid', 255).notNullable().index();
        t.string('bucket', 1).notNullable(); // 'A' true orphan, 'B' deleted-only
        t.integer('created_year').nullable();
        t.string('year_source', 50).nullable();
        t.string('am_status', 50).nullable();
        t.string('package_type', 50).nullable();
        t.bigInteger('size_bytes').nullable();
        t.string('current_location', 512).nullable();
        t.string('current_path', 1024).nullable();
        t.text('title').nullable();
        t.timestamp('generated_at').notNullable();
    });
    const generated_at = new Date();
    for (const chunk of chunked(rows, 500)) {
        await db()(REPORT_TABLE).insert(
            chunk.map((r) => ({
                sip_uuid: r.sip_uuid,
                bucket: r.bucket,
                created_year: r.created_year,
                year_source: r.year_source,
                am_status: r.am_status,
                package_type: r.package_type,
                size_bytes: r.size_bytes,
                current_location: r.current_location,
                current_path: r.current_path,
                title: r.title,
                generated_at,
            }))
        );
    }
}

// Submit AM deletion REQUESTS for each candidate, paced. Returns one result
// row per candidate. 202 (submitted) and 200 (already requested) are ok.
async function submit_deletions(items, { reason }) {
    const results = [];
    for (const it of items) {
        let status = null;
        let ok = false;
        let message = null;
        try {
            const res = await archivematica.delete_aip_request({
                uuid: it.sip_uuid,
                delete_reason: reason,
            });
            status = res.status;
            ok = res.status === 202 || res.status === 200;
            const d = res.data || {};
            message = d.message || d.id || null;
            if (message !== null && message !== undefined) message = String(message);
        } catch (err) {
            message = err.message;
        }
        log[ok ? 'info' : 'warn']({ event: 'am_orphan_delete', uuid: it.sip_uuid, status, ok });
        results.push({
            sip_uuid: it.sip_uuid,
            created_year: it.created_year,
            current_path: it.current_path,
            http_status: status,
            ok,
            message,
        });
        await sleep(DELETE_PACE_MS);
    }
    return results;
}

function today_stamp() {
    return new Date().toISOString().slice(0, 10);
}

// Resolve ingest year for orphans that the package list couldn't reliably
// date, by fetching each one's PREMIS pointer file. Mutates the orphan rows
// in place: sets created_year + year_source='pointer' (or 'unknown' if the
// pointer has no parseable date / can't be fetched). Only touches orphans
// whose current year is missing or came from the untrusted current_path —
// AIPs already dated by stored_date are left as-is (no fetch). Paced +
// progress-logged; `limit` caps how many pointer files are fetched (useful
// for a quick sample). Returns { processed, dated }.
async function enrich_years_via_pointer(orphans, { pace_ms = 150, limit = null } = {}) {
    const needs = orphans.filter(
        (o) =>
            o.created_year === null ||
            o.created_year === undefined ||
            o.year_source === 'current_path'
    );
    const targets = limit ? needs.slice(0, limit) : needs;
    let processed = 0;
    let dated = 0;
    for (const o of targets) {
        try {
            const res = await archivematica.get_pointer_file(o.sip_uuid);
            const year = res.status === 200 ? parse_ingest_year(res.xml) : null;
            if (year) {
                o.created_year = year;
                o.year_source = 'pointer';
                dated++;
            } else {
                o.created_year = null;
                o.year_source = 'unknown';
            }
        } catch (err) {
            o.created_year = null;
            o.year_source = 'unknown';
            log.warn({ event: 'am_orphan_pointer_failed', uuid: o.sip_uuid, err: err.message });
        }
        processed++;
        if (processed % 100 === 0) {
            log.info({ event: 'am_orphan_pointer_progress', processed, total: targets.length, dated });
        }
        if (pace_ms) await sleep(pace_ms);
    }
    return { processed, dated };
}

// ---------------------------------------------------------------------------
// Modes.
// ---------------------------------------------------------------------------

async function run_report(opts) {
    console.log(`Enumerating Archivematica ${opts.package_type} packages…`);
    const packages = await fetch_all_packages({
        package_type: opts.package_type,
        page_size: opts.page_size,
    });
    const { live_refs, deleted_refs } = await load_reference_sets();
    const { orphans, kept, skipped } = classify(packages, live_refs, deleted_refs, {
        package_type: opts.package_type,
        date_field: opts.date_field,
    });

    const b_uuids = orphans.filter((o) => o.bucket === 'B').map((o) => o.sip_uuid);
    const titles = await load_titles_for(b_uuids);
    for (const o of orphans) {
        if (o.bucket === 'B') o.title = titles.get(o.sip_uuid) || null;
    }

    const csv_path = opts.csv || `./am_orphans_${today_stamp()}.csv`;
    fs.writeFileSync(csv_path, to_csv(orphans));
    if (opts.write_table) await write_report_table(orphans);

    const a = orphans.filter((o) => o.bucket === 'A').length;
    const b = orphans.length - a;
    console.log('');
    console.log(`AM ${opts.package_type} packages scanned : ${packages.length}`);
    console.log(`  skipped (deleted/other type)   : ${skipped}`);
    console.log(`  kept (live-referenced)         : ${kept}`);
    console.log(`orphans                          : ${orphans.length}`);
    console.log(`  A — no tbl_objects row         : ${a}`);
    console.log(`  B — only soft-deleted row(s)   : ${b}`);
    console.log('');
    console.log(`CSV   : ${path.resolve(csv_path)}`);
    if (opts.write_table) console.log(`Table : ${REPORT_TABLE} (repo DB)`);
    console.log('Review before any deletion — see --delete (dry-run by default).');
}

async function run_year_report(opts) {
    console.log(`Enumerating Archivematica ${opts.package_type} packages…`);
    const packages = await fetch_all_packages({
        package_type: opts.package_type,
        page_size: opts.page_size,
    });
    const { live_refs, deleted_refs } = await load_reference_sets();
    const { orphans } = classify(packages, live_refs, deleted_refs, {
        package_type: opts.package_type,
        date_field: opts.date_field,
    });
    const bucket_a = orphans.filter((o) => o.bucket === 'A');

    console.log('');
    console.log(`Bucket-A orphans: ${bucket_a.length}`);
    console.log(
        'Resolving ingest year (stored_date when present, else pointer file)' +
            (opts.limit ? ` — sampling ${opts.limit}` : '') +
            `, paced ${opts.pace_ms}ms…`
    );
    const { processed, dated } = await enrich_years_via_pointer(bucket_a, {
        pace_ms: opts.pace_ms,
        limit: opts.limit,
    });
    console.log(`  pointer files fetched: ${processed}, dated from pointer: ${dated}`);

    const by_year = new Map();
    for (const o of bucket_a) {
        const key = o.created_year ? String(o.created_year) : 'unknown';
        by_year.set(key, (by_year.get(key) || 0) + 1);
    }
    const keys = [...by_year.keys()].sort();
    console.log('');
    console.log('Bucket-A orphans by ingest year:');
    for (const k of keys) console.log(`  ${k.padStart(8)} : ${by_year.get(k)}`);

    const csv_path = opts.csv || `./am_orphans_by_year_${today_stamp()}.csv`;
    fs.writeFileSync(
        csv_path,
        to_csv(bucket_a, ['sip_uuid', 'created_year', 'year_source', 'am_status', 'size_bytes', 'current_path'])
    );
    console.log('');
    console.log(`CSV (one row per bucket-A orphan, with resolved year): ${path.resolve(csv_path)}`);
    if (opts.limit) {
        console.log(`NOTE: --limit ${opts.limit} dated only a sample; the rest show year_source=unknown.`);
    }
    console.log('Next: delete a given year with  --delete --year YYYY --reason "..."  (dry-run first).');
}

async function run_delete(opts) {
    if (!opts.year) {
        console.error('--delete requires --year YYYY (the AM creation year to target).');
        process.exitCode = 1;
        return;
    }
    if (opts.execute && (!opts.reason || !opts.reason.trim())) {
        console.error('--execute requires --reason "text" (recorded as the AM deletion event_reason).');
        process.exitCode = 1;
        return;
    }

    console.log(`Enumerating Archivematica ${opts.package_type} packages…`);
    const packages = await fetch_all_packages({
        package_type: opts.package_type,
        page_size: opts.page_size,
    });
    const { live_refs, deleted_refs } = await load_reference_sets();
    const { orphans } = classify(packages, live_refs, deleted_refs, {
        package_type: opts.package_type,
        date_field: opts.date_field,
    });

    // AM's package list has no ingest date for legacy AIPs, so resolve each
    // bucket-A orphan's year from its pointer file (unless --no-pointer).
    // Without this, --year would match only AIPs that carry stored_date.
    const bucket_a = orphans.filter((o) => o.bucket === 'A');
    if (!opts.no_pointer) {
        console.log(
            `Resolving ingest year for ${bucket_a.length} bucket-A orphans ` +
                `(stored_date when present, else pointer file), paced ${opts.pace_ms}ms…`
        );
        const { processed, dated } = await enrich_years_via_pointer(bucket_a, { pace_ms: opts.pace_ms });
        console.log(`  pointer files fetched: ${processed}, dated from pointer: ${dated}`);
    }

    const { deletions, excluded_undated, total_matched } = select_deletions(orphans, {
        year: opts.year,
        allow_path_year: opts.allow_path_year,
        limit: opts.limit,
    });

    const bucket_a_total = bucket_a.length;
    const src_counts = {};
    for (const d of deletions) src_counts[d.year_source] = (src_counts[d.year_source] || 0) + 1;

    console.log('');
    console.log(`Bucket-A orphans total              : ${bucket_a_total}`);
    console.log(
        `  not reliably dated (skipped)      : ${excluded_undated}` +
            (opts.allow_path_year ? '' : '  [current_path years untrusted; --allow-path-year to include]')
    );
    console.log(`Bucket-A orphans created in ${opts.year}    : ${total_matched}`);
    if (opts.limit && total_matched > deletions.length) {
        console.log(`  capped by --limit to              : ${deletions.length}`);
    }
    console.log(`  year source breakdown             : ${JSON.stringify(src_counts)}`);
    console.log('');
    for (const d of deletions.slice(0, 50)) {
        console.log(`  - ${d.sip_uuid}  ${d.created_year} [${d.year_source}]  ${d.current_path || ''}`);
    }
    if (deletions.length > 50) console.log(`  … and ${deletions.length - 50} more (see CSV)`);
    console.log('');

    if (!opts.execute) {
        const csv_path = opts.csv || `./am_orphans_delete_${opts.year}_dryrun_${today_stamp()}.csv`;
        fs.writeFileSync(
            csv_path,
            to_csv(deletions, ['sip_uuid', 'created_year', 'year_source', 'am_status', 'size_bytes', 'current_path'])
        );
        console.log(`DRY RUN — nothing submitted. ${deletions.length} deletion request(s) WOULD be sent.`);
        console.log(`Candidates CSV : ${path.resolve(csv_path)}`);
        console.log('Verify the year_source/dates above, then re-run with: --execute --reason "your reason"');
        return;
    }

    if (deletions.length === 0) {
        console.log('Nothing to delete for that year.');
        return;
    }

    console.log(
        `EXECUTING — submitting ${deletions.length} Archivematica deletion request(s). ` +
            'Each must still be APPROVED by a Storage Service admin in the AM UI.'
    );
    const results = await submit_deletions(deletions, { reason: opts.reason });
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    const csv_path = opts.csv || `./am_orphans_delete_${opts.year}_results_${today_stamp()}.csv`;
    fs.writeFileSync(
        csv_path,
        to_csv(results, ['sip_uuid', 'created_year', 'current_path', 'http_status', 'ok', 'message'])
    );
    console.log('');
    console.log(`Requests submitted ok : ${ok}`);
    console.log(`Failed                : ${failed}`);
    console.log(`Results CSV           : ${path.resolve(csv_path)}`);
    console.log('Finalize in Archivematica: a Storage Service admin must APPROVE each request in the AM UI.');
}

async function main() {
    const opts = parse_args(process.argv.slice(2));

    if (!archivematica.is_storage_configured()) {
        console.error(
            'Archivematica storage API not configured — set ARCHIVEMATICA_STORAGE_API, ' +
                'ARCHIVEMATICA_STORAGE_USERNAME, ARCHIVEMATICA_STORAGE_API_KEY. Aborting.'
        );
        process.exitCode = 1;
        return;
    }

    // PROBE: fetch a tiny page, print the raw shape, exit. Run this FIRST in a
    // new environment to confirm AM's field names (incl. the date field for
    // --date-field) before a full sweep or any deletion.
    if (opts.probe) {
        const page = await archivematica.list_packages({
            package_type: opts.package_type,
            limit: 3,
            offset: 0,
        });
        console.log('HTTP status :', page.status);
        console.log('meta        :', JSON.stringify(page.meta, null, 2));
        console.log('objects[0..2]:', JSON.stringify(page.objects.slice(0, 3), null, 2));
        return;
    }

    if (opts.year_report) {
        await run_year_report(opts);
        return;
    }

    if (opts.delete) {
        await run_delete(opts);
        return;
    }

    await run_report(opts);
}

if (require.main === module) {
    // Load .env from the repo root regardless of the caller's cwd — the
    // script may be run from scripts/ or anywhere, and dotenv otherwise
    // resolves .env against process.cwd() (which would miss it and leave
    // required vars like TOKEN_SECRET unset).
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    main()
        .then(() => destroy_all())
        .catch(async (err) => {
            console.error(err && err.stack ? err.stack : err);
            process.exitCode = 1;
            await destroy_all().catch(() => {});
        });
}

module.exports = {
    parse_args,
    is_actionable,
    classify,
    to_csv,
    csv_cell,
    to_size,
    year_from_value,
    extract_year,
    parse_ingest_year,
    select_deletions,
    SKIP_STATUSES,
    DATE_FIELD_CANDIDATES,
    CSV_COLUMNS,
};
