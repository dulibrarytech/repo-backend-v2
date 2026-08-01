'use strict';

/*
 * Thin wrapper around @elastic/elasticsearch.
 *
 *   is_configured()           cheap gate, so the worker can skip ticks where no
 *                             ES instance is available
 *   ensure_index()            idempotent create; safe on every boot
 *   delete_index()            idempotent drop, silent on 404; pairs with
 *                             ensure_index for the admin drop & rebuild flow
 *   index_document(pid, body) single-doc upsert keyed by pid as _id, so a
 *                             re-index replaces in place
 *   delete_document(pid)      silent on 404
 *   bulk_write(ops)           batched index/delete in one HTTP call, returning
 *                             per-item results
 *   health()                  cluster ping → { ok, status } | { ok: false, err }
 *   count()                   doc count for the admin status page
 *   search_documents/get_document   read side for the public API
 *   project_for_index(row, dr)      row → indexed document shape
 *
 * The native client is created lazily and is factory-injectable for tests.
 */

const fs = require('node:fs');
const { Client } = require('@elastic/elasticsearch');
const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError } = require('./errors');
/*
 * Mirrors the production `repo_public` mapping the public discovery site
 * queries directly. See project_for_index() for the matching document shape.
 */
const INDEX_MAPPINGS = require('./es_mappings.json');

function is_configured() {
    const cfg = app_config().elasticsearch;
    return Boolean(cfg && cfg.host);
}

/*
 * The TLS option block for the ES Client, or undefined when no customization
 * is needed (so the constructor never sees a stray `tls: {}`).
 *
 *   ca_cert_file            added to the trust chain; read synchronously ONCE
 *                           at client construction, so a reload needs a restart.
 *                           A read failure is logged and falls back to the
 *                           default trust store.
 *   reject_unauthorized:false  disables cert verification. Dev only; logged
 *                           loudly.
 *   neither                 Node's bundled trust store.
 */
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
        log.warn({
            event: 'es_tls_verification_disabled',
            msg:
                'ELASTICSEARCH_REJECT_UNAUTHORIZED=false — TLS verification ' +
                'is OFF for the ES connection. Do not run this in production.',
        });
    }

    return Object.keys(tls).length > 0 ? tls : undefined;
}

/*
 * Default client factory. Returns null rather than throwing on a bogus host —
 * the Client constructor throws on an invalid URL, and that should leave ES
 * unreachable, not kill the worker.
 */
function default_client_factory() {
    const cfg = app_config().elasticsearch;
    if (!cfg.host) return null;
    try {
        return new Client({
            node: cfg.host,
            requestTimeout: cfg.timeout_ms,
            // No topology probe at boot: slow on a cold ES, fails behind a proxy.
            sniffOnStart: false,
            tls: build_tls_options(),
        });
    } catch (err) {
        log.warn({ event: 'es_client_construct_failed', err: err.message });
        return null;
    }
}

/*
 * The first useful string from a value that may be a string, an array of
 * strings, or null. Duplicates libs/object_projection's helper to keep this
 * module free of dashboard-domain imports.
 */
function first_string(v) {
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    return null;
}

/*
 * ---- v1-compatible projection helpers --------------------------------
 *
 * Mirror digitaldu-backend/libs/display-record.js create_display_record. Every
 * denormalized top-level field is derived from the INNER ArchivesSpace record,
 * so the output is correct whether the stored display_record column is a rich
 * legacy envelope or the sparse one v2's ingester writes.
 */

// abstract: the `abstract`-type note's content, falling back to a plain field.
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

/*
 * The single canonical parts manifest, stored once at display_record.parts.
 * Prefers an ENRICHED copy — one carrying object/thumbnail DuraCloud paths —
 * because the inner ASpace record's own parts are un-enriched for simple
 * objects. Checks the envelope's `parts`/`compound` before the inner `parts`.
 */
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

/*
 * Master file path for the top-level `object` field: the legacy envelope's own
 * value, else the master part, else the row's file_name column (which mirrors
 * the DIP path for normally-ingested objects).
 */
function master_object(inner, dr, parts, row) {
    if (typeof dr.object === 'string' && dr.object) return dr.object;
    if (Array.isArray(parts)) {
        const m =
            parts.find((p) => p && p.type === 'object' && p.object) ||
            parts.find((p) => p && p.object);
        if (m && m.object) return m.object;
    }
    if (row && typeof row.file_name === 'string' && row.file_name) return row.file_name;
    return null;
}

/*
 * Kaltura entry id for A/V objects — a top-level convenience field; the
 * per-part ids stay inside display_record.parts. Single-file legacy A/V objects
 * carry it on the envelope or inner record rather than in a parts entry.
 */
function derive_entry_id(parts, dr, inner) {
    if (Array.isArray(parts)) {
        const p = parts.find((x) => x && (x.entry_id || x.kaltura_id));
        if (p) return p.entry_id || p.kaltura_id;
    }
    if (dr && (dr.entry_id || dr.kaltura_id)) return dr.entry_id || dr.kaltura_id;
    if (inner && (inner.entry_id || inner.kaltura_id)) return inner.entry_id || inner.kaltura_id;
    return null;
}

/*
 * Coarse resource type from the mime type — a last-resort fallback so an object
 * whose metadata never carried resource_type still lands in a Format facet
 * bucket. Values match the frontend's facet normalization.
 */
function type_from_mime(mime) {
    if (typeof mime !== 'string' || !mime) return null;
    if (mime.startsWith('image/')) return 'still image';
    if (mime === 'application/pdf') return 'text';
    if (mime.startsWith('video/')) return 'moving image';
    if (mime.startsWith('audio/')) return 'sound recording';
    return null;
}

/*
 * Public-domain projection — the 2-level production `repo_public` document
 * shape: a top-level denormalized query/display surface, plus `display_record`
 * holding the raw ArchivesSpace record verbatim. No extra envelope, and the raw
 * record is NOT nested under display_record.display_record. The parts manifest
 * appears exactly once, at display_record.parts.
 *
 * Collections get the stripped shape prod uses (title/abstract only).
 *
 * See repo/notes/INDEX_STRUCTURE_FINAL.md.
 */
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
    const entry_id = derive_entry_id(parts, dr, inner);
    // display_record = the raw ASpace record, carrying the single parts copy.
    const display_record = { ...inner };
    if (parts) display_record.parts = parts;

    const doc = {
        pid: row.pid,
        is_member_of_collection: row.is_member_of_collection || null,
        handle: row.handle || null,
        thumbnail: row.thumbnail || null,
        mime_type: row.mime_type || null,
        // v1 and the frontend know only 'object' + is_compound, never 'compound'.
        object_type: 'object',
        is_published: row.is_published ? 1 : 0, // INTEGER 1/0 (matches prod)
        is_compound: inner.is_compound === true || row.is_compound ? 1 : 0,
        title,
        creator: derive_creator(inner, dr),
        f_subjects: derive_f_subjects(inner, dr),
        abstract,
        type: inner.resource_type || dr.type || type_from_mime(row.mime_type),
        object: master_object(inner, dr, parts, row),
        display_record,
    };
    if (entry_id) doc.entry_id = entry_id;
    /*
     * Indexed under both names: the frontend displays object.transcript, and
     * its advanced search targets the `transcript` field.
     */
    const transcript = meaningful_text(row.transcript) || meaningful_text(row.transcript_search);
    if (transcript) {
        doc.transcript = transcript;
        doc.transcript_search = meaningful_text(row.transcript_search) || transcript;
    }
    return doc;
}

// Real transcript text vs junk placeholders ("{}", "[]", "null", whitespace).
function meaningful_text(v) {
    const s = first_string(v);
    if (!s) return null;
    const t = s.trim();
    if (t.length < 3 || t === '{}' || t === '[]' || t === 'null') return null;
    return s;
}

function create_client(factory = default_client_factory) {
    let cached_client = null;

    function client() {
        if (!cached_client) cached_client = factory();
        return cached_client;
    }

    // Test seam — drops the cache so an injected factory's next client is used.
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
        // Existing index no-ops; otherwise create at the configured shards/replicas.
        let exists;
        try {
            exists = await c.indices.exists({ index: cfg.index });
        } catch (err) {
            log.warn({ event: 'es_exists_check_failed', err: err.message });
            throw new UpstreamError(`ES exists check failed: ${err.message}`);
        }
        // v8 returns a plain boolean; v7 returned { body: boolean }.
        if (exists === true || (exists && exists.body === true)) return { created: false };
        try {
            await c.indices.create({
                index: cfg.index,
                settings: {
                    number_of_shards: cfg.shards,
                    number_of_replicas: cfg.replicas,
                },
                mappings: INDEX_MAPPINGS,
            });
            log.info({ event: 'es_index_created', index: cfg.index });
            return { created: true };
        } catch (err) {
            // Another process won the race between exists() and create().
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

    /*
     * Drop the index, for the admin "drop & rebuild" flow when a mapping change
     * needs more than a re-push of documents. A 404 returns
     * { ok: true, deleted: false }, so a rebuild against a fresh ES succeeds.
     */
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
                // No per-write flush; ES refreshes on its own 1s cadence.
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
            // 404 = already absent, which is the desired end state.
            if (err && err.meta && err.meta.statusCode === 404) {
                return { ok: true, deleted: false };
            }
            log.warn({ event: 'es_delete_failed', pid, err: err.message });
            throw new UpstreamError(`ES delete failed: ${err.message}`);
        }
    }

    /*
     * Batched index/delete via the _bulk API — one HTTP round trip instead of N.
     * Each item is independent, so a poison row mid-batch does not abort the rest.
     *
     * Input — array of:
     *   { op: 'index',  pid, body }   indexed under _id = pid
     *   { op: 'delete', pid }         delete by _id = pid
     *
     * Output:
     *   { items: [ { op, pid, ok: true },
     *              { op, pid, ok: false, err: 'reason' }   caller requeues ] }
     *
     * Items align with input order. A 404 on a delete counts as success, and
     * empty input returns { items: [] } without touching ES. A top-level ES
     * error (network, auth) throws UpstreamError — a batch-wide failure the
     * caller should requeue in full.
     */
    async function bulk_write(ops) {
        if (!Array.isArray(ops) || ops.length === 0) return { items: [] };
        if (!is_configured()) throw new UpstreamError('Elasticsearch is not configured');
        const c = client();
        if (!c) throw new UpstreamError('Elasticsearch client unavailable');
        const cfg = app_config().elasticsearch;
        // Interleaved action/document array; the v8 client serializes it as-is.
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
        // ES wraps each result under its op verb ({index:{…}} / {delete:{…}}).
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

    /*
     * Read-side helpers for the public API. They return raw ES hits and docs;
     * projection to the public response shape happens in api/model.js.
     *
     * search_documents(opts):
     *   opts.query   a fully-formed ES query DSL object, built by the caller
     *   opts.from    pagination offset, ES-native 0-indexed
     *   opts.size    page size, capped at 100, default 25
     *   opts.sort    optional sort spec; defaults to relevance
     *   opts.source  optional _source filter ({ excludes: [...] }), e.g. to omit
     *                the bulky display_record
     *   → { total, hits: [{ pid, body, score }] }
     *
     * get_document(pid): the full _source, or null on 404.
     */
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
            // v8 returns the body directly; v7 wraps it.
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
            // 404 = not indexed, because the row isn't eligible. Not an error.
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
// Exported for unit tests — pure config translation, testable on its own.
module.exports.build_tls_options = build_tls_options;
