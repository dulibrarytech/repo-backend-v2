#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { destroy_all } = require('../config/db');
const app_config = require('../config/app');
const aspace_default = require('../libs/archivesspace');
const aspace_session = require('../libs/aspace_session');
const link = require('../libs/aspace_link');
const sync = require('../aspace_links/sync');
const links_model = require('../aspace_links/model');

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 250;
const SAMPLE_LIMIT = 5;
const REPORTED_STATES = [...sync.ATTENTION_STATES, 'invalid_uri', 'orphan_link'];

const USAGE = `Usage: node scripts/sync_aspace_links.js [options]

Adds the "${link.LINK_TITLE}" link to each ArchivesSpace record that has
none yet, and the handle as the identifier of its digital object. A record
that already has a link is never changed, and records already recorded as
linked are not read at all. Reports what it finds. Writes nothing unless
--execute is given.

  --execute            write the changes to ArchivesSpace
                       (also needs ASPACE_WRITES_ENABLED=1 on this host, and
                       ASPACE_WRITES_FROM_DEV=1 on a development host when
                       ArchivesSpace is on another machine)
  --pids a,b           only the records these repository objects point at
  --since YYYY-MM-DD   only records with an object created on or after this date
                       (the date in the database server's time zone)
  --out FILE           write one JSON line per record to FILE
  --batch-size N       records per ArchivesSpace request (1-${MAX_BATCH_SIZE}, default ${DEFAULT_BATCH_SIZE})
  --help               show this text
`;

function is_calendar_date(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.toISOString().slice(0, 10) === text;
}

function parse_args(argv) {
    const o = {
        execute: false,
        help: false,
        pids: null,
        since: null,
        out: null,
        batch_size: DEFAULT_BATCH_SIZE,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--execute') o.execute = true;
        else if (a === '--help') o.help = true;
        else if (a === '--out') o.out = String(argv[++i] || '');
        else if (a === '--pids') {
            o.pids = String(argv[++i] || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        } else if (a === '--since') {
            o.since = String(argv[++i] || '');
            if (!is_calendar_date(o.since)) {
                throw new Error('--since must be YYYY-MM-DD, a date that exists');
            }
        } else if (a === '--batch-size') {
            o.batch_size = Number.parseInt(argv[++i], 10);
            if (!(o.batch_size >= 1 && o.batch_size <= MAX_BATCH_SIZE)) {
                throw new Error(`--batch-size must be between 1 and ${MAX_BATCH_SIZE}`);
            }
        } else throw new Error(`unknown arg: ${a}`);
    }
    return o;
}

function select_targets(built, args) {
    const since = args.since ? new Date(`${args.since}T00:00:00Z`) : null;
    const wanted = (row) =>
        (!args.pids || args.pids.includes(row.pid)) && (!since || new Date(row.created) >= since);
    return {
        targets: built.targets.filter((target) => [...target.live, ...target.deleted].some(wanted)),
        invalid: built.invalid.filter(wanted),
    };
}

function tally(values) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function print_summary(results, args, write) {
    write('\n  result\n');
    for (const [state, n] of tally(results.map((r) => r.state))) {
        write(`    ${String(n).padStart(6)}  ${state}\n`);
    }

    const changed = results.filter((r) => ['pending', 'updated', 'failed'].includes(r.state));
    const changes = [
        ...changed.map(() => 'link add'),
        ...changed
            .filter((r) => r.digital_object === 'update')
            .map(() => 'digital object identifier'),
    ];
    if (changes.length > 0) {
        write(`\n  changes ${args.execute ? 'planned' : 'that would be written'}\n`);
        for (const [change, n] of tally(changes)) {
            write(`    ${String(n).padStart(6)}  ${change}\n`);
        }
    }

    for (const state of REPORTED_STATES) {
        const subset = results.filter((r) => r.state === state);
        if (subset.length === 0) continue;
        write(`\n  ${state}:\n`);
        for (const r of subset.slice(0, SAMPLE_LIMIT)) {
            const reason = r.error || r.note;
            write(
                `    ${r.uri || '(no uri)'}  [${r.pids.join(', ')}]${reason ? `  ${reason}` : ''}\n`
            );
        }
        if (subset.length > SAMPLE_LIMIT) {
            write(`    ...and ${subset.length - SAMPLE_LIMIT} more\n`);
        }
    }
}

async function run(args, deps) {
    const write = deps.write;
    const cfg = app_config();
    const prefix = String(cfg.handles.prefix || '').replace(/^\/+|\/+$/g, '');

    if (!deps.aspace.is_configured()) {
        write('ARCHIVESPACE_* configuration incomplete - see .env-example.\n');
        return 1;
    }
    if (!prefix) {
        write('HANDLE_PREFIX is not set - see .env-example.\n');
        return 1;
    }
    if (args.execute && !cfg.archivespace.writes_enabled) {
        write(
            (cfg.archivespace.writes_requested
                ? '--execute from a development host to an ArchivesSpace on another machine\n' +
                  'also needs ASPACE_WRITES_FROM_DEV=1.\n'
                : '--execute needs ASPACE_WRITES_ENABLED=1 in the environment of this host.\n') +
                'Nothing was written.\n'
        );
        return 1;
    }

    write('\nSync repository handle links into ArchivesSpace\n');
    write(`  ArchivesSpace  ${cfg.archivespace.host}\n`);
    write(`  mode           ${args.execute ? 'EXECUTE' : 'dry run (no writes)'}\n`);
    if (args.pids) write(`  pids           ${args.pids.length}\n`);
    if (args.since) write(`  since          ${args.since}\n`);
    if (args.execute) {
        write(
            `  admin page     ${deps.store ? 'updated with each result' : 'not updated (queue tables missing)'}\n`
        );
    }

    const linked = deps.linked_uris ? await deps.linked_uris() : new Set();
    const selected = select_targets(sync.build_targets(await deps.load_rows()), args);
    const targets = selected.targets
        .filter((target) => !linked.has(target.uri))
        .sort((a, b) => a.listing.localeCompare(b.listing));
    write(`\n  ${targets.length} ArchivesSpace record(s) to check\n`);
    const skipped = selected.targets.length - targets.length;
    if (skipped > 0) write(`  ${skipped} record(s) already linked, skipped\n`);

    const results = [];
    if (args.out) fs.writeFileSync(args.out, '');
    const keep = (found) => {
        results.push(...found);
        if (args.out && found.length > 0) {
            fs.appendFileSync(args.out, `${found.map((r) => JSON.stringify(r)).join('\n')}\n`);
        }
    };
    keep(selected.invalid.map((row) => ({ uri: row.uri, pids: [row.pid], state: 'invalid_uri' })));

    const options = { prefix, execute: args.execute };
    let read_at = new Date();
    const sync_deps = {
        ...deps,
        loaders: deps,
        on_outcome: async ({ result }) => {
            if (!result) return;
            keep([result]);
            if (args.execute && deps.store) await deps.store(result, read_at);
        },
        on_written: deps.log_change,
    };
    let halted = null;
    let failures_in_a_row = 0;
    for (let at = 0; at < targets.length && !halted; at += args.batch_size) {
        const uris = targets.slice(at, at + args.batch_size).map((target) => target.uri);
        read_at = new Date();
        const fresh = await sync.load_targets(uris, deps);
        const batch = uris.filter((uri) => fresh.has(uri)).map((uri) => fresh.get(uri));
        const synced = await sync.sync_targets(batch, { ...options, failures_in_a_row }, sync_deps);
        ({ halted, failures_in_a_row } = synced);
        write(`    ${Math.min(at + args.batch_size, targets.length)}/${targets.length}\n`);
    }

    print_summary(results, args, write);
    if (args.out) write(`\n  per-record outcomes written to ${args.out}\n`);
    if (halted) write(`\nStopped early: ${halted}\n`);

    const pending = results.filter((r) => r.state === 'pending').length;
    const failed = results.filter((r) => r.state === 'failed').length;
    if (!args.execute) {
        write(
            `\nDry run: ${pending} record(s) would be updated in ArchivesSpace. ` +
                'Re-run with --execute to apply.\n'
        );
        return 0;
    }
    const updated = results.filter((r) => r.state === 'updated').length;
    write(`\n  ${updated} updated, ${failed} failed\n`);
    return failed > 0 ? 1 : 0;
}

async function main() {
    const args = parse_args(process.argv);
    if (args.help) {
        process.stdout.write(USAGE);
        return 0;
    }
    const aspace = aspace_default;
    const tables_ready = await links_model.is_ready().catch(() => false);
    const deps = {
        aspace,
        write: (text) => process.stdout.write(text),
        load_rows: links_model.load_object_rows,
        load_rows_for: links_model.load_object_rows_for,
        linked_uris: tables_ready ? links_model.linked_uris : null,
        linked_handles: tables_ready ? links_model.linked_handles : null,
        store: args.execute && tables_ready ? links_model.store : null,
        log_change: args.execute && tables_ready ? links_model.log_change : null,
        request: (call, label) =>
            aspace_session.request_with_retry(call, {
                aspace,
                label,
                min_interval_ms: app_config().aspace_links.min_interval_ms,
            }),
    };
    try {
        return await run(args, deps);
    } finally {
        const token = aspace_session.holder_for(aspace).peek();
        if (token) await aspace.destroy_session_token(token).catch(() => {});
    }
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

module.exports = { USAGE, parse_args, select_targets, run };
