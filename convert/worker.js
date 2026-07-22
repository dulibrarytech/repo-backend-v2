'use strict';

/*
 * In-process TIFF→JPG conversion worker.
 * 
 * Drains tbl_convert_queue one row per tick, POSTing each object to the
 * remote convert service. Unlike the indexer/metadata workers (which
 * use setInterval + bounded *parallel* batches), this worker is
 * deliberately SERIAL with a cooldown:
 * 
 *   claim 1 → POST → wait CONVERT_SERVICE_DELAY_MS → repeat
 * 
 * The downstream DU convert service (libspec02) is fragile under load —
 * the legacy post_tiff_convert.py paced requests 20s apart for exactly
 * this reason. A self-rescheduling setTimeout (rather than setInterval)
 * guarantees the gap is measured from the END of one request to the
 * START of the next, so a slow response never compresses the cooldown.
 * 
 * Lifecycle matches the other workers: start() after the HTTP server is
 * listening, stop() drains the in-flight request (aborting it) before
 * the DB pools close. reset_orphaned() at start returns rows a crashed
 * predecessor left IN_PROGRESS back to PENDING.
 */

const app_config = require('../config/app');
const log = require('../libs/log');
const client_default = require('./client');
const model = require('./model');

function create_worker({ client = client_default } = {}) {
    let running = false;
    let stopping = false;
    let timer = null;
    let in_flight = Promise.resolve();
    let abort = null;

    /*
     * Process exactly one queue row. Returns true if a row was handled
     * (caller then waits the full cooldown), false if the queue was
     * empty (caller waits the shorter idle interval).
     */
    async function tick_once() {
        if (stopping) return false;
        if (!client.is_configured()) return false;

        let row;
        try {
            row = await model.claim_one();
        } catch (err) {
            log.error({ event: 'convert_claim_failed', err: err.message });
            return false;
        }
        if (!row) return false;

        abort = new AbortController();
        try {
            const { status, body } = await client.convert(model.build_payload(row), {
                signal: abort.signal,
            });
            const ok = status >= 200 && status < 300;
            if (ok) {
                await model.mark_complete(row.id, { http_status: status, body });
                log.info({ event: 'convert_ok', id: row.id, object: row.object_name, status });
            } else {
                const res = await model.mark_failed(row, {
                    http_status: status,
                    body,
                    error: `HTTP ${status}`,
                });
                log.warn({
                    event: 'convert_http_error',
                    id: row.id,
                    object: row.object_name,
                    status,
                    terminal: res.terminal,
                });
            }
        } catch (err) {
            /*
             * Graceful-shutdown abort → release without spending an
             * attempt. Genuine transport failure → count it as a try.
             */
            if (abort && abort.signal.aborted) {
                await model.release(row.id).catch(() => {});
                log.info({ event: 'convert_aborted', id: row.id });
            } else {
                const res = await model
                    .mark_failed(row, { error: err.message })
                    .catch(() => ({ terminal: false }));
                log.warn({
                    event: 'convert_failed',
                    id: row.id,
                    object: row.object_name,
                    err: err.message,
                    terminal: res.terminal,
                });
            }
        } finally {
            abort = null;
        }
        return true;
    }

    function schedule(ms) {
        timer = setTimeout(run, ms);
        if (timer.unref) timer.unref();
    }

    async function run() {
        if (stopping) return;
        in_flight = tick_once();
        let did_work = false;
        try {
            did_work = await in_flight;
        } catch (err) {
            log.error({ event: 'convert_tick_error', err: err.message });
        }
        if (stopping) return;
        const cfg = app_config().convert_service;
        schedule(did_work ? cfg.delay_ms : cfg.idle_poll_ms);
    }

    async function start() {
        if (running) return;
        const cfg = app_config().convert_service;
        if (!cfg.enabled) {
            log.info({ event: 'convert_worker_disabled', reason: 'CONVERT_WORKER_ENABLED=false' });
            return;
        }
        if (!client.is_configured()) {
            /*
             * Stay idle (don't schedule) until the service is configured.
             * The dashboard still works; Start just won't process.
             */
            log.info({
                event: 'convert_worker_idle',
                reason: 'CONVERT_SERVICE / CONVERT_SERVICE_API_KEY not set',
            });
            return;
        }
        running = true;
        stopping = false;
        try {
            const reset = await model.reset_orphaned();
            if (reset.affected > 0) {
                log.info({ event: 'convert_orphans_reset', affected: reset.affected });
            }
        } catch (err) {
            log.warn({ event: 'convert_orphan_reset_failed', err: err.message });
        }
        log.info({
            event: 'convert_worker_started',
            delay_ms: cfg.delay_ms,
            idle_poll_ms: cfg.idle_poll_ms,
        });
        schedule(0);
    }

    async function stop({ timeout_ms = 8000 } = {}) {
        if (!running) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        timer = null;
        /*
         * Abort the in-flight POST so shutdown doesn't block for the full
         * axios timeout; the catch path releases the row back to PENDING.
         */
        if (abort) abort.abort();
        try {
            await Promise.race([in_flight, new Promise((r) => setTimeout(r, timeout_ms))]);
        } catch {
            // in_flight resolves past tick_once's own catch; defensive.
        }
        running = false;
        log.info({ event: 'convert_worker_stopped' });
    }

    return { start, stop, tick: tick_once, _is_running: () => running };
}

module.exports = { create_worker };
