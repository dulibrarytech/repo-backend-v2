'use strict';

/*
 * ArchivesSpace record validator. Direct port of v1's
 * libs/metadata_validation.js with one rename: the function is named
 * `validate_record` here (the v1 name `validate_record_metadata` was
 * confusing — the "record" IS metadata).
 * 
 * This is the single source of truth for "is an AS record safe to
 * ingest?" Two consumers must agree:
 * 
 *   1. The ingest worker's process_metadata stage (Phase 3). On any
 *      error returned here, the worker halts the row with
 *      AS_METADATA_INVALID and stops — no Archivematica activity
 *      happens, so no rollback is needed.
 * 
 *   2. The dashboard's ASpace Description QA view. It runs the same
 *      validator pre-ingest so staff see the exact errors they'd hit
 *      at ingest time. The QA view's promise is "what you see here is
 *      what the ingest will check"; both callers MUST stay in sync.
 * 
 * Rules (all v1-compatible; do NOT change without coordinating with
 * the dashboard QA view):
 * 
 *   - title: required, non-empty
 *   - uri: required, non-empty
 *   - identifiers: required, non-empty array
 *   - notes: required, non-empty; among them an abstract + a
 *     userestrict (rights statement) note must each have content
 *   - dates[].expression: every date must have an expression
 *   - is_compound=true → parts.length >= 2
 *   - parts: required, non-empty; every part must have a non-empty
 *     type (mime type)
 */

function validate_record(metadata) {
    const errors = [];

    if (!metadata) {
        errors.push('Metadata is missing or empty');
        return errors;
    }

    if (is_empty(metadata.title)) errors.push('Title field is missing');
    if (is_empty(metadata.uri)) errors.push('URI field is missing');

    if (is_empty_array(metadata.identifiers)) {
        errors.push('Identifier field is missing');
    }

    if (is_empty_array(metadata.notes)) {
        errors.push(
            'Notes field is missing - The notes field contains the abstract and rights statement'
        );
    } else {
        for (const note of metadata.notes) {
            if (note && note.type === 'abstract' && is_empty(note.content)) {
                errors.push('Abstract field is missing');
            }
            if (note && note.type === 'userestrict' && is_empty(note.content)) {
                errors.push('Rights statement field is missing');
            }
        }
    }

    if (Array.isArray(metadata.dates)) {
        for (const date of metadata.dates) {
            if (!date || is_empty(date.expression)) {
                errors.push('Date expression is missing');
            }
        }
    }

    if (metadata.is_compound === true) {
        if (!Array.isArray(metadata.parts) || metadata.parts.length < 2) {
            errors.push('Compound objects are missing');
        }
    }

    if (is_empty_array(metadata.parts)) {
        errors.push('Parts is missing');
    } else {
        for (const part of metadata.parts) {
            if (!part || is_empty(part.type)) {
                const title = part && part.title ? part.title : '?';
                errors.push(`Mime-type is missing (${title})`);
            }
        }
    }

    return errors;
}

function is_empty(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return v.length === 0;
    if (Array.isArray(v)) return v.length === 0;
    return false;
}

function is_empty_array(v) {
    return v === undefined || v === null || !Array.isArray(v) || v.length === 0;
}

module.exports = { validate_record };
