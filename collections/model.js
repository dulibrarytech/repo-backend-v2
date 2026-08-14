'use strict';

/*
 * Collections — the staff-facing view of repository objects whose
 * object_type='collection'. Each collection has a `display_record`
 * JSON column populated by the legacy ingest pipeline; we parse it at
 * read time to surface title/thumbnail/abstract/handle without an
 * extra ES round-trip.
 * 
 * The DB columns (pid, is_member_of_collection, is_published,
 * is_active, object_type) remain the source of truth for filtering;
 * display_record only enriches the public projection. This keeps the
 * behavior portable between MariaDB (production) and sqlite (tests):
 * no JSON_EXTRACT in WHERE clauses — JSON parsing happens in Node.
 */

const { randomUUID } = require('node:crypto');

const validator = require('validator');

const { db } = require('../config/db');
const tables = require('../config/db_tables');
const repo_model = require('../repository/model');
const projection = require('../libs/object_projection');
const log = require('../libs/log');
const { NotFoundError, ValidationError, ConflictError } = require('../libs/errors');

const COLLECTION_FIELDS = [
    'id',
    'pid',
    'handle',
    'uri',
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

/*
 * ---------------------------------------------------------------------------
 * Row projection. parse_display_record + the basic enrichment live in
 * libs/object_projection so the dashboard's object list and this
 * collections list share one implementation. We add the collection-
 * flavored field (mime_type from display_record) on top.
 * ---------------------------------------------------------------------------
 */
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

/*
 * ---------------------------------------------------------------------------
 * Counts of objects-per-collection. One aggregate scan, indexed on
 * is_member_of_collection. Returned as Map<collection_pid, {total, published}>.
 * ---------------------------------------------------------------------------
 */
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

/*
 * ---------------------------------------------------------------------------
 * titles_by_pids(pids) — resolve a set of collection PIDs to their titles in
 * ONE query. Used by the add-objects picker to show each candidate's CURRENT
 * collection by name (is_member_of_collection holds the collection's PID, not
 * its title). Returns Map<pid, title>; non-collection / unknown PIDs and the
 * '' (no-collection) value are simply absent from the map.
 * ---------------------------------------------------------------------------
 */
async function titles_by_pids(pids) {
    const unique = [...new Set((pids || []).filter(Boolean).map(String))];
    const map = new Map();
    if (unique.length === 0) return map;
    const rows = await db()(tables.objects)
        .select('pid', 'display_record')
        .whereIn('pid', unique)
        .where({ object_type: 'collection' });
    for (const r of rows) {
        const dr = parse_display_record(r.display_record);
        if (dr.title) map.set(r.pid, dr.title);
    }
    return map;
}

/*
 * ---------------------------------------------------------------------------
 * list_collections({ q, sort, page, page_size })
 * ---------------------------------------------------------------------------
 */
async function list_collections(opts = {}) {
    const q = typeof opts.q === 'string' ? opts.q.trim().toLowerCase() : '';
    const sort = ALLOWED_SORTS.has(opts.sort) ? opts.sort : 'count';
    const page = Math.max(1, Number.parseInt(opts.page, 10) || 1);
    const page_size = Math.min(100, Math.max(1, Number.parseInt(opts.page_size, 10) || 25));

    if (opts.q !== undefined && q.length > 200) {
        throw new ValidationError('Search term too long');
    }

    /*
     * Pull all collection rows (only ~hundreds, not millions). DB-level
     * pagination happens after we sort by computed counts.
     */
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

/*
 * ---------------------------------------------------------------------------
 * get_collection(pid) — single row, parsed.
 * ---------------------------------------------------------------------------
 */
async function get_collection(pid) {
    require_pid(pid);
    const row = await db()(tables.objects)
        .select(COLLECTION_FIELDS)
        .where({ pid, object_type: 'collection' })
        .first();
    if (!row) throw new NotFoundError(`Collection ${pid} not found`);
    const p = project(row);
    /*
     * Enrich with member counts. One aggregate query against an indexed
     * column — fast even on the full 21k-row table.
     */
    const counts = await db()(tables.objects)
        .where({ is_member_of_collection: pid, is_active: 1 })
        /*
         * Count member OBJECTS only — a nested sub-collection is shown in its
         * own "Sub-collections" section, not counted as a member object (keeps
         * this consistent with counts_by_collection + the member list).
         */
        .whereNot({ object_type: 'collection' })
        .count({ total: '*' })
        .sum({
            published: db().raw('CASE WHEN is_published = 1 THEN 1 ELSE 0 END'),
        })
        .first();
    p.member_count = Number(counts.total || 0);
    p.published_count = Number(counts.published || 0);
    return p;
}

/*
 * ---------------------------------------------------------------------------
 * sub_collections(parent_pid) — the collections nested directly under a
 * parent (is_member_of_collection = parent). Projected + enriched with member
 * counts, same shape as list_collections items, so the detail page can render
 * them like the collections list. Dashboard-only nesting: there's no rollup,
 * so this is a single-level child query.
 * ---------------------------------------------------------------------------
 */
async function sub_collections(parent_pid) {
    require_pid(parent_pid);
    const rows = await db()(tables.objects)
        .select(COLLECTION_FIELDS)
        .where({ is_member_of_collection: parent_pid, object_type: 'collection', is_active: 1 });
    if (rows.length === 0) return [];
    const counts = await counts_by_collection();
    /*
     * `is_empty` drives whether the dashboard offers "Delete" on a sub-collection.
     * Emptiness must account for ANY active child — member objects AND nested
     * sub-collections — so we never offer delete on a collection that still has
     * sub-collections under it. counts_by_collection excludes collection rows, so
     * run a second, type-agnostic count scoped to just these sub pids.
     */
    const sub_pids = rows.map((r) => r.pid);
    const child_rows = await db()(tables.objects)
        .select('is_member_of_collection')
        .count({ n: '*' })
        .where({ is_active: 1 })
        .whereIn('is_member_of_collection', sub_pids)
        .groupBy('is_member_of_collection');
    const child_map = new Map(
        child_rows.map((r) => [r.is_member_of_collection, Number(r.n || 0)])
    );
    return rows
        .map((r) => {
            const p = project(r);
            const c = counts.get(p.pid) || { total: 0, published: 0 };
            p.member_count = c.total;
            p.published_count = c.published;
            p.is_empty = (child_map.get(p.pid) || 0) === 0;
            return p;
        })
        .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

/*
 * ---------------------------------------------------------------------------
 * add_members(collection_pid, pids) — move existing objects INTO a collection
 * (single-membership reassign). Sets is_member_of_collection + is_updated=1
 * (so the indexer re-syncs each moved object to its new collection home) for
 * the given object PIDs. Only ACTIVE, non-collection rows move — we never
 * re-parent a collection this way (avoids cycles; sub-collections are created
 * fresh). This is the first post-ingest writer of is_member_of_collection.
 * Returns { added: <rows moved> }.
 * ---------------------------------------------------------------------------
 */
async function add_members(collection_pid, pids) {
    require_pid(collection_pid);
    if (!Array.isArray(pids) || pids.length === 0) {
        throw new ValidationError('Select at least one object to add');
    }
    if (pids.length > 100) {
        throw new ValidationError('At most 100 objects can be added at once');
    }
    const exists = await db()(tables.objects)
        .where({ pid: collection_pid, object_type: 'collection', is_active: 1 })
        .first('id');
    if (!exists) throw new NotFoundError(`Collection ${collection_pid} not found`);

    const added = await db()(tables.objects)
        .whereIn('pid', pids)
        .where({ is_active: 1 })
        .whereNot({ object_type: 'collection' })
        .update({ is_member_of_collection: collection_pid, is_updated: 1 });
    return { added };
}

/*
 * ---------------------------------------------------------------------------
 * delete_collection(pid, { actor }) — soft-delete an EMPTY collection.
 * 
 * "Empty" = no active rows reference it via is_member_of_collection — neither
 * member objects NOR nested sub-collections. We refuse a non-empty collection
 * (ConflictError) so staff can't strand its contents under a dead parent;
 * they must move/delete the children first. Unlike object delete there's no
 * Archivematica AIP (a collection is just an ArchivesSpace mirror record), so
 * there's no deletion request and no published-state guard — soft-delete with
 * is_updated=1 lets the indexer drop it from ES on its next tick.
 * 
 * Soft delete (is_active=0) also frees the resource URI: the live-collection
 * unique index only covers active rows, so the same ASpace resource can be
 * re-provisioned later. delete_id is stamped for audit parity with objects.
 * 
 * Returns { ok: true, pid, parent_pid } (parent_pid = the now-deleted
 * collection's former is_member_of_collection, so the caller can route back to
 * the parent detail).
 * ---------------------------------------------------------------------------
 */
async function delete_collection(pid, { actor } = {}) {
    require_pid(pid);
    const row = await db()(tables.objects)
        .where({ pid, object_type: 'collection', is_active: 1 })
        .first('id', 'is_member_of_collection');
    if (!row) throw new NotFoundError(`Collection ${pid} not found`);

    /*
     * Type-agnostic child count: any active row (object OR sub-collection)
     * pointing at this collection makes it non-empty.
     */
    const child = await db()(tables.objects)
        .where({ is_member_of_collection: pid, is_active: 1 })
        .count({ n: '*' })
        .first();
    const child_count = Number(child.n || 0);
    if (child_count > 0) {
        throw new ConflictError(
            `Cannot delete collection ${pid}: it still has ${child_count} item(s). ` +
                'Move or delete its contents first.'
        );
    }

    const delete_id = randomUUID();
    const affected = await db()(tables.objects)
        .where({ pid, is_active: 1 })
        .update({ is_active: 0, delete_id, is_updated: 1 });
    if (affected === 0) {
        // Race: a concurrent delete won between SELECT and UPDATE.
        throw new NotFoundError(`Collection ${pid} not found`);
    }
    log.info({
        event: 'collection_deleted',
        pid,
        parent_pid: row.is_member_of_collection || '',
        delete_id,
        actor: actor || null,
    });
    return { ok: true, pid, parent_pid: row.is_member_of_collection || '' };
}

/*
 * ---------------------------------------------------------------------------
 * Is `candidate_pid` a descendant of `ancestor_pid`? Walks UP the
 * is_member_of_collection chain from candidate. Used by move_collection's cycle
 * guard: you can't move a collection under one of its own sub-collections.
 * Depth-bounded so a pre-existing cycle in the data can't loop forever.
 * ---------------------------------------------------------------------------
 */
async function _is_descendant_of(candidate_pid, ancestor_pid, max_depth = 100) {
    let current = candidate_pid;
    for (let i = 0; i < max_depth; i++) {
        const row = await db()(tables.objects)
            .where({ pid: current, object_type: 'collection' })
            .first('is_member_of_collection');
        if (!row) return false; // hit a non-collection / missing row → root reached
        const parent = row.is_member_of_collection;
        if (!parent || parent === current) return false; // top-level or self-loop
        if (parent === ancestor_pid) return true; // ancestor found → it's a descendant
        current = parent;
    }
    return false; // depth bound (defensive against dirty cyclic data)
}

/*
 * ---------------------------------------------------------------------------
 * move_collection(pid, new_parent_pid) — re-parent an existing collection.
 *   new_parent_pid = '' / null  → make it top-level (un-nest)
 *   new_parent_pid = <coll pid>  → nest it under that collection
 * Sets is_member_of_collection (+ is_updated=1 so the indexer re-syncs). Guards:
 * target must be an active collection; can't be itself; can't be one of its own
 * descendants (cycle). Returns { ok, pid, parent_pid, changed }.
 * ---------------------------------------------------------------------------
 */
async function move_collection(pid, new_parent_pid) {
    require_pid(pid);
    const row = await db()(tables.objects)
        .where({ pid, object_type: 'collection', is_active: 1 })
        .first('id', 'is_member_of_collection');
    if (!row) throw new NotFoundError(`Collection ${pid} not found`);

    let target_parent = '';
    if (new_parent_pid) {
        require_pid(new_parent_pid);
        if (new_parent_pid === pid) {
            throw new ValidationError('A collection cannot be its own parent');
        }
        const parent = await db()(tables.objects)
            .where({ pid: new_parent_pid, object_type: 'collection', is_active: 1 })
            .first('id');
        if (!parent) throw new NotFoundError(`Parent collection ${new_parent_pid} not found`);
        if (await _is_descendant_of(new_parent_pid, pid)) {
            throw new ValidationError(
                'Cannot move a collection under one of its own sub-collections'
            );
        }
        target_parent = new_parent_pid;
    }

    if ((row.is_member_of_collection || '') === target_parent) {
        return { ok: true, pid, parent_pid: target_parent, changed: false };
    }
    await db()(tables.objects)
        .where({ pid, is_active: 1 })
        .update({ is_member_of_collection: target_parent, is_updated: 1 });
    log.info({ event: 'collection_moved', pid, parent_pid: target_parent || null });
    return { ok: true, pid, parent_pid: target_parent, changed: true };
}

/*
 * ---------------------------------------------------------------------------
 * eligible_parents(pid) — active collections a given collection may be moved
 * under: every active collection EXCEPT itself and its own descendants (moving
 * under a descendant would create a cycle). Returns [{ pid, title }] sorted by
 * title. Small set (hundreds of collections), so we load + walk in JS.
 * ---------------------------------------------------------------------------
 */
async function eligible_parents(pid) {
    require_pid(pid);
    const rows = await db()(tables.objects)
        .select('pid', 'is_member_of_collection', 'display_record')
        .where({ object_type: 'collection', is_active: 1 });
    /*
     * Children map keyed by parent pid, then BFS down from `pid` to collect its
     * descendant set.
     */
    const children_of = new Map();
    for (const r of rows) {
        const p = r.is_member_of_collection || '';
        if (!children_of.has(p)) children_of.set(p, []);
        children_of.get(p).push(r.pid);
    }
    const excluded = new Set([pid]);
    const queue = [...(children_of.get(pid) || [])];
    while (queue.length) {
        const c = queue.shift();
        if (excluded.has(c)) continue;
        excluded.add(c);
        for (const gc of children_of.get(c) || []) queue.push(gc);
    }
    return rows
        .filter((r) => !excluded.has(r.pid))
        .map((r) => ({
            pid: r.pid,
            title: parse_display_record(r.display_record).title || '(untitled)',
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
}

/*
 * ---------------------------------------------------------------------------
 * members(collection_pid, filters) — delegates to repository.list,
 * pinning the collection filter so callers can't accidentally bypass it.
 * exclude_collections is pinned too: a "member" is a member OBJECT — a nested
 * sub-collection is browsed via its own row, not listed (or counted) here. This
 * keeps members().total in step with get_collection().member_count + the
 * dashboard member list, all of which now exclude collections.
 * ---------------------------------------------------------------------------
 */
async function members(collection_pid, filters = {}) {
    require_pid(collection_pid);
    return repo_model.list({
        ...filters,
        collection: collection_pid,
        exclude_collections: true,
    });
}

/*
 * ---------------------------------------------------------------------------
 * set_members_publish_state(collection_pid, value)
 * 
 * Scope-based bulk: every active, non-collection member of the given
 * collection has its is_published flipped in a single UPDATE. No pid
 * list is involved so there's no cap — the cost is the same whether
 * the collection has 5 members or 5,000.
 * 
 * Skips object_type='collection' on purpose: a collection record's own
 * publish state is managed via the per-row publish action, not by
 * this scope action. Otherwise "publish all in collection X" would
 * also flip nested sub-collection rows, which is rarely what staff want.
 * ---------------------------------------------------------------------------
 */
async function set_members_publish_state(collection_pid, value) {
    require_pid(collection_pid);
    /*
     * Make sure the collection actually exists before we run a write —
     * staff occasionally typo a PID, and a no-op UPDATE on a bad id
     * would silently succeed.
     */
    const exists = await db()(tables.objects)
        .where({ pid: collection_pid, object_type: 'collection', is_active: 1 })
        .first('id');
    if (!exists) throw new NotFoundError(`Collection ${collection_pid} not found`);

    /*
     * Both publish and suppress dirty: keep the staff workflow
     * single-click. See repository/model.js set_publish_state for
     * the full rationale. Publish → indexer INDEXes each row;
     * suppress → indexer DELETEs each row.
     */
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
    sub_collections,
    members,
    add_members,
    delete_collection,
    move_collection,
    eligible_parents,
    titles_by_pids,
    publish_members,
    suppress_members,
    project,
    parse_display_record,
    ALLOWED_SORTS,
    COLLECTION_FIELDS,
};
