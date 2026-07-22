'use strict';

/*
 * Object search over tbl_objects.
 * 
 * MariaDB-backed LIKE search. Two tiers of columns:
 * 
 *   1. Small/indexed identity columns — pid, handle, mods_id,
 *      file_name, sip_uuid, is_member_of_collection. Cheap to match.
 * 
 *   2. display_record — the denormalized JSON envelope the dashboard
 *      renders from. It carries title, abstract, subjects, names,
 *      dates AND the full nested metadata record, so matching it lets
 *      staff search by ANYTHING shown on an object (the #1 thing they
 *      actually search by — title — lives only here, never in a
 *      dedicated column). This is a long-text column with no index, so
 *      the match is a table scan; that's an accepted cost for the
 *      staff dashboard search (NOT the public path — that's ES). The
 *      transcript/transcript_search/mods blobs stay OUT: transcripts
 *      are huge and noisy, and mods duplicates what display_record
 *      already nests. Phase 8 swaps this whole implementation for an
 *      ES-backed one (with real stemming) behind the same interface.
 * 
 * Query handling: `q` is split into whitespace tokens; each token must
 * match (AND) somewhere in the searchable set (OR across columns), so
 * word order doesn't matter and "Former patient" matches a title like
 * "Former patient in Ford county ..." even with words between them. A
 * light singularization (trailing "s" → stem) lets a plural query like
 * "patients" match a stored "patient". This BROADENS recall (never
 * hides a hit) — the safe direction for a lookup tool; precise
 * stemming is the ES search's job.
 * 
 * Filters available alongside `q`:
 *   collection      — exact match on is_member_of_collection
 *   object_type     — closed set: object | collection | compound
 *   is_published    — boolean
 *   is_active       — boolean (defaults to true)
 */

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
    /*
     * Long-text JSON envelope — title/abstract/subjects/names/dates +
     * the full nested record. Unindexed (table scan); see module
     * docstring for the rationale + the ES migration note.
     */
    'display_record',
];

/*
 * Cap on tokens per query so a pathological 40-word search (q is
 * capped at 200 chars in normalize) can't fan out into 40 ANDed
 * table-scan predicates. 12 is far more than any real staff query.
 */
const MAX_QUERY_TOKENS = 12;

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
    /*
     * display_record drives the dashboard's title/handle/uri columns.
     * Same rationale as repository/model.js: enrich at render time.
     */
    'display_record',
];

function clamp_int(value, fallback, min, max) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/*
 * Validate + normalize the search payload. Returns the cleaned filter
 * object; throws ValidationError for malformed input.
 */
function normalize(filter = {}) {
    const out = {};
    if (filter.q !== undefined && filter.q !== null) {
        const q = String(filter.q).trim();
        /*
         * Reject lone wildcards — they'd scan the whole table without
         * hitting any index. Empty q = "no text filter" not "match all".
         */
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
    if (
        filter.not_member_of_collection !== undefined &&
        filter.not_member_of_collection !== ''
    ) {
        out.not_member_of_collection = String(filter.not_member_of_collection).trim();
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
    if (filter.exclude_collections) out.exclude_collections = true;
    out.page = clamp_int(filter.page, 1, 1, 10_000);
    out.page_size = clamp_int(filter.page_size, 25, 1, 200);
    return out;
}

/*
 * LIKE-escape: a user-supplied `q` may contain SQL LIKE wildcards
 * (%, _) that they didn't intend. Escape them so the search matches
 * the literal characters.
 */
function escape_like(value) {
    return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/*
 * Split a query into whitespace-delimited tokens, capped at
 * MAX_QUERY_TOKENS. Empty fragments (from runs of whitespace) drop out.
 */
function tokenize(q) {
    return q
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, MAX_QUERY_TOKENS);
}

/*
 * Light singularization. Collapses a single trailing plural "s" so a
 * query token like "patients" becomes "patient" — and because we match
 * as a substring, that stem also matches the plural form in stored
 * data ("patient" ⊂ "patients"). So one stemmed needle covers both
 * singular and plural. Rules:
 *   - only tokens longer than 3 chars (don't mangle "is", "los", IDs)
 *   - the char before the trailing "s" must be a letter/digit
 *   - skip words ending in "ss" ("class", "address") — stripping there
 *     reads wrong and the substring match already covers them
 * This can only BROADEN matches (the stem is a substring of the
 * original token), so it never hides the row the user is looking for.
 */
function stem_token(token) {
    if (token.length > 3 && /[a-z0-9]s$/i.test(token) && !/ss$/i.test(token)) {
        return token.slice(0, -1);
    }
    return token;
}

/*
 * `q` is tokenized; each token must match (AND) as a case-insensitive
 * substring in at least one searchable column (OR across columns).
 * Identity columns (pid/sip_uuid/handle/file_name) catch UUIDs, handle
 * URLs, and filenames; display_record catches title + all descriptive
 * metadata. Successive query_builder.where() calls AND together, so the
 * per-token OR-groups combine as (tokenA) AND (tokenB) AND ...
 */
function apply_text_search(query_builder, q) {
    if (!q || q.length === 0) return;
    const tokens = tokenize(q);
    if (tokens.length === 0) return;
    for (const token of tokens) {
        const needle = '%' + escape_like(stem_token(token)) + '%';
        query_builder.where((sub) => {
            for (const col of SEARCHABLE_COLUMNS) {
                /*
                 * sqlite is case-insensitive on ASCII by default; mysql
                 * collations vary. Using LIKE keeps both engines happy.
                 */
                sub.orWhereILike
                    ? sub.orWhereILike(col, needle)
                    : sub.orWhere(col, 'LIKE', needle);
            }
        });
    }
}

function apply_filters(qb, f) {
    if (f.collection) qb.where({ is_member_of_collection: f.collection });
    if (f.object_type) qb.where({ object_type: f.object_type });
    if (f.is_published !== undefined) qb.where({ is_published: f.is_published ? 1 : 0 });
    if (f.is_active !== undefined) qb.where({ is_active: f.is_active ? 1 : 0 });
    /*
     * Used by the collection-detail member list so a nested sub-collection
     * doesn't appear among the parent's member objects.
     */
    if (f.exclude_collections) qb.whereNot({ object_type: 'collection' });
    /*
     * Used by the add-objects picker: exclude rows already in the target
     * collection so its current members aren't offered again (and so the
     * paginated total reflects only eligible candidates).
     */
    if (f.not_member_of_collection) {
        qb.whereNot({ is_member_of_collection: f.not_member_of_collection });
    }
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

/*
 * Lightweight UUID-aware lookup used by suggest/autocomplete in the
 * future. For now exposed mainly so callers don't have to reimplement
 * the wildcard guard.
 */
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
    _tokenize: tokenize,
    _stem_token: stem_token,
};
