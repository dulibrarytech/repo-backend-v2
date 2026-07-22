'use strict';

/*
 * Queue CRUD for the metadata-refresh pipeline. Mirrors v1's
 * import/model.js + import/tasks/metadata_tasks.js but uses the v2
 * async/await + knex pattern.
 * 
 * Lifecycle (status column):
 * 
 *   PENDING        Enqueued, awaiting a worker pickup.
 *   IN_PROGRESS    A worker has claimed the row. If the process dies
 *                  while a row is IN_PROGRESS we reset it back to
 *                  PENDING on the next boot — see reset_orphaned().
 *   RECORD_UPDATED Fetched from ArchivesSpace, tbl_objects written,
 *                  is_updated=1. Not yet "done" because in v1 there
 *                  was also an indexing step here; we keep the state
 *                  for forward compatibility and because the indexer
 *                  port may want to pivot on it.
 *   COMPLETE       Terminal success.
 *   CANCELLED      Terminal — user cancelled before the worker got here.
 * 
 * Flags (boolean columns kept for v1 schema parity):
 * 
 *   is_updated   1 once tbl_objects has been written.
 *   is_indexed   0 in v2 (the indexer runs separately). v1 used it to
 *                gate the ES re-push; we leave it 0 here and let a
 *                future port set it.
 *   is_complete  1 in any terminal state (COMPLETE, CANCELLED, errored).
 *                The worker's primary stop signal.
 */

const { randomUUID } = require('node:crypto');
const validator = require('validator');

const { db_queue, db } = require('../config/db');
const tables = require('../config/db_tables');
const app_config = require('../config/app');
const { NotFoundError, ValidationError } = require('../libs/errors');

const QUEUE = tables.metadata_update_queue;
const OBJECTS = tables.objects;

// Validators ------------------------------------------------------------

function require_pid(pid) {
    if (!pid || typeof pid !== 'string') throw new ValidationError('pid is required');
    if (!validator.isUUID(pid)) throw new ValidationError('pid must be a UUID');
}

function require_batch_uuid(batch_uuid) {
    if (!batch_uuid || typeof batch_uuid !== 'string') {
        throw new ValidationError('batch_uuid is required');
    }
    if (!validator.isUUID(batch_uuid)) {
        throw new ValidationError('batch_uuid must be a UUID');
    }
}

// Enqueue ---------------------------------------------------------------

/*
 * Fetch the object's row and assert it has a usable ASpace URI to refresh
 * against. Returns { pid, uri, object_type } so the caller can decide
 * between single-row and collection expansion.
 */
async function fetch_target(pid) {
    require_pid(pid);
    const row = await db()(OBJECTS)
        .select('pid', 'uri', 'object_type', 'is_active')
        .where({ pid })
        .first();
    if (!row) throw new NotFoundError(`Object ${pid} not found`);
    if (row.is_active !== 1) {
        throw new ValidationError(`Object ${pid} is soft-deleted`);
    }
    if (!row.uri) {
        throw new ValidationError(`Object ${pid} has no ArchivesSpace URI`);
    }
    return row;
}

/*
 * Insert one row per pid. De-duplicates within the request so an array
 * with duplicates yields a clean batch.
 * 
 * `batch_uuid` is optional — if absent, a fresh one is minted (the
 * typical on-demand path). System-refresh enqueues pass an existing
 * batch_uuid so every chunk the producer ships ends up under one
 * rollup row.
 * 
 * `priority` controls drain order at the worker — see claim_pending.
 * On-demand calls leave this at 0; system-refresh calls pass the
 * config priority (5 by default).
 */
async function _insert_batch(rows, { batch_uuid: explicit_uuid, priority = 0 } = {}) {
    if (rows.length === 0) return { batch_uuid: explicit_uuid || null, count: 0 };
    const batch_uuid = explicit_uuid || randomUUID();
    const seen = new Set();
    const unique = rows.filter((r) => {
        if (seen.has(r.uuid)) return false;
        seen.add(r.uuid);
        return true;
    });
    const to_insert = unique.map((r) => ({
        batch_uuid,
        uuid: r.uuid,
        uri: r.uri,
        update_type: r.update_type,
        status: 'PENDING',
        is_updated: 0,
        is_indexed: 0,
        is_complete: 0,
        priority,
        attempts: 0,
    }));
    await db_queue()(QUEUE).insert(to_insert);
    return { batch_uuid, count: to_insert.length };
}

/*
 * System-refresh path — enqueue rows under an existing batch_uuid at
 * the configured system priority. The producer reads chunks of pids
 * from tbl_objects (paced by cursor advancement) and ships them
 * here. No dedup against the rest of the queue: an on-demand refresh
 * for the same pid landing concurrently will result in two queue
 * rows (priority 0 + priority 5); the worker drains them in order
 * and the second is a harmless duplicate refresh. Worth flagging in
 * the operator runbook; not worth blocking on for v1.
 */
async function enqueue_chunk_for_batch({ batch_uuid, rows, priority }) {
    require_batch_uuid(batch_uuid);
    if (!Array.isArray(rows)) throw new ValidationError('rows must be an array');
    return _insert_batch(rows, { batch_uuid, priority });
}

/*
 * Enqueue a refresh for a single object. The PID's row must already be
 * active in tbl_objects and have a non-empty `uri`.
 */
async function enqueue_single(pid) {
    const row = await fetch_target(pid);
    return _insert_batch([{ uuid: row.pid, uri: row.uri, update_type: 'single' }]);
}

/*
 * Enqueue a refresh for just the collection/resource record itself —
 * no member expansion. Sibling to enqueue_collection (whole collection
 * + every member) and enqueue_single (any object, no type check).
 * 
 * Why a dedicated function instead of "just call enqueue_single":
 *   - It enforces object_type === 'collection' so the kabob action on
 *     a collection row can't be coerced into running against a
 *     non-collection pid (defense in depth alongside the UI gating).
 *   - The update_type label is distinct ('collection-record' vs
 *     'single' vs 'collection') so the queue table itself records
 *     which surface the row came from — useful for audit/observability
 *     even though no production code currently filters on it.
 * 
 * Returns the same { batch_uuid, count } shape as enqueue_single.
 */
async function enqueue_collection_record(collection_pid) {
    const collection = await fetch_target(collection_pid);
    if (collection.object_type !== 'collection') {
        throw new ValidationError(`Object ${collection_pid} is not a collection`);
    }
    return _insert_batch([
        { uuid: collection.pid, uri: collection.uri, update_type: 'collection-record' },
    ]);
}

/*
 * Enqueue a refresh for every active member of a collection (plus the
 * collection record itself, mirroring v1). Members without a URI are
 * silently skipped — the worker would error on them anyway, no point
 * queueing them up. The MAX_BULK_PIDS cap is intentionally NOT applied
 * here: collection-scoped refresh is the bulk path, and capping it would
 * require staff to chunk a big collection manually.
 */
async function enqueue_collection(collection_pid) {
    const collection = await fetch_target(collection_pid);
    if (collection.object_type !== 'collection') {
        throw new ValidationError(`Object ${collection_pid} is not a collection`);
    }
    const members = await db()(OBJECTS)
        .select('pid', 'uri', 'object_type')
        .where({ is_member_of_collection: collection_pid, is_active: 1 })
        .whereNot('uri', '')
        .whereNotNull('uri');
    const rows = [
        { uuid: collection.pid, uri: collection.uri, update_type: 'collection' },
        ...members.map((m) => ({
            uuid: m.pid,
            uri: m.uri,
            update_type: 'collection',
        })),
    ];
    return _insert_batch(rows);
}

/*
 * Enqueue an explicit list of pids (the multi-select path from the
 * objects page). Capped by config.metadata_worker.max_batch_pids so the
 * staff UI can't queue 23k records in one click.
 */
async function enqueue_pids(pids) {
    if (!Array.isArray(pids) || pids.length === 0) {
        throw new ValidationError('pids must be a non-empty array');
    }
    const cfg = app_config().metadata_worker;
    if (pids.length > cfg.max_batch_pids) {
        throw new ValidationError(
            `Metadata refresh is capped at ${cfg.max_batch_pids} pids per batch`
        );
    }
    const rows = [];
    for (const pid of pids) {
        const row = await fetch_target(pid);
        rows.push({ uuid: row.pid, uri: row.uri, update_type: 'single' });
    }
    return _insert_batch(rows);
}

// Progress + cancellation -----------------------------------------------

/*
 * Return a snapshot of a batch's progress. Fast: one aggregation query
 * against the (batch_uuid, is_complete, id) index. Used by the polling
 * progress modal so we don't want it to do row scans.
 */
async function get_batch_progress(batch_uuid) {
    require_batch_uuid(batch_uuid);
    const rows = await db_queue()(QUEUE)
        .select('status', 'is_complete', 'error')
        .where({ batch_uuid });
    if (rows.length === 0) {
        throw new NotFoundError(`No batch found for ${batch_uuid}`);
    }
    const total = rows.length;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let in_progress = 0;
    for (const r of rows) {
        if (r.is_complete === 1) {
            completed += 1;
            if (r.status === 'CANCELLED') cancelled += 1;
            else if (r.error) failed += 1;
        } else if (r.status === 'IN_PROGRESS') {
            in_progress += 1;
        }
    }
    const pending = total - completed - in_progress;
    const done = completed === total;
    const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
    return {
        batch_uuid,
        total,
        completed,
        pending,
        in_progress,
        failed,
        cancelled,
        percent,
        /*
         * status: 'in_progress' until every row is_complete=1; 'done'
         * after. The UI distinguishes failed/cancelled by inspecting
         * the counters, not the top-level status.
         */
        status: done ? 'done' : 'in_progress',
    };
}

/*
 * Mark every non-terminal row in a batch as cancelled. The worker will
 * see is_complete=1 next time it queries and skip these. Any rows the
 * worker has ALREADY claimed (status=IN_PROGRESS) will be allowed to
 * finish their ASpace fetch — we don't try to abort an in-flight HTTP
 * request — but the result will be written and then the worker exits
 * the loop because there's nothing left to claim.
 */
async function cancel_batch(batch_uuid) {
    require_batch_uuid(batch_uuid);
    const affected = await db_queue()(QUEUE)
        .where({ batch_uuid, is_complete: 0 })
        .update({ status: 'CANCELLED', is_complete: 1, error: 'User cancelled' });
    return { affected };
}

// Worker-side primitives ------------------------------------------------

/*
 * Claim up to `limit` pending rows for processing. Uses a transaction
 * + UPDATE-then-SELECT pattern that's safe under concurrency: even if
 * two worker ticks fire simultaneously (which shouldn't happen with our
 * single-process worker but is cheap insurance), each row gets claimed
 * by exactly one tick.
 * 
 * Ordering: (priority ASC, id ASC). On-demand rows (priority=0) drain
 * before system-refresh rows (priority=5) so a long-running bulk
 * refresh never starves an operator clicking "refresh this object."
 * Within a priority tier, FIFO via id.
 * 
 * Backoff filter: rows with next_attempt_at in the future are skipped.
 * mark_failed sets that on a retry to give ArchivesSpace breathing
 * room before we hit it again — see mark_failed docstring. The cutoff
 * is computed in JS (new Date()) rather than via SQL date arithmetic
 * so the same query serializes correctly against both MariaDB (prod)
 * and sqlite (tests) under knex.
 * 
 * Returns the claimed rows so the caller can hand them off to the
 * ASpace client.
 */
async function claim_pending(limit) {
    return db_queue().transaction(async (trx) => {
        const now = new Date();
        const candidates = await trx(QUEUE)
            .select('id')
            .where({ status: 'PENDING', is_complete: 0 })
            .andWhere(function () {
                this.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now);
            })
            .orderBy([
                { column: 'priority', order: 'asc' },
                { column: 'id', order: 'asc' },
            ])
            .limit(limit);
        if (candidates.length === 0) return [];
        const ids = candidates.map((c) => c.id);
        /*
         * Bump date_updated so the admin "in-flight" panel can show
         * "claimed N seconds ago". Sqlite + MariaDB both lack a
         * reliable ON UPDATE auto-bump for TIMESTAMP, so we set it
         * explicitly on every transition.
         */
        await trx(QUEUE)
            .whereIn('id', ids)
            .update({ status: 'IN_PROGRESS', date_updated: db_queue().fn.now() });
        return trx(QUEUE)
            .select('id', 'batch_uuid', 'uuid', 'uri', 'update_type', 'priority', 'attempts')
            .whereIn('id', ids);
    });
}

/*
 * Mark a single row as successfully updated. Called after the
 * repository UPDATE succeeds. Keeps status=RECORD_UPDATED so the
 * progress query can distinguish "written to DB" from "fully done"
 * once the indexer port arrives.
 */
async function mark_updated(id) {
    await db_queue()(QUEUE).where({ id }).update({
        status: 'RECORD_UPDATED',
        is_updated: 1,
    });
}

/*
 * Finalize a row in success: mark complete, leave is_indexed=0 (the
 * indexer flips that later).
 */
async function mark_complete(id) {
    await db_queue()(QUEUE).where({ id }).update({
        status: 'COMPLETE',
        is_complete: 1,
        date_updated: db_queue().fn.now(),
    });
}

/*
 * Finalize a row in failure. The error message is truncated to 1000
 * chars to keep the longtext column from blowing up if ASpace ever
 * returns a giant HTML error page.
 * 
 * Retry policy: if the row's attempts so far is below
 * config.metadata_worker.max_attempts (default 3), flip back to
 * PENDING with attempts incremented and `last_error` set; the next
 * tick re-claims it (once next_attempt_at has elapsed). Once attempts
 * reaches the cap, the row goes terminal as DEAD_LETTERED with both
 * `error` (final) and `last_error` set.
 * 
 * Backoff: on a retry we set next_attempt_at = now() + backoff_ms so
 * claim_pending skips the row until then. backoff_ms doubles on each
 * successive failure, capped at retry_max_backoff_ms. Setting
 * retry_base_backoff_ms=0 disables backoff (next_attempt_at stays
 * NULL) — useful in tests that drive mark_failed -> claim_pending
 * back-to-back without wanting to sleep.
 * 
 * Returns { outcome: 'retry' | 'dead_lettered' } so the worker can
 * roll the right counter on the parent batch row (a retry doesn't
 * roll the batch counters — only terminals do).
 */
async function mark_failed(id, message) {
    const text = String(message || 'unknown error').slice(0, 1000);
    const cfg = app_config().metadata_worker;
    const max_attempts = cfg && cfg.max_attempts > 0 ? cfg.max_attempts : 3;
    const row = await db_queue()(QUEUE).select('attempts').where({ id }).first();
    const next_attempts = (row && Number.isFinite(row.attempts) ? row.attempts : 0) + 1;
    if (next_attempts < max_attempts) {
        const update = {
            status: 'PENDING',
            attempts: next_attempts,
            last_error: text,
            is_complete: 0,
            date_updated: db_queue().fn.now(),
        };
        const base_ms = cfg && cfg.retry_base_backoff_ms > 0 ? cfg.retry_base_backoff_ms : 0;
        if (base_ms > 0) {
            /*
             * Exponential: base * 2 ** (n-1). n=1 → base; n=2 → 2×base.
             * Cap at retry_max_backoff_ms so a high max_attempts can't
             * schedule a retry hours into the future. Math.pow on
             * small integers is cheap; no need for a precomputed table.
             */
            const max_ms = cfg.retry_max_backoff_ms > 0 ? cfg.retry_max_backoff_ms : base_ms;
            const backoff_ms = Math.min(base_ms * Math.pow(2, next_attempts - 1), max_ms);
            update.next_attempt_at = new Date(Date.now() + backoff_ms);
        } else {
            /*
             * Explicit null — if a prior retry stamped a value, clear
             * it now so the row is eligible immediately. Matters when
             * an operator flips backoff off mid-run.
             */
            update.next_attempt_at = null;
        }
        await db_queue()(QUEUE).where({ id }).update(update);
        return { outcome: 'retry', attempts: next_attempts };
    }
    await db_queue()(QUEUE).where({ id }).update({
        status: 'DEAD_LETTERED',
        attempts: next_attempts,
        error: text,
        last_error: text,
        is_complete: 1,
        date_updated: db_queue().fn.now(),
    });
    return { outcome: 'dead_lettered', attempts: next_attempts };
}

/*
 * Reset IN_PROGRESS rows back to PENDING. Two use sites:
 * 
 *   1. Called once at worker boot (no args / older_than_seconds=0)
 *      to clean up after a crash: any row the worker had claimed but
 *      not finished gets re-queued for another try.
 * 
 *   2. Called every worker tick with older_than_seconds=300 to
 *      sweep up rows that have been IN_PROGRESS suspiciously long.
 *      Catches the "process didn't crash, but the fetch hung" case
 *      where a row sits IN_PROGRESS forever without the boot-time
 *      reset ever firing.
 * 
 * Idempotent — safe to call repeatedly. We compute the cutoff in
 * JS (not via SQL date arithmetic) so the same query works on
 * MariaDB in prod and sqlite in tests; knex serializes a Date to
 * the right wire format for each driver.
 */
async function reset_orphaned({ older_than_seconds = 0 } = {}) {
    let q = db_queue()(QUEUE).where({ status: 'IN_PROGRESS', is_complete: 0 });
    if (older_than_seconds > 0) {
        const cutoff = new Date(Date.now() - older_than_seconds * 1000);
        q = q.where('date_updated', '<', cutoff);
    }
    /*
     * Clear next_attempt_at — an orphaned row got stuck during a
     * legitimate in-flight claim, not as part of a retry backoff, so
     * it should be eligible immediately on the next claim cycle. Not
     * clearing it would leave a stale future-dated value on rows that
     * were retried, then claimed, then orphaned — they'd be invisible
     * to claim_pending until the old backoff timer expired.
     */
    const affected = await q.update({ status: 'PENDING', next_attempt_at: null });
    return { affected };
}

/*
 * Hard-delete every row in a batch. Used by tests; never by routes.
 * (We never delete in production — the audit trail of completed rows
 * is small and useful.)
 */
async function _purge(batch_uuid) {
    return db_queue()(QUEUE).where({ batch_uuid }).del();
}

module.exports = {
    enqueue_single,
    enqueue_collection,
    enqueue_collection_record,
    enqueue_pids,
    enqueue_chunk_for_batch,
    get_batch_progress,
    cancel_batch,
    claim_pending,
    mark_updated,
    mark_complete,
    mark_failed,
    reset_orphaned,
    _purge,
};
