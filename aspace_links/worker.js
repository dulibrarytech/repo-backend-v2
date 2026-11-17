'use strict';

const app_config = require('../config/app');
const log = require('../libs/log');
const aspace_default = require('../libs/archivesspace');
const aspace_session = require('../libs/aspace_session');
const model_default = require('./model');
const sync = require('./sync');

const BUSY_DELAY_MS = 1000;
const POLL_MS = 60000;
const MAX_BATCH_SIZE = 250;
const DELAY_AFTER = Object.freeze({ worked: BUSY_DELAY_MS, halted: model_default.RETRY_MS });

function create_worker({ aspace = aspace_default, model = model_default, request } = {}) {
    let running = false;
    let stopping = false;
    let timer = null;
    let in_flight = Promise.resolve();
    let failures_in_a_row = 0;
    let requeued = false;
    let reported_missing = false;

    const send =
        request ||
        ((call, label) =>
            aspace_session.request_with_retry(call, {
                aspace,
                label,
                min_interval_ms:
                    aspace === aspace_default
                        ? app_config().aspace_links.min_interval_ms
                        : undefined,
            }));

    async function tables_ready() {
        if (await model.is_ready()) return true;
        if (!reported_missing) {
            reported_missing = true;
            log.error({
                event: 'aspace_links_table_missing',
                msg: 'nothing is queued or checked until npm run migrate:queue is run',
            });
        }
        return false;
    }

    async function put_off(rows, reason) {
        try {
            await model.defer(rows, reason);
        } catch (err) {
            log.error({ event: 'aspace_links_defer_failed', rows: rows.length, err: err.message });
        }
    }

    async function prepare(cfg) {
        const released = await model.release();
        if (released > 0) log.info({ event: 'aspace_links_released', count: released });
        if (requeued || !cfg.archivespace.writes_enabled) return;
        const count = await model.requeue_state('pending');
        requeued = true;
        if (count > 0) log.info({ event: 'aspace_links_pending_requeued', count });
    }

    async function tick_once() {
        if (stopping) return 'idle';
        const cfg = app_config();
        const prefix = String(cfg.handles.prefix || '').replace(/^\/+|\/+$/g, '');
        if (!aspace.is_configured() || !prefix) return 'idle';
        if (!(await tables_ready())) return 'idle';
        await prepare(cfg);

        const claimed = await model.claim(Math.min(cfg.aspace_links.batch_size, MAX_BATCH_SIZE));
        if (claimed.length === 0) return 'idle';

        const waiting = new Map(claimed.map((row) => [row.uri, row]));
        const states = {};
        let removed = 0;
        const save = async ({ target, result }) => {
            const row = waiting.get(target.uri);
            if (result) {
                await model.record(row, result);
                states[result.state] = (states[result.state] || 0) + 1;
            } else {
                await model.remove([row]);
                removed += 1;
            }
            waiting.delete(target.uri);
        };

        try {
            const targets = await sync.load_targets([...waiting.keys()], {
                load_rows_for: model.load_object_rows_for,
                load_rows: model.load_object_rows,
            });
            const gone = claimed.filter((row) => !targets.has(row.uri));
            await model.remove(gone);
            for (const row of gone) waiting.delete(row.uri);
            removed += gone.length;

            const synced = await sync.sync_targets(
                [...waiting.keys()].map((uri) => targets.get(uri)),
                {
                    prefix,
                    publish: false,
                    execute: cfg.archivespace.writes_enabled,
                    failures_in_a_row,
                },
                {
                    aspace,
                    request: send,
                    on_outcome: save,
                    on_written: model.log_change,
                    should_stop: () => stopping,
                }
            );
            failures_in_a_row = synced.failures_in_a_row;
            const summary = {
                event: 'aspace_links_batch',
                checked: synced.outcomes.length,
                removed,
                states,
            };
            if (!synced.halted) {
                log.info(summary);
                return 'worked';
            }
            await put_off([...waiting.values()], synced.halted);
            log.warn({ ...summary, halted: synced.halted });
            return 'halted';
        } catch (err) {
            await put_off([...waiting.values()], err.message);
            log.warn({
                event: 'aspace_links_batch_failed',
                rows: waiting.size,
                err: err.message,
            });
            return sync.auth_failure(err) ? 'halted' : 'failed';
        }
    }

    function schedule(ms) {
        timer = setTimeout(run, ms);
        if (timer.unref) timer.unref();
    }

    async function run() {
        if (stopping) return;
        in_flight = tick_once();
        let outcome = 'idle';
        try {
            outcome = await in_flight;
        } catch (err) {
            log.error({ event: 'aspace_links_tick_error', err: err.message });
        }
        if (stopping) return;
        schedule(DELAY_AFTER[outcome] || POLL_MS);
    }

    async function start() {
        if (running) return;
        const cfg = app_config();
        if (!cfg.aspace_links.enabled) {
            log.info({
                event: 'aspace_links_worker_disabled',
                reason: 'ASPACE_LINKS_WORKER_ENABLED=false',
            });
            return;
        }
        running = true;
        stopping = false;
        log.info({
            event: 'aspace_links_worker_started',
            poll_ms: POLL_MS,
            batch_size: cfg.aspace_links.batch_size,
            writes_enabled: cfg.archivespace.writes_enabled,
        });
        schedule(0);
    }

    async function stop({ timeout_ms = 8000 } = {}) {
        if (!running) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        timer = null;
        await Promise.race([
            in_flight.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, timeout_ms)),
        ]);
        running = false;
        log.info({ event: 'aspace_links_worker_stopped' });
    }

    return { start, stop, tick: tick_once, _is_running: () => running };
}

module.exports = { create_worker };
