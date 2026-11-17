#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { db, destroy_all } = require('../config/db');
const tables = require('../config/db_tables');
const app_config = require('../config/app');
const handles_default = require('../libs/handles');
const writer_default = require('../libs/handle_writer');
const indexer_model = require('../indexer/model');
const aspace_links = require('../aspace_links/model');
const link = require('../libs/aspace_link');

const URL_INDEX = 2;
const TRIES = 3;
const MINT_FAILURE = /^Error: \[\/libs\/handles lib \(create_handle\)\]/;
const MOMENT = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2})(:\d{2})?)?$/;

function is_moment(text) {
    const match = MOMENT.exec(text);
    if (!match) return false;
    const iso = `${match[1]}T${match[2] || '00:00'}${match[3] || ':00'}`;
    const parsed = new Date(`${iso}Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === iso;
}

function parse_args(argv) {
    const o = { execute: false, pids: null, from: null, to: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--execute') o.execute = true;
        else if (a === '--pids') {
            o.pids = String(argv[++i] || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        } else if (a === '--from') o.from = String(argv[++i] || '');
        else if (a === '--to') o.to = String(argv[++i] || '');
        else throw new Error(`unknown arg: ${a}`);
    }
    const window = o.from !== null || o.to !== null;
    if (window && o.pids) throw new Error('use --pids or --from/--to, not both');
    if (window && !(is_moment(o.from || '') && is_moment(o.to || ''))) {
        throw new Error(
            '--from and --to are both required, as YYYY-MM-DD or "YYYY-MM-DD HH:MM:SS"'
        );
    }
    if (!window && (!o.pids || o.pids.length === 0)) {
        throw new Error('name the objects with --pids, or their ingest dates with --from and --to');
    }
    return o;
}

function load_rows(args) {
    const query = db()(tables.objects)
        .select('pid', 'handle', 'is_active')
        .orderBy('created', 'asc');
    return args.pids
        ? query.whereIn('pid', args.pids)
        : query.where('created', '>=', args.from).andWhere('created', '<', args.to);
}

async function ask(handles, pid) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await handles.get_handle(pid);
        } catch (err) {
            if (attempt === TRIES) throw err;
        }
    }
}

async function assess(row, handles, prefix) {
    const plan = { pid: row.pid, mint: false, store: false, skipped: null, failed: null };
    if (row.is_active !== 1) return { ...plan, skipped: 'deleted object' };

    const stored = link.handle_id(row.handle) === `${prefix}/${row.pid}`.toLowerCase();
    if (!stored && !MINT_FAILURE.test(String(row.handle))) {
        return { ...plan, skipped: 'unexpected stored handle' };
    }
    try {
        const found = await ask(handles, row.pid);
        return { ...plan, mint: !found, store: !stored };
    } catch (err) {
        return { ...plan, failed: err.message };
    }
}

function points_at(found, url) {
    return (
        Boolean(found) &&
        (found.values || []).some(
            (v) => v.type === 'URL' && Boolean(v.data) && v.data.value === url
        )
    );
}

async function confirm(handles, pid, url) {
    try {
        return points_at(await ask(handles, pid), url);
    } catch {
        return false;
    }
}

function with_handle(display_record, url) {
    try {
        const record = JSON.parse(display_record);
        return record && typeof record === 'object' && !Array.isArray(record)
            ? JSON.stringify({ ...record, handle: url })
            : null;
    } catch {
        return null;
    }
}

async function store_handle(pid, url) {
    const row = await db()(tables.objects).select('display_record', 'uri').where({ pid }).first();
    const update = { handle: url };
    const display_record = with_handle(row.display_record, url);
    if (display_record) update.display_record = display_record;
    await db()(tables.objects).where({ pid }).update(update);
    await indexer_model.mark_dirty_pid(pid);
    await aspace_links.enqueue_safely([row.uri], 'handle_minted');
}

function outcome(plan, execute) {
    if (plan.failed) return 'FAILED';
    if (plan.skipped) return 'skipped';
    if (!plan.mint && !plan.store) return 'exists';
    const steps = [plan.mint && 'create', plan.store && 'store'].filter(Boolean).join(' and ');
    return `${execute ? 'done' : 'to do'}: ${steps}`;
}

async function run(args, deps = {}) {
    const handles = deps.handles || handles_default;
    const writer = deps.writer || writer_default;
    const print = deps.print || ((line) => process.stdout.write(`${line}\n`));

    const cfg = app_config().handles;
    const prefix = cfg.prefix.replace(/^\/+|\/+$/g, '');
    const target = (pid) => `${cfg.target}${pid}`;

    const rows = await load_rows(args);
    const plans = [];
    for (const row of rows) plans.push(await assess(row, handles, prefix));
    for (const pid of args.pids || []) {
        if (!rows.some((row) => row.pid === pid)) {
            plans.push({ pid, mint: false, store: false, skipped: 'no such object', failed: null });
        }
    }

    if (args.execute) {
        const to_mint = plans.filter((plan) => plan.mint);
        const operations = to_mint.map((plan) => ({
            op: 'create',
            uuid: plan.pid,
            index: URL_INDEX,
            url: target(plan.pid),
        }));
        const { results } =
            operations.length > 0 ? await writer.batch(operations) : { results: [] };
        const said = new Map(results.map((result) => [result.suffix, result.message]));
        for (const plan of to_mint) {
            if (!(await confirm(handles, plan.pid, target(plan.pid)))) {
                plan.failed = `the handle server does not show the new handle (the helper said: ${said.get(plan.pid) || 'nothing'})`;
            }
        }
        for (const plan of plans) {
            if (plan.store && !plan.failed) {
                await store_handle(plan.pid, handles_default.build_handle_url(plan.pid));
            }
        }
    }

    const counts = {};
    for (const plan of plans) {
        const label = outcome(plan, args.execute);
        counts[label] = (counts[label] || 0) + 1;
        if (label !== 'exists') {
            print(
                `  ${label.padEnd(22)} ${plan.pid}  ${plan.failed || plan.skipped || ''}`.trimEnd()
            );
        }
    }
    print(
        `\n${args.execute ? 'EXECUTED' : 'DRY RUN (nothing written)'}: ${plans.length} object(s)`
    );
    for (const [label, n] of Object.entries(counts)) print(`  ${String(n).padStart(6)}  ${label}`);
    if (!args.execute) print('\nRe-run with --execute to apply.');
    return plans;
}

async function main() {
    const args = parse_args(process.argv);
    if (!handles_default.is_configured()) {
        process.stderr.write('HANDLE_* configuration incomplete - see .env-example.\n');
        return 1;
    }
    const plans = await run(args);
    return plans.some((plan) => plan.failed) ? 1 : 0;
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

module.exports = { parse_args, assess, points_at, with_handle, outcome, run };
