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
// successes and requeue failures with three UPDATEs total — no
// per-row chatter against either ES or the DB.
//
// Failure modes:
//   - Bulk call throws (transport / auth / cluster red) → requeue ALL
//     claimed pids and bail. The next tick retries.
//   - Bulk returns with some items errored → mark the successes,
//     requeue the failures. Mirrors the single-row behavior: a poison
//     row gets retried indefinitely until its underlying data is fixed.
async function process_batch(rows, es) {
    if (rows.length === 0) return;
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
    const failed_pids = [];
    for (const item of result.items) {
        if (!item.ok) {
            log.warn({ event: 'indexer_row_failed', pid: item.pid, err: item.err });
            failed_pids.push(item.pid);
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
            failed_pids.length
                ? model.requeue_bulk(failed_pids).catch((e) => {
                      log.error({
                          event: 'indexer_requeue_failed',
                          count: failed_pids.length,
                          err: e.message,
                      });
                  })
                : null,
        ].filter(Boolean)
    );
}

function create_worker({ es = es_default, on_tick = null } = {}) {
    let running = false;
    let stopping = false;
    let timer = null;
    let in_flight = Promise.resolve();
    let ensured = false;

    async function tick() {
        if (stopping) return;
        if (!es.is_configured()) return;

        // First tick: ensure the index exists. We try once per
        // start() — if ES is temporarily down the worker keeps
        // ticking and we retry the ensure on each tick until it
        // succeeds. Cheap; idempotent.
        if (!ensured) {
            try {
                await es.ensure_index();
                ensured = true;
            } catch (err) {
                log.warn({ event: 'es_ensure_index_failed', err: err.message });
                return; // skip this tick — no point claiming rows we can't write
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
