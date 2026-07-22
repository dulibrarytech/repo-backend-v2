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
        /*
         * display_record is intentionally fetched so the controller can
         * enrich rows (title, handle, uri) and then strip it from the
         * response. mods/transcript stay out entirely.
         */
        for (const f of ['mods', 'transcript', 'transcript_search']) {
            expect(search_model.PUBLIC_FIELDS).not.toContain(f);
        }
    });

    it('SEARCHABLE_COLUMNS includes display_record but excludes the heavy blobs', () => {
        /*
         * display_record is intentionally searchable — it carries the
         * title + all descriptive metadata, which is what staff search
         * by. transcript/transcript_search/mods stay out: transcripts
         * are huge + noisy, mods duplicates what display_record nests.
         */
        expect(search_model.SEARCHABLE_COLUMNS).toContain('display_record');
        for (const c of ['mods', 'transcript', 'transcript_search']) {
            expect(search_model.SEARCHABLE_COLUMNS).not.toContain(c);
        }
    });
});

describe('search/model — tokenize', () => {
    it('splits on whitespace and drops empty fragments', () => {
        expect(search_model._tokenize('Former patients')).toEqual(['Former', 'patients']);
        expect(search_model._tokenize('  Former   patients  ')).toEqual(['Former', 'patients']);
    });

    it('caps the token count', () => {
        const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
        expect(search_model._tokenize(many).length).toBe(12);
    });
});

describe('search/model — stem_token (light singularization)', () => {
    it('strips a trailing plural s on long-enough tokens', () => {
        expect(search_model._stem_token('patients')).toBe('patient');
        expect(search_model._stem_token('objects')).toBe('object');
        expect(search_model._stem_token('collections')).toBe('collection');
    });

    it('leaves short tokens and non-plural words alone', () => {
        expect(search_model._stem_token('is')).toBe('is'); // too short
        expect(search_model._stem_token('los')).toBe('los'); // too short (3)
        expect(search_model._stem_token('Former')).toBe('Former'); // no trailing s
        expect(search_model._stem_token('photo')).toBe('photo');
    });

    it('does not strip words ending in "ss"', () => {
        expect(search_model._stem_token('class')).toBe('class');
        expect(search_model._stem_token('address')).toBe('address');
    });

    it('does not strip when the char before "s" is punctuation', () => {
        // A trailing "-s" or "/s" isn't a plural; leave it.
        expect(search_model._stem_token('a-s')).toBe('a-s');
    });
});
