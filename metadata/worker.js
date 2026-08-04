'use strict';

/*
 * In-process metadata-refresh worker.
 * 
 * One worker instance per process. Polls the queue every `poll_ms`,
 * claims up to `concurrency` PENDING rows per tick, fans out the
 * ArchivesSpace fetches in parallel, then writes results to tbl_objects
 * and finalizes each row's queue state.
 *
 * One global worker serves every open batch, so a single semaphore caps
 * upstream ArchivesSpace load.
 *
 * Crash recovery: start() calls model.reset_orphaned(), returning any
 * IN_PROGRESS rows to PENDING, so a kill -9 mid-fetch loses about one
 * fetch-window of work.
 */

const app_config = require('../config/app');
const log = require('../libs/log');
const aspace_default = require('../libs/archivesspace');
const repo_model = require('../repository/model');
const display_envelope = require('../libs/display_envelope');
const model = require('./model');
const batches = require('./batches');

/*
 * Build the tbl_objects write from an ASpace metadata response:
 * `mods`, the denormalized `display_record` envelope, and the derived
 * `compound_parts` / `is_compound` fields.
 *
 * `existing_row` is the current tbl_objects row (repository/model.get
 * shape). The envelope is REBUILT from scratch via libs/display_envelope
 * so a refresh re-derives every denormalized top-level field (title,
 * creator, f_subjects, type, …) instead of fossilizing the old ones —
 * and so it heals thin pre-consolidation envelopes. The ASpace fetch
 * carries no DuraCloud paths (those are local DIP data), so object/
 * thumbnail per part are recovered from the previous envelope's parts.
 */
function build_payload(existing_row, metadata) {
    const row = existing_row && typeof existing_row === 'object' ? existing_row : {};
    let old_envelope = {};
    if (row.display_record) {
        try {
            const parsed =
                typeof row.display_record === 'string'
                    ? JSON.parse(row.display_record)
                    : row.display_record;
            if (parsed && typeof parsed === 'object') old_envelope = parsed;
        } catch {
            /* Corrupt prior display_record — rebuild without path data. */
        }
    }

    /*
     * DuraCloud object/thumbnail source, in either prior shape:
     *   - thin envelope: the METS/DIP list at the top level, usable as-is
     *   - fat envelope: the merged manifest at display_record.parts,
     *     mapped back to the DIP shape merge_parts consumes
     */
    let dip_parts = [];
    if (display_envelope.is_dip_parts(old_envelope.parts)) {
        dip_parts = old_envelope.parts;
    } else {
        const prior =
            old_envelope.display_record && Array.isArray(old_envelope.display_record.parts)
                ? old_envelope.display_record.parts
                : [];
        dip_parts = prior
            .filter((p) => p && (p.object || p.thumbnail))
            .map((p) => ({
                file: p.title,
                mime_type: p.type,
                type: 'object',
                object: p.object,
                thumbnail: p.thumbnail,
                kaltura_id: p.kaltura_id,
            }));
    }

    /*
     * A fresh fetch that carries no parts (older exporter output) must
     * not lose the prior manifest: fall back to the previous inner parts
     * for order/title/MIME/kaltura_id — merge_parts reunites them with
     * the DuraCloud paths recovered above.
     */
    let metadata_for_envelope = metadata;
    if (
        (!Array.isArray(metadata && metadata.parts) || metadata.parts.length === 0) &&
        old_envelope.display_record &&
        Array.isArray(old_envelope.display_record.parts) &&
        old_envelope.display_record.parts.length > 0
    ) {
        metadata_for_envelope = { ...metadata, parts: old_envelope.display_record.parts };
    }

    /*
     * ASpace's explicit is_compound wins; when silent, keep the row's
     * current value (the parts list alone can't distinguish a compound
     * whose siblings failed to export).
     */
    const is_compound =
        metadata && metadata.is_compound === true
            ? 1
            : metadata && metadata.is_compound === false
              ? 0
              : row.is_compound
                ? 1
                : 0;

    const built = display_envelope.build_envelope({
        pid: row.pid,
        is_member_of_collection: row.is_member_of_collection,
        handle: row.handle,
        is_published: row.is_published,
        is_compound,
        metadata: metadata_for_envelope,
        dip_parts,
    });
    /*
     * A custom-uploaded thumbnail lives in the column as an absolute URL
     * (set_thumbnail); it must survive a metadata refresh rather than be
     * replaced by the derived DIP path.
     */
    if (typeof row.thumbnail === 'string' && /^https?:\/\//i.test(row.thumbnail)) {
        built.envelope.thumbnail = row.thumbnail;
    }
    return {
        mods: JSON.stringify(metadata),
        display_record: JSON.stringify(built.envelope),
        compound_parts: built.compound_parts,
        is_compound,
    };
}

/*
 * Whether a queue row belongs to a system-refresh batch, deciding
 * whether a terminal transition rolls up per-batch counters. Any row
 * with a matching batches row counts, including cancelled batches, so
 * their in-flight rows are still accounted for as the worker drains.
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
 * One end-to-end process step for a single claimed row; the worker loop
 * runs `concurrency` of these in parallel. Returns nothing — all state
 * lives in the DB.
 *
 * `token_holder` is a mutable single-element array, so a 401-driven
 * refresh updates the token shared by concurrent fetches in the tick.
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

    /* On 401/403, refresh the token and retry once. */
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
    const payload = build_payload(existing, res.data);

    try {
        await repo_model.update_metadata_payload(row.uuid, payload);
        await model.mark_updated(row.id);
        /*
         * No ES push here — is_updated=1 tells the indexer to pick the
         * row up on its next tick.
         */
        await model.mark_complete(row.id);
        await roll_up(row, 'succeeded');
    } catch (err) {
        const result = await model.mark_failed(row.id, `db write failed: ${err.message}`);
        if (result.outcome === 'dead_lettered') await roll_up(row, 'dead_lettered');
    }
}

/*
 * Exponential backoff for the first-tick token bootstrap when
 * ArchivesSpace is unreachable, capping login attempts at one per
 * TOKEN_BACKOFF_MAX_MS for the duration of an outage.
 */
const TOKEN_BACKOFF_BASE_MS = 5000;
const TOKEN_BACKOFF_MAX_MS = 60000;

/*
 * Build a worker. Every external surface is injectable so tests can
 * substitute fakes.
 */
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
     * Session token: minted at start(), refreshed on 401, and rotated
     * periodically by _maybe_rotate_token below.
     */
    const token_holder = [null];
    /*
     * Bootstrap backoff state (TOKEN_BACKOFF_* above). Bootstrap only —
     * _maybe_rotate_token recovers by nulling the token so the next
     * bootstrap re-mints.
     */
    let token_fail_count = 0;
    let token_cooldown_until = 0;
    /*
     * Rows claimed since the last token rotation, each roughly one AS
     * request. At the configured threshold the post-tick rotation fires.
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
         * First-tick token bootstrap, deferred to tick() rather than
         * start() so an ASpace outage at boot does not crash the entry
         * point. Failures back off exponentially (TOKEN_BACKOFF_*).
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
         * Orphan sweep, before claiming new rows: resets rows stuck
         * IN_PROGRESS longer than orphan_reset_seconds.
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
            /* A sweep failure must not block the tick. */
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
         * Fan out one ASpace round-trip + DB write per row, in parallel
         * up to `concurrency`. allSettled so every claim is finalized
         * and no row is left stuck at IN_PROGRESS.
         */
        in_flight = Promise.allSettled(
            rows.map((r) => process_row(r, aspace, token_holder, get_db_record))
        );
        await in_flight;

        /*
         * Count claims, not requests, against the rotation threshold —
         * a lower bound, since the 401-retry path under-counts by one.
         */
        requests_since_token_rotation += rows.length;
        await _maybe_rotate_token();

        if (on_tick) on_tick({ claimed: rows.length });
    }

    /*
     * Rotate the AS session token once the request counter crosses the
     * configured threshold. Called at the end of each tick; a no-op
     * when the threshold is 0, not yet reached, or no token is held.
     *
     * Best-effort: destroys the old token (capped at 2s) then mints a
     * fresh one. A failed mint leaves token_holder empty for the next
     * tick's bootstrap. The counter resets either way.
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
