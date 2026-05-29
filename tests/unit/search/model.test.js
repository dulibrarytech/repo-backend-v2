'use strict';

const search_model = require('../../../search/model');
const { ValidationError } = require('../../../libs/errors');

describe('search/model — input normalization', () => {
    it('defaults page=1 page_size=25, hides inactive', () => {
        const f = search_model.normalize({});
        expect(f.page).toBe(1);
        expect(f.page_size).toBe(25);
        expect(f.is_active).toBe(true);
        expect(f.q).toBeUndefined();
    });

    it('caps page_size at 200', () => {
        expect(search_model.normalize({ page_size: 9999 }).page_size).toBe(200);
    });

    it('caps page_size at >= 1', () => {
        expect(search_model.normalize({ page_size: 0 }).page_size).toBe(1);
        expect(search_model.normalize({ page_size: -5 }).page_size).toBe(1);
    });

    it('accepts a normal text query', () => {
        const f = search_model.normalize({ q: 'photo' });
        expect(f.q).toBe('photo');
    });

    it('rejects a wildcard-only query', () => {
        expect(() => search_model.normalize({ q: '%%%' })).toThrow(ValidationError);
        expect(() => search_model.normalize({ q: '__' })).toThrow(ValidationError);
        expect(() => search_model.normalize({ q: '***' })).toThrow(ValidationError);
    });

    it('rejects an over-long query (>200 chars)', () => {
        expect(() => search_model.normalize({ q: 'a'.repeat(201) })).toThrow(ValidationError);
    });

    it('rejects an unknown object_type', () => {
        expect(() => search_model.normalize({ object_type: 'video' })).toThrow(ValidationError);
    });

    it('accepts allowed object_types', () => {
        for (const t of ['object', 'collection', 'compound']) {
            expect(search_model.normalize({ object_type: t }).object_type).toBe(t);
        }
    });
});

describe('search/model — LIKE escape', () => {
    it('escapes % and _ wildcards', () => {
        const out = search_model._escape_like('100% _yes_');
        expect(out).toBe('100\\% \\_yes\\_');
    });

    it('escapes literal backslashes too', () => {
        expect(search_model._escape_like('a\\b')).toBe('a\\\\b');
    });

    it('leaves normal text alone', () => {
        expect(search_model._escape_like('codu:root')).toBe('codu:root');
    });
});

describe('search/model — closed sets', () => {
    it('ALLOWED_OBJECT_TYPES matches the documented set', () => {
        expect([...search_model.ALLOWED_OBJECT_TYPES].sort()).toEqual([
            'collection',
            'compound',
            'object',
        ]);
    });

    it('PUBLIC_FIELDS does not leak long-text columns', () => {
        // display_record is intentionally fetched so the controller can
        // enrich rows (title, handle, uri) and then strip it from the
        // response. mods/transcript stay out entirely.
        for (const f of ['mods', 'transcript', 'transcript_search']) {
            expect(search_model.PUBLIC_FIELDS).not.toContain(f);
        }
    });

    it('SEARCHABLE_COLUMNS only touches indexed/small columns', () => {
        for (const c of search_model.SEARCHABLE_COLUMNS) {
            expect(['mods', 'display_record', 'transcript']).not.toContain(c);
        }
    });
});
