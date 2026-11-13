'use strict';

const { db, db_queue } = require('../config/db');
const tables = require('../config/db_tables');
const sync = require('./sync');

const OBJECTS = tables.objects;
const LINKS = tables.aspace_links;

const STATUS = Object.freeze({ PENDING: 'PENDING', DONE: 'DONE' });
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

function load_object_rows() {
    return db()(OBJECTS).select('pid', 'uri', 'handle', 'object_type', 'is_active', 'created');
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

async function enqueue_all() {
    const rows = await db()(OBJECTS).select('uri');
    return enqueue(rows.map((row) => row.uri));
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
    return db_queue()(LINKS)
        .where({ status: STATUS.PENDING })
        .andWhere(function () {
            this.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now);
        })
        .orderBy('id', 'asc')
        .limit(limit);
}

async function record(row, result) {
    const { uri: _uri, pids, state, error, ...detail } = result;
    await db_queue()(LINKS)
        .where({ id: row.id })
        .update({
            status: STATUS.DONE,
            state,
            pids: JSON.stringify(pids || []),
            detail: JSON.stringify(detail),
            error: shorten(error),
            next_attempt_at: null,
            checked_at: new Date(),
            updated_at: db_queue().fn.now(),
        });
}

async function defer(rows, error) {
    if (rows.length === 0) return;
    await db_queue()(LINKS)
        .where({ status: STATUS.PENDING })
        .whereIn(
            'id',
            rows.map((row) => row.id)
        )
        .update({
            next_attempt_at: new Date(Date.now() + RETRY_MS),
            error: shorten(error),
            updated_at: db_queue().fn.now(),
        });
}

async function remove(ids) {
    if (ids.length === 0) return;
    await db_queue()(LINKS).whereIn('id', ids).del();
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
        if (row.status === STATUS.PENDING) {
            waiting += n;
        } else {
            checked += n;
            states[row.state] = (states[row.state] || 0) + n;
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

module.exports = {
    STATUS,
    RETRY_MS,
    load_object_rows,
    enqueue,
    enqueue_all,
    requeue_state,
    claim,
    record,
    defer,
    remove,
    summary,
    list,
};
