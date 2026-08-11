'use strict';

/*
 * AIP backfill — admin-initiated catch-up for objects that ingested
 * BEFORE Stage 6 existed (or with AIP_STORE_ENABLED=false).
 * 
 * Premise: tbl_objects has rows that DO have an Archivematica
 * sip_uuid but DON'T have a matching tbl_aip_store success row.
 * These are AIPs that AM produced and DuraCloud has, but Wasabi
 * doesn't. Stage 6 (ingester/stages/aip_store.js) already knows how
 * to do the copy — it reads `sip_uuid` from an ingest_queue row,
 * calls the curation /copy-to-wasabi endpoint, and writes the
 * tbl_aip_store row. All we need is a way to feed it those PIDs.
 * 
 * Approach: synthetic ingest_queue rows.
 * 
 *   - One row per eligible tbl_objects.pid
 *   - batch = 'aip-backfill-<batch_uuid>' so the regular ingest-queue
 *     view can filter them out and the admin page can find them
 *   - pipeline_state = 'AIP_STORE_PENDING' so the worker routes
 *     them to Stage 6 on its next tick
 *   - sip_uuid copied from tbl_objects so Stage 6 knows which AM
 *     package to fetch
 *   - filler values for the other NOT NULL queue columns; they're
 *     never used because Stage 6 only reads sip_uuid + pipeline_state
 * 
 * Why synthetic rows over a separate backfill queue: Stage 6 + the
 * ingest worker + dashboard timeline / status_metadata / cancel hook
 * all already work against ingest_queue. Reusing it means zero new
 * worker code; the only new code is enqueue + the admin status query.
 * 
 * Cap: at most `cfg.aip_store.backfill_chunk_size` rows enqueued per
 * call (default 1000). Operators run "Start backfill" repeatedly to
 * chew through a large catch-up — keeps the queue table bounded and
 * gives the worker time to drain before more pile up. The chunk is
 * taken in tbl_objects.id ASC order so successive runs make forward
 * progress without re-scanning the same tail.
 */

const { randomUUID } = require('node:crypto');

const { db, db_queue } = require('../config/db');
const tables = require('../config/db_tables');
const app_config = require('../config/app');
const aip_store_model = require('../repository/aip_store_model');
const { ValidationError } = require('../libs/errors');

const QUEUE = tables.ingest_queue;
const OBJECTS = tables.objects;
const AIP_STORE = tables.aip_store;

/*
 * Marker prefix on ingest_queue.batch for backfill rows. The default
 * ingest-queue dashboard filters out anything with this prefix so
 * staff don't see synthetic rows mixed in with real ingest jobs;
 * the admin backfill page reads them via this prefix.
 */
const BACKFILL_BATCH_PREFIX = 'aip-backfill-';

/*
 * "Eligible" predicate — applied identically by count_missing_aips()
 * and enqueue_backfill_batch() so the two queries can't disagree
 * about which rows qualify.
 * 
 * A row is eligible IFF:
 *   1. tbl_objects.object_type = 'object'         (collections have NO
 *      AIP — AM never packages them — but they carry their own pid in
 *      sip_uuid, so without this filter each one would enter the queue
 *      and burn the full not-found attempt budget before being tagged
 *      a false orphan)
 *   2. tbl_objects.is_active = 1                  (not soft-deleted)
 *   3. tbl_objects.sip_uuid is a real value       (Stage 6 needs it)
 *   4. NOT EXISTS a tbl_aip_store row for the pid that's already in
 *      a "we've definitively decided this row's fate" state:
 *        - legacy migrated OK (5)
 *        - v2 ingest copied OK (6)
 *        - AM not found / orphan (8) — no retry can fix this; we
 *          don't want to keep re-enqueuing known orphans on every
 *          backfill click
 *      Other failure states (2, 3, 7) DO keep the row eligible
 *      because they're retry-recoverable (transient curation /
 *      Wasabi / AM-5xx errors).
 *
 * This makes the backfill idempotent + skips dead-end orphans.
 */
function _apply_eligible_filter(q) {
    q.from(`${OBJECTS} as o`)
        .leftJoin(`${AIP_STORE} as a`, function () {
            /*
             * Treat success codes AND orphan code as "already decided" —
             * a row matching any of these joins to a non-null `a.id`
             * and gets filtered out by the whereNull below.
             */
            this.on('a.uuid', '=', 'o.pid').andOnIn('a.is_migrated', [
                aip_store_model.STATUS.LEGACY_MIGRATED_OK,
                aip_store_model.STATUS.INGEST_COPIED_OK,
                aip_store_model.STATUS.AM_NOT_FOUND,
            ]);
        })
        .where('o.object_type', 'object')
        .where('o.is_active', 1)
        .whereNotNull('o.sip_uuid')
        .whereNot('o.sip_uuid', '')
        .whereNot('o.sip_uuid', 'PENDING')
        .whereNull('a.id');
    return q;
}

/*
 * sip_uuids that already have a LIVE Stage 6 queue row (PENDING or
 * IN_PROGRESS, not complete). Objects matching these are excluded
 * from eligibility so clicking Start while a prior batch is still
 * draining cannot mint duplicate queue rows for the same AIPs
 * (2026-08-07 — previously each re-click duplicated the in-flight
 * set and the duplicates either drained as no-ops or, if the batch
 * was cancelled, sat forever inflating the status counts).
 *
 * Deliberately NOT restricted to backfill batches: a real ingest
 * currently at Stage 6 is about to copy its own AIP, so enqueuing a
 * backfill row for it would be the same duplication. Deliberately
 * NOT including AIP_STORE_FAILED rows (is_complete=0): those have
 * exhausted their retries and never drain on their own — they must
 * stay eligible or one failed batch would block its AIPs from every
 * future backfill. Cancelled rows are is_complete=1, so a cancelled
 * batch's AIPs become eligible again immediately — cancel + Start
 * is the supported "re-run it" flow.
 *
 * Lives on the queue DB connection, so callers stitch it into the
 * objects-DB query as a plain value list (no cross-DB join exists).
 */
async function _live_stage6_sip_uuids() {
    const rows = await db_queue()(QUEUE)
        .whereIn('pipeline_state', ['AIP_STORE_PENDING', 'AIP_STORE_IN_PROGRESS'])
        .andWhere({ is_complete: 0 })
        .distinct('sip_uuid');
    return rows.map((r) => r.sip_uuid).filter(Boolean);
}

/*
 * Mutate an eligible-rows query to also exclude the live-queue set —
 * applied identically by count/preview/enqueue so the three can't
 * disagree about what "eligible" means.
 *
 * Deliberately returns nothing: knex builders are thenables, so
 * returning one from an async function makes the caller's `await`
 * EXECUTE the query instead of receiving the builder.
 */
async function _apply_live_exclusion(q) {
    const live = await _live_stage6_sip_uuids();
    if (live.length > 0) q.whereNotIn('o.sip_uuid', live);
}

/*
 * Total count of eligible rows — drives the admin page's "N AIPs
 * missing" header before the operator clicks Start. Excludes AIPs
 * already queued or in flight (see _live_stage6_sip_uuids), so the
 * headline is "missing AND not already being handled" — it matches
 * exactly what the next Start click would take on. Returns a plain
 * number.
 */
async function count_missing_aips() {
    const q = _apply_eligible_filter(db()(OBJECTS));
    await _apply_live_exclusion(q);
    const row = await q.count({ n: 'o.id' }).first();
    return row ? Number(row.n) : 0;
}

/*
 * Preview the next chunk that Start would enqueue, without writing
 * anything. Used by the admin page to show the operator what they're
 * about to commit. Returns the rows (pid + sip_uuid) capped at
 * `chunk_size`.
 */
async function preview_next_chunk(chunk_size) {
    const limit = _resolve_chunk_size(chunk_size);
    const q = _apply_eligible_filter(db()(OBJECTS));
    await _apply_live_exclusion(q);
    return q
        .select({ pid: 'o.pid', sip_uuid: 'o.sip_uuid' })
        .orderBy('o.id', 'asc')
        .limit(limit);
}

/*
 * Enqueue up to `chunk_size` eligible rows as Stage 6-ready
 * ingest_queue entries. Returns:
 *   { batch_uuid, batch_marker, count }
 * 
 * batch_uuid is the UUID that distinguishes this backfill invocation;
 * batch_marker is the full `batch` column value written to each row
 * (`<BACKFILL_BATCH_PREFIX><batch_uuid>`); count is how many rows
 * landed.
 *
 * Idempotent against an in-flight prior backfill (2026-08-07): the
 * eligibility check excludes sip_uuids that already have a live
 * Stage 6 queue row (see _live_stage6_sip_uuids), so re-clicking
 * Start before the prior chunk drains enqueues only AIPs the queue
 * is NOT already handling — never duplicates. AIPs whose rows were
 * cancelled or exhausted their retries (AIP_STORE_FAILED) are NOT
 * excluded; a new Start picks them up again by design.
 */
async function enqueue_backfill_batch({ chunk_size, actor = '' } = {}) {
    const limit = _resolve_chunk_size(chunk_size);
    const eligible = _apply_eligible_filter(db()(OBJECTS));
    await _apply_live_exclusion(eligible);
    const candidates = await eligible
        .select({ pid: 'o.pid', sip_uuid: 'o.sip_uuid' })
        .orderBy('o.id', 'asc')
        .limit(limit);
    if (candidates.length === 0) {
        return { batch_uuid: null, batch_marker: null, count: 0 };
    }
    const batch_uuid = randomUUID();
    const batch_marker = `${BACKFILL_BATCH_PREFIX}${batch_uuid}`;

    /*
     * Fill the NOT NULL columns the ingest_queue schema requires.
     * None of these values are read by Stage 6 — sip_uuid is the
     * only one that matters. We stamp `actor` into the error column
     * so the timeline payload's audit trail can attribute the
     * backfill to the operator that started it; that's a slight
     * abuse of the error column, but it survives without a schema
     * change and Stage 6 overwrites it on the first run.
     */
    const rows = candidates.map((c) => ({
        package: 'AIP_BACKFILL',
        batch: batch_marker,
        collection_uuid: 'AIP_BACKFILL',
        sip_uuid: c.sip_uuid,
        status: 'AIP_STORE_PENDING',
        pipeline_state: 'AIP_STORE_PENDING',
        is_complete: 0,
        /*
         * Stash the originating actor in the error column so the
         * dashboard can show who kicked off the batch. Stage 6 will
         * overwrite this on success/failure.
         */
        error: actor ? `backfill_by:${actor}` : null,
    }));
    await db_queue()(QUEUE).insert(rows);
    return { batch_uuid, batch_marker, count: rows.length };
}

/*
 * Counts for the admin page's status panel, scoped to the LATEST
 * batch (2026-08-07 — previously every historical batch was counted
 * forever, so the total grew by chunk_size on each cancel + Start
 * cycle and cancelled rows silently padded it without appearing in
 * any per-state counter). Returns shape:
 *   {
 *     total_backfill_rows,        // rows in the latest batch
 *     pending,
 *     in_progress,
 *     complete,
 *     failed,
 *     cancelled,
 *     latest_batch_marker | null,
 *     latest_batch_started_at | null,
 *     top_failure_reasons: [{ reason, count }, ...] (up to 3),
 *   }
 * with total = pending + in_progress + complete + failed + cancelled.
 * With no batches yet, everything is zero/null.
 *
 * Two bounded queries: a LIMIT-1 tail for the latest marker + one
 * GROUP BY over that batch's rows. Cheap enough to poll every 2s.
 *
 * top_failure_reasons is the dominant signal an operator needs when
 * triaging a failed backfill — "is curation reachable", "is AIP_BUCKET
 * configured", "is AM responding". We bucket queue.error text and
 * surface the top three — also scoped to the latest batch, so stale
 * reasons from long-fixed problems don't haunt the panel.
 */
async function get_status() {
    const summary = {
        total_backfill_rows: 0,
        pending: 0,
        in_progress: 0,
        complete: 0,
        failed: 0,
        cancelled: 0,
        latest_batch_marker: null,
        latest_batch_started_at: null,
        top_failure_reasons: [],
    };

    /*
     * Find the most recent batch_marker first — it scopes everything
     * else. Bounded by LIMIT 1 so this stays O(1) on the (batch,
     * created) index even with hundreds of historical batches; id is
     * the tiebreaker for same-second inserts across batches.
     */
    const latest = await db_queue()(QUEUE)
        .where('batch', 'like', `${BACKFILL_BATCH_PREFIX}%`)
        .orderBy([
            { column: 'created', order: 'desc' },
            { column: 'id', order: 'desc' },
        ])
        .select('batch', 'created')
        .first();
    if (!latest) return summary;
    summary.latest_batch_marker = latest.batch;
    summary.latest_batch_started_at = latest.created;

    const rows = await db_queue()(QUEUE)
        .where({ batch: latest.batch })
        .select('pipeline_state', 'is_complete')
        .select(db_queue().raw('COUNT(*) as n'))
        .groupBy('pipeline_state', 'is_complete');

    for (const r of rows) {
        const n = Number(r.n);
        summary.total_backfill_rows += n;
        if (r.pipeline_state === 'AIP_STORE_COMPLETE' && r.is_complete === 1) {
            summary.complete += n;
        } else if (r.pipeline_state === 'AIP_STORE_FAILED') {
            summary.failed += n;
        } else if (r.pipeline_state === 'AIP_STORE_IN_PROGRESS') {
            summary.in_progress += n;
        } else if (r.pipeline_state === 'AIP_STORE_PENDING') {
            summary.pending += n;
        } else if (r.pipeline_state === 'CANCELLED_BY_USER') {
            summary.cancelled += n;
        }
    }

    if (summary.failed > 0) {
        const failed_rows = await db_queue()(QUEUE)
            .where({ batch: latest.batch })
            .andWhere({ pipeline_state: 'AIP_STORE_FAILED' })
            .select('error');
        const buckets = new Map();
        for (const r of failed_rows) {
            if (!r.error) continue;
            /*
             * First 80 chars + token-normalize any UUIDs to <uuid> so
             * per-row uuids don't fragment buckets.
             */
            const key = r.error
                .slice(0, 80)
                .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
            buckets.set(key, (buckets.get(key) || 0) + 1);
        }
        summary.top_failure_reasons = [...buckets.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([reason, count]) => ({ reason, count }));
    }

    return summary;
}

/*
 * Cancel a backfill — flips every still-pending row in the batch to
 * a terminal CANCELLED state so the worker skips them. In-flight
 * rows (AIP_STORE_IN_PROGRESS) are NOT aborted; their Wasabi upload
 * continues until the curation call returns. We can't kill an HTTP
 * stream mid-flight, and a half-uploaded multipart on Wasabi would
 * be wasted bytes anyway — let it finish, then the worker drains.
 * 
 * Returns { cancelled: number } — count of rows we actually flipped.
 */
async function cancel_backfill(batch_marker) {
    if (!batch_marker || !batch_marker.startsWith(BACKFILL_BATCH_PREFIX)) {
        throw new ValidationError(
            'batch_marker must start with ' + BACKFILL_BATCH_PREFIX
        );
    }
    const affected = await db_queue()(QUEUE)
        .where({ batch: batch_marker, pipeline_state: 'AIP_STORE_PENDING' })
        .update({
            status: 'CANCELLED_BY_USER',
            pipeline_state: 'CANCELLED_BY_USER',
            is_complete: 1,
            error: 'cancelled by operator',
        });
    return { cancelled: affected };
}

/*
 * Resolve chunk size from config; clamp to a sane range. The cap
 * exists so a misconfigured `AIP_STORE_BACKFILL_CHUNK_SIZE=999999`
 * can't enqueue a million queue rows in one click and OOM the DB.
 */
function _resolve_chunk_size(override) {
    const cfg = app_config().aip_store;
    const raw = override || (cfg && cfg.backfill_chunk_size) || 1000;
    return Math.max(1, Math.min(10_000, Number(raw)));
}

module.exports = {
    BACKFILL_BATCH_PREFIX,
    count_missing_aips,
    preview_next_chunk,
    enqueue_backfill_batch,
    get_status,
    cancel_backfill,
    // Test introspection.
    _apply_eligible_filter,
};
