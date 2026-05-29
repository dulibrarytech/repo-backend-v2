'use strict';

const collections_model = require('../../../collections/model');

describe('collections/model — parse_display_record', () => {
    const parse = collections_model.parse_display_record;

    it('returns {} for null/undefined/empty', () => {
        expect(parse(null)).toEqual({});
        expect(parse(undefined)).toEqual({});
        expect(parse('')).toEqual({});
    });

    it('parses a valid JSON string', () => {
        expect(parse('{"title":"X","thumbnail":"t"}')).toEqual({ title: 'X', thumbnail: 't' });
    });

    it('passes through an already-parsed object', () => {
        const obj = { title: 'X' };
        expect(parse(obj)).toBe(obj);
    });

    it('returns {} for invalid JSON (no throw)', () => {
        expect(parse('{not json}')).toEqual({});
        expect(parse('{"unterminated":')).toEqual({});
    });

    it('returns {} for a non-object JSON literal', () => {
        expect(parse('"just a string"')).toEqual({});
        expect(parse('42')).toEqual({});
        expect(parse('null')).toEqual({});
    });
});

describe('collections/model — project', () => {
    const project = collections_model.project;

    it('extracts title + thumbnail from display_record', () => {
        const row = {
            id: 1,
            pid: 'p',
            display_record: JSON.stringify({
                title: 'JCRS',
                thumbnail: 'tn-uuid',
                handle: 'https://hdl/x',
                abstract: '<p>The Jewish Consumptives...</p>',
                f_subjects: ['Tuberculosis', null, 'Jewish history'],
                mime_type: 'image/tiff',
            }),
        };
        const p = project(row);
        expect(p.title).toBe('JCRS');
        // The stored value is a dip-store-relative path, so the
        // projection rewrites `thumbnail` to point at the DuraCloud
        // proxy. The literal stored value is preserved as
        // `thumbnail_raw` for the upload modal / debuggers.
        expect(p.thumbnail_raw).toBe('tn-uuid');
        expect(p.thumbnail).toBe('/repo/dashboard/objects/p/thumbnail/raw');
        expect(p.handle).toBe('https://hdl/x');
        expect(p.abstract).toContain('Jewish Consumptives');
        expect(p.subjects).toEqual(['Tuberculosis', 'Jewish history']); // nulls dropped
        expect(p.mime_type).toBe('image/tiff');
    });

    it('falls back to DB columns when display_record is missing', () => {
        const row = {
            id: 1,
            pid: 'p',
            handle: 'db-handle',
            thumbnail: 'db-tn',
            display_record: null,
        };
        const p = project(row);
        expect(p.handle).toBe('db-handle');
        // Same rewrite — `db-tn` isn't an http URL, so the proxy URL
        // gets synthesized; raw value preserved for round-tripping.
        expect(p.thumbnail_raw).toBe('db-tn');
        expect(p.thumbnail).toBe('/repo/dashboard/objects/p/thumbnail/raw');
        expect(p.title).toBeNull();
    });

    it('handles array-typed abstract by taking the first string', () => {
        const row = {
            pid: 'p',
            display_record: JSON.stringify({ abstract: ['first paragraph', 'second'] }),
        };
        expect(project(row).abstract).toBe('first paragraph');
    });

    it('does NOT leak the long-text columns in the projection', () => {
        const row = {
            pid: 'p',
            display_record: JSON.stringify({
                title: 't',
                mods: '<giant XML>',
                transcript: 'long text',
            }),
        };
        const p = project(row);
        // We only surface known fields; mods/transcript intentionally
        // not enumerated.
        expect(p.mods).toBeUndefined();
        expect(p.transcript).toBeUndefined();
    });

    it('survives a row whose display_record is malformed', () => {
        const row = { pid: 'p', display_record: '{not parseable' };
        const p = project(row);
        expect(p.pid).toBe('p');
        expect(p.title).toBeNull();
    });
});

describe('collections/model — closed sets', () => {
    it('ALLOWED_SORTS matches what list_collections accepts', () => {
        expect([...collections_model.ALLOWED_SORTS].sort()).toEqual(['count', 'recent', 'title']);
    });

    it('COLLECTION_FIELDS does not pull mods/transcript long-text', () => {
        for (const f of ['mods', 'transcript', 'transcript_search']) {
            expect(collections_model.COLLECTION_FIELDS).not.toContain(f);
        }
    });
});
