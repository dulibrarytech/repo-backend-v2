'use strict';

// Public API model. Wraps libs/elasticsearch with the domain
// concerns the public read API needs:
//
//   1. Query construction — turn URL query params into an ES query
//      DSL object. Validation lives here too (string lengths, allowed
//      object_type values, page bounds).
//   2. Eligibility — every query is wrapped in a `is_published=true
//      AND is_active=true`-equivalent filter. The indexer is supposed
//      to keep ineligible docs OUT of the index already, but we
//      defense-in-depth at the query side too: a misbehaving indexer
//      tick can't accidentally expose suppressed content.
//   3. Public projection — the ES doc shape is internal; the public
//      response shape is what we promise consumers. Transformations:
//        - synthesize a `thumbnail_url` pointing at our public
//          thumbnail proxy (not the internal tn_service path)
//        - DROP fields consumers shouldn't see (sip_uuid is
//          operational metadata, not for public consumption)
//        - rename nothing, keep the same names ES uses, so a
//          consumer reading the docs vs hitting the API gets the
//          same field names
//
// The ES client is injected through the constructor so tests can
// pass in a fake without setting up a real cluster.

const validator = require('validator');

const es_default = require('../libs/elasticsearch');
const app_config = require('../config/app');
const { ValidationError } = require('../libs/errors');

const ALLOWED_OBJECT_TYPES = new Set(['object', 'collection', 'compound']);
const ALLOWED_SORTS = new Set(['relevance', 'title', 'created_desc', 'created_asc']);

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_Q_LENGTH = 200;

// Coerce a query param that might be a string OR an array (Express's
// query parser turns repeated keys into arrays). Returns a string array
// of non-empty trimmed values.
function as_string_array(v) {
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) {
        return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0);
    }
    if (typeof v === 'string') {
        const trimmed = v.trim();
        return trimmed.length > 0 ? [trimmed] : [];
    }
    return [];
}

// Build the ES query body from incoming filters. The actual eligibility
// filter (is_published + is_active stand-in) lives in the must clause;
// search relevance lives in the should clause. We split into "must"
// (which contributes to relevance scoring) and "filter" (which doesn't,
// so the filtering work is cacheable in ES's query cache).
function build_query(opts = {}) {
    const must = [];
    const filter = [];

    // Eligibility — pin every query to published, even if the indexer
    // misbehaves and somehow inserted an ineligible doc. is_published is
    // an integer (0/1) in the index, so filter on 1 — a boolean `true`
    // would not match the long-typed field.
    filter.push({ term: { is_published: 1 } });

    // Free text → multi_match against the searchable fields. We
    // boost title relative to abstract/f_subjects so a hit on the
    // title outranks a hit elsewhere. (subjects live in the top-level
    // `f_subjects` text field in the v1-compatible index shape.)
    if (opts.q && opts.q.trim().length > 0) {
        const q = opts.q.trim();
        if (q.length > MAX_Q_LENGTH) {
            throw new ValidationError(`q must be ${MAX_Q_LENGTH} characters or fewer`);
        }
        must.push({
            multi_match: {
                query: q,
                fields: ['title^3', 'abstract', 'f_subjects'],
                type: 'best_fields',
            },
        });
    }

    // Collection filter (exact match on the keyword field). Accepts
    // either a single string or an array (repeated query params).
    const collections = as_string_array(opts.collection);
    if (collections.length > 0) {
        // Validate each: collection ids are UUIDs.
        for (const c of collections) {
            if (!validator.isUUID(c)) {
                throw new ValidationError(`collection must be a UUID (got "${c}")`);
            }
        }
        filter.push({ terms: { is_member_of_collection: collections } });
    }

    // Object type — closed set.
    if (opts.object_type !== undefined && opts.object_type !== '') {
        if (!ALLOWED_OBJECT_TYPES.has(opts.object_type)) {
            throw new ValidationError(
                `object_type must be one of ${[...ALLOWED_OBJECT_TYPES].join(', ')}`
            );
        }
        filter.push({ term: { object_type: opts.object_type } });
    }

    // Subjects — array of keyword filters. Multiple values = OR
    // (any subject matches). For AND semantics the caller would
    // chain calls; not needed in v1. The facet field is `f_subjects`,
    // a text+keyword multi-field; a terms filter must target the exact
    // `.keyword` sub-field (this matches the frontend's Subject facet).
    const subjects = as_string_array(opts.subject);
    if (subjects.length > 0) {
        // Cap to a reasonable list — defends against degenerate
        // queries that pack the URL.
        if (subjects.length > 50) {
            throw new ValidationError('At most 50 subject filters per request');
        }
        filter.push({ terms: { 'f_subjects.keyword': subjects } });
    }

    // is_compound — accept "true"/"false" strings since query params
    // arrive as strings, but filter on the integer (0/1) the index
    // stores; a boolean would not match the long-typed field.
    if (opts.is_compound !== undefined && opts.is_compound !== '') {
        const v = String(opts.is_compound).toLowerCase();
        if (v !== 'true' && v !== 'false') {
            throw new ValidationError('is_compound must be true or false');
        }
        filter.push({ term: { is_compound: v === 'true' ? 1 : 0 } });
    }

    return {
        bool: {
            must: must.length > 0 ? must : [{ match_all: {} }],
            filter,
        },
    };
}

// Translate `sort` query param into an ES sort spec.
function build_sort(sort_key) {
    if (!sort_key || sort_key === 'relevance') return undefined; // ES default
    if (!ALLOWED_SORTS.has(sort_key)) {
        throw new ValidationError(`sort must be one of ${[...ALLOWED_SORTS].join(', ')}`);
    }
    switch (sort_key) {
        case 'title':
            return [{ 'title.keyword': 'asc' }];
        case 'created_desc':
            return [{ created: 'desc' }];
        case 'created_asc':
            return [{ created: 'asc' }];
        default:
            return undefined;
    }
}

// Project an ES doc into the public response shape.
//
// Field names mirror the index (see module header). The indexer emits the
// 2-level production shape: denormalized query/display fields at the top
// level (creator, f_subjects, type, object, …) + `display_record` = the raw
// ArchivesSpace record. Note `uri` no longer has a top-level copy — it lives
// inside display_record — so it's only populated on the detail endpoint;
// list responses exclude display_record for slimness (uri is null there).
//
// `kind` controls how much we return:
//   - 'list'   : the slim form, no display_record envelope. Used
//                for search results + collections list.
//   - 'detail' : the full doc including display_record envelope.
//                Used for /objects/:pid.
//
// `make_thumbnail_url` is a callable injected by the controller so
// the URL can be built from the request's host + path config (we
// don't want to bake the host into the model layer).
function project_to_public(doc, kind, make_thumbnail_url) {
    if (!doc) return null;
    const dr =
        doc.display_record && typeof doc.display_record === 'object' ? doc.display_record : null;
    const base = {
        pid: doc.pid,
        title: doc.title || null,
        creator: doc.creator || null,
        abstract: doc.abstract || null,
        handle: doc.handle || null,
        // uri is no longer top-level; it lives in the raw record. Present on
        // detail (full _source); null on list (display_record excluded).
        uri: doc.uri || (dr && dr.uri) || null,
        object_type: doc.object_type || 'object',
        mime_type: doc.mime_type || null,
        type: doc.type || null,
        // Index uses integer 1/0; expose a clean JS boolean to API consumers.
        is_compound: Boolean(doc.is_compound),
        is_member_of_collection: doc.is_member_of_collection || null,
        // Facet/keyword subjects. The v1-compatible index shape calls this
        // `f_subjects` (was `subjects` in the earlier 3-level v2 shape).
        f_subjects: Array.isArray(doc.f_subjects) ? doc.f_subjects : [],
        object: doc.object || null,
        // Not emitted by the current (prod-parity) index shape; kept as a
        // stable key should a top-level `created` ever be reintroduced.
        created: doc.created || null,
        thumbnail_url: make_thumbnail_url(doc.pid),
    };
    // A/V objects carry a top-level Kaltura entry id; surface it when present.
    if (doc.entry_id) base.entry_id = doc.entry_id;
    if (kind === 'detail') {
        // The raw ArchivesSpace record, so consumers can render rich record
        // pages (parts/notes/dates/names…) without a second ES round-trip.
        base.display_record = dr;
    }
    // sip_uuid is deliberately omitted — operational metadata, no
    // public consumer should need it.
    return base;
}

// ----- Public surface ----------------------------------------------

function create_model({ es = es_default } = {}) {
    return {
        // GET /api/v1/search
        async search(params, { make_thumbnail_url }) {
            const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
            const page_size = Math.min(
                MAX_PAGE_SIZE,
                Math.max(1, Number.parseInt(params.page_size, 10) || DEFAULT_PAGE_SIZE)
            );
            const query = build_query(params);
            const sort = build_sort(params.sort);
            const from = (page - 1) * page_size;

            const { total, hits } = await es.search_documents({
                query,
                from,
                size: page_size,
                sort,
                // Exclude the bulky display_record envelope from search
                // results — consumers can fetch detail per-row if they
                // need the full record.
                source: { excludes: ['display_record'] },
            });
            const items = hits.map((h) => project_to_public(h.body, 'list', make_thumbnail_url));
            return {
                q: params.q || '',
                page,
                page_size,
                total,
                items,
            };
        },

        // GET /api/v1/objects/:pid
        async get(pid, { make_thumbnail_url }) {
            if (!validator.isUUID(String(pid))) {
                throw new ValidationError('pid must be a UUID');
            }
            const doc = await es.get_document(pid);
            // Defense in depth: even if the doc is in the index, only
            // serve it to public callers if it claims published. The
            // index stores is_published as an integer (1/0), so test
            // truthiness rather than a strict boolean.
            if (!doc || !doc.is_published) return null;
            return project_to_public(doc, 'detail', make_thumbnail_url);
        },

        // GET /api/v1/collections
        async list_collections(params, { make_thumbnail_url }) {
            const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
            const page_size = Math.min(
                MAX_PAGE_SIZE,
                Math.max(1, Number.parseInt(params.page_size, 10) || DEFAULT_PAGE_SIZE)
            );
            const query = {
                bool: {
                    filter: [
                        { term: { is_published: 1 } },
                        { term: { object_type: 'collection' } },
                    ],
                },
            };
            const from = (page - 1) * page_size;
            const { total, hits } = await es.search_documents({
                query,
                from,
                size: page_size,
                sort: [{ 'title.keyword': 'asc' }],
                source: { excludes: ['display_record'] },
            });
            const items = hits.map((h) => project_to_public(h.body, 'list', make_thumbnail_url));
            return { page, page_size, total, items };
        },

        // Eligibility check used by the thumbnail proxy. Returns
        // `true` iff the ES index says this pid is published-and-
        // active. Cheap (single _get by id), but acceptable because
        // every thumbnail request goes through it.
        async is_eligible(pid) {
            if (!validator.isUUID(String(pid))) return false;
            try {
                const doc = await es.get_document(pid);
                // is_published is an integer (1/0) in the index — truthy check.
                return Boolean(doc && doc.is_published);
            } catch {
                return false;
            }
        },
    };
}

// Build the URL for a given pid's thumbnail proxy. Depends on the
// incoming request's protocol + host so absolute URLs work behind
// proxies + reverse-proxies. The caller (controller) wraps this in
// a closure with the req in scope.
function make_thumbnail_url_for(req, pid) {
    const cfg = app_config();
    // We deliberately use a RELATIVE URL by default — most browsers
    // resolve it correctly, and it survives moving behind a reverse
    // proxy without config gymnastics. Absolute form available for
    // callers that need it (cross-origin embeds).
    return `${cfg.path}/api/v1/objects/${pid}/thumbnail`;
}

module.exports = {
    create_model,
    build_query,
    build_sort,
    project_to_public,
    make_thumbnail_url_for,
    ALLOWED_OBJECT_TYPES,
    ALLOWED_SORTS,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    MAX_Q_LENGTH,
};
