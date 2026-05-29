'use strict';

// XSS sanitization for request bodies and query strings.
//
// Strategy:
//   - String values are run through DOMPurify with `ALLOWED_TAGS: []`
//     (strip everything) then validator.escape (HTML-entity-encode
//     anything that survived). Belt and braces.
//   - Numbers, booleans, null, undefined pass through unchanged.
//   - Arrays and plain objects are walked recursively.
//   - Buffers and other typed instances are left alone.
//
// Mutates `req.body` and `req.query` in place. Run AFTER body parsers,
// BEFORE route handlers.

const validator = require('validator');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

function clean_string(value) {
    if (typeof value !== 'string' || value.length === 0) return value;
    // Order matters (matches legacy libs/dom.js):
    //   1. trim trailing whitespace (UX, harmless)
    //   2. validator.escape — HTML-entity-encodes <, >, &, ", ', /
    //      After this step, the string has no live tags left for any
    //      browser parser; safe to render in either HTML or attribute
    //      context with <%- %>.
    //   3. DOMPurify — defense in depth. With everything already
    //      entity-encoded there are no real tags to strip, so this is
    //      mostly a no-op but catches anything our escape missed.
    //
    // Reversing 2 and 3 (DOMPurify first) causes `&` to be double-
    // encoded into `&amp;amp;`, breaking display of stored data.
    const trimmed = validator.trim(value);
    const escaped = validator.escape(trimmed);
    return DOMPurify.sanitize(escaped, {
        ALLOWED_TAGS: [],
        ALLOWED_ATTR: [],
        KEEP_CONTENT: true,
    });
}

function is_plain_object(value) {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return false;
    // Use the prototype, not value.constructor — the latter is itself
    // a property an attacker can shadow with a payload like
    // `{"constructor": {"x":1}}`, which would otherwise slip past us.
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function clean_value(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return clean_string(value);
    if (Array.isArray(value)) return value.map(clean_value);
    if (is_plain_object(value)) {
        const out = {};
        for (const key of Object.keys(value)) {
            // Reject prototype pollution attempts at the boundary.
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            out[key] = clean_value(value[key]);
        }
        return out;
    }
    return value;
}

function req_body(req, _res, next) {
    if (req.body && typeof req.body === 'object') {
        req.body = clean_value(req.body);
    }
    next();
}

function req_query(req, _res, next) {
    if (req.query && typeof req.query === 'object') {
        const cleaned = clean_value(req.query);
        // Express 5 defines req.query as a getter backed by the query
        // parser — direct mutation (assignment, delete) doesn't persist.
        // Redefine it as a plain data property holding the cleaned value
        // so every downstream handler sees the sanitized form.
        Object.defineProperty(req, 'query', {
            value: cleaned,
            writable: true,
            configurable: true,
            enumerable: true,
        });
    }
    next();
}

// Express middleware: reject any path param that's supposed to be a UUID
// but isn't. Avoids handing garbage to downstream DB lookups.
function validate_uuid(req, _res, next) {
    const candidates = ['uuid', 'pid', 'id'];
    for (const key of candidates) {
        const v = req.params && req.params[key];
        if (v && !validator.isUUID(String(v))) {
            const err = new Error(`Invalid UUID for path param "${key}"`);
            err.status = 400;
            err.code = 'INVALID_UUID';
            return next(err);
        }
    }
    next();
}

module.exports = {
    clean_string,
    clean_value,
    req_body,
    req_query,
    validate_uuid,
};
