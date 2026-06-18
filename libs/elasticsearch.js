'use strict';

// Thin wrapper around @elastic/elasticsearch. Concerns it owns:
//
//   1. `is_configured()` — cheap gate so the worker can skip ticks in
//      dev/test environments without an ES instance available.
//   2. `ensure_index()` — idempotent index creation. Safe to call on
//      every boot; no-ops if the index already exists.
//   3. `delete_index()` — idempotent index drop. Silent on 404. Paired
//      with ensure_index() for the admin "drop & rebuild" flow.
//   4. `index_document(pid, body)` — single-doc upsert. Uses the row's
//      pid as the _id so re-indexing replaces in place.
//   5. `delete_document(pid)` — silent on 404 (ineligible-but-not-yet-
//      indexed is a valid steady state, not an error).
//   6. `bulk_write(ops)` — batched index/delete in a single HTTP call.
//      Returns per-item results so the worker can mark/requeue rows
//      individually even when some operations in the batch failed.
//   7. `health()` — cluster ping for the /health endpoint + the
//      admin status page. Returns { ok, status } or { ok: false, err }.
//
// The native client is created lazily so a missing/unreachable ES at
// boot doesn't crash the process — the worker just stays idle until
// ES comes back. Factory-injectable for tests.

const fs = require('node:fs');
const { Client } = require('@elastic/elasticsearch');
const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError } = require('./errors');
// Index mappings live in a sibling JSON file (es_mappings.json) rather
// than inline below. They mirror the production `repo_public` mapping
// the public discovery site (digitaldu-frontend-master) queries
// directly, so the v2 index is a drop-in for that consumer. See
// project_for_index() for the matching document shape.
const INDEX_MAPPINGS = require('./es_mappings.json');

function is_configured() {
    const cfg = app_config().elasticsearch;
    return Boolean(cfg && cfg.host);
}

// Build the TLS option block for the ES Client. Three layers:
//
//   1. ca_cert_file (optional) — read and added to the trust chain.
//      Use this for internal CAs OR to patch around a server that
//      doesn't send its intermediate. We READ the file synchronously
//      ONCE at client construction; subsequent reloads need a restart.
//      A read failure is logged but doesn't break the client — we'd
//      rather have a working client with the default trust store than
//      no client at all.
//
//   2. rejectUnauthorized=false (optional, dev only) — disables cert
//      verification entirely. Loud warning logged at construction.
//
//   3. Default (no env vars set) — Node's bundled trust store; same
//      behavior the @elastic/elasticsearch client has out of the box.
//
// Returns undefined when no TLS customization is needed, so the
// Client constructor doesn't get a stray `tls: {}` option.
function build_tls_options() {
    const cfg = app_config().elasticsearch;
    const tls = {};

    if (cfg.ca_cert_file) {
        try {
            const ca_pem = fs.readFileSync(cfg.ca_cert_file);
            tls.ca = ca_pem;
            log.info({
                event: 'es_ca_cert_loaded',
                path: cfg.ca_cert_file,
                bytes: ca_pem.length,
            });
        } catch (err) {
            log.warn({
                event: 'es_ca_cert_load_failed',
                path: cfg.ca_cert_file,
                err: err.message,
                msg: 'Falling back to default trust store',
            });
        }
    }

    if (cfg.reject_unauthorized === false) {
        tls.rejectUnauthorized = false;
        // Make this very obvious in the logs. Cert verification off
        // is acceptable in dev, never in prod.
        log.warn({
            event: 'es_tls_verification_disabled',
            msg:
                'ELASTICSEARCH_REJECT_UNAUTHORIZED=false — TLS verification ' +
                'is OFF for the ES connection. Do not run this in production.',
        });
    }

    return Object.keys(tls).length > 0 ? tls : undefined;
}

// Default client factory. The @elastic/elasticsearch Client constructor
// throws on bogus URLs at construction time, so we wrap it; an invalid
// host shouldn't kill the worker — it should just be unreachable until
// fixed.
function default_client_factory() {
    const cfg = app_config().elasticsearch;
    if (!cfg.host) return null;
    try {
        return new Client({
            node: cfg.host,
            requestTimeout: cfg.timeout_ms,
            // sniffOnStart=false: we don't want the client probing the
            // cluster topology at boot (slow on a cold ES, fails
            // outright on a single-node dev cluster behind a proxy).
            sniffOnStart: false,
            tls: build_tls_options(),
        });
    } catch (err) {
        log.warn({ event: 'es_client_construct_failed', err: err.message });
        return null;
    }
}

// Helper: the first useful string from a value that might be a
// string, an array of strings, or null. Mirrors libs/object_projection
// (we duplicate the tiny logic here to keep this module free of
// dashboard-domain imports).
function first_string(v) {
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    return null;
}

// ---- v1-compatible projection helpers --------------------------------
//
// These mirror digitaldu-backend/libs/display-record.js create_display_record,
// the function that produced the production `repo_public` documents the
// public site reads. We derive every denormalized top-level field from
// the inner ArchivesSpace record so the output is correct regardless of
// whether the stored display_record column is a rich legacy envelope or
// the sparse one v2's own ingester writes.

// abstract: the `abstract`-type note's content (string or array), with a
// plain `abstract` field as fallback.
function extract_abstract(inner, dr) {
    if (inner && Array.isArray(inner.notes)) {
        const note = inner.notes.find((n) => n && n.type === 'abstract');
        if (note && note.content !== null && note.content !== undefined) {
            return first_string(note.content);
        }
    }
    return first_string((inner && inner.abstract) || (dr && dr.abstract));
}

// creator: the title of the first name whose role is 'creator'.
function derive_creator(inner, dr) {
    if (inner && Array.isArray(inner.names)) {
        const c = inner.names.find((n) => n && n.role === 'creator');
        if (c && c.title) return c.title;
    }
    return (dr && dr.creator) || null;
}

// f_subjects: flat list of subject titles (the facet/search surface).
function derive_f_subjects(inner, dr) {
    if (inner && Array.isArray(inner.subjects)) {
        const arr = inner.subjects.map((s) => s && s.title).filter((s) => typeof s === 'string');
        if (arr.length > 0) return arr;
    }
    return Array.isArray(dr && dr.f_subjects)
        ? dr.f_subjects.filter((s) => typeof s === 'string')
        : [];
}

// The single canonical parts manifest. Stored once at display_record.parts.
// Prefer an *enriched* copy (one carrying object/thumbnail DuraCloud paths),
// since the inner ASpace record's own parts are un-enriched for simple
// objects. Looks in the envelope's `parts`/`compound` (v2 ingest + legacy)
// before the inner record's `parts`.
function pick_parts(inner, dr) {
    const candidates = [dr && dr.parts, dr && dr.compound, inner && inner.parts];
    for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0 && c.some((p) => p && (p.object || p.thumbnail)))
            return c;
    }
    for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0) return c;
    }
    return undefined;
}

// Master file path for the top-level `object` field. Legacy envelopes
// carry it directly; otherwise take it from the master part.
function master_object(inner, dr, parts) {
    if (typeof dr.object === 'string' && dr.object) return dr.object;
    if (Array.isArray(parts)) {
        const m =
            parts.find((p) => p && p.type === 'object' && p.object) ||
            parts.find((p) => p && p.object);
        if (m && m.object) return m.object;
    }
    return null;
}

// Kaltura entry id for A/V objects (top-level convenience field; the
// per-part ids stay inside display_record.parts).
function derive_entry_id(parts) {
    if (!Array.isArray(parts)) return null;
    const p = parts.find((x) => x && (x.entry_id || x.kaltura_id));
    return p ? p.entry_id || p.kaltura_id : null;
}

// Public-domain projection — emits the 2-level production `repo_public`
// document shape (top-level denormalized query/display surface +
// `display_record` = the raw ArchivesSpace record, verbatim).
//
// This deliberately does NOT wrap the document in an extra envelope or
// nest the raw record under display_record.display_record (the bloated
// 3-level shape earlier versions produced). The parts manifest is stored
// exactly once at display_record.parts. See INDEX_STRUCTURE_FINAL.md.
//
// Collections get the stripped shape prod uses (title/abstract only).
function project_for_index(row, dr) {
    dr = dr && typeof dr === 'object' ? dr : {};
    const inner =
        dr.display_record && typeof dr.display_record === 'object' ? dr.display_record : {};
    const title = inner.title || dr.title || null;
    const abstract = extract_abstract(inner, dr);

    // Collections: stripped shape (matches production repo_public).
    if ((row.object_type || '') === 'collection') {
        return {
            pid: row.pid,
            is_member_of_collection: row.is_member_of_collection || null,
            handle: row.handle || null,
            object_type: 'collection',
            title,
            thumbnail: row.thumbnail || null,
            is_published: row.is_published ? 1 : 0,
            abstract,
            display_record: { title, abstract },
        };
    }

    // Objects (simple + compound): full shape.
    const parts = pick_parts(inner, dr);
    const entry_id = derive_entry_id(parts);
    // display_record = the raw ASpace record, carrying the single parts copy.
    const display_record = { ...inner };
    if (parts) display_record.parts = parts;

    const doc = {
        pid: row.pid,
        is_member_of_collection: row.is_member_of_collection || null,
        handle: row.handle || null,
        thumbnail: row.thumbnail || null,
        mime_type: row.mime_type || null,
        // v2's ingester tags compounds object_type='compound'; v1/the
        // frontend only know 'object' (+ is_compound). Normalize.
        object_type: 'object',
        is_published: row.is_published ? 1 : 0, // INTEGER 1/0 (matches prod)
        is_compound: inner.is_compound === true || row.is_compound ? 1 : 0,
        title,
        creator: derive_creator(inner, dr),
        f_subjects: derive_f_subjects(inner, dr),
        abstract,
        type: inner.resource_type || dr.type || null,
        object: master_object(inner, dr, parts),
        display_record,
    };
    if (entry_id) doc.entry_id = entry_id;
    return doc;
}

function create_client(factory = default_client_factory) {
    let cached_client = null;

    function client() {
        if (!cached_client) cached_client = factory();
        return cached_client;
    }

    // Test seam: when an injected factory returns a new client per
    // call we want callers to pick it up. Used only in tests that
    // swap the underlying client mid-test.
    function _reset_client() {
        cached_client = null;
    }

    async function ensure_index() {
        if (!is_configured()) {
            throw new UpstreamError('Elasticsearch is not configured');
        }
        const c = client();
        if (!c) throw new UpstreamError('Elasticsearch client unavailable');
        const cfg = app_config().elasticsearch;
        // exists -> if true, no-op; if false, create with the
        // configured shard/replica counts.
        let exists;
        try {
            exists = await c.indices.exists({ index: cfg.index });
        } catch (err) {
            log.warn({ event: 'es_exists_check_failed', err: err.message });
            throw new UpstreamError(`ES exists check failed: ${err.message}`);
        }
        // @elastic/elasticsearch v8 returns a plain boolean; v7
        // returned { body: boolean }. Handle both defensively.
        if (exists === true || (exists && exists.body === true)) return { created: false };
        try {
            await c.indices.create({
                index: cfg.index,
                settings: {
                    number_of_shards: cfg.shards,
                    number_of_replicas: cfg.replicas,
                },
                // Mappings come from es_mappings.json — the production
                // repo_public mapping the public site queries. Key points:
                //   - is_compound/is_published are `long` (prod's 0/1 wire
                //     format), matched by the integer flags project_for_index
                //     now emits.
                //   - top-level text fields carry a `.keyword` sub-field for
                //     exact-match facets/sort (object_type.keyword,
                //     creator.keyword, f_subjects.keyword, type.keyword, …).
                //   - display_record is an `object` with `dynamic: false` but
                //     WITH explicit sub-properties: the fields the frontend
                //     queries inside it (dates/identifiers as `nested`,
                //     names.title.keyword, subjects.terms.*, t_language.text,
                //     notes.*) are mapped and queryable; any other/odd-shaped
                //     sub-field is stored in _source but not indexed, so a
                //     shape collision can't throw mapper_parsing_exception.
                mappings: INDEX_MAPPINGS,
            });
            log.info({ event: 'es_index_created', index: cfg.index });
            return { created: true };
        } catch (err) {
            // Race: another process created it between our exists()
            // and create(). Idempotent semantics demand we treat
            // "resource_already_exists_exception" as success.
            const code =
                err && err.meta && err.meta.body && err.meta.body.error
                    ? err.meta.body.error.type
                    : null;
            if (code === 'resource_already_exists_exception') {
                return { created: false };
            }
            throw new UpstreamError(`ES index create failed: ${err.message}`);
        }
    }

    // Drop the index. Used by the admin "drop & rebuild" flow when a
    // mapping change requires more than a re-push of documents. A 404
    // (index doesn't exist) is a normal outcome — treat it as success
    // so a rebuild against an empty/fresh ES doesn't spuriously fail.
    async function delete_index() {
        if (!is_configured()) throw new UpstreamError('Elasticsearch is not configured');
        const c = client();
        if (!c) throw new UpstreamError('Elasticsearch client unavailable');
        const cfg = app_config().elasticsearch;
        try {
            await c.indices.delete({ index: cfg.index });
            return { ok: true, deleted: true };
        } catch (err) {
            if (err && err.meta && err.meta.statusCode === 404) {
                return { ok: true, deleted: false };
            }
            log.warn({ event: 'es_delete_index_failed', err: err.message });
            throw new UpstreamError(`ES delete index failed: ${err.message}`);
        }
    }

    async function index_document(pid, body) {
        if (!is_configured()) throw new UpstreamError('Elasticsearch is not configured');
        const c = client();
        if (!c) throw new UpstreamError('Elasticsearch client unavailable');
        const cfg = app_config().elasticsearch;
        try {
            await c.index({
                index: cfg.index,
                id: pid,
                document: body,
                // refresh=false: don't force a flush per write — the
                // indexer batches and ES does its own near-realtime
                // refresh on a 1s cadence anyway.
                refresh: false,
            });
            return { ok: true };
        } catch (err) {
            log.warn({ event: 'es_index_failed', pid, err: err.message });
            throw new UpstreamError(`ES index failed: ${err.message}`);
        }
    }

    async function delete_document(pid) {
        if (!is_configured()) throw new UpstreamError('Elasticsearch is not configured');
        const c = client();
        if (!c) throw new UpstreamError('Elasticsearch client unavailable');
        const cfg = app_config().elasticsearch;
        try {
            await c.delete({ index: cfg.index, id: pid });
            return { ok: true, deleted: true };
        } catch (err) {
            // 404 = the doc wasn't there. That's a normal steady
            // state when a never-published row gets suppressed: the
            // indexer would call delete_document anyway. Don't throw.
            if (err && err.meta && err.meta.statusCode === 404) {
                return { ok: true, deleted: false };
            }
            log.warn({ event: 'es_delete_failed', pid, err: err.message });
            throw new UpstreamError(`ES delete failed: ${err.message}`);
        }
    }

    // Batched index/delete via the _bulk API. One HTTP roundtrip per
    // call instead of N — the dominant cost in the indexer worker
    // (single-doc index_document/delete_document each paid full
    // request latency). ES _bulk handles partial failures: each item
    // is independent, so a poison row in the middle of a batch
    // doesn't abort the rest.
    //
    // Input — array of:
    //   { op: 'index',  pid, body }   indexed under _id = pid
    //   { op: 'delete', pid }         delete by _id = pid
    //
    // Output:
    //   {
    //     items: [
    //       { op, pid, ok: true }                  successful op
    //       { op, pid, ok: false, err: 'reason' }  failed op (caller requeues)
    //     ]
    //   }
    //
    // Notes:
    //   - 404 on a delete is treated as success: the doc wasn't there,
    //     which is the desired end state. Mirrors delete_document.
    //   - On empty input, returns { items: [] } without touching ES.
    //   - If ES returns a top-level error (network failure, auth, etc.),
    //     throws UpstreamError. The caller should treat that as a
    //     batch-wide failure and requeue all pids.
    async function bulk_write(ops) {
        if (!Array.isArray(ops) || ops.length === 0) return { items: [] };
        if (!is_configured()) throw new UpstreamError('Elasticsearch is not configured');
        const c = client();
        if (!c) throw new UpstreamError('Elasticsearch client unavailable');
        const cfg = app_config().elasticsearch;
        // Build the interleaved operations array. The v8 client accepts
        // a flat array and serializes it correctly on the wire.
        const operations = [];
        for (const op of ops) {
            if (op.op === 'index') {
                operations.push({ index: { _index: cfg.index, _id: op.pid } });
                operations.push(op.body);
            } else if (op.op === 'delete') {
                operations.push({ delete: { _index: cfg.index, _id: op.pid } });
            } else {
                throw new UpstreamError(`bulk_write: unknown op "${op.op}"`);
            }
        }
        let res;
        try {
            res = await c.bulk({ operations, refresh: false });
        } catch (err) {
            log.warn({ event: 'es_bulk_failed', count: ops.length, err: err.message });
            throw new UpstreamError(`ES bulk failed: ${err.message}`);
        }
        const body = res && res.body ? res.body : res;
        const raw_items = (body && body.items) || [];
        // ES returns one wrapper per op, keyed by the op verb
        // ({index:{...}} or {delete:{...}}). Unwrap and align with the
        // input order so callers can match by index.
        const items = ops.map((op, i) => {
            const wrapper = raw_items[i] || {};
            const inner = wrapper.index || wrapper.delete || wrapper.create || wrapper.update || {};
            const status = inner.status;
            if (op.op === 'delete' && status === 404) {
                return { op: op.op, pid: op.pid, ok: true };
            }
            if (inner.error) {
                const reason =
                    (inner.error && inner.error.reason) ||
                    (typeof inner.error === 'string' ? inner.error : 'unknown');
                return { op: op.op, pid: op.pid, ok: false, err: reason };
            }
            return { op: op.op, pid: op.pid, ok: true };
        });
        return { items };
    }

    async function health() {
        if (!is_configured()) return { ok: false, status: 'unconfigured' };
        const c = client();
        if (!c) return { ok: false, status: 'unconfigured' };
        try {
            const res = await c.cluster.health();
            // v8 returns the body directly; v7 wraps it.
            const body = res && res.body ? res.body : res;
            return { ok: body.status !== 'red', status: body.status };
        } catch (err) {
            return { ok: false, status: 'unreachable', err: err.message };
        }
    }

    async function count() {
        // Doc count in the index — used by the admin status page.
        if (!is_configured()) return { count: 0 };
        const c = client();
        if (!c) return { count: 0 };
        const cfg = app_config().elasticsearch;
        try {
            const res = await c.count({ index: cfg.index });
            const body = res && res.body ? res.body : res;
            return { count: Number(body.count || 0) };
        } catch {
            return { count: 0 };
        }
    }

    // Read-side helpers powering the public API. These return raw ES
    // hits/docs — projection to the public response shape happens in
    // api/model.js so the lib stays free of domain shaping.
    //
    // search_documents:
    //   - opts.query: a fully-formed ES query DSL object. The caller
    //     (api/model) builds this from request params; we don't try
    //     to abstract over it here.
    //   - opts.from / opts.size: pagination, in ES-native 0-indexed form.
    //   - opts.sort: optional sort spec. Defaults to relevance.
    //   - opts.source: optional _source filter ({ excludes: [...] })
    //     so the search response can omit the bulky display_record.
    //
    //   Returns { total, hits } where hits is an array of { pid, body, score }.
    //
    // get_document:
    //   - Looks up one doc by pid (which is the ES _id).
    //   - Returns the full _source on hit, null on 404.
    async function search_documents(opts = {}) {
        if (!is_configured()) throw new UpstreamError('Elasticsearch is not configured');
        const c = client();
        if (!c) throw new UpstreamError('Elasticsearch client unavailable');
        const cfg = app_config().elasticsearch;
        const body = {
            query: opts.query || { match_all: {} },
            from: Math.max(0, Number.parseInt(opts.from, 10) || 0),
            size: Math.max(0, Math.min(100, Number.parseInt(opts.size, 10) || 25)),
        };
        if (opts.sort) body.sort = opts.sort;
        if (opts.source) body._source = opts.source;
        try {
            const res = await c.search({ index: cfg.index, ...body });
            // v8 returns the body directly; v7 wraps it in res.body.
            const r = res && res.body ? res.body : res;
            const total =
                r.hits && r.hits.total
                    ? typeof r.hits.total === 'number'
                        ? r.hits.total
                        : r.hits.total.value
                    : 0;
            const hits = (r.hits && r.hits.hits ? r.hits.hits : []).map((h) => ({
                pid: h._id,
                body: h._source,
                score: h._score,
            }));
            return { total, hits };
        } catch (err) {
            log.warn({ event: 'es_search_failed', err: err.message });
            throw new UpstreamError(`ES search failed: ${err.message}`);
        }
    }

    async function get_document(pid) {
        if (!is_configured()) throw new UpstreamError('Elasticsearch is not configured');
        const c = client();
        if (!c) throw new UpstreamError('Elasticsearch client unavailable');
        const cfg = app_config().elasticsearch;
        try {
            const res = await c.get({ index: cfg.index, id: pid });
            const body = res && res.body ? res.body : res;
            return body && body._source ? body._source : null;
        } catch (err) {
            // 404 is the expected miss path — the doc simply isn't
            // indexed (because it isn't eligible). Return null so
            // the controller can map to its own 404.
            if (err && err.meta && err.meta.statusCode === 404) return null;
            log.warn({ event: 'es_get_failed', pid, err: err.message });
            throw new UpstreamError(`ES get failed: ${err.message}`);
        }
    }

    return {
        is_configured,
        ensure_index,
        delete_index,
        index_document,
        delete_document,
        bulk_write,
        health,
        count,
        search_documents,
        get_document,
        project_for_index,
        _reset_client,
    };
}

module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
module.exports.project_for_index = project_for_index;
// Exported for unit tests — capturing the Client constructor's TLS
// argument requires module mocking, but the helper is pure config
// translation and trivially testable on its own.
module.exports.build_tls_options = build_tls_options;
