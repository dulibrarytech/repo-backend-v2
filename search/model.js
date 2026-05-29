'use strict';

// Object search over tbl_objects.
//
// MariaDB-backed LIKE search across the small/indexed columns:
// pid, handle, mods_id, file_name, sip_uuid, is_member_of_collection.
// We deliberately do NOT scan the long-text columns (mods,
// display_record, transcript, transcript_search) — they're huge and
// unindexed; that's the ES indexer's job. Phase 8 will swap this
// implementation with an ES-backed one behind the same interface.
//
// Filters available alongside `q`:
//   collection      — exact match on is_member_of_collection
//   object_type     — closed set: object | collection | compound
//   is_published    — boolean
//   is_active       — boolean (defaults to true)

const validator = require('validator');

const { db } = require('../config/db');
const tables = require('../config/db_tables');
const { ValidationError } = require('../libs/errors');

const ALLOWED_OBJECT_TYPES = new Set(['object', 'collection', 'compound']);

const SEARCHABLE_COLUMNS = [
    'pid',
    'handle',
    'mods_id',
    'file_name',
    'sip_uuid',
    'is_member_of_collection',
];

const PUBLIC_FIELDS = [
    'id',
    'pid',
    'handle',
    'uri',
    'is_member_of_collection',
    'object_type',
    'mime_type',
    'file_name',
    'thumbnail',
    'is_published',
    'is_restricted',
    'is_active',
    'is_compound',
    'is_indexed',
    'sip_uuid',
    'created',
    // display_record drives the dashboard's title/handle/uri columns.
    // Same rationale as repository/model.js: enrich at render time.
    'display_record',
];

function clamp_int(value, fallback, min, max) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// Validate + normalize the search payload. Returns the cleaned filter
// object; throws ValidationError for malformed input.
function normalize(filter = {}) {
    const out = {};
    if (filter.q !== undefined && filter.q !== null) {
        const q = String(filter.q).trim();
        // Reject lone wildcards — they'd scan the whole table without
        // hitting any index. Empty q = "no text filter" not "match all".
        if (q.length > 0 && q.replace(/[%_*]/g, '').length === 0) {
            throw new ValidationError('Search term must contain non-wildcard characters');
        }
        if (q.length > 200) {
            throw new ValidationError('Search term too long');
        }
        out.q = q;
    }
    if (filter.collection !== undefined && filter.collection !== '') {
        out.collection = String(filter.collection).trim();
    }
    if (filter.object_type !== undefined && filter.object_type !== '') {
        const t = String(filter.object_type).trim();
        if (!ALLOWED_OBJECT_TYPES.has(t)) {
            throw new ValidationError(
                `object_type must be one of ${[...ALLOWED_OBJECT_TYPES].join(', ')}`
            );
        }
        out.object_type = t;
    }
    if (filter.is_published !== undefined && filter.is_published !== '') {
        out.is_published = Boolean(filter.is_published);
    }
    if (filter.is_active !== undefined && filter.is_active !== '') {
        out.is_active = Boolean(filter.is_active);
    } else {
        out.is_active = true; // hide soft-deleted by default
    }
    out.page = clamp_int(filter.page, 1, 1, 10_000);
    out.page_size = clamp_int(filter.page_size, 25, 1, 200);
    return out;
}

// LIKE-escape: a user-supplied `q` may contain SQL LIKE wildcards
// (%, _) that they didn't intend. Escape them so the search matches
// the literal characters.
function escape_like(value) {
    return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// `q` is matched as a case-insensitive substring against each
// searchable column. UUIDs are caught by the pid/sip_uuid match;
// handle URLs are caught by the handle match; file names by file_name.
function apply_text_search(query_builder, q) {
    if (!q || q.length === 0) return;
    const needle = '%' + escape_like(q) + '%';
    query_builder.where((sub) => {
        for (const col of SEARCHABLE_COLUMNS) {
            // sqlite is case-insensitive on ASCII by default; mysql
            // collations vary. Using LIKE keeps both engines happy.
            sub.orWhereILike ? sub.orWhereILike(col, needle) : sub.orWhere(col, 'LIKE', needle);
        }
    });
}

function apply_filters(qb, f) {
    if (f.collection) qb.where({ is_member_of_collection: f.collection });
    if (f.object_type) qb.where({ object_type: f.object_type });
    if (f.is_published !== undefined) qb.where({ is_published: f.is_published ? 1 : 0 });
    if (f.is_active !== undefined) qb.where({ is_active: f.is_active ? 1 : 0 });
}

async function search(filter = {}) {
    const f = normalize(filter);

    const data_q = db()(tables.objects).select(PUBLIC_FIELDS);
    apply_filters(data_q, f);
    apply_text_search(data_q, f.q);

    const count_q = data_q.clone().clearSelect().clearOrder().count({ total: '*' }).first();

    data_q
        .orderBy('id', 'desc')
        .limit(f.page_size)
        .offset((f.page - 1) * f.page_size);

    const [rows, count] = await Promise.all([data_q, count_q]);
    return {
        q: f.q || '',
        page: f.page,
        page_size: f.page_size,
        total: Number(count.total || 0),
        items: rows,
    };
}

// Lightweight UUID-aware lookup used by suggest/autocomplete in the
// future. For now exposed mainly so callers don't have to reimplement
// the wildcard guard.
async function quick_lookup(q) {
    if (typeof q !== 'string' || q.length < 3) return [];
    if (validator.isUUID(q)) {
        return db()(tables.objects).select(PUBLIC_FIELDS).where({ pid: q }).limit(5);
    }
    const needle = '%' + escape_like(q.trim()) + '%';
    return db()(tables.objects)
        .select(PUBLIC_FIELDS)
        .where(function () {
            this.where('file_name', 'LIKE', needle)
                .orWhere('handle', 'LIKE', needle)
                .orWhere('is_member_of_collection', 'LIKE', needle);
        })
        .where({ is_active: 1 })
        .limit(10);
}

module.exports = {
    search,
    quick_lookup,
    normalize,
    ALLOWED_OBJECT_TYPES,
    SEARCHABLE_COLUMNS,
    PUBLIC_FIELDS,
    _escape_like: escape_like,
};
