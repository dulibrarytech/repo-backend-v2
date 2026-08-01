#!/usr/bin/env node
'use strict';

/*
 * Delete handles minted by ingest for objects that should never have had one
 * — in practice, test ingests run against production before
 * HANDLE_SKIP_BATCH_TOKENS existed.
 *
 * WHY THIS IS DELIBERATELY AWKWARD TO USE
 *
 * Deleting a persistent identifier is normally the wrong thing: anything that
 * has been published or cited must keep resolving, to a tombstone if need be,
 * never to nothing. A test handle that was never shared is the one legitimate
 * exception, and this exists only for that.
 *
 * The obvious selection rule — "handles whose object was deleted" — is
 * actively dangerous. Objects are soft-deleted, never removed, and
 * repository/model.soft_delete() REFUSES a published object ("Suppress it
 * first, then delete"). So every deleted row reads is_published=0 whether it
 * was a test from this morning or a collection that was live and cited for
 * years. There is no publication-history flag. **Object state cannot prove a
 * handle was never public**, so it must not drive the delete set: 1,640 rows
 * in the dev database alone match "deleted and unpublished".
 *
 * Hence: pids are named explicitly, one at a time, and every guard below has
 * to pass. There is no --all, and no filter-based selection. If that feels
 * tedious for more than a handful, that is the intended signal — reach for
 * a tombstone retarget (scripts/retarget_handles.js) instead.
 *
 * GUARDS (all must pass, per pid)
 *
 *   1. the object exists in tbl_objects and carries a handle
 *   2. is_active = 0        — a live object's handle is never touched
 *   3. is_published = 0     — belt and braces; soft_delete enforces it too
 *   4. the handle resolves, and its target is exactly HANDLE_TARGET + pid,
 *      i.e. it really is this object's handle and not something else
 *   5. the handle's SERVER-SIDE value timestamp is within --max-age-days
 *      (default 7). This is the strongest guard and the only one that does
 *      not depend on our own database: a handle minted three years ago
 *      cannot be the test you ran this morning.
 *
 * On success the handle is deleted AND tbl_objects.handle is nulled — leaving
 * it populated would point the row at a dead identifier and make the Admin >
 * Handles delete guard still count it as "in use".
 *
 * Usage:
 *   node scripts/delete_object_handles.js --pids <pid>[,<pid>]
 *   node scripts/delete_object_handles.js --pids <pid> --execute
 *   node scripts/delete_object_handles.js --pids <pid> --max-age-days 2
 *   node scripts/delete_object_handles.js --pids <pid> --out results.ndjson
 *
 * DRY-RUN by default: prints the verdict per pid and writes nothing.
 */

const fs = require('node:fs');
const path = require('node:path');

const { db, destroy_all } = require('../config/db');
const tables = require('../config/db_tables');
const app_config = require('../config/app');
const handles = require('../libs/handles');
const handle_writer = require('../libs/handle_writer');

const DEFAULT_MAX_AGE_DAYS = 7;

function parse_args(argv) {
    const o = { pids: null, execute: false, max_age_days: DEFAULT_MAX_AGE_DAYS, out: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--execute') o.execute = true;
        else if (a === '--pids') {
            o.pids = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
        } else if (a === '--max-age-days') {
            o.max_age_days = Number.parseFloat(argv[++i]);
        } else if (a === '--out') o.out = String(argv[++i] || '');
        else throw new Error(`unknown arg: ${a}`);
    }
    if (!o.pids || o.pids.length === 0) {
        throw new Error('--pids is required; there is no bulk or filter-based mode');
    }
    if (!Number.isFinite(o.max_age_days) || o.max_age_days <= 0) {
        throw new Error('--max-age-days must be a positive number');
    }
    return o;
}

/* The one DB read assess() needs, isolated so it can be injected. */
async function fetch_object_row(pid) {
    return db()(tables.objects)
        .select('pid', 'handle', 'is_active', 'is_published')
        .where({ pid })
        .first();
}

/*
 * Decide one pid. Read-only: resolution is public and nothing is written
 * here, so the dry run exercises exactly the same checks as the real one.
 *
 * `deps` follows the injectable shape used elsewhere in the codebase
 * (libs/handles create_client, handles/model mint) so the guards can be
 * tested without a database or a handle server.
 */
async function assess(pid, args, now, deps = {}) {
    const fetch_row = deps.fetch_row || fetch_object_row;
    const handles_client = deps.handles || handles;

    const cfg = app_config().handles;
    const verdict = { pid, ok: false, reason: null, handle: null, minted_at: null };

    const row = await fetch_row(pid);

    if (!row) { verdict.reason = 'no tbl_objects row'; return verdict; }
    if (!row.handle) { verdict.reason = 'object has no handle'; return verdict; }
    verdict.handle = row.handle;

    /* Guard 2 + 3: never touch a live or published object's handle. */
    if (row.is_active === 1) { verdict.reason = 'object is ACTIVE'; return verdict; }
    if (row.is_published === 1) { verdict.reason = 'object is PUBLISHED'; return verdict; }

    let resolved;
    try {
        resolved = await handles_client.get_handle(pid);
    } catch (err) {
        verdict.reason = `resolve failed: ${err.message}`;
        return verdict;
    }
    if (!resolved) { verdict.reason = 'handle does not exist on the server'; return verdict; }

    const url_value = (resolved.values || []).find((v) => v.type === 'URL');
    if (!url_value) { verdict.reason = 'handle has no URL value'; return verdict; }

    /*
     * Guard 4: the handle must point at THIS object. A handle pointing
     * anywhere else is not ours to delete on the strength of this pid.
     */
    const expected = `${cfg.target}${pid}`;
    if (url_value.data && url_value.data.value !== expected) {
        verdict.reason = `target is not this object (${url_value.data.value})`;
        return verdict;
    }

    /*
     * Guard 5: the handle server's own timestamp, not ours. Independent of
     * anything in tbl_objects, and the only check that cannot be fooled by a
     * DB row that was edited after the fact.
     */
    if (!url_value.timestamp) { verdict.reason = 'handle has no timestamp'; return verdict; }
    const minted = new Date(url_value.timestamp);
    verdict.minted_at = url_value.timestamp;
    if (Number.isNaN(minted.getTime())) {
        verdict.reason = `unparseable timestamp ${url_value.timestamp}`;
        return verdict;
    }
    const age_days = (now - minted.getTime()) / 86400000;
    if (age_days > args.max_age_days) {
        verdict.reason =
            `minted ${age_days.toFixed(1)} days ago, older than --max-age-days `
            + `${args.max_age_days}`;
        return verdict;
    }

    verdict.ok = true;
    verdict.age_days = Number(age_days.toFixed(2));
    return verdict;
}

async function main() {
    const args = parse_args(process.argv);
    const cfg = app_config().handles;

    if (!handles.is_configured()) {
        process.stderr.write('HANDLE_* configuration incomplete - see .env-example.\n');
        return 1;
    }

    process.stdout.write('\nDelete ingest-minted handles\n');
    process.stdout.write(`  mode          ${args.execute ? 'EXECUTE' : 'dry run (no writes)'}\n`);
    process.stdout.write(`  max age       ${args.max_age_days} day(s)\n`);
    process.stdout.write(`  target prefix ${cfg.target}\n\n`);

    const now = Date.now();
    const verdicts = [];
    for (const pid of args.pids) {
        /*
         * Sequential on purpose: this is a handful of pids, and interleaved
         * output would make the per-pid verdict hard to read. 
         */
        const v = await assess(pid, args, now);
        verdicts.push(v);
        process.stdout.write(
            v.ok
                ? `  ELIGIBLE  ${pid}  (${v.handle}, minted ${v.age_days}d ago)\n`
                : `  REFUSED   ${pid}  ${v.reason}\n`
        );
    }

    const eligible = verdicts.filter((v) => v.ok);
    process.stdout.write(`\n  ${eligible.length} of ${verdicts.length} eligible\n`);

    if (!args.execute) {
        process.stdout.write('\nDry run. Re-run with --execute to delete.\n');
        if (args.out) write_results(args.out, verdicts);
        return 0;
    }
    if (eligible.length === 0) {
        process.stdout.write('\nNothing to delete.\n');
        if (args.out) write_results(args.out, verdicts);
        return 0;
    }

    process.stdout.write('\n  deleting...\n');
    let deleted = 0;
    for (const v of eligible) {
        try {
            const result = await handle_writer.write('delete', v.pid);
            /* 404 counts as done — the end state is what was asked for. */
            const gone = result.status === 200 || result.status === 404;
            if (!gone) {
                v.ok = false;
                v.reason = `handle server refused: ${(result.data && result.data.message) || result.status}`;
                process.stdout.write(`  FAILED    ${v.pid}  ${v.reason}\n`);
                continue;
            }
            /*
             * Null the column too: a row still pointing at a deleted handle
             * would keep counting as "in use" in the Admin > Handles guard,
             * and would be restored with a dead reference.
             */
            await db()(tables.objects).where({ pid: v.pid }).update({ handle: null });
            v.deleted = true;
            deleted++;
            process.stdout.write(`  DELETED   ${v.pid}  ${v.handle}\n`);
        } catch (err) {
            v.ok = false;
            v.reason = err.message;
            process.stdout.write(`  FAILED    ${v.pid}  ${err.message}\n`);
        }
    }

    process.stdout.write(`\n  ${deleted} handle(s) deleted, tbl_objects.handle cleared\n`);
    if (args.out) write_results(args.out, verdicts);
    return deleted === eligible.length ? 0 : 1;
}

function write_results(file, verdicts) {
    fs.writeFileSync(file, `${verdicts.map((v) => JSON.stringify(v)).join('\n')}\n`);
    process.stdout.write(`\n  per-pid outcomes written to ${file}\n`);
}

if (require.main === module) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    main()
        .then(async (code) => { await destroy_all(); process.exit(code); })
        .catch(async (err) => {
            process.stderr.write(`\n${err.stack || err.message}\n`);
            await destroy_all();
            process.exit(1);
        });
}

module.exports = { parse_args, assess, fetch_object_row };
