'use strict';

// Collections — the staff-facing view of repository objects whose
// object_type='collection'. Each collection has a `display_record`
// JSON column populated by the legacy ingest pipeline; we parse it at
// read time to surface title/thumbnail/abstract/handle without an
// extra ES round-trip.
//
// The DB columns (pid, is_member_of_collection, is_published,
// is_active, object_type) remain the source of truth for filtering;
// display_record only enriches the public projection. This keeps the
// behavior portable between MariaDB (production) and sqlite (tests):
// no JSON_EXTRACT in WHERE clauses — JSON parsing happens in Node.

const validator = require('validator');

const { db } = require('../config/db');
const tables = require('../config/db_tables');
const repo_model = require('../repository/model');
const projection = require('../libs/object_projection');
const { NotFoundError, ValidationError } = require('../libs/errors');

const COLLECTION_FIELDS = [
    'id',
    'pid',
    'handle',
    'object_type',
    'is_member_of_collection',
    'is_published',
    'is_active',
    'is_compound',
    'is_indexed',
    'thumbnail',
    'created',
    'display_record',
];

// Sort modes. Empty / unknown -> 'count'.
const ALLOWED_SORTS = new Set(['count', 'title', 'recent']);

// ---------------------------------------------------------------------------
// Row projection. parse_display_record + the basic enrichment live in
// libs/object_projection so the dashboard's object list and this
// collections list share one implementation. We add the collection-
// flavored field (mime_type from display_record) on top.
// ---------------------------------------------------------------------------
const parse_display_record = projection.parse_display_record;

function project(row) {
    const enriched = projection.enrich(row);
    const dr = parse_display_record(row.display_record);
    return {
        ...enriched,
        is_member_of_collection: enriched.is_member_of_collection || null,
        mime_type: enriched.mime_type || dr.mime_type || null,
    };
}

function require_pid(pid) {
    if (!pid || typeof pid !== 'string') throw new ValidationError('pid is required');
    if (!validator.isUUID(pid)) throw new ValidationError('pid must be a UUID');
}

// ---------------------------------------------------------------------------
// Counts of objects-per-collection. One aggregate scan, indexed on
// is_member_of_collection. Returned as Map<collection_pid, {total, published}>.
// ---------------------------------------------------------------------------
async function counts_by_collection() {
    const rows = await db()(tables.objects)
        .select('is_member_of_collection')
        .count({ total: '*' })
        .sum({
            published: db().raw('CASE WHEN is_published = 1 THEN 1 ELSE 0 END'),
        })
        .where({ is_active: 1 })
        .whereNot({ object_type: 'collection' })
        .whereNot({ is_member_of_collection: '' })
        .groupBy('is_member_of_collection');
    const map = new Map();
    for (const r of rows) {
        map.set(r.is_member_of_collection, {
            total: Number(r.total || 0),
            published: Number(r.published || 0),
        });
    }
    return map;
}

// ---------------------------------------------------------------------------
// list_collections({ q, sort, page, page_size })
// ---------------------------------------------------------------------------
async function list_collections(opts = {}) {
    const q = typeof opts.q === 'string' ? opts.q.trim().toLowerCase() : '';
    const sort = ALLOWED_SORTS.has(opts.sort) ? opts.sort : 'count';
    const page = Math.max(1, Number.parseInt(opts.page, 10) || 1);
    const page_size = Math.min(100, Math.max(1, Number.parseInt(opts.page_size, 10) || 25));

    if (opts.q !== undefined && q.length > 200) {
        throw new ValidationError('Search term too long');
    }

    // Pull all collection rows (only ~hundreds, not millions). DB-level
    // pagination happens after we sort by computed counts.
    const rows = await db()(tables.objects)
        .select(COLLECTION_FIELDS)
        .where({ object_type: 'collection', is_active: 1 });

    const counts = await counts_by_collection();

    // Project + enrich with member counts
    const all = rows.map((r) => {
        const p = project(r);
        const c = counts.get(p.pid) || { total: 0, published: 0 };
        p.member_count = c.total;
        p.published_count = c.published;
        return p;
    });

    // Filter on title (in JS — keeps SQL portable between drivers).
    let filtered = all;
    if (q) {
        filtered = all.filter((c) => (c.title || '').toLowerCase().includes(q));
    }

    // Sort
    filtered.sort((a, b) => {
        if (sort === 'title') {
            return (a.title || '').localeCompare(b.title || '');
        }
        if (sort === 'recent') {
            return new Date(b.created) - new Date(a.created);
        }
        // default: count desc, title asc as tiebreaker
        if (b.member_count !== a.member_count) return b.member_count - a.member_count;
        return (a.title || '').localeCompare(b.title || '');
    });

    const total = filtered.length;
    const items = filtered.slice((page - 1) * page_size, page * page_size);

    return { q, sort, page, page_size, total, items };
}

// ---------------------------------------------------------------------------
// get_collection(pid) — single row, parsed.
// ---------------------------------------------------------------------------
async function get_collection(pid) {
    require_pid(pid);
    const row = await db()(tables.objects)
        .select(COLLECTION_FIELDS)
        .where({ pid, object_type: 'collection' })
        .first();
    if (!row) throw new NotFoundError(`Collection ${pid} not found`);
    const p = project(row);
    // Enrich with member counts. One aggregate query against an indexed
    // column — fast even on the full 21k-row table.
    const counts = await db()(tables.objects)
        .where({ is_member_of_collection: pid, is_active: 1 })
        .count({ total: '*' })
        .sum({
            published: db().raw('CASE WHEN is_published = 1 THEN 1 ELSE 0 END'),
        })
        .first();
    p.member_count = Number(counts.total || 0);
    p.published_count = Number(counts.published || 0);
    return p;
}

// ---------------------------------------------------------------------------
// members(collection_pid, filters) — delegates to repository.list,
// pinning the collection filter so callers can't accidentally bypass it.
// ---------------------------------------------------------------------------
async function members(collection_pid, filters = {}) {
    require_pid(collection_pid);
    return repo_model.list({
        ...filters,
        collection: collection_pid,
    });
}

// ---------------------------------------------------------------------------
// set_members_publish_state(collection_pid, value)
//
// Scope-based bulk: every active, non-collection member of the given
// collection has its is_published flipped in a single UPDATE. No pid
// list is involved so there's no cap — the cost is the same whether
// the collection has 5 members or 5,000.
//
// Skips object_type='collection' on purpose: a collection record's own
// publish state is managed via the per-row publish action, not by
// this scope action. Otherwise "publish all in collection X" would
// also flip nested sub-collection rows, which is rarely what staff want.
// ---------------------------------------------------------------------------
async function set_members_publish_state(collection_pid, value) {
    require_pid(collection_pid);
    // Make sure the collection actually exists before we run a write —
    // staff occasionally typo a PID, and a no-op UPDATE on a bad id
    // would silently succeed.
    const exists = await db()(tables.objects)
        .where({ pid: collection_pid, object_type: 'collection', is_active: 1 })
        .first('id');
    if (!exists) throw new NotFoundError(`Collection ${collection_pid} not found`);

    // Both publish and suppress dirty: keep the staff workflow
    // single-click. See repository/model.js set_publish_state for
    // the full rationale. Publish → indexer INDEXes each row;
    // suppress → indexer DELETEs each row.
    const affected = await db()(tables.objects)
        .where({ is_member_of_collection: collection_pid, is_active: 1 })
        .whereNot({ object_type: 'collection' })
        .update({ is_published: value ? 1 : 0, is_updated: 1 });
    return { affected };
}

async function publish_members(collection_pid) {
    return set_members_publish_state(collection_pid, true);
}

async function suppress_members(collection_pid) {
    return set_members_publish_state(collection_pid, false);
}

module.exports = {
    list_collections,
    get_collection,
    members,
    publish_members,
    suppress_members,
    project,
    parse_display_record,
    ALLOWED_SORTS,
    COLLECTION_FIELDS,
};
