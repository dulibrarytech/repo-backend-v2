'use strict';

/*
 * Shared collection provisioning — "given an ArchivesSpace resource URI,
 * find-or-create the local collection mirror." Extracted from the ingest
 * pre-flight gate (ingester/workspace.js `_ensure_collection_exists`) so the
 * dashboard "create collection" flow and ingest share ONE implementation.
 * 
 *   provision_collection({ uri, parent_collection_pid }, deps) ->
 *       { ok:true, collection_pid, uri, created, handle, collection }
 *     | { ok:false, error }
 * 
 * `created:false` means the resource already had a live collection (the
 * unique-on-uri index guarantees one per resource); the caller decides
 * whether that's "reuse" (ingest) or "already exists" (dashboard).
 * 
 * `parent_collection_pid` (optional) nests the new collection under an
 * existing parent (sub-collection). Omit it for a top-level collection — the
 * ingest path does, so its behavior is unchanged.
 * 
 * deps (all injectable for tests): aspace, repo_model, handles.
 */

const { randomUUID } = require('node:crypto');

const aspace_default = require('../libs/archivesspace');
const repo_model_default = require('./model');
const handles_default = require('../libs/handles');
const log = require('../libs/log');

/*
 * Best-effort handle mint for a freshly-generated collection PID. Returns
 * the handle URL on success, '' on any failure (unconfigured, HTTP error,
 * network down). NEVER throws — collection creation must not be blocked by a
 * flaky handle service; an admin can backfill later.
 */
async function mint_collection_handle(handles, pid) {
    if (!handles || !handles.is_configured || !handles.is_configured()) {
        log.info({ event: 'collection_handle_skipped', pid, reason: 'not_configured' });
        return '';
    }
    try {
        const result = await handles.create_handle(pid);
        if (result && result.handle) return result.handle;
        log.warn({
            event: 'collection_handle_unexpected_status',
            pid,
            status: result && result.status,
        });
        return '';
    } catch (err) {
        log.warn({ event: 'collection_handle_failed', pid, err: err.message });
        return '';
    }
}

async function provision_collection({ uri, parent_collection_pid } = {}, deps = {}) {
    const aspace = deps.aspace || aspace_default;
    const repo_model = deps.repo_model || repo_model_default;
    const handles = deps.handles || handles_default;

    if (!uri || typeof uri !== 'string') {
        return { ok: false, error: 'A resource URI is required' };
    }

    /*
     * Fast path — collection already mirrored locally (one live collection
     * per resource URI, enforced by the unique index). Reuse, don't recreate.
     */
    const existing = await repo_model.find_collection_by_uri(uri);
    if (existing) {
        return {
            ok: true,
            collection_pid: existing.pid,
            uri,
            created: false,
            collection: existing,
        };
    }

    // Slow path — fetch from ArchivesSpace, then create.
    if (!aspace.is_configured()) {
        return {
            ok: false,
            error: 'ArchivesSpace is not configured; cannot verify the collection resource',
        };
    }
    let token;
    try {
        token = await aspace.get_session_token();
    } catch (err) {
        return { ok: false, error: `ArchivesSpace login failed: ${err.message}` };
    }
    let res;
    try {
        res = await aspace.get_record(uri, token);
    } catch (err) {
        return { ok: false, error: `ArchivesSpace fetch for ${uri} failed: ${err.message}` };
    } finally {
        // Best-effort logout; never block on it.
        aspace.destroy_session_token(token).catch(() => {});
    }

    if (res.status === 404) {
        return {
            ok: false,
            error:
                `Resource ${uri} does not exist in ArchivesSpace. ` +
                `Confirm the URI matches an active resource.`,
        };
    }
    if (res.status !== 200 || !res.data) {
        return { ok: false, error: `ArchivesSpace returned HTTP ${res.status} for ${uri}` };
    }

    /*
     * Generate the PID up front so the handle is minted against the same UUID
     * that ends up in the row (handle service is best-effort; '' on failure).
     */
    const pid = randomUUID();
    const handle_url = await mint_collection_handle(handles, pid);

    try {
        const created = await repo_model.create_collection({
            uri,
            mods: res.data,
            pid,
            handle: handle_url,
            parent_collection_pid,
        });
        log.info({
            event: 'collection_provisioned',
            uri,
            pid: created.pid,
            parent_collection_pid: parent_collection_pid || null,
            handle: handle_url || null,
        });
        return {
            ok: true,
            collection_pid: created.pid,
            uri,
            created: true,
            handle: handle_url || null,
            collection: created,
        };
    } catch (err) {
        // Includes the parent-collection validation error from create_collection.
        return { ok: false, error: `Could not create collection for ${uri}: ${err.message}` };
    }
}

module.exports = { provision_collection, mint_collection_handle };
