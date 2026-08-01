#!/usr/bin/env node
'use strict';

/*
 * Retarget Handle.net handles at the current HANDLE_TARGET.
 *
 * Every 10176 handle still resolves to https://specialcollections.du.edu/
 * object/<uuid>. That host 301s to digitalarchives.du.edu today, so nothing
 * is broken — but ~2,000 published, citable identifiers currently depend on
 * a legacy redirect that one nginx change would silently kill. This rewrites
 * the URL value on each handle to point straight at the current target.
 *
 * DRY-RUN by default: classifies everything, prints counts and samples,
 * writes nothing. Only --execute modifies handles.
 *
 * Usage:
 *   node scripts/retarget_handles.js                        # classify only
 *   node scripts/retarget_handles.js --execute              # retarget the live set
 *   node scripts/retarget_handles.js --from-logs <dir>      # + handles the DB has forgotten
 *   node scripts/retarget_handles.js --tombstone <url>      # send orphans elsewhere
 *   node scripts/retarget_handles.js --leave-orphans        # skip orphans entirely
 *   node scripts/retarget_handles.js --pids a,b             # restrict
 *   node scripts/retarget_handles.js --out results.ndjson   # record per-handle outcomes
 *
 * IDEMPOTENT, which is what makes it resumable: a handle already pointing at
 * the target classifies as `already_correct` and is skipped, so re-running
 * after an interruption finishes the remainder and a full re-run is a no-op.
 *
 * ORPHANS (handles with no repository row) are retargeted along with
 * everything else, because the destination is already the right one. A
 * uuid with no object renders digitaldu-frontend's page-not-found view —
 * HTTP 404, site chrome, and the words "the page or record that was here has
 * been withdrawn or moved". That is tombstone behaviour without a tombstone
 * page, and it has a property a generic tombstone URL does not: if the object
 * is ever restored, the handle starts working again with no handle-server
 * change. They are still counted separately so the orphan population stays
 * visible — it means objects left the repository without their handles being
 * cleaned up. Use --tombstone <url> to send them somewhere else, or
 * --leave-orphans to skip them.
 *
 * TWO THINGS THIS DELIBERATELY WILL NOT DO:
 *
 *  - It never deletes a handle. A persistent identifier already in a citation
 *    should keep resolving.
 *  - It never mints. Handles in the DB that no longer exist on the server are
 *    reported as `missing` and left alone; re-minting is a separate decision.
 */

const fs = require('node:fs');
const path = require('node:path');

const { db, destroy_all } = require('../config/db');
const tables = require('../config/db_tables');
const app_config = require('../config/app');
const handles = require('../libs/handles');
const handle_writer = require('../libs/handle_writer');

const UUID_PATTERN =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/*
 * How many handles to resolve concurrently. Resolution is a cheap public
 * GET; this is the only part of the run that is per-handle.
 */
const RESOLVE_CONCURRENCY = 8;

function parse_args(argv) {
    const o = {
        execute: false, pids: null, from_logs: null,
        tombstone: null, leave_orphans: false, out: null, limit: null,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--execute') o.execute = true;
        else if (a === '--pids') o.pids = String(argv[++i] || '').split(',').filter(Boolean);
        else if (a === '--from-logs') o.from_logs = String(argv[++i] || '');
        else if (a === '--tombstone') o.tombstone = String(argv[++i] || '');
        else if (a === '--leave-orphans') o.leave_orphans = true;
        else if (a === '--out') o.out = String(argv[++i] || '');
        else if (a === '--limit') o.limit = Number.parseInt(argv[++i], 10);
        else throw new Error(`unknown arg: ${a}`);
    }
    if (o.tombstone && !/^https?:\/\//i.test(o.tombstone)) {
        throw new Error('--tombstone must be an absolute http(s) URL');
    }
    if (o.tombstone && o.leave_orphans) {
        throw new Error('--tombstone and --leave-orphans are mutually exclusive');
    }
    return o;
}

/*
 * The handle suffix is the object's uuid. Take it from the stored handle
 * rather than assuming it equals pid — the column has carried junk before
 * (v1-era mint-failure strings, bare pids), and a malformed suffix is
 * exactly what put 10176/0 into the namespace.
 */
function suffix_from_handle(handle_value, prefix) {
    if (typeof handle_value !== 'string' || handle_value === '') return null;
    const marker = `/${prefix}/`;
    const at = handle_value.indexOf(marker);
    if (at === -1) return null;
    const suffix = handle_value.slice(at + marker.length).trim();
    return UUID_PATTERN.test(suffix) ? suffix : null;
}

/*
 * Candidates the repository knows about. Collections carry handles too, and
 * suppressed/inactive rows are included on purpose — their handles exist on
 * the server regardless of publication state, and classification decides
 * what to do about them.
 */
async function candidates_from_db(args, prefix) {
    let q = db()(tables.objects).select('pid', 'handle', 'is_published', 'is_active');
    if (args.pids) q = q.whereIn('pid', args.pids);
    const rows = await q;

    const out = new Map();
    let junk = 0;
    for (const row of rows) {
        const suffix = suffix_from_handle(row.handle, prefix);
        if (!suffix) {
            if (row.handle) junk++;
            continue;
        }
        out.set(suffix, {
            suffix,
            pid: row.pid,
            in_db: true,
            live: row.is_published === 1 && row.is_active === 1,
        });
    }
    return { candidates: out, junk };
}

/*
 * Handles the retired Python service minted, read from its per-operation
 * logs. This is the only record of handles whose object has since left the
 * repository — the DB cannot list them, and the server cannot be enumerated
 * remotely (allow_list_hdls is off; `?prefix=` returns "that prefix doesn't
 * live here"). Note it covers only service-era handles: the 2019-vintage
 * ones predate these logs entirely.
 */
function candidates_from_logs(dir) {
    const found = new Set();
    let scanned = 0;
    for (const name of fs.readdirSync(dir)) {
        const m = /^du_create_handle_(.+)\.log$/.exec(name);
        if (!m || !UUID_PATTERN.test(m[1])) continue;
        scanned++;
        const body = fs.readFileSync(path.join(dir, name), 'utf8');
        if (/==>SUCCESS/.test(body)) found.add(m[1]);
    }
    return { found, scanned };
}

/* Small fixed-size worker pool — resolution is the only per-handle step. */
async function map_pool(items, size, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    });
    await Promise.all(runners);
    return results;
}

/*
 * Decide what should happen to one handle. Resolution is public, so this
 * whole phase is read-only and safe to run at any time.
 */
async function classify(entry, cfg) {
    const desired = `${cfg.target}${entry.suffix}`;
    const record = { ...entry, desired };

    let resolved;
    try {
        resolved = await handles.get_handle(entry.suffix);
    } catch (err) {
        record.state = 'resolve_failed';
        record.detail = err.message;
        return record;
    }

    if (!resolved) {
        record.state = 'missing';
        return record;
    }

    const urls = (resolved.values || []).filter((v) => v.type === 'URL');
    if (urls.length === 0) {
        record.state = 'no_url_value';
        return record;
    }
    if (urls.length > 1) record.multiple_url_values = urls.map((v) => v.index);

    /*
     * The corpus is not uniform: service-minted handles hold the URL at
     * index 2, 2019-era ones at index 1 alongside an HS_ADMIN. Writing to a
     * fixed index would fail with VALUES NOT FOUND on the older population,
     * so carry the real index through to the write.
     */
    record.index = urls[0].index;
    record.current = urls[0].data && urls[0].data.value;

    if (record.current === desired) {
        record.state = 'already_correct';
    } else if (entry.in_db) {
        /*
         * Publication state deliberately does NOT affect this. An object
         * that exists in the repository should point at the repository
         * whether or not it is currently public — suppression is reversible,
         * and a suppressed object left on the legacy redirect would simply
         * break later for no reason. `live` is carried through for
         * reporting, not for the decision.
         */
        record.state = 'retarget';
    } else {
        /*
         * No repository row at all — an orphan, and the only tombstone
         * candidate.
         */
        record.state = 'withdrawn';
    }
    return record;
}

function summarise(records) {
    const counts = {};
    for (const r of records) counts[r.state] = (counts[r.state] || 0) + 1;
    return counts;
}

function print_samples(label, records, limit = 5) {
    const subset = records.slice(0, limit);
    if (subset.length === 0) return;
    process.stdout.write(`\n  ${label}:\n`);
    for (const r of subset) {
        const from = r.current ? `\n      from ${r.current}` : '';
        process.stdout.write(`    ${r.suffix}  [index ${r.index ?? '-'}]${from}\n`);
    }
    if (records.length > limit) {
        process.stdout.write(`    …and ${records.length - limit} more\n`);
    }
}

async function main() {
    const args = parse_args(process.argv);
    const cfg = app_config().handles;

    if (!handles.is_configured()) {
        process.stderr.write('HANDLE_* configuration incomplete — see .env-example.\n');
        return 1;
    }

    const prefix = cfg.prefix.replace(/^\/+|\/+$/g, '');
    process.stdout.write(`\nRetarget handles under ${prefix}\n`);
    process.stdout.write(`  target     ${cfg.target}\n`);
    process.stdout.write(`  mode       ${args.execute ? 'EXECUTE' : 'dry run (no writes)'}\n`);
    if (args.tombstone) process.stdout.write(`  tombstone  ${args.tombstone}\n`);

    /* --- gather ------------------------------------------------------- */
    const { candidates, junk } = await candidates_from_db(args, prefix);
    process.stdout.write(`\n  ${candidates.size} handle(s) from the database`);
    if (junk) process.stdout.write(`, ${junk} junk handle value(s) skipped`);
    process.stdout.write('\n');

    if (args.from_logs) {
        const { found, scanned } = candidates_from_logs(args.from_logs);
        let added = 0;
        for (const suffix of found) {
            if (!candidates.has(suffix)) {
                candidates.set(suffix, { suffix, pid: null, in_db: false, live: false });
                added++;
            }
        }
        process.stdout.write(
            `  ${scanned} create log(s) scanned; ${added} handle(s) not present in the database\n`
        );
    }

    let list = [...candidates.values()];
    if (args.limit) list = list.slice(0, args.limit);
    if (list.length === 0) {
        process.stdout.write('\nNothing to do.\n');
        return 0;
    }

    /* --- classify (read-only) ----------------------------------------- */
    process.stdout.write(`\n  resolving ${list.length} handle(s)…\n`);
    let done = 0;
    const records = await map_pool(list, RESOLVE_CONCURRENCY, async (entry) => {
        const record = await classify(entry, cfg);
        done++;
        if (done % 250 === 0) process.stdout.write(`    ${done}/${list.length}\n`);
        return record;
    });

    const counts = summarise(records);
    process.stdout.write('\n  classification\n');
    for (const [state, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        process.stdout.write(`    ${String(n).padStart(6)}  ${state}\n`);
    }

    const to_retarget = records.filter((r) => r.state === 'retarget');
    const withdrawn = records.filter((r) => r.state === 'withdrawn');
    const missing = records.filter((r) => r.state === 'missing');

    const suppressed = to_retarget.filter((r) => !r.live).length;
    if (suppressed) {
        process.stdout.write(
            `\n  (${suppressed} of those are currently unpublished or inactive —`
            + ' retargeted anyway, since suppression is reversible)\n'
        );
    }

    print_samples('would retarget', to_retarget);
    print_samples('withdrawn — no repository row (orphans)', withdrawn);
    print_samples('missing on the handle server — NOT re-minted', missing);

    /* --- plan --------------------------------------------------------- */
    const operations = to_retarget.map((r) => ({
        op: 'modify', uuid: r.suffix, index: r.index, url: r.desired,
    }));

    if (withdrawn.length) {
        if (args.leave_orphans) {
            process.stdout.write(
                `\n  ${withdrawn.length} orphan(s) left untouched (--leave-orphans).\n`
            );
        } else {
            const destination = args.tombstone || null;
            for (const r of withdrawn) {
                operations.push({
                    op: 'modify',
                    uuid: r.suffix,
                    index: r.index,
                    url: destination || r.desired,
                });
            }
            process.stdout.write(
                `\n  ${withdrawn.length} orphan(s) included, pointing at `
                + `${destination || 'the object URL (renders the 404 "withdrawn or moved" page)'}\n`
            );
        }
    }

    if (!args.execute) {
        process.stdout.write(
            `\nDry run: ${operations.length} handle(s) would be modified. `
            + 'Re-run with --execute to apply.\n'
        );
        if (args.out) write_results(args.out, records);
        return 0;
    }
    if (operations.length === 0) {
        process.stdout.write('\nNothing to modify.\n');
        if (args.out) write_results(args.out, records);
        return 0;
    }

    /* --- execute ------------------------------------------------------ */
    process.stdout.write(`\n  modifying ${operations.length} handle(s)…\n`);
    let applied = 0;
    const { results } = await handle_writer.batch(operations, {
        on_result(result, n, total) {
            applied = n;
            if (!result.ok) {
                process.stdout.write(
                    `    FAIL ${result.suffix}: ${result.responseCode} ${result.message}\n`
                );
            } else if (n % 250 === 0) {
                process.stdout.write(`    ${n}/${total}\n`);
            }
        },
    });

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    process.stdout.write(`\n  ${succeeded} modified, ${failed} failed, ${applied} attempted\n`);

    const by_suffix = new Map(results.map((r) => [r.suffix, r]));
    for (const record of records) {
        const outcome = by_suffix.get(record.suffix);
        if (outcome) {
            record.applied = outcome.ok;
            record.response_code = outcome.responseCode;
            record.message = outcome.message;
        }
    }
    if (args.out) write_results(args.out, records);

    if (failed) {
        process.stdout.write(
            '\nRe-run to retry the failures — handles already retargeted will\n'
            + 'classify as already_correct and be skipped.\n'
        );
    }
    return failed ? 1 : 0;
}

function write_results(file, records) {
    fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    process.stdout.write(`\n  per-handle outcomes written to ${file}\n`);
}

if (require.main === module) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    main()
        .then(async (code) => {
            await destroy_all();
            process.exit(code);
        })
        .catch(async (err) => {
            process.stderr.write(`\n${err.stack || err.message}\n`);
            await destroy_all();
            process.exit(1);
        });
}

module.exports = { suffix_from_handle, classify, summarise, parse_args };
