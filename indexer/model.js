'use strict';

/*
 * Indexer-side queue ops on tbl_objects.
 * 
 * We don't maintain a separate queue table — the (is_updated,
 * is_indexed) pair on each row IS the queue. Lifecycle:
 * 
 *   is_updated=1, is_indexed=*   →  row needs indexing/deletion. Picked
 *                                   up next poll cycle.
 *   is_updated=0, is_indexed=1   →  row is in the ES index, in sync.
 *   is_updated=0, is_indexed=0   →  row has never been indexed. Steady
 *                                   state for never-published rows.
 * 
 * Claim flow mirrors metadata/model.js but uses the bare (is_updated,
 * is_indexed) flags instead of a status enum — the row IS the claim,
 * no extra column needed. A small but important difference from the
 * metadata queue: there's no "IN_PROGRESS" tri-state here, because
 * the worker's per-row work is short (one ES API call) and a crash
 * mid-call just means is_updated=1 stays set and the next poll picks
 * the row up again. Idempotent re-indexing is free.
 */

const validator = require('validator');

const { db } = require('../config/db');
const tables = require('../config/db_tables');
const { ValidationError } = require('../libs/errors');

const OBJECTS = tables.objects;

/*
 * Columns the worker needs to make its index/delete decision and to
 * build the public-side projection. Deliberately narrow — we never
 * pull mods or transcript here (those are megabytes and the indexer
 * doesn't need them).
 */
const WORKER_FIELDS = [
    'id',
    'pid',
    'handle',
    'uri',
    'is_member_of_collection',
    'object_type',
    'mime_type',
    'thumbnail',
    'is_compound',
    'is_published',
    'is_active',
    'is_indexed',
    'is_updated',
    'sip_uuid',
    'created',
    'display_record',
    'file_name',
    'transcript',
    'transcript_search',
];

function require_pid(pid) {
    if (!pid || typeof pid !== 'string') throw new ValidationError('pid is required');
    if (!validator.isUUID(pid)) throw new ValidationError('pid must be a UUID');
}

/*
 * Claim up to `limit` dirty rows for processing. Uses a transaction
 * to read + flip in one go — even if two workers raced (which can't
 * happen in our single-process setup but the safety is cheap),
 * each row gets claimed once.
 * 
 * We immediately set is_updated=0. If the ES write fails afterwards,
 * the next mutation of the row (publish/suppress/delete/refresh)
 * will flip is_updated back to 1 and the indexer gets another go.
 * That's the "free retry" property the lifecycle comment promised.
 */
async function claim_dirty(limit) {
    const cap = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 5));
    return db().transaction(async (trx) => {
        const candidates = await trx(OBJECTS)
            .select('id')
            .where({ is_updated: 1 })
            .orderBy('id', 'asc')
            .limit(cap);
        if (candidates.length === 0) return [];
        const ids = candidates.map((c) => c.id);
        /*
         * Pre-emptively flip is_updated=0 so a concurrent tick (or a
         * simultaneous bulk update) doesn't double-claim. The worker
         * will set is_indexed appropriately after the ES call.
         */
        await trx(OBJECTS).whereIn('id', ids).update({ is_updated: 0 });
        return trx(OBJECTS).select(WORKER_FIELDS).whereIn('id', ids);
    });
}

/*
 * Mark a row as successfully written to ES. The worker calls this
 * for both index AND delete operations — `is_indexed=1` here means
 * "the ES index now reflects this row's intended state."
 * 
 * Success also clears any dead-letter state (index_attempts/index_error):
 * the row indexed cleanly this time, so a prior failure streak is moot.
 */
async function mark_indexed(pid) {
    require_pid(pid);
    await db()(OBJECTS)
        .where({ pid })
        .update({ is_indexed: 1, index_attempts: 0, index_error: null });
}

/*
 * Mark a row as removed from the ES index. The semantic difference
 * from mark_indexed is small but worth keeping for clarity: a row
 * that was indexed and later deleted from ES has is_indexed=0.
 * Like mark_indexed, a clean removal clears any dead-letter state.
 */
async function mark_deindexed(pid) {
    require_pid(pid);
    await db()(OBJECTS)
        .where({ pid })
        .update({ is_indexed: 0, index_attempts: 0, index_error: null });
}

/*
 * Re-queue a failed row. Called when ES throws on us; we flip
 * is_updated=1 back so the next poll picks it up. is_indexed is
 * left alone — we don't know whether the previous successful index
 * (if any) is still accurate, but it's better than a guaranteed-
 * stale flag.
 */
async function requeue(pid) {
    require_pid(pid);
    await db()(OBJECTS).where({ pid }).update({ is_updated: 1 });
}

/*
 * Admin actions: bulk-flip is_updated on broad scopes. These power
 * the "Reindex all" / "Reindex collection" buttons. They don't talk
 * to ES directly — they just dirty the rows; the running worker
 * picks them up at its own pace.
 * 
 * The two broad-scope variants (all / collection) restrict to
 * is_published=1 AND is_active=1: per the indexing rule, those are
 * the only rows we ever want to push into ES. Unpublished or
 * soft-deleted rows that are STILL in ES (e.g. recently suppressed
 * before the worker drained the queue) get removed automatically
 * when their own suppress/soft-delete dirtied them — not via this
 * admin action.
 * All these admin "dirty for reindex" actions also clear index_attempts /
 * index_error: an explicit reindex is a deliberate "try again", so any
 * row that had been dead-lettered gets a fresh set of attempts (and after
 * a mapping/data fix, re-pushing all rows should un-dead-letter them).
 */
async function mark_dirty_all() {
    const affected = await db()(OBJECTS)
        .where({ is_active: 1, is_published: 1 })
        .update({ is_updated: 1, index_attempts: 0, index_error: null });
    return { affected };
}

async function mark_dirty_collection(collection_pid) {
    require_pid(collection_pid);
    const affected = await db()(OBJECTS)
        .where({
            is_member_of_collection: collection_pid,
            is_active: 1,
            is_published: 1,
        })
        .update({ is_updated: 1, index_attempts: 0, index_error: null });
    return { affected };
}

/*
 * Per-PID reindex stays unrestricted. It's a targeted operator
 * action — an admin asking "reindex this exact row" knows what
 * they're doing. If the row is ineligible the worker will DELETE
 * it from ES (which is the right answer too: forces ES + DB to
 * reconcile for that one row).
 */
async function mark_dirty_pid(pid) {
    require_pid(pid);
    const affected = await db()(OBJECTS)
        .where({ pid })
        .update({ is_updated: 1, index_attempts: 0, index_error: null });
    return { affected };
}

/*
 * Drop-and-rebuild reset. Sister of the admin rebuild_index controller:
 * after the ES index has been deleted+recreated, every eligible row
 * needs (a) is_indexed=0 because the new index is empty, and (b)
 * is_updated=1 so the worker re-pushes it. One UPDATE does both.
 * 
 * Restricted to is_active=1 AND is_published=1 — the same predicate
 * mark_dirty_all uses, for the same reason (only eligible rows belong
 * in the public index).
 */
async function reset_all_index_state() {
    const affected = await db()(OBJECTS)
        .where({ is_active: 1, is_published: 1 })
        .update({ is_updated: 1, is_indexed: 0, index_attempts: 0, index_error: null });
    return { affected };
}

/*
 * Bulk variants of mark_indexed / mark_deindexed / requeue. The worker
 * uses these after a bulk ES write so per-row results can be applied
 * in three UPDATEs instead of N. Empty input is a no-op so callers
 * don't have to guard.
 */
async function mark_indexed_bulk(pids) {
    if (!Array.isArray(pids) || pids.length === 0) return { affected: 0 };
    const affected = await db()(OBJECTS)
        .whereIn('pid', pids)
        .update({ is_indexed: 1, index_attempts: 0, index_error: null });
    return { affected };
}

async function mark_deindexed_bulk(pids) {
    if (!Array.isArray(pids) || pids.length === 0) return { affected: 0 };
    const affected = await db()(OBJECTS)
        .whereIn('pid', pids)
        .update({ is_indexed: 0, index_attempts: 0, index_error: null });
    return { affected };
}

/*
 * Re-queue rows after a whole-batch ES TRANSPORT failure (the bulk call
 * itself threw — ES down/unreachable). Flips is_updated=1 with NO penalty:
 * the rows are blameless, so this path deliberately does NOT increment
 * index_attempts. (Per-item rejections — the poison case — go through
 * record_failures instead, which DOES count toward the dead-letter cap.)
 */
async function requeue_bulk(pids) {
    if (!Array.isArray(pids) || pids.length === 0) return { affected: 0 };
    const affected = await db()(OBJECTS).whereIn('pid', pids).update({ is_updated: 1 });
    return { affected };
}

/*
 * Record PER-ITEM index failures with a bounded retry. `failures` is an
 * array of { pid, err }. For each pid we increment index_attempts, then:
 *   - under the cap  → requeue (is_updated=1) for another attempt.
 *   - at/over the cap → DEAD-LETTER: leave is_updated=0 (so claim_dirty
 *                       never re-picks it) and store index_error so the
 *                       admin page can surface it. "No silent caps."
 * Returns { requeued: [pid], dead_lettered: [pid] } so the worker can log
 * dead-letters exactly once (a dead-lettered row isn't re-claimed, so it
 * won't re-log every poll the way the old unbounded requeue did).
 * 
 * Done in one transaction so the increment + partition + writes are
 * atomic with respect to a concurrent claim.
 */
async function record_failures(failures, { max_attempts = 5 } = {}) {
    const list = Array.isArray(failures) ? failures.filter((f) => f && f.pid) : [];
    if (list.length === 0) return { requeued: [], dead_lettered: [] };
    const cap = Math.max(1, Number.parseInt(max_attempts, 10) || 5);
    const pids = list.map((f) => f.pid);
    const err_by_pid = new Map(
        list.map((f) => [f.pid, String(f.err || 'index failed').slice(0, 1000)])
    );
    return db().transaction(async (trx) => {
        await trx(OBJECTS).whereIn('pid', pids).increment('index_attempts', 1);
        const rows = await trx(OBJECTS).whereIn('pid', pids).select('pid', 'index_attempts');
        const dead_lettered = rows.filter((r) => Number(r.index_attempts) >= cap).map((r) => r.pid);
        const requeued = rows.filter((r) => Number(r.index_attempts) < cap).map((r) => r.pid);
        if (requeued.length) {
            await trx(OBJECTS).whereIn('pid', requeued).update({ is_updated: 1 });
        }
        /*
         * Dead-letter writes are per-row (each gets its own error) but
         * this branch is rare — only rows that exhausted the cap.
         */
        for (const pid of dead_lettered) {
            await trx(OBJECTS)
                .where({ pid })
                .update({ is_updated: 0, index_error: err_by_pid.get(pid) });
        }
        return { requeued, dead_lettered };
    });
}

/*
 * Admin "Retry failed": un-dead-letter every row (index_error IS NOT NULL),
 * reset its attempt counter, and dirty it so the worker re-attempts. Used
 * after the underlying cause (bad mapping/data) is fixed. Unlike
 * reset_all_index_state this targets ONLY the failed rows regardless of
 * publish/active state, so a dead-lettered-then-unpublished row still gets
 * reconciled (the worker will delete it from ES, which is correct).
 */
async function requeue_dead_lettered() {
    const affected = await db()(OBJECTS)
        .whereNotNull('index_error')
        .update({ is_updated: 1, index_attempts: 0, index_error: null });
    return { affected };
}

// Health/status counters. Each is a single indexed count; cheap.
async function status_counts() {
    const dirty = await db()(OBJECTS).where({ is_updated: 1 }).count({ n: '*' }).first();
    const indexed = await db()(OBJECTS).where({ is_indexed: 1 }).count({ n: '*' }).first();
    const eligible = await db()(OBJECTS)
        .where({ is_published: 1, is_active: 1 })
        .count({ n: '*' })
        .first();
    /*
     * Dead-lettered: rows that exhausted the retry cap and were parked
     * (index_error set, no longer auto-requeued). Surfaced on the admin
     * page so a stuck row is never silently dropped from the index.
     */
    const dead = await db()(OBJECTS).whereNotNull('index_error').count({ n: '*' }).first();
    return {
        dirty: Number(dirty.n || 0),
        indexed_flag: Number(indexed.n || 0),
        eligible: Number(eligible.n || 0),
        dead_lettered: Number(dead.n || 0),
    };
}

module.exports = {
    WORKER_FIELDS,
    claim_dirty,
    mark_indexed,
    mark_deindexed,
    requeue,
    mark_indexed_bulk,
    mark_deindexed_bulk,
    requeue_bulk,
    record_failures,
    requeue_dead_lettered,
    mark_dirty_all,
    mark_dirty_collection,
    mark_dirty_pid,
    reset_all_index_state,
    status_counts,
};
