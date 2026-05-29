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

// Public-domain projection.
//
// Shape rationale:
//
// Top-level: every field we want to QUERY or FILTER on goes here,
// with an explicit type in ensure_index() below. That's: pid/handle/
// uri/etc. (keyword), is_compound/is_published (boolean), created
// (date), title/abstract (text), subjects (keyword for faceting).
//
// display_record: the full ASpace envelope, included for retrieval
// only. ES stores it in _source but doesn't index sub-fields —
// declared `dynamic: false` in ensure_index. This is deliberate:
// the source data has wildly inconsistent shapes across records
// (extents is a string in one record, an object in the next; same
// for parts, dates, names, etc.), so any attempt to auto-infer
// per-field mappings produces mapper_parsing_exception on the next
// record with a different shape. Treating the blob as opaque sidesteps
// the problem entirely. If a future public-site query needs to hit
// a specific sub-path, declare it explicitly in the mappings.
//
// Title/abstract/subjects are pulled out of BOTH the outer envelope
// (v1-style denormalized fields the legacy ingest stamped at write
// time) and the inner ASpace record (the fresh fetch). The inner
// one wins when both are present — that's the post-refresh canonical.
function project_for_index(row, dr) {
    const inner =
        dr && dr.display_record && typeof dr.display_record === 'object' ? dr.display_record : null;

    // Inner (fresh ASpace fetch) wins over outer (denormalized at
    // ingest time) when both are present. Same priority for both
    // title and abstract.
    const title = (inner && inner.title) || (dr && dr.title) || null;
    const abstract = first_string((inner && inner.abstract) || (dr && dr.abstract));
    const subjects =
        Array.isArray(dr && dr.f_subjects) && dr.f_subjects.length > 0
            ? dr.f_subjects.filter((s) => typeof s === 'string')
            : [];

    return {
        pid: row.pid,
        handle: row.handle || null,
        uri: row.uri || null,
        is_member_of_collection: row.is_member_of_collection || null,
        object_type: row.object_type || 'object',
        mime_type: row.mime_type || null,
        thumbnail: row.thumbnail || null,
        is_compound: Boolean(row.is_compound),
        is_published: Boolean(row.is_published),
        sip_uuid: row.sip_uuid || null,
        created: row.created || null,
        // Searchable text fields, promoted out of display_record.
        title,
        abstract,
        subjects,
        // Opaque blob for retrieval — see ensure_index mapping.
        display_record: dr,
    };
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
                // Explicit mappings for every projection field. See
                // project_for_index() above for the shape rationale.
                //
                //   - Booleans: declared up front so v1's old
                //     0/1 wire format can never lock us into `long`.
                //   - id-shaped strings (pid, handle, uri, sip_uuid,
                //     is_member_of_collection, mime_type, object_type,
                //     thumbnail) are `keyword`: exact-match filters,
                //     no tokenization.
                //   - created is `date`: enables range queries.
                //   - title + abstract are `text` with a `.keyword`
                //     sub-field (multi-field pattern). Tokenized for
                //     full-text search; the .keyword sub-field
                //     supports exact-value aggregation and sort
                //     (you can't sort on a `text` field alone).
                //     ignore_above: 256 caps the keyword side so a
                //     pathological 100KB title doesn't bloat the
                //     inverted index — anything past 256 chars
                //     simply isn't keyword-searchable.
                //   - subjects is `keyword`: subjects are facets,
                //     not free text — filter exact-match.
                //   - display_record is `object` with `dynamic: false`:
                //     ES stores the blob in _source (so the full
                //     ASpace envelope is retrievable on a hit) but
                //     does NOT auto-add sub-fields to the mapping.
                //     This is critical: source records have wildly
                //     inconsistent shapes (extents is a string in
                //     one row, an object in another), and dynamic
                //     inference produces mapper_parsing_exception on
                //     the next shape collision. Keeping the blob
                //     opaque sidesteps the entire problem; if a
                //     specific sub-path ever needs to be queryable,
                //     add a property here explicitly.
                mappings: {
                    properties: {
                        pid: { type: 'keyword' },
                        handle: { type: 'keyword' },
                        uri: { type: 'keyword' },
                        is_member_of_collection: { type: 'keyword' },
                        object_type: { type: 'keyword' },
                        mime_type: { type: 'keyword' },
                        thumbnail: { type: 'keyword' },
                        sip_uuid: { type: 'keyword' },
                        is_compound: { type: 'boolean' },
                        is_published: { type: 'boolean' },
                        created: { type: 'date' },
                        title: {
                            type: 'text',
                            fields: {
                                keyword: { type: 'keyword', ignore_above: 256 },
                            },
                        },
                        abstract: {
                            type: 'text',
                            fields: {
                                keyword: { type: 'keyword', ignore_above: 256 },
                            },
                        },
                        subjects: { type: 'keyword' },
                        display_record: { type: 'object', dynamic: false },
                    },
                },
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
