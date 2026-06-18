'use strict';

// Repository-level stats over tbl_objects.
//
// All queries are simple aggregates against indexed columns
// (is_member_of_collection, is_published, is_active, created). Results
// are cached in-process for 30 seconds — long enough to absorb a refresh
// storm from a dashboard page reload, short enough that the numbers
// feel live. Cache is invalidated by simply letting it expire.

const { LRUCache } = require('lru-cache');

const { db } = require('../config/db');
const tables = require('../config/db_tables');
const { ValidationError } = require('../libs/errors');

const CACHE_TTL_MS = 30_000;
const cache = new LRUCache({ max: 32, ttl: CACHE_TTL_MS });

async function memoized(key, compute) {
    if (cache.has(key)) return cache.get(key);
    const value = await compute();
    cache.set(key, value);
    return value;
}

// Top-line counts. One query, three aggregates.
async function summary() {
    return memoized('summary', async () => {
        const row = await db()(tables.objects)
            .select(
                db().raw('COUNT(*) AS total'),
                db().raw('SUM(CASE WHEN is_published = 1 THEN 1 ELSE 0 END) AS published'),
                db().raw('SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS deleted'),
                db().raw(
                    "SUM(CASE WHEN object_type = 'collection' THEN 1 ELSE 0 END) AS collections"
                ),
                db().raw("SUM(CASE WHEN object_type = 'compound' THEN 1 ELSE 0 END) AS compounds")
            )
            .first();
        return {
            total: Number(row.total || 0),
            published: Number(row.published || 0),
            unpublished:
                Number(row.total || 0) - Number(row.published || 0) - Number(row.deleted || 0),
            deleted: Number(row.deleted || 0),
            collections: Number(row.collections || 0),
            compounds: Number(row.compounds || 0),
        };
    });
}

// Top N collections by object count.
//
// Two-query shape:
//   1. Aggregate by `is_member_of_collection` → top N (pid, count, published).
//   2. Look up each collection row's `display_record` and parse out
//      `title` so the dashboard can render it instead of the raw PID.
//
// The title lookup is a single indexed `whereIn` on `pid`, capped at
// the user-supplied limit (≤ 50). If a collection row doesn't exist
// (orphaned membership) OR its display_record has no title, we leave
// `title: null` so the consumer can fall back to the PID.
//
// Deliberately NOT filtering the title lookup on `is_active=1` — even
// soft-deleted collections should display their title in the count
// list because the count itself includes their children (the
// aggregate is on `is_member_of_collection`, not on collection
// activeness). Keeps the panel readable when a collection is in the
// middle of being curated.
async function by_collection({ limit = 5 } = {}) {
    const n = Number.parseInt(limit, 10);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
        throw new ValidationError('limit must be 1..50');
    }
    return memoized(`by_collection:${n}`, async () => {
        const rows = await db()(tables.objects)
            .select('is_member_of_collection')
            .count({ count: '*' })
            .sum({
                published: db().raw('CASE WHEN is_published = 1 THEN 1 ELSE 0 END'),
            })
            .where({ is_active: 1 })
            .whereNot({ is_member_of_collection: '' })
            .groupBy('is_member_of_collection')
            .orderBy('count', 'desc')
            .limit(n);

        const pids = rows.map((r) => r.is_member_of_collection);
        const titles_by_pid = pids.length > 0
            ? await _titles_for_pids(pids)
            : new Map();

        return rows.map((r) => ({
            collection: r.is_member_of_collection,
            title: titles_by_pid.get(r.is_member_of_collection) || null,
            count: Number(r.count || 0),
            published: Number(r.published || 0),
        }));
    });
}

// Resolve `pid → title` for a batch of collection-membership PIDs.
// Returns a Map; missing/title-less rows are simply absent from the
// Map (the caller falls back to the PID).
async function _titles_for_pids(pids) {
    const rows = await db()(tables.objects)
        .select('pid', 'display_record')
        .whereIn('pid', pids)
        .andWhere({ object_type: 'collection' });
    const out = new Map();
    for (const row of rows) {
        const dr = _safe_parse_display_record(row.display_record);
        const title = _extract_title_from_dr(dr);
        if (title) out.set(row.pid, title);
    }
    return out;
}

// --- display_record helpers ---------------------------------------------
//
// Shared by by_collection() and recent_ingests(). Single parse + a
// pair of extractors keeps both query paths consistent.

function _safe_parse_display_record(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function _extract_title_from_dr(dr) {
    if (!dr || typeof dr !== 'object') return null;
    const title = typeof dr.title === 'string' ? dr.title.trim() : '';
    return title.length > 0 ? title : null;
}

// Latest N ingested objects (active only).
//
// Surfaces `title` parsed from `display_record` so the home-page panel can
// render a human-readable label; `title` is null when the display_record
// has none, and the partial falls back to a shortened pid. (The card was
// simplified to title-only — the former call-number/file-path subtitle was
// dropped, so `call_number` / `file_name` are no longer derived here.)
//
// We strip the raw `display_record` blob from the response (~3KB per row);
// the dashboard partial only needs the derived `title`.
async function recent_ingests({ limit = 5 } = {}) {
    const n = Number.parseInt(limit, 10);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
        throw new ValidationError('limit must be 1..50');
    }
    return memoized(`recent:${n}`, async () => {
        const rows = await db()(tables.objects)
            .select(
                'id',
                'pid',
                'is_member_of_collection',
                'object_type',
                'is_published',
                'display_record',
                'created'
            )
            .where({ is_active: 1 })
            .orderBy('created', 'desc')
            .orderBy('id', 'desc')
            .limit(n);
        return rows.map((row) => {
            const dr = _safe_parse_display_record(row.display_record);
            // eslint-disable-next-line no-unused-vars
            const { display_record, ...rest } = row;
            return {
                ...rest,
                title: _extract_title_from_dr(dr),
            };
        });
    });
}

// Full breakdown for the dedicated /dashboard/stats page. Mirrors v1's
// 12-card layout: collections + objects subcounts, media-type counts,
// current fiscal-year ingests. One query each, all against indexed
// columns. Returned as a flat object keyed for easy template access.
//
// Fiscal year follows DU convention: July 1 → June 30. We compute the
// boundary inside the call so a year rollover at midnight just works
// without any cache busting beyond the normal 30s expiry.
async function extended_summary() {
    return memoized('extended_summary', async () => {
        // Eight count aggregates in two grouped queries — one COUNT
        // per row, one big CASE-heavy aggregate for the rest. Keeps
        // the DB roundtrips bounded regardless of how many cards we
        // surface.
        const counts_row = await db()(tables.objects)
            .select(
                db().raw(
                    "SUM(CASE WHEN object_type = 'collection' AND is_active = 1 THEN 1 ELSE 0 END) " +
                    'AS total_collections'
                ),
                db().raw(
                    "SUM(CASE WHEN object_type = 'collection' AND is_active = 1 AND is_published = 1 " +
                    'THEN 1 ELSE 0 END) AS published_collections'
                ),
                db().raw(
                    "SUM(CASE WHEN object_type = 'object' AND is_active = 1 THEN 1 ELSE 0 END) " +
                    'AS total_objects'
                ),
                db().raw(
                    "SUM(CASE WHEN object_type = 'object' AND is_active = 1 AND is_published = 1 " +
                    'THEN 1 ELSE 0 END) AS published_objects'
                )
            )
            .first();

        // Media-type buckets. Same mime-type lists v1 used; preserving
        // them so the v1 → v2 numbers compare directly.
        const media_row = await db()(tables.objects)
            .select(
                db().raw(
                    "SUM(CASE WHEN is_active = 1 AND mime_type IN ('image/tiff','image/jpeg','image/png') " +
                    'THEN 1 ELSE 0 END) AS images'
                ),
                db().raw(
                    "SUM(CASE WHEN is_active = 1 AND mime_type = 'application/pdf' " +
                    'THEN 1 ELSE 0 END) AS pdfs'
                ),
                db().raw(
                    "SUM(CASE WHEN is_active = 1 AND mime_type IN ('audio/x-wav','audio/mpeg') " +
                    'THEN 1 ELSE 0 END) AS audio'
                ),
                db().raw(
                    "SUM(CASE WHEN is_active = 1 AND mime_type IN ('video/mp4','video/quicktime','video/mpeg') " +
                    'THEN 1 ELSE 0 END) AS videos'
                )
            )
            .first();

        // Fiscal-year ingests: July 1 of (current FY start year) to
        // June 30 of (current FY end year). For today = Aug 2026,
        // FY 2027 = 2026-07-01 to 2027-06-30. For today = Mar 2026,
        // FY 2026 = 2025-07-01 to 2026-06-30.
        const { start, end } = _current_fiscal_year_bounds();
        const fy_row = await db()(tables.objects)
            .where({ is_active: 1 })
            .whereBetween('created', [start, end])
            .count({ n: '*' })
            .first();

        return {
            total_collections: Number(counts_row.total_collections || 0),
            published_collections: Number(counts_row.published_collections || 0),
            total_objects: Number(counts_row.total_objects || 0),
            published_objects: Number(counts_row.published_objects || 0),
            images: Number(media_row.images || 0),
            pdfs: Number(media_row.pdfs || 0),
            audio: Number(media_row.audio || 0),
            videos: Number(media_row.videos || 0),
            current_fy_ingests: Number(fy_row.n || 0),
            current_fy_label: _fy_label(start, end),
        };
    });
}

// Ingests per calendar year, all object types, active + inactive
// (v1 counted everything to show throughput, not just leaf objects).
//
// `min_year` defaults to 2020 to match v1's chart range. We pad
// missing years with zero so the chart x-axis is contiguous —
// the consumer (EJS template) doesn't need to fill gaps itself.
async function ingests_per_year({ min_year = 2020 } = {}) {
    const min = Number.parseInt(min_year, 10);
    if (!Number.isFinite(min) || min < 2000 || min > 2100) {
        throw new ValidationError('min_year must be 2000..2100');
    }
    return memoized(`ingests_per_year:${min}`, async () => {
        // Year extraction SQL differs by driver:
        //   MariaDB / MySQL: YEAR(created)
        //   SQLite (tests):  CAST(strftime('%Y', created) AS INTEGER)
        // Dispatch on the knex client name once at query time rather
        // than try/catching — keeps the failure mode clean if the
        // first form is rejected for an unrelated reason (perms,
        // missing column, etc.).
        const client = db().client.config.client;
        const year_sql =
            client === 'mysql' || client === 'mysql2'
                ? 'YEAR(created)'
                : "CAST(strftime('%Y', created) AS INTEGER)";
        const rows = await db()(tables.objects)
            .select(db().raw(`${year_sql} AS year`))
            .count({ count: '*' })
            .whereRaw(`${year_sql} >= ?`, [min])
            .groupByRaw(year_sql)
            .orderBy('year', 'asc');

        // Pad gaps so the chart x-axis is contiguous from `min` to
        // the latest data point. If there's no data at all, return
        // a single zero row for the current year so the chart still
        // renders sensibly.
        const this_year = new Date().getFullYear();
        const by_year = new Map(
            rows.map((r) => [Number(r.year), Number(r.count || 0)])
        );
        const max = Math.max(this_year, ...by_year.keys(), min);
        const out = [];
        for (let y = min; y <= max; y++) {
            out.push({ year: y, count: by_year.get(y) || 0 });
        }
        return out;
    });
}

function _current_fiscal_year_bounds(today = new Date()) {
    // FY N runs from July 1 of (N-1) to June 30 of N. So if today is
    // Jan-Jun, we're in FY (current calendar year). If Jul-Dec, we're
    // in FY (current calendar year + 1).
    const y = today.getFullYear();
    const in_second_half = today.getMonth() >= 6; // months are 0-indexed; July = 6
    const start_year = in_second_half ? y : y - 1;
    const end_year = in_second_half ? y + 1 : y;
    // Use YYYY-MM-DD strings — DB drivers handle the timestamp
    // comparison correctly without us picking a timezone for them.
    return {
        start: `${start_year}-07-01 00:00:00`,
        end: `${end_year}-06-30 23:59:59`,
        start_year,
        end_year,
    };
}

function _fy_label(start, end) {
    // start/end are 'YYYY-MM-DD HH:MM:SS' from _current_fiscal_year_bounds.
    return `Jul 1, ${start.slice(0, 4)} – Jun 30, ${end.slice(0, 4)}`;
}

// Active user count. Cheap aggregate, but cached so the home page
// doesn't ping tbl_users separately.
async function active_users() {
    return memoized('active_users', async () => {
        const row = await db()(tables.users).where({ is_active: 1 }).count({ n: '*' }).first();
        return Number(row.n || 0);
    });
}

// Test-only — drops the in-process cache so independent tests don't
// observe each other's reads.
function _reset() {
    cache.clear();
}

module.exports = {
    summary,
    extended_summary,
    ingests_per_year,
    by_collection,
    recent_ingests,
    active_users,
    _reset,
    _current_fiscal_year_bounds,
    CACHE_TTL_MS,
};
