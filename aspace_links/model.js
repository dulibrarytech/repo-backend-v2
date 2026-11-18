'use strict';

const { db, db_queue } = require('../config/db');
const tables = require('../config/db_tables');
const log = require('../libs/log');
const sync = require('./sync');

const OBJECTS = tables.objects;
const LINKS = tables.aspace_links;
const CHANGES = tables.aspace_link_changes;

const STATUS = Object.freeze({ PENDING: 'PENDING', IN_PROGRESS: 'IN_PROGRESS', DONE: 'DONE' });
const RETRY_MS = 5 * 60 * 1000;
const CHUNK = 500;
const ERROR_LENGTH = 1000;

function shorten(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value).slice(0, ERROR_LENGTH);
}

function parse(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

let ready = false;

async function is_ready() {
    if (!ready) {
        const queue = db_queue();
        ready = (await queue.schema.hasTable(LINKS)) && (await queue.schema.hasTable(CHANGES));
    }
    return ready;
}

async function log_change(entry) {
    await db_queue()(CHANGES).insert({
        record_uri: entry.record_uri,
        uri: entry.uri,
        field: entry.field,
        action: entry.action,
        previous: entry.previous ?? null,
        value: entry.value ?? null,
        pids: JSON.stringify(entry.pids || []),
    });
}

const OBJECT_COLUMNS = Object.freeze([
    'pid',
    'uri',
    'handle',
    'object_type',
    'is_active',
    'created',
]);

function load_object_rows() {
    return db()(OBJECTS).select(OBJECT_COLUMNS);
}

function load_object_rows_for(uris) {
    if (uris.length === 0) return Promise.resolve([]);
    return db()(OBJECTS)
        .select(OBJECT_COLUMNS)
        .where((query) => {
            for (const uri of uris) {
                query.orWhereRaw("?? like ? escape '!'", [
                    'uri',
                    `${uri.replace(/[!%_]/g, '!$&')}%`,
                ]);
            }
        });
}

async function enqueue(uris) {
    const wanted = [...new Set(uris.map(sync.record_uri).filter(Boolean))];
    for (let at = 0; at < wanted.length; at += CHUNK) {
        await db_queue()(LINKS)
            .insert(wanted.slice(at, at + CHUNK).map((uri) => ({ uri, status: STATUS.PENDING })))
            .onConflict('uri')
            .merge({
                status: STATUS.PENDING,
                next_attempt_at: null,
                error: null,
                updated_at: db_queue().fn.now(),
            });
    }
    return wanted.length;
}

async function enqueue_safely(uris, context) {
    try {
        return await enqueue(uris);
    } catch (err) {
        log.error({ event: 'aspace_link_queue_failed', context, err: err.message });
        return 0;
    }
}

async function linked_uris() {
    const rows = await db_queue()(LINKS)
        .select('uri')
        .where({ status: STATUS.DONE })
        .whereIn('state', sync.LINKED_STATES);
    return new Set(rows.map((row) => row.uri));
}

function linked_handle(row) {
    const detail = parse(row.detail, {});
    if (detail.linked) return detail.linked;
    return sync.LINKED_STATES.includes(row.state) ? detail.handle || null : null;
}

async function linked_handles(uris) {
    const handles = new Map();
    for (let at = 0; at < uris.length; at += CHUNK) {
        const rows = await db_queue()(LINKS)
            .select('uri', 'state', 'detail')
            .whereIn('uri', uris.slice(at, at + CHUNK));
        for (const row of rows) {
            const handle = linked_handle(row);
            if (handle) handles.set(row.uri, handle);
        }
    }
    return handles;
}

async function is_linked_for(uri, pid) {
    const record = sync.record_uri(uri);
    if (!record || !(await is_ready())) return false;
    const row = await db_queue()(LINKS).select('state', 'pids').where({ uri: record }).first();
    if (!row || !sync.LINKED_STATES.includes(row.state)) return false;
    return parse(row.pids, []).includes(pid);
}

async function enqueue_all() {
    const linked = await linked_uris();
    const rows = await db()(OBJECTS).select('uri');
    return enqueue(rows.map((row) => row.uri).filter((uri) => !linked.has(sync.record_uri(uri))));
}

function requeue_state(state) {
    return db_queue()(LINKS).where({ status: STATUS.DONE, state }).update({
        status: STATUS.PENDING,
        next_attempt_at: null,
        error: null,
        updated_at: db_queue().fn.now(),
    });
}

function claim(limit) {
    const now = new Date();
    return db_queue().transaction(async (trx) => {
        const rows = await trx(LINKS)
            .where({ status: STATUS.PENDING })
            .andWhere(function () {
                this.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now);
            })
            .orderBy('id', 'asc')
            .limit(limit);
        if (rows.length === 0) return rows;
        await trx(LINKS)
            .whereIn(
                'id',
                rows.map((row) => row.id)
            )
            .update({ status: STATUS.IN_PROGRESS, updated_at: trx.fn.now() });
        return rows.map((row) => ({ ...row, status: STATUS.IN_PROGRESS }));
    });
}

function release() {
    return db_queue()(LINKS)
        .where({ status: STATUS.IN_PROGRESS })
        .update({ status: STATUS.PENDING, updated_at: db_queue().fn.now() });
}

function result_columns(result) {
    const { uri: _uri, pids, state, error, ...detail } = result;
    return {
        status: STATUS.DONE,
        state,
        pids: JSON.stringify(pids || []),
        detail: JSON.stringify(detail),
        error: shorten(error),
        next_attempt_at: null,
        checked_at: new Date(),
        updated_at: db_queue().fn.now(),
    };
}

async function record(row, result) {
    await db_queue()(LINKS)
        .where({ id: row.id, status: row.status })
        .update(result_columns(result));
}

async function store(result, read_at = new Date()) {
    const uri = sync.record_uri(result.uri);
    if (!uri) return;
    const columns = result_columns(result);
    const updated = await db_queue()(LINKS)
        .where({ uri, status: STATUS.DONE })
        .andWhere((query) => query.whereNull('checked_at').orWhere('checked_at', '<=', read_at))
        .update(columns);
    if (updated === 0) {
        await db_queue()(LINKS)
            .insert({ uri, ...columns })
            .onConflict('uri')
            .ignore();
    }
}

async function defer(rows, error) {
    if (rows.length === 0) return;
    await db_queue()(LINKS)
        .whereIn('status', [STATUS.PENDING, STATUS.IN_PROGRESS])
        .whereIn(
            'id',
            rows.map((row) => row.id)
        )
        .update({
            status: STATUS.PENDING,
            next_attempt_at: new Date(Date.now() + RETRY_MS),
            error: shorten(error),
            updated_at: db_queue().fn.now(),
        });
}

async function remove(rows) {
    for (const row of rows) {
        await db_queue()(LINKS).where({ id: row.id, status: row.status }).del();
    }
}

async function summary() {
    const rows = await db_queue()(LINKS)
        .select('status', 'state')
        .count({ n: '*' })
        .groupBy('status', 'state');
    const states = {};
    let waiting = 0;
    let checked = 0;
    for (const row of rows) {
        const n = Number(row.n || 0);
        if (row.status === STATUS.DONE) {
            checked += n;
            states[row.state] = (states[row.state] || 0) + n;
        } else {
            waiting += n;
        }
    }

    const last = await db_queue()(LINKS)
        .whereNotNull('checked_at')
        .orderBy('checked_at', 'desc')
        .first('checked_at');
    const stalled = await db_queue()(LINKS)
        .where({ status: STATUS.PENDING })
        .whereNotNull('next_attempt_at')
        .whereNotNull('error')
        .orderBy('updated_at', 'desc')
        .first('error');

    return {
        waiting,
        checked,
        states,
        last_checked_at: last ? last.checked_at : null,
        waiting_error: stalled ? stalled.error : null,
    };
}

async function list({ states, limit = 200 } = {}) {
    if (!Array.isArray(states) || states.length === 0) return { rows: [], total: 0 };
    const scope = () => db_queue()(LINKS).where({ status: STATUS.DONE }).whereIn('state', states);
    const total = await scope().count({ n: '*' }).first();
    const rows = await scope()
        .orderBy([
            { column: 'checked_at', order: 'desc' },
            { column: 'id', order: 'desc' },
        ])
        .limit(limit);
    return {
        total: Number((total && total.n) || 0),
        rows: rows.map((row) => ({
            ...row,
            pids: parse(row.pids, []),
            detail: parse(row.detail, {}),
        })),
    };
}

async function results_for(uris) {
    const wanted = [...new Set(uris.map(sync.record_uri).filter(Boolean))];
    if (wanted.length === 0) return new Map();
    const rows = await db_queue()(LINKS)
        .select('uri', 'status', 'state', 'pids', 'detail', 'error', 'checked_at')
        .whereIn('uri', wanted);
    return new Map(
        rows.map((row) => [
            row.uri,
            { ...row, pids: parse(row.pids, []), detail: parse(row.detail, {}) },
        ])
    );
}

module.exports = {
    STATUS,
    RETRY_MS,
    is_ready,
    log_change,
    load_object_rows,
    load_object_rows_for,
    enqueue,
    enqueue_safely,
    linked_uris,
    linked_handles,
    is_linked_for,
    enqueue_all,
    requeue_state,
    claim,
    release,
    record,
    store,
    defer,
    remove,
    summary,
    list,
    results_for,
};
