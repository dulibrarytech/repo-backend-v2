'use strict';

// In-process Elasticsearch indexer.
//
// Same pattern as metadata/worker.js: one global worker, one polling
// loop, bounded batch size. The differences are domain-specific:
//
//   - No external auth flow (ES doesn't need a token round-trip per
//     request like ArchivesSpace did).
//   - Eligibility is computed per row, not enqueued ahead of time:
//     a row that's is_updated=1 might be INDEXED (eligible) or
//     DELETED (ineligible) depending on its current flags.
//   - Each tick issues ONE ES `_bulk` call covering all claimed rows,
//     not N parallel single-doc calls. ES bulk handles partial
//     failures per item, so per-row error handling is preserved.
//     `concurrency` is therefore really "batch size" now — kept under
//     the old name to avoid breaking INDEXER_CONCURRENCY env vars.
//   - On failure we requeue (is_updated=1) so the next poll retries.
//     There's no concept of a "permanent failure" here; if ES is down
//     the rows just sit dirty until it's back.
//
// Boot sequence:
//   1. start() ensures the index exists (idempotent).
//   2. Sets up the interval.
//   3. Each tick claims up to `concurrency` rows and writes them in
//      one bulk call.
//
// On shutdown we wait for the current in-flight tick to drain
// (capped at 8s) so a single in-flight ES write isn't abandoned.

const app_config = require('../config/app');
const log = require('../libs/log');
const es_default = require('../libs/elasticsearch');
const projection = require('../libs/object_projection');
const model = require('./model');

// Decide what to do with each claimed row and shape an ES bulk op.
//   eligible (published + active)  → index op carrying the projection
//   ineligible                     → delete op (removes from ES if present)
function build_op(row) {
    const eligible = row.is_published === 1 && row.is_active === 1;
    if (eligible) {
        const dr = projection.parse_display_record(row.display_record);
        const body = es_default.project_for_index(row, dr);
        return { op: 'index', pid: row.pid, body };
    }
    return { op: 'delete', pid: row.pid };
}

// Batch processing. One ES `_bulk` call per tick covering every row
// claimed by claim_dirty. ES returns per-item results, so we can mark
// successes and requeue/dead-letter failures with a few UPDATEs total —
// no per-row chatter against either ES or the DB.
//
// Failure modes (the distinction matters for the dead-letter cap):
//   - Bulk call throws (transport / auth / cluster red) → the rows are
//     blameless, so requeue ALL claimed pids WITHOUT penalty (no attempt
//     increment) and bail. The next tick retries. An ES outage must not
//     dead-letter the whole queue.
//   - Bulk returns with some items errored → mark the successes, and hand
//     the per-item failures to model.record_failures, which increments
//     each row's attempt counter and, once it exhausts INDEXER_MAX_ATTEMPTS,
//     DEAD-LETTERS the row (parks it with index_error set) instead of
//     re-failing every poll forever. Dead-letters are logged ONCE here.
async function process_batch(rows, es) {
    if (rows.length === 0) return;
    const cfg = app_config().indexer;
    const ops = rows.map(build_op);
    let result;
    try {
        result = await es.bulk_write(ops);
    } catch (err) {
        log.warn({ event: 'indexer_bulk_failed', count: rows.length, err: err.message });
        await model.requeue_bulk(rows.map((r) => r.pid)).catch((e) => {
            log.error({ event: 'indexer_requeue_failed', count: rows.length, err: e.message });
        });
        return;
    }
    const indexed_pids = [];
    const deindexed_pids = [];
    const failed = [];
    for (const item of result.items) {
        if (!item.ok) {
            log.warn({ event: 'indexer_row_failed', pid: item.pid, err: item.err });
            failed.push({ pid: item.pid, err: item.err });
        } else if (item.op === 'index') {
            indexed_pids.push(item.pid);
        } else {
            deindexed_pids.push(item.pid);
        }
    }
    await Promise.all(
        [
            indexed_pids.length ? model.mark_indexed_bulk(indexed_pids) : null,
            deindexed_pids.length ? model.mark_deindexed_bulk(deindexed_pids) : null,
            failed.length
                ? model
                      .record_failures(failed, { max_attempts: cfg.max_attempts })
                      .then((r) => {
                          if (r.dead_lettered.length) {
                              // Logged once: a dead-lettered row isn't re-
                              // claimed, so this won't repeat every poll the
                              // way the old unbounded requeue did.
                              log.error({
                                  event: 'indexer_row_dead_lettered',
                                  count: r.dead_lettered.length,
                                  pids: r.dead_lettered,
                                  max_attempts: cfg.max_attempts,
                              });
                          }
                      })
                      .catch((e) => {
                          log.error({
                              event: 'indexer_requeue_failed',
                              count: failed.length,
                              err: e.message,
                          });
                      })
                : null,
        ].filter(Boolean)
    );
}

// Backoff for the first-tick ensure_index when ES is unreachable. Without
// it, a down ES is re-probed every tick at the client's ~10s connect timeout
// — a log + connection flood for the whole outage (the symptom that motivated
// this). We retry with exponential backoff (base→max) so a persistent outage
// is probed at most once per ENSURE_BACKOFF_MAX_MS, while recovery is still
// detected within that window. When ES is healthy this is a no-op: ensure
// succeeds on the first tick and never runs again.
const ENSURE_BACKOFF_BASE_MS = 5000;
const ENSURE_BACKOFF_MAX_MS = 60000;

function create_worker({ es = es_default, on_tick = null, now = () => Date.now() } = {}) {
    let running = false;
    let stopping = false;
    let timer = null;
    let in_flight = Promise.resolve();
    let ensured = false;
    // ensure_index backoff state (see ENSURE_BACKOFF_* above). `ensuring`
    // serializes the attempt so two overlapping ticks can't both fire the
    // ~10s call; the cooldown gates retries after a failure.
    let ensure_fail_count = 0;
    let ensure_cooldown_until = 0;
    let ensuring = false;

    async function tick() {
        if (stopping) return;
        if (!es.is_configured()) return;

        // First tick: ensure the index exists (idempotent). If ES is down we
        // retry on a later tick, but with exponential backoff — not every
        // tick — so a persistent outage doesn't flood logs/connections with
        // a ~10s-timeout attempt each cycle. See ENSURE_BACKOFF_* above.
        if (!ensured) {
            // Skip while another tick's ensure is in flight, or during the
            // post-failure cooldown window.
            if (ensuring || now() < ensure_cooldown_until) return;
            ensuring = true;
            try {
                await es.ensure_index();
                ensured = true;
                ensure_fail_count = 0;
                ensure_cooldown_until = 0;
            } catch (err) {
                ensure_fail_count += 1;
                const delay = Math.min(
                    ENSURE_BACKOFF_BASE_MS * 2 ** (ensure_fail_count - 1),
                    ENSURE_BACKOFF_MAX_MS
                );
                ensure_cooldown_until = now() + delay;
                log.warn({
                    event: 'es_ensure_index_failed',
                    attempt: ensure_fail_count,
                    retry_in_ms: delay,
                    err: err.message,
                });
                return; // skip this tick — no point claiming rows we can't write
            } finally {
                ensuring = false;
            }
        }

        const cfg = app_config().indexer;
        let rows;
        try {
            rows = await model.claim_dirty(cfg.concurrency);
        } catch (err) {
            log.error({ event: 'indexer_claim_failed', err: err.message });
            return;
        }
        if (rows.length === 0) return;

        log.debug({ event: 'indexer_tick', claimed: rows.length });
        in_flight = process_batch(rows, es);
        await in_flight;
        if (on_tick) on_tick({ claimed: rows.length });
    }

    async function start() {
        if (running) return;
        running = true;
        stopping = false;
        const cfg = app_config().indexer;
        if (!cfg.enabled) {
            log.info({ event: 'indexer_disabled' });
            running = false;
            return;
        }
        log.info({
            event: 'indexer_started',
            concurrency: cfg.concurrency,
            poll_ms: cfg.poll_ms,
        });
        const cadence = Math.max(500, cfg.poll_ms);
        timer = setInterval(() => {
            tick().catch((err) => log.error({ event: 'indexer_tick_error', err: err.message }));
        }, cadence);
        if (timer.unref) timer.unref();
    }

    async function stop({ timeout_ms = 8000 } = {}) {
        if (!running) return;
        stopping = true;
        if (timer) clearInterval(timer);
        timer = null;
        try {
            await Promise.race([
                in_flight,
                new Promise((resolve) => setTimeout(resolve, timeout_ms)),
            ]);
        } catch {
            // allSettled never rejects; defensive
        }
        running = false;
        log.info({ event: 'indexer_stopped' });
    }

    return {
        start,
        stop,
        tick,
        _is_running: () => running,
    };
}

module.exports = { create_worker, process_batch, build_op };
