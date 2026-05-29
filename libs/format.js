'use strict';

// Display formatters. Pure functions — no I/O, no logging. Imported
// by EJS templates via locals + by callers that need consistent
// number rendering across the UI.

// Binary unit thresholds — matches what Wasabi / S3 / DuraCloud
// display in their dashboards, and what staff are used to reading.
// (Decimal units render the same size as 0.93x of the binary equivalent,
// which is confusing when cross-referencing.)
const BINARY_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

// Render a byte count as a short human-readable string.
//   12345         → '12.06 KB'
//   8.29e12 bytes → '8.29 TB' (matches v1 dashboard's display)
//   null/NaN      → '—' (em dash; signals "unknown")
//
// `precision` is the number of decimal places shown for the
// non-byte units. Bytes are always rendered as integers — no
// "0.5 bytes" silliness.
function format_bytes(n, { precision = 2 } = {}) {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '—';
    if (v < 1024) return `${Math.round(v)} ${BINARY_UNITS[0]}`;
    let i = 0;
    let cur = v;
    while (cur >= 1024 && i < BINARY_UNITS.length - 1) {
        cur /= 1024;
        i += 1;
    }
    return `${cur.toFixed(precision)} ${BINARY_UNITS[i]}`;
}

// Render an integer with locale-aware grouping separators.
//   12345  → '12,345'   (en-US)
//   null   → '0'        (treats null/undefined as zero)
// Used by every numeric stat card so the rendering is consistent
// regardless of which controller built the locals.
function format_count(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '0';
    return v.toLocaleString('en-US');
}

module.exports = {
    format_bytes,
    format_count,
};
