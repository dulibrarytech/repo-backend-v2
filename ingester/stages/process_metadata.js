'use strict';

/*
 * Stage 1 — process_metadata.
 * 
 *   entry:  PENDING                (or QA_COMPLETE on resume)
 *   exit:   QA_COMPLETE            (success)
 *         | AS_METADATA_INVALID    (validation failed; reset-eligible)
 *         | INGEST_HALTED          (transport failure; staff intervention)
 * 
 * What it does:
 *   1. Fetch the ArchivesSpace record at `row.metadata_uri`. If a
 *      cached snapshot is present in `row.metadata`, use it as a
 *      fallback when AS is unavailable (v1's "Phase 3c-1" snapshot
 *      optimization).
 *   2. Validate the record against the ingester/libs/aspace_validator
 *      rules.
 *   3. On success: persist the snapshot in `metadata` (JSON string)
 *      and advance to QA_COMPLETE. The audit log captures the
 *      transition. Stage 2 (upload) picks it up next.
 *   4. On validation error: halt with AS_METADATA_INVALID. The error
 *      list is stored in `row.error`. No AM activity has happened so
 *      "reset" is the only rollback needed.
 *   5. On transport error: halt with INGEST_HALTED so staff can
 *      intervene — distinct from a true validation failure.
 * 
 * Dependencies (all injectable for tests):
 *   - aspace: libs/archivesspace client
 *   - validator: ingester/libs/aspace_validator
 *   - model: ingester/model (update_queue)
 */

const aspace_default = require('../../libs/archivesspace');
const validator_default = require('../libs/aspace_validator');
const model_default = require('../model');
const log = require('../../libs/log');
const { fetch_record_with_retry } = require('../../libs/aspace_session');

async function run(row, deps = {}) {
    const aspace = deps.aspace || aspace_default;
    const validator = deps.validator || validator_default;
    const model = deps.model || model_default;

    /*
     * Move to PROCESSING_METADATA so the dashboard can show the row
     * is actively being worked. This event also gives staff a precise
     * "started at" timestamp in the timeline.
     */
    await model.update_queue(
        { id: row.id },
        { status: 'PROCESSING_METADATA' },
        { actor: 'worker', payload: { stage: 'process_metadata' } }
    );

    /*
     * Fetch the AS record. If we already have a cached snapshot in
     * the queue row (from a prior partial run), we use that as a
     * fallback only — fresh data is preferred so we catch any edits
     * staff made between enqueue and process.
     */
    let metadata = null;
    let fetch_error = null;
    try {
        metadata = await fetch_from_aspace(row.metadata_uri, aspace, {
            session: deps.session,
            sleep: deps.sleep,
        });
    } catch (err) {
        fetch_error = err;
        // Try the cached snapshot before halting.
        const cached = parse_metadata(row.metadata);
        if (cached) {
            log.warn({
                event: 'process_metadata_using_cached_snapshot',
                queue_id: row.id,
                fetch_err: err.message,
            });
            metadata = cached;
        }
    }

    /*
     * If both live fetch and cached snapshot failed, halt the row.
     * INGEST_HALTED (not AS_METADATA_INVALID) — the AS record itself
     * might be fine; we just couldn't reach it.
     */
    if (!metadata) {
        await halt(model, row, 'INGEST_HALTED', {
            stage: 'process_metadata',
            reason: 'aspace_unreachable',
            error: fetch_error ? fetch_error.message : 'no metadata available',
        });
        return { ok: false, reason: 'aspace_unreachable' };
    }

    /*
     * Validate. validate_record returns [] on success, [reasons] on
     * failure — surface every reason in the audit payload so staff
     * can fix all of them in one pass rather than ping-pong.
     */
    const errors = validator.validate_record(metadata);
    if (errors.length > 0) {
        await halt(model, row, 'AS_METADATA_INVALID', {
            stage: 'process_metadata',
            reason: 'validation_failed',
            errors,
        });
        return { ok: false, reason: 'validation_failed', errors };
    }

    /*
     * Happy path: persist the snapshot + advance. We store the
     * metadata as JSON in the existing `metadata` LONGTEXT column so
     * stage 4's post-AM drift check has a baseline to compare against.
     */
    try {
        await model.update_queue(
            { id: row.id },
            { status: 'QA_COMPLETE', metadata: JSON.stringify(metadata) },
            {
                actor: 'worker',
                payload: { stage: 'process_metadata', result: 'validated' },
            }
        );
        return { ok: true, metadata };
    } catch (err) {
        await halt(model, row, 'INGEST_HALTED', {
            stage: 'process_metadata',
            reason: 'queue_write_failed',
            error: err.message,
        });
        return { ok: false, reason: 'queue_write_failed' };
    }
}

/*
 * Fetch the AS record. The shape we hand to the validator is the
 * `data` object as ASpace returned it.
 *
 * 2026-07-29 (95-package burst incident): this used to mint a fresh
 * ASpace session PER PACKAGE and halt the row on the first transport
 * blip — a big batch fired dozens of rapid logins and ASpace started
 * resetting them (ECONNRESET), halting rows that had nothing wrong
 * with them. Now the session is shared process-wide (one login per
 * worker lifetime, refreshed on 401) and transport failures / 5xx
 * retry with backoff+jitter before the row is allowed to halt. See
 * libs/aspace_session.js.
 */
async function fetch_from_aspace(uri, aspace, { session, sleep } = {}) {
    if (!uri || typeof uri !== 'string') {
        throw new Error('row has no metadata_uri');
    }
    const res = await fetch_record_with_retry(uri, { aspace, session, sleep });
    if (res.status === 200 && res.data) return res.data;
    if (res.status === 401 || res.status === 403) {
        throw new Error(`ArchivesSpace auth failed: HTTP ${res.status}`);
    }
    if (res.status === 404) {
        /*
         * Surface 404 specifically — it's structurally different from
         * a 5xx and the dashboard can suggest "check the URI" rather
         * than "try again later".
         */
        throw new Error(`ArchivesSpace record not found: ${uri}`);
    }
    throw new Error(`ArchivesSpace ${uri} returned HTTP ${res.status}`);
}

/*
 * Try to revive a cached metadata snapshot from the queue row.
 * Returns the parsed object or null. We tolerate both JSON-string
 * and already-object shapes because some legacy code paths wrote
 * JSON.parse-able strings; new code writes strings.
 */
function parse_metadata(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/*
 * Write the halt state + audit row. We always set `error` so the
 * dashboard's red-flag column has useful text without having to
 * drill into the timeline.
 */
async function halt(model, row, terminal_state, payload) {
    const error_text = payload.errors
        ? payload.errors.join('; ').slice(0, 1000)
        : payload.error || payload.reason || 'halted';
    await model.update_queue(
        { id: row.id },
        { status: terminal_state, error: error_text },
        { actor: 'worker', event_type: 'state_change', payload }
    );
}

module.exports = { run };
