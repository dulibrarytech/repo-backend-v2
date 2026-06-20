'use strict';

// Shared row-enrichment helpers. Used by the dashboard and the
// collections domain to surface display_record JSON fields alongside
// the bare DB columns.
//
// Lives in libs/ because both collections/model.js and dashboard/
// need it; importing across domains would couple the dashboard
// to the collections module, which it otherwise has no reason to know
// about.

const app_config = require('../config/app');

function parse_display_record(raw) {
    if (raw === null || raw === undefined || raw === '') return {};
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function first_string(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return '';
}

// Decide what URL to put in the rendered <img src>. There are three
// shapes a stored `thumbnail` value can take:
//
//   1. Empty/null → return null so the caller renders a placeholder.
//   2. Absolute http(s) URL → use as-is. Covers uploaded thumbnails
//      we serve from /repo/static/tn/<pid>.jpg AND any future CDN
//      URLs an admin sets directly.
//   3. Anything else → treat as a DuraCloud dip-store-relative path
//      (the shape the ingest service writes). Rewrite the value to
//      point at our proxy route so the browser can fetch it through
//      the dashboard's authenticated session. The proxy looks up the
//      row, performs the DC fetch with Basic auth in headers, and
//      pipes bytes back.
//
// Note: needs `pid` because the proxy is keyed by pid (the path
// inside the DB row isn't safe to put in a URL — it's user-controlled
// at ingest time and could contain path-traversal segments).
function thumbnail_src(raw, pid) {
    if (!raw || typeof raw !== 'string') return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!pid) return null;
    const cfg = app_config();
    return `${cfg.path}/dashboard/objects/${pid}/thumbnail/raw`;
}

// Enrich a raw object row with the small set of display_record fields
// the dashboard needs. Does NOT replace the original row — adds keys.
// The big `display_record` blob is dropped from the result so callers
// don't accidentally serialize 3KB per row to the browser.
// Map a master-file mime_type to a coarse media category, used by the
// dashboard to pick a default-thumbnail icon when an object has no real
// thumbnail derivative. Audio / video / PDF read distinctly from images;
// unknown or absent → 'file' (a generic document icon).
function media_category(mime_type) {
    const m = typeof mime_type === 'string' ? mime_type.trim().toLowerCase() : '';
    if (!m) return 'file';
    if (m === 'application/pdf') return 'pdf';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('image/')) return 'image';
    return 'file';
}

function enrich(row) {
    if (!row) return row;
    const dr = parse_display_record(row.display_record);
    // Strip the raw JSON column so payloads stay lean
    // eslint-disable-next-line no-unused-vars
    const { display_record, ...rest } = row;
    // Handle and thumbnail can live in either the DB column or the
    // parsed JSON. The indexer writes display_record after the row
    // is fully assembled — it's the more reliable copy when they
    // disagree, so prefer it. Fall back to the column when the
    // legacy ingest pipeline didn't populate display_record (rare
    // but present in fixtures + dev data).
    const raw_thumbnail = dr.thumbnail || rest.thumbnail || null;
    return {
        ...rest,
        title: dr.title || null,
        abstract: first_string(dr.abstract),
        handle: dr.handle || rest.handle || null,
        // Keep the raw value so debuggers and the upload modal can
        // see what's stored, but synthesize the proxy URL for the
        // EJS partial via `thumbnail`. The partial uses `thumbnail`
        // unchanged; the upload modal can still inspect `thumbnail_raw`
        // if it ever needs to.
        thumbnail_raw: raw_thumbnail,
        thumbnail: thumbnail_src(raw_thumbnail, rest.pid),
        media_category: media_category(rest.mime_type),
        subjects: Array.isArray(dr.f_subjects) ? dr.f_subjects.filter(Boolean) : [],
    };
}

function enrich_all(rows) {
    if (!Array.isArray(rows)) return rows;
    return rows.map(enrich);
}

// Is a display_record value "empty" for display purposes? Used by the
// metadata modal to skip blank fields. 0 and false are NOT empty (they're
// meaningful values); only nullish/blank-string/empty-or-all-empty
// arrays/objects are.
function is_empty_value(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim().length === 0;
    if (typeof v === 'number' || typeof v === 'boolean') return false;
    if (Array.isArray(v)) return v.every(is_empty_value);
    if (typeof v === 'object') return Object.keys(v).every((k) => is_empty_value(v[k]));
    return false;
}

module.exports = {
    parse_display_record,
    first_string,
    thumbnail_src,
    media_category,
    enrich,
    enrich_all,
    is_empty_value,
};
