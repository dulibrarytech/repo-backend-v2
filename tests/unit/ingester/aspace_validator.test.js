'use strict';

const { validate_record } = require('../../../ingester/libs/aspace_validator');

function valid_record(overrides = {}) {
    return {
        title: 'A Title',
        uri: '/repositories/2/archival_objects/1',
        identifiers: ['ID-1'],
        notes: [
            { type: 'abstract', content: 'Some abstract' },
            { type: 'userestrict', content: 'Some restrictions' },
        ],
        dates: [{ expression: '1942' }],
        parts: [{ title: 'p1', type: 'image/tiff' }],
        is_compound: false,
        ...overrides,
    };
}

describe('ingester/libs/aspace_validator — validate_record', () => {
    it('returns an empty array for a complete record', () => {
        expect(validate_record(valid_record())).toEqual([]);
    });

    it('returns ["Metadata is missing or empty"] for null/undefined input', () => {
        expect(validate_record(null)).toEqual(['Metadata is missing or empty']);
        expect(validate_record(undefined)).toEqual(['Metadata is missing or empty']);
    });

    it('flags missing title', () => {
        expect(validate_record(valid_record({ title: '' }))).toContain('Title field is missing');
        expect(validate_record(valid_record({ title: null }))).toContain('Title field is missing');
    });

    it('flags missing uri', () => {
        expect(validate_record(valid_record({ uri: '' }))).toContain('URI field is missing');
    });

    it('flags missing identifiers', () => {
        expect(validate_record(valid_record({ identifiers: [] }))).toContain(
            'Identifier field is missing'
        );
        expect(validate_record(valid_record({ identifiers: null }))).toContain(
            'Identifier field is missing'
        );
    });

    it('flags missing notes block as a whole', () => {
        const errs = validate_record(valid_record({ notes: [] }));
        expect(errs.some((e) => e.startsWith('Notes field is missing'))).toBe(true);
    });

    it('flags an empty abstract note specifically', () => {
        const errs = validate_record(
            valid_record({
                notes: [
                    { type: 'abstract', content: '' },
                    { type: 'userestrict', content: 'restrictions' },
                ],
            })
        );
        expect(errs).toContain('Abstract field is missing');
        expect(errs).not.toContain('Rights statement field is missing');
    });

    it('flags an empty userestrict note specifically', () => {
        const errs = validate_record(
            valid_record({
                notes: [
                    { type: 'abstract', content: 'abstract' },
                    { type: 'userestrict', content: '' },
                ],
            })
        );
        expect(errs).toContain('Rights statement field is missing');
    });

    it('flags a date with no expression', () => {
        const errs = validate_record(valid_record({ dates: [{ expression: '' }] }));
        expect(errs).toContain('Date expression is missing');
    });

    it('is permissive when dates is undefined (the field is optional)', () => {
        const errs = validate_record(valid_record({ dates: undefined }));
        expect(errs).toEqual([]);
    });

    it('flags compound objects with fewer than 2 parts', () => {
        const errs = validate_record(
            valid_record({ is_compound: true, parts: [{ title: 'only', type: 'image/tiff' }] })
        );
        expect(errs).toContain('Compound objects are missing');
    });

    it('does not flag a non-compound record with one part', () => {
        const errs = validate_record(
            valid_record({ is_compound: false, parts: [{ title: 'only', type: 'image/tiff' }] })
        );
        expect(errs).toEqual([]);
    });

    it('flags an empty parts array', () => {
        const errs = validate_record(valid_record({ parts: [] }));
        expect(errs).toContain('Parts is missing');
    });

    it('flags a part with no mime type, including the part title in the message', () => {
        const errs = validate_record(valid_record({ parts: [{ title: 'page-1', type: '' }] }));
        expect(errs).toContain('Mime-type is missing (page-1)');
    });

    it('falls back to "?" in the message when the part has no title', () => {
        const errs = validate_record(valid_record({ parts: [{ type: '' }] }));
        expect(errs).toContain('Mime-type is missing (?)');
    });

    it('collects multiple errors in one call', () => {
        const errs = validate_record({
            // Empty record — should flag almost everything.
            title: '',
            uri: '',
            identifiers: [],
            notes: [],
            parts: [],
        });
        expect(errs.length).toBeGreaterThanOrEqual(5);
        expect(errs).toContain('Title field is missing');
        expect(errs).toContain('URI field is missing');
        expect(errs).toContain('Identifier field is missing');
        expect(errs).toContain('Parts is missing');
    });
});
