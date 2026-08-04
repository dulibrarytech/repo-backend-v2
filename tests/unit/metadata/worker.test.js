'use strict';

/*
 * Unit tests for metadata/worker.js. The build_payload helper is pure
 * and easy to test in isolation; the rest of the worker (network +
 * DB) is exercised at the integration tier with a real sqlite + fake
 * ArchivesSpace.
 *
 * build_payload takes the CURRENT tbl_objects row and the fresh ASpace
 * record, and rebuilds the full fat display_record envelope via
 * libs/display_envelope — re-deriving the denormalized top level rather
 * than fossilizing the previous values, and healing thin
 * pre-consolidation envelopes (repo/REPOV2_DISPLAY_RECORD_FINDINGS.md).
 */

const { build_payload } = require('../../../metadata/worker');

/* A fat-envelope row as repository/model.get returns it. */
function fat_row(overrides = {}) {
    return {
        pid: 'p',
        is_member_of_collection: 'col-1',
        handle: 'https://hdl.example/p',
        thumbnail: 'dip/thumbnails/t.jpg',
        mime_type: 'image/tiff',
        is_published: 1,
        is_compound: 0,
        display_record: JSON.stringify({
            pid: 'p',
            title: 'OLD',
            display_record: {
                title: 'OLD',
                dates: ['1999'],
                parts: [
                    {
                        order: '1',
                        title: 'thing.tif',
                        type: 'image/tiff',
                        caption: null,
                        object: 'dip/objects/thing.tif',
                        thumbnail: 'dip/thumbnails/t.jpg',
                    },
                ],
            },
        }),
        ...overrides,
    };
}

describe('metadata/worker — build_payload', () => {
    it('rebuilds the envelope around the fresh ASpace JSON', () => {
        const fresh = { title: 'NEW', dates: ['2024'] };
        const payload = build_payload(fat_row(), fresh);
        const dr = JSON.parse(payload.display_record);
        expect(dr.display_record.title).toBe('NEW');
        expect(dr.display_record.dates).toEqual(['2024']);
        // Row identity fields are re-stamped, not copied from the old envelope.
        expect(dr.pid).toBe('p');
        expect(dr.is_member_of_collection).toBe('col-1');
        expect(dr.handle).toBe('https://hdl.example/p');
        expect(dr.is_published).toBe(1);
    });

    it('re-derives the denormalized top level instead of fossilizing it', () => {
        const fresh = {
            title: 'NEW',
            resource_type: 'text',
            subjects: [{ title: 'Subject A' }],
            names: [{ title: 'Doe, Jane', role: 'creator' }],
            notes: [{ type: 'abstract', content: 'fresh abstract' }],
        };
        const payload = build_payload(fat_row(), fresh);
        const dr = JSON.parse(payload.display_record);
        expect(dr.title).toBe('NEW');
        expect(dr.creator).toBe('Doe, Jane');
        expect(dr.f_subjects).toEqual(['Subject A']);
        expect(dr.abstract).toBe('fresh abstract');
        expect(dr.type).toBe('text');
    });

    it('recovers DuraCloud paths from a prior FAT envelope', () => {
        const fresh = {
            title: 'NEW',
            parts: [{ order: '1', title: 'thing.tif', type: 'image/tiff', caption: null }],
        };
        const payload = build_payload(fat_row(), fresh);
        const dr = JSON.parse(payload.display_record);
        expect(dr.display_record.parts).toHaveLength(1);
        expect(dr.display_record.parts[0].object).toBe('dip/objects/thing.tif');
        expect(dr.display_record.parts[0].thumbnail).toBe('dip/thumbnails/t.jpg');
        expect(dr.object).toBe('dip/objects/thing.tif');
    });

    it('heals a THIN pre-consolidation envelope, recovering paths from its DIP list', () => {
        const row = fat_row({
            display_record: JSON.stringify({
                title: 'OLD',
                abstract: '',
                handle: 'https://hdl.example/p',
                display_record: { title: 'OLD' },
                parts: [
                    {
                        uuid: 'u1',
                        file_id: 'thing',
                        file: 'thing.tif',
                        mime_type: 'image/tiff',
                        type: 'object',
                        object: 'dip/objects/thing.tif',
                        thumbnail: 'dip/thumbnails/u1.jpg',
                    },
                ],
            }),
        });
        const fresh = {
            title: 'NEW',
            parts: [
                {
                    order: '1',
                    title: 'thing.tif',
                    type: 'image/tiff',
                    caption: null,
                    kaltura_id: '1_abc',
                },
            ],
        };
        const payload = build_payload(row, fresh);
        const dr = JSON.parse(payload.display_record);
        expect(dr.pid).toBe('p');
        expect(dr.display_record.parts[0].kaltura_id).toBe('1_abc');
        expect(dr.display_record.parts[0].object).toBe('dip/objects/thing.tif');
        expect(dr.entry_id).toBe('1_abc');
    });

    it('initializes an envelope when there is no prior display_record', () => {
        const payload = build_payload({ pid: 'x' }, { title: 'X' });
        const dr = JSON.parse(payload.display_record);
        expect(dr.display_record.title).toBe('X');
        expect(dr.pid).toBe('x');
    });

    it('recovers from a corrupt prior display_record', () => {
        const payload = build_payload({ pid: 'x', display_record: '{not json' }, { title: 'X' });
        const dr = JSON.parse(payload.display_record);
        expect(dr.display_record.title).toBe('X');
    });

    it('writes mods as the raw stringified ASpace JSON (no spliced parts)', () => {
        const fresh = { title: 'X', notes: [{ content: 'note' }] };
        const payload = build_payload(fat_row(), fresh);
        expect(JSON.parse(payload.mods)).toEqual(fresh);
    });

    it('sets compound_parts="[]" and is_compound=0 for simple objects', () => {
        const payload = build_payload({ pid: 'x' }, { title: 'X', is_compound: false });
        expect(payload.compound_parts).toBe('[]');
        expect(payload.is_compound).toBe(0);
    });

    it('preserves the prior parts list when the fresh record carries none (compound)', () => {
        const row = fat_row({
            is_compound: 1,
            display_record: JSON.stringify({
                pid: 'p',
                display_record: {
                    title: 'OLD',
                    parts: [
                        { order: '1', title: 'one' },
                        { order: '2', title: 'two' },
                    ],
                },
            }),
        });
        const fresh = { title: 'NEW', is_compound: true };
        const payload = build_payload(row, fresh);
        expect(payload.is_compound).toBe(1);
        const parts = JSON.parse(payload.compound_parts);
        expect(parts).toHaveLength(2);
        expect(parts[0].title).toBe('one');
        const dr = JSON.parse(payload.display_record);
        expect(dr.display_record.parts).toHaveLength(2);
    });

    it('keeps the row is_compound when ASpace is silent about it', () => {
        const payload = build_payload(fat_row({ is_compound: 1 }), { title: 'X' });
        expect(payload.is_compound).toBe(1);
        expect(JSON.parse(payload.display_record).is_compound).toBe(1);
    });

    it('handles a compound object that previously had no parts list', () => {
        const row = fat_row({
            display_record: JSON.stringify({ display_record: { title: 'OLD' } }),
        });
        const payload = build_payload(row, { title: 'NEW', is_compound: true });
        expect(payload.compound_parts).toBe('[]');
        expect(payload.is_compound).toBe(1);
    });

    it('keeps a custom-uploaded (absolute URL) thumbnail authoritative', () => {
        const row = fat_row({ thumbnail: 'https://repo.example/static/tn/p.jpg' });
        const fresh = {
            title: 'NEW',
            parts: [{ order: '1', title: 'thing.tif', type: 'image/tiff', caption: null }],
        };
        const payload = build_payload(row, fresh);
        const dr = JSON.parse(payload.display_record);
        expect(dr.thumbnail).toBe('https://repo.example/static/tn/p.jpg');
    });
});
