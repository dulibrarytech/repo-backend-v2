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
     * The row whose conversion was POSTed last tick and is awaiting
     * verification: { row, ack: {status, body}, checks }. The service
     * ACKs 202 BEFORE converting (fire-and-forget), so completion is
     * only recorded once the derivative is confirmed real — verified on
     * the NEXT tick, by which point the paced cooldown has given the
     * background conversion ≥ delay_ms to land. In-memory on purpose:
     * a crash leaves the row IN_PROGRESS and reset_orphaned() returns
     * it to PENDING for a harmless re-conversion.
     */
    let awaiting = null;
    // Log the endpoint-absent fallback once per process, not per row.
    let verify_unavailable_logged = false;

    // "thing.tif" → "thing.jpg" — the derivative the service writes.
    function derivative_name(object_name) {
        return String(object_name || '').replace(/\.[^.]+$/, '') + '.jpg';
    }

    /*
     * Verify the awaited row's derivative and settle its queue status.
     * Clears `awaiting` when settled; leaves it set (checks++) when the
     * verdict is retryable (file not landed yet / service unreachable).
     */
    async function verify_awaiting() {
        const a = awaiting;
        const cfg = app_config().convert_service;
        const jpg = derivative_name(a.row.object_name);
        let verdict;
        try {
            verdict = await client.verify_image(jpg, { signal: abort && abort.signal });
        } catch {
            // Transport failure — service down? Retry next tick, capped.
            a.checks += 1;
            if (a.checks >= cfg.verify_max_checks) {
                awaiting = null;
                const res = await model.mark_failed(a.row, {
                    error: `verification unreachable after ${a.checks} checks`,
                });
                log.warn({
                    event: 'convert_verify_unreachable',
                    id: a.row.id,
                    object: a.row.object_name,
                    terminal: res.terminal,
                });
            }
            return;
        }

        if (verdict.outcome === 'ok') {
            awaiting = null;
            await model.mark_complete(a.row.id, {
                http_status: a.ack.status,
                body: { ack: a.ack.body, verified_bytes: verdict.bytes },
            });
            log.info({
                event: 'convert_verified',
                id: a.row.id,
                object: a.row.object_name,
                bytes: verdict.bytes,
            });
        } else if (verdict.outcome === 'empty') {
            awaiting = null;
            const res = await model.mark_failed(a.row, {
                http_status: a.ack.status,
                body: a.ack.body,
                error:
                    'verification failed: derivative is EMPTY (0 bytes) — ' +
                    'check convert host disk space',
            });
            log.error({
                event: 'convert_verify_empty',
                id: a.row.id,
                object: a.row.object_name,
                terminal: res.terminal,
            });
        } else if (verdict.outcome === 'missing') {
            a.checks += 1;
            if (a.checks >= cfg.verify_max_checks) {
                awaiting = null;
                const res = await model.mark_failed(a.row, {
                    http_status: a.ack.status,
                    body: a.ack.body,
                    error: `verification failed: derivative missing after ${a.checks} checks`,
                });
                log.warn({
                    event: 'convert_verify_missing',
                    id: a.row.id,
                    object: a.row.object_name,
                    terminal: res.terminal,
                });
            }
            // else: conversion may still be running — check again next tick.
        } else {
            /*
             * 'unavailable' — endpoint absent (older service build).
             * Fall back to unverified completion rather than failing
             * rows the worker cannot check.
             */
            awaiting = null;
            await model.mark_complete(a.row.id, {
                http_status: a.ack.status,
                body: a.ack.body,
            });
            if (!verify_unavailable_logged) {
                verify_unavailable_logged = true;
                log.warn({
                    event: 'convert_verify_unavailable',
                    msg:
                        'Convert service GET /image endpoint not available — ' +
                        'derivatives are being marked COMPLETE unverified. ' +
                        'Deploy a service build with the /image endpoint or ' +
                        'set CONVERT_VERIFY_ENABLED=false to silence this.',
                });
            }
        }
    }

    /*
     * Process one queue step: settle the previous tick's verification,
     * then claim + POST the next row. Returns true if any work was done
     * (caller then waits the full cooldown), false if idle (caller
     * waits the shorter idle interval).
     */
    async function tick_once() {
        if (stopping) return false;
        if (!client.is_configured()) return false;

        const verify_enabled = app_config().convert_service.verify_enabled;
        let did_verify = false;
        if (awaiting) {
            abort = new AbortController();
            try {
                await verify_awaiting();
            } finally {
                abort = null;
            }
            did_verify = true;
            if (stopping) return true;
        }

        let row;
        try {
            row = await model.claim_one();
        } catch (err) {
            log.error({ event: 'convert_claim_failed', err: err.message });
            return did_verify;
        }
        if (!row) return did_verify;

        abort = new AbortController();
        try {
            const { status, body } = await client.convert(model.build_payload(row), {
                signal: abort.signal,
            });
            const ok = status >= 200 && status < 300;
            if (ok && verify_enabled) {
                /*
                 * ACK received — completion is decided next tick, once
                 * the background conversion has had the cooldown to
                 * finish. Row stays IN_PROGRESS meanwhile.
                 */
                awaiting = { row, ack: { status, body }, checks: 0 };
                log.info({
                    event: 'convert_acked',
                    id: row.id,
                    object: row.object_name,
                    status,
                });
            } else if (ok) {
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
        /*
         * A row still awaiting verification goes back to PENDING without
         * spending an attempt — the restart re-converts it (a harmless
         * overwrite) rather than leaving it IN_PROGRESS or marking it
         * complete unchecked.
         */
        if (awaiting) {
            await model.release(awaiting.row.id).catch(() => {});
            log.info({ event: 'convert_verify_released', id: awaiting.row.id });
            awaiting = null;
        }
        running = false;
        log.info({ event: 'convert_worker_stopped' });
    }

    return { start, stop, tick: tick_once, _is_running: () => running };
}

module.exports = { create_worker };
