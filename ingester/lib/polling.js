'use strict';

// Abortable polling primitive for the ingest worker.
//
// Why this exists:
//   v1's worker spun up bare `setInterval` loops for every long-poll
//   (transfer status, ingest status, upload progress, DuraCloud
//   propagation). When the worker process restarted, the old timers
//   leaked — Phase 1's resume logic re-spawned fresh pollers on top.
//   Worse, there was no way to ask a long poll to stop early during
//   graceful shutdown; SIGINT just killed the process mid-poll and
//   the row's state was whatever happened to be in flight.
//
// What this gives us:
//   - One async generator-ish API: `poll(check, opts)` returns
//     `{result, attempts, elapsed_ms, timed_out, aborted}`.
//   - Backpressure: never overlaps probes (await each `check()` to
//     completion before scheduling the next sleep).
//   - Cancellation: callers pass an AbortSignal (the worker creates
//     one per row, fires it on stop()).
//   - Pure: no module-level state; safe to use from multiple stages
//     concurrently.
//
// Semantics:
//   `check()` is called repeatedly. Its return value is interpreted:
//     - { done: true, value }   → poll resolves with this value
//     - { done: false }         → keep polling
//     - any thrown error        → poll rejects (caller decides)
//   The poll also resolves (with timed_out=true) once
//   `start + timeout_ms < now`, OR (with aborted=true) once `signal`
//   fires. `interval_ms` is the gap BETWEEN probes — total wall
//   time is roughly attempts * (probe_time + interval_ms).

const { ValidationError } = require('../../libs/errors');

async function poll(check, { interval_ms, timeout_ms, signal, on_attempt } = {}) {
    if (typeof check !== 'function') {
        throw new ValidationError('poll: check must be a function');
    }
    if (!Number.isFinite(interval_ms) || interval_ms < 0) {
        throw new ValidationError('poll: interval_ms must be a non-negative number');
    }
    if (!Number.isFinite(timeout_ms) || timeout_ms <= 0) {
        throw new ValidationError('poll: timeout_ms must be a positive number');
    }

    const start = Date.now();
    let attempts = 0;

    while (true) {
        if (signal && signal.aborted) {
            return {
                result: null,
                attempts,
                elapsed_ms: Date.now() - start,
                timed_out: false,
                aborted: true,
            };
        }
        const elapsed = Date.now() - start;
        if (elapsed >= timeout_ms) {
            return {
                result: null,
                attempts,
                elapsed_ms: elapsed,
                timed_out: true,
                aborted: false,
            };
        }

        attempts += 1;
        // We swallow thrown errors here only if the caller asked us to
        // via `on_attempt` (which returns a soft-fail). By default we
        // surface the error — the stage knows what to do.
        let probe;
        try {
            probe = await check({ attempt: attempts, elapsed_ms: elapsed });
        } catch (err) {
            if (on_attempt) {
                // Let the caller log + decide whether to keep going.
                const should_continue = await on_attempt({ attempt: attempts, error: err });
                if (!should_continue) throw err;
            } else {
                throw err;
            }
            probe = { done: false };
        }
        if (probe && probe.done) {
            return {
                result: probe.value,
                attempts,
                elapsed_ms: Date.now() - start,
                timed_out: false,
                aborted: false,
            };
        }

        // Sleep `interval_ms`, but wake immediately on abort. We
        // implement this with two racing timers — the abort listener
        // is removed once the sleep resolves either way.
        await sleep_or_abort(interval_ms, signal);
    }
}

// Sleep `ms` milliseconds. If `signal` fires before then, resolve
// early. Safe to call with a null signal.
function sleep_or_abort(ms, signal) {
    return new Promise((resolve) => {
        if (signal && signal.aborted) return resolve();
        const t = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', on_abort);
            resolve();
        }, ms);
        // Don't keep the process alive just for a long sleep.
        if (t.unref) t.unref();
        const on_abort = () => {
            clearTimeout(t);
            resolve();
        };
        if (signal) signal.addEventListener('abort', on_abort, { once: true });
    });
}

module.exports = { poll, sleep_or_abort };
