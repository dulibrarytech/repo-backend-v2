'use strict';

/*
 * In-process metadata-refresh worker.
 * 
 * One worker instance per process. Polls the queue every `poll_ms`,
 * claims up to `concurrency` PENDING rows per tick, fans out the
 * ArchivesSpace fetches in parallel, then writes results to tbl_objects
 * and finalizes each row's queue state.
 * 
 * Why one global worker (not one per batch):
 *   - We have to cap upstream load on ArchivesSpace regardless of how
 *     many batches are open. A single semaphore governs the world.
 *   - The queue table already serializes work via the (batch_uuid,
 *     is_complete) index — there's no benefit to per-batch coroutines.
 *   - Simpler shutdown: one stop signal, one drain.
 * 
 * Crash recovery: on start() we call model.reset_orphaned() which
 * returns any IN_PROGRESS rows to PENDING. So a kill -9 mid-fetch
 * loses ~1 fetch-window of work and that's it.
 */

const app_config = require('../config/app');
const log = require('../libs/log');
const aspace_default = require('../libs/archivesspace');
const repo_model = require('../repository/model');
const model = require('./model');
const batches = require('./batches');

/*
 * ArchivesSpace returns the metadata as response.data; the v1 worker
 * wrote that plus a denormalized envelope (display_record) and three
 * derived fields (compound_parts, is_compound) into tbl_objects. We
 * keep that shape for parity — the legacy indexer reads display_record,
 * and the v2 dashboard's projection assumes it too.
 * 
 * `metadata` is whatever ASpace gave us. We trust it's an object.
 */
function build_payload(existing_display_record, metadata) {
    let envelope = {};
    if (existing_display_record) {
        try {
            const parsed = JSON.parse(existing_display_record);
            if (parsed && typeof parsed === 'object') envelope = parsed;
        } catch {
            /*
             * Corrupt prior display_record — overwrite with a fresh
             * envelope. Better than failing the refresh.
             */
        }
    }
    const is_compound = metadata && metadata.is_compound === true;
    /*
     * For compound objects v1 preserves the existing parts list under
     * the new display_record. The metadata fetch from ASpace doesn't
     * include the parts manifest (that's local DIP data), so we read
     * the old parts list BEFORE overwriting the inner display_record
     * and splice it back into the fresh metadata.
     */
    let existing_parts = [];
    if (is_compound && envelope.display_record && Array.isArray(envelope.display_record.parts)) {
        existing_parts = envelope.display_record.parts;
    }

    envelope.display_record = metadata;
    let compound_parts = '[]';
    if (is_compound) {
        envelope.display_record.parts = existing_parts;
        compound_parts = JSON.stringify(existing_parts);
    }
    return {
        mods: JSON.stringify(metadata),
        display_record: JSON.stringify(envelope),
        compound_parts,
        is_compound: is_compound ? 1 : 0,
    };
}

/*
 * Whether a queue row belongs to an active system-refresh batch. Used
 * to decide whether the worker should roll up per-batch counters on
 * a terminal transition. On-demand refreshes (priority=0, no batch
 * row) skip the rollup entirely.
 * 
 * We treat any row that has a corresponding active batches row as a
 * "system" row — that way operator-canceled batches still get their
 * in-flight rows accounted for as the worker drains them.
 */
async function row_is_system_refresh(batch_uuid) {
    if (!batch_uuid) return false;
    try {
        await batches.get_batch(batch_uuid);
        return true;
    } catch {
        /*
         * No batches row → on-demand or pre-existing batch_uuid not
         * managed by the system-refresh feature.
         */
        return false;
    }
}

/*
 * Hand a per-row outcome to the batch rollup IF the row is part of
 * an active system-refresh batch. No-op for on-demand rows.
 */
async function roll_up(row, outcome) {
    if (!(await row_is_system_refresh(row.batch_uuid))) return;
    try {
        await batches.on_row_terminal(row.batch_uuid, outcome);
    } catch (err) {
        /*
         * Counter rollup is informational — don't fail the row write
         * if the rollup query glitches. Loud log so an operator
         * notices counter drift.
         */
        log.warn({
            event: 'metadata_batch_rollup_failed',
            batch_uuid: row.batch_uuid,
            outcome,
            err: err.message,
        });
    }
}

/*
 * One end-to-end process step for a single claimed row. Encapsulated
 * here so the worker loop can run `concurrency` of them in parallel
 * via Promise.allSettled. Returns nothing — all state lives in the DB.
 * 
 * The `token_holder` is a single-element array we mutate so 401-driven
 * refreshes update the value shared across concurrent fetches in the
 * same tick. (A bare local would be per-call; an object would also
 * work — array is just a convenient mutable holder.)
 */
async function process_row(row, aspace, token_holder, get_db_record) {
    let res;
    try {
        res = await aspace.get_record(row.uri, token_holder[0]);
    } catch (err) {
        const result = await model.mark_failed(row.id, err.message);
        if (result.outcome === 'dead_lettered') await roll_up(row, 'dead_lettered');
        return;
    }

    /*
     * On 401/403, refresh the token and retry once. v1's worker never
     * did this — a single mid-batch token expiry there would silently
     * fail every subsequent row.
     */
    if (res.status === 401 || res.status === 403) {
        try {
            token_holder[0] = await aspace.get_session_token();
            res = await aspace.get_record(row.uri, token_holder[0]);
        } catch (err) {
            const result = await model.mark_failed(row.id, `auth refresh failed: ${err.message}`);
            if (result.outcome === 'dead_lettered') await roll_up(row, 'dead_lettered');
            return;
        }
    }

    if (res.status !== 200 || !res.data) {
        const result = await model.mark_failed(row.id, `ArchivesSpace ${res.status}`);
        if (result.outcome === 'dead_lettered') await roll_up(row, 'dead_lettered');
        return;
    }

    /*
     * Read the current display_record so we can preserve compound
     * parts. get_db_record is injected so tests can stub the read.
     */
    let existing;
    try {
        existing = await get_db_record(row.uuid);
    } catch (err) {
        const result = await model.mark_failed(row.id, `db read failed: ${err.message}`);
        if (result.outcome === 'dead_lettered') await roll_up(row, 'dead_lettered');
        return;
    }
    const payload = build_payload(existing && existing.display_record, res.data);

    try {
        await repo_model.update_metadata_payload(row.uuid, payload);
        await model.mark_updated(row.id);
        /*
         * In v2 we don't push to ES here — the indexer port will. Move
         * the row straight to COMPLETE; the is_updated=1 flag tells
         * the indexer to pick it up.
         */
        await model.mark_complete(row.id);
        await roll_up(row, 'succeeded');
    } catch (err) {
        const result = await model.mark_failed(row.id, `db write failed: ${err.message}`);
        if (result.outcome === 'dead_lettered') await roll_up(row, 'dead_lettered');
    }
}

/*
 * Factory so the entry point can pass in injected deps and tests can
 * substitute fakes for every external surface.
 * Backoff for the first-tick token bootstrap when ArchivesSpace is
 * unreachable. The self-rescheduling loop already prevents overlapping
 * ticks, but without backoff a down AS is re-probed every cadence for the
 * whole outage. Exponential backoff (base→max) caps that at one login
 * attempt per TOKEN_BACKOFF_MAX_MS while still recovering within that window.
 */
const TOKEN_BACKOFF_BASE_MS = 5000;
const TOKEN_BACKOFF_MAX_MS = 60000;

function create_worker({
    aspace = aspace_default,
    get_db_record = require_db_record,
    on_tick = null,
    now = () => Date.now(),
} = {}) {
    let running = false;
    let stopping = false;
    let timer = null;
    let in_flight = Promise.resolve();
    /*
     * Session token. We pull a fresh one at start() and refresh on
     * 401. We ALSO rotate it periodically — see _maybe_rotate_token
     * below — to mitigate AS-side per-session cache buildup that
     * dominates the slow-down curve on multi-hour refreshes.
     */
    const token_holder = [null];
    /*
     * Bootstrap backoff state (see TOKEN_BACKOFF_* above). Only the bootstrap
     * path uses this — the periodic rotation in _maybe_rotate_token has its
     * own recovery (it nulls the token so the next bootstrap re-mints).
     */
    let token_fail_count = 0;
    let token_cooldown_until = 0;
    /*
     * Count of rows claimed since the last token rotation. Each
     * claimed row corresponds to ~1 AS request (occasionally 2 if a
     * 401 forces a mid-request token refresh; we accept the
     * undercount). When this hits the configured threshold, the
     * post-tick rotation fires.
     */
    let requests_since_token_rotation = 0;

    async function tick() {
        if (stopping) return;
        if (!aspace.is_configured()) {
            /*
             * Worker is enabled but ASpace isn't configured. Don't claim
             * rows — the next fetch would fail. The dev/test friendly
             * path: queue entries pile up harmlessly, ready for a real
             * ASpace instance to come online.
             */
            return;
        }
        const cfg = app_config().metadata_worker;

        /*
         * First-tick token bootstrap. We delay until tick() instead of
         * start() so a transient ASpace outage at boot doesn't crash
         * the entry point — the worker just doesn't make progress
         * until ASpace comes back. On failure we back off exponentially
         * (see TOKEN_BACKOFF_* above) rather than re-attempting every
         * cadence for the whole outage.
         */
        if (!token_holder[0]) {
            if (now() < token_cooldown_until) return; // in backoff window
            try {
                token_holder[0] = await aspace.get_session_token();
                token_fail_count = 0;
                token_cooldown_until = 0;
            } catch (err) {
                token_fail_count += 1;
                const delay = Math.min(
                    TOKEN_BACKOFF_BASE_MS * 2 ** (token_fail_count - 1),
                    TOKEN_BACKOFF_MAX_MS
                );
                token_cooldown_until = now() + delay;
                log.warn({
                    event: 'aspace_token_unavailable',
                    attempt: token_fail_count,
                    retry_in_ms: delay,
                    err: err.message,
                });
                return;
            }
        }

        /*
         * Periodic orphan sweep — runs every tick BEFORE we claim
         * new rows. Catches rows that got stuck IN_PROGRESS because
         * a previous tick's fetch hung or the process was killed
         * mid-claim and somehow restarted without our boot-time
         * reset_orphaned (e.g. an in-process worker restart). The
         * threshold (default 300s) is comfortably above the worst-
         * case legitimate per-row processing time (~30s), so we
         * never reset a healthy in-flight claim.
         * 
         * Cheap: indexed query against (status, is_complete); 0
         * affected rows in steady state.
         */
        try {
            const orphan_age = cfg.orphan_reset_seconds > 0 ? cfg.orphan_reset_seconds : 300;
            const swept = await model.reset_orphaned({ older_than_seconds: orphan_age });
            if (swept.affected > 0) {
                log.info({
                    event: 'metadata_orphan_sweep',
                    count: swept.affected,
                    age_seconds: orphan_age,
                });
            }
        } catch (err) {
            /*
             * Sweep failure shouldn't block the tick; log and
             * continue. Worst case is a stuck row stays stuck one
             * more tick.
             */
            log.warn({ event: 'metadata_orphan_sweep_failed', err: err.message });
        }

        let rows;
        try {
            rows = await model.claim_pending(cfg.concurrency);
        } catch (err) {
            log.error({ event: 'metadata_claim_failed', err: err.message });
            return;
        }
        if (rows.length === 0) return;

        log.debug({ event: 'metadata_tick', claimed: rows.length });

        /*
         * Fan out: each row gets its own ASpace round-trip + DB write,
         * running in parallel up to `concurrency`. allSettled because
         * we want every claim to be finalized (success or failure) —
         * never leave a row stuck in IN_PROGRESS.
         */
        in_flight = Promise.allSettled(
            rows.map((r) => process_row(r, aspace, token_holder, get_db_record))
        );
        await in_flight;

        /*
         * Count requests against the rotation threshold. We use the
         * claim count rather than per-request bookkeeping to avoid
         * threading state through process_row — it's a lower bound
         * (under-counts the 401-retry path by one) but that's fine
         * for a periodic-rotation signal.
         */
        requests_since_token_rotation += rows.length;
        await _maybe_rotate_token();

        if (on_tick) on_tick({ claimed: rows.length });
    }

    /*
     * Rotate the AS session token when the per-rotation request
     * counter crosses the configured threshold. Called at the end of
     * each tick. No-op when:
     *   - the feature is disabled (threshold = 0)
     *   - we haven't reached the threshold yet
     *   - we have no current token (the first-tick bootstrap will
     *     mint one fresh on the next tick anyway)
     * 
     * The rotation itself is best-effort:
     *   1. Destroy old token, capped at 2s so a hung AS can't stall
     *      the worker.
     *   2. Mint a fresh token. If THIS fails, we leave token_holder
     *      empty and let the next tick's bootstrap try again. The
     *      counter is always reset (whether or not minting
     *      succeeded) so we don't loop on the same exhausted token
     *      ad infinitum.
     */
    async function _maybe_rotate_token() {
        const cfg = app_config().archivespace;
        const threshold = cfg && cfg.token_rotate_after_requests > 0
            ? cfg.token_rotate_after_requests
            : 0;
        if (threshold === 0) return; // feature disabled
        if (requests_since_token_rotation < threshold) return;
        if (!token_holder[0]) {
            /*
             * Nothing to rotate; reset counter so a future bootstrap
             * can start fresh.
             */
            requests_since_token_rotation = 0;
            return;
        }

        const old_token = token_holder[0];
        log.info({
            event: 'aspace_token_rotating',
            requests_since_rotation: requests_since_token_rotation,
            threshold,
        });

        /*
         * Best-effort destroy, bounded so the worker can't be
         * stalled by an unresponsive AS during rotation.
         */
        try {
            await Promise.race([
                aspace.destroy_session_token(old_token),
                new Promise((resolve) => setTimeout(resolve, 2000)),
            ]);
        } catch (err) {
            log.warn({
                event: 'aspace_token_destroy_failed_on_rotate',
                err: err.message,
            });
        }

        // Mint fresh.
        try {
            token_holder[0] = await aspace.get_session_token();
            log.info({ event: 'aspace_token_rotated' });
        } catch (err) {
            log.warn({
                event: 'aspace_token_rotate_get_failed',
                err: err.message,
            });
            /*
             * Leave token_holder[0] null so the next tick's
             * bootstrap retries. The 401-retry path on process_row
             * also recovers without our help.
             */
            token_holder[0] = null;
        }

        requests_since_token_rotation = 0;
    }

    async function start() {
        if (running) return;
        running = true;
        stopping = false;
        const cfg = app_config().metadata_worker;
        if (!cfg.enabled) {
            log.info({ event: 'metadata_worker_disabled' });
            running = false;
            return;
        }

        // Sweep up after any prior crash before we begin claiming.
        try {
            const reset = await model.reset_orphaned();
            if (reset.affected > 0) {
                log.info({ event: 'metadata_orphans_reset', count: reset.affected });
            }
        } catch (err) {
            log.warn({ event: 'metadata_orphan_reset_failed', err: err.message });
        }

        log.info({
            event: 'metadata_worker_started',
            concurrency: cfg.concurrency,
            poll_ms: cfg.poll_ms,
        });

        /*
         * Self-rescheduling loop. We deliberately avoid setInterval
         * here: with setInterval, when ArchivesSpace is slow and a
         * tick runs longer than `cadence`, the next tick still fires
         * on schedule and runs concurrently with the previous one.
         * That race let `claim_pending(concurrency)` be called twice
         * before the first batch drained, so effective concurrency
         * climbed past the configured cap exactly when AS was already
         * struggling — the opposite of what we want under load.
         * 
         * With setTimeout chained at the end of each tick, the next
         * tick is scheduled only AFTER the current one resolves. The
         * wall-clock cadence becomes max(tick_duration, cfg.poll_ms)
         * instead of cfg.poll_ms; pacing degrades gracefully when AS
         * slows down rather than getting worse.
         */
        const cadence = Math.max(500, cfg.poll_ms);

        async function loop() {
            if (stopping) return;
            try {
                await tick();
            } catch (err) {
                /*
                 * Defensive: tick() catches its own errors, but if a
                 * future change adds a throw we still want it logged
                 * rather than turning into an unhandled rejection.
                 */
                log.error({ event: 'metadata_tick_error', err: err.message });
            }
            if (stopping) return;
            timer = setTimeout(loop, cadence);
            if (timer.unref) timer.unref();
        }

        /*
         * Kick off after a `cadence` delay (matches the old behavior
         * where setInterval's first fire was one cadence after start).
         */
        timer = setTimeout(loop, cadence);
        /*
         * Don't keep the process alive just for the timer — the HTTP
         * server is the keepalive. Without unref(), `npm test` would
         * hang waiting for the worker.
         */
        if (timer.unref) timer.unref();
    }

    async function stop({ timeout_ms = 10000 } = {}) {
        if (!running) return;
        stopping = true;
        if (timer) clearTimeout(timer);
        timer = null;

        /*
         * Wait for the current tick (if any) to finish. Cap at the
         * shutdown deadline so a hung ASpace fetch can't block exit
         * indefinitely.
         */
        try {
            await Promise.race([
                in_flight,
                new Promise((resolve) => setTimeout(resolve, timeout_ms)),
            ]);
        } catch {
            // allSettled never rejects; this is defensive.
        }

        // Best-effort logout — never blocks shutdown longer than 2s.
        if (token_holder[0]) {
            try {
                await Promise.race([
                    aspace.destroy_session_token(token_holder[0]),
                    new Promise((resolve) => setTimeout(resolve, 2000)),
                ]);
            } catch {
                // ignored
            }
            token_holder[0] = null;
        }

        running = false;
        log.info({ event: 'metadata_worker_stopped' });
    }

    return {
        start,
        stop,
        /*
         * Exposed for tests: force a single tick synchronously instead
         * of waiting for the interval timer. Returns the promise so
         * the test can await it.
         */
        tick,
        // Test introspection.
        _is_running() {
            return running;
        },
    };
}

/*
 * Default reader: pulls just enough of the row for the worker to
 * preserve compound_parts during the refresh. Injectable for tests.
 */
async function require_db_record(pid) {
    return require('../repository/model').get(pid);
}

module.exports = { create_worker, build_payload, process_row };
