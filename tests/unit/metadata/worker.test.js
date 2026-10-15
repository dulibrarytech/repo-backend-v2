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
        file_name: 'dip/objects/thing.tif',
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

/*
 * The common single-object envelope (modeled on 7df39b46): the DIP paths
 * sit only at the top level. There is no top-level `parts`, and the inner
 * parts are plain ASpace parts without object/thumbnail.
 */
function single_envelope(overrides = {}) {
    return {
        pid: 'p',
        is_member_of_collection: 'col-1',
        handle: 'https://hdl.example/p',
        thumbnail: 'dip/thumbnails/u1.jpg',
        mime_type: 'image/tiff',
        object_type: 'object',
        is_published: 1,
        is_compound: 0,
        title: 'OLD',
        type: 'still image',
        display_record: {
            title: 'OLD',
            resource_type: 'still image',
            parts: [{ order: '1', title: 'thing.tif', type: 'image/tiff', caption: null }],
        },
        object: 'dip/objects/u1-thing.tif',
        ...overrides,
    };
}

/* A row carrying single_envelope(), with the same values in its columns. */
function single_row(overrides = {}) {
    return {
        pid: 'p',
        is_member_of_collection: 'col-1',
        handle: 'https://hdl.example/p',
        file_name: 'dip/objects/u1-thing.tif',
        thumbnail: 'dip/thumbnails/u1.jpg',
        mime_type: 'image/tiff',
        is_published: 1,
        is_compound: 0,
        display_record: JSON.stringify(single_envelope()),
        ...overrides,
    };
}

/* A fresh ASpace record for single_row(): its parts carry no DIP paths. */
function fresh_single(overrides = {}) {
    return {
        title: 'NEW',
        resource_type: 'still image',
        parts: [{ order: '1', title: 'thing.tif', type: 'image/tiff', caption: null }],
        ...overrides,
    };
}

/* An old envelope with no top-level paths, so only the columns can supply them. */
const PATHLESS_ENVELOPE = JSON.stringify(
    single_envelope({ object: null, thumbnail: null, mime_type: null })
);

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
        // Thin envelopes carry the DIP uuid, so the path is normalized too.
        expect(dr.display_record.parts[0].object).toBe('dip/objects/u1-thing.tif');
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

/*
 * The top-level object/thumbnail/mime_type are DIP facts a refresh never
 * changes: build_payload keeps the old envelope's values, takes the parts'
 * only when the old envelope has none, and the row's columns last.
 */
describe('metadata/worker — build_payload top-level path refill', () => {
    it('keeps object/thumbnail/mime_type of the 7df39b46 shape', () => {
        const dr = JSON.parse(build_payload(single_row(), fresh_single()).display_record);
        expect(dr.display_record.title).toBe('NEW');
        expect(dr.object).toBe('dip/objects/u1-thing.tif');
        expect(dr.thumbnail).toBe('dip/thumbnails/u1.jpg');
        expect(dr.mime_type).toBe('image/tiff');
        expect(dr.type).toBe('still image');
        /* The paths stay top-level; the inner parts gain none. */
        expect(dr.display_record.parts[0].object).toBeUndefined();
    });

    it('keeps them when the top-level parts are ASpace-shaped (513722e4 shape)', () => {
        const aspace_parts = [
            {
                order: '1',
                title: '005.wav',
                kaltura_id: '1_abc',
                type: 'audio/x-wav',
                caption: '005.wav',
            },
        ];
        const row = single_row({
            file_name: 'dip/objects/u2-005.wav',
            thumbnail: 'dip/thumbnails/u2.jpg',
            mime_type: 'audio/x-wav',
            display_record: JSON.stringify(
                single_envelope({
                    thumbnail: 'dip/thumbnails/u2.jpg',
                    mime_type: 'audio/x-wav',
                    type: 'sound recording',
                    entry_id: '1_abc',
                    parts: aspace_parts,
                    display_record: {
                        title: 'OLD',
                        resource_type: 'sound recording',
                        parts: aspace_parts,
                    },
                    object: 'dip/objects/u2-005.wav',
                })
            ),
        });
        const fresh = fresh_single({ resource_type: 'sound recording', parts: aspace_parts });
        const dr = JSON.parse(build_payload(row, fresh).display_record);
        expect(dr.object).toBe('dip/objects/u2-005.wav');
        expect(dr.thumbnail).toBe('dip/thumbnails/u2.jpg');
        expect(dr.mime_type).toBe('audio/x-wav');
        expect(dr.entry_id).toBe('1_abc');
    });

    it('prefers the old envelope over the columns (.tif envelope, .jp2 file_name)', () => {
        const row = single_row({
            file_name: 'dip/objects/u1-thing.jp2',
            thumbnail: 'dip/thumbnails/col.jpg',
            mime_type: 'image/jp2',
        });
        const dr = JSON.parse(build_payload(row, fresh_single()).display_record);
        expect(dr.object).toBe('dip/objects/u1-thing.tif');
        expect(dr.thumbnail).toBe('dip/thumbnails/u1.jpg');
        expect(dr.mime_type).toBe('image/tiff');
    });

    it('falls back to the columns when the old envelope lacks the values', () => {
        const row = single_row({
            file_name: 'dip/objects/u1-thing.jp2',
            thumbnail: 'dip/thumbnails/col.jpg',
            mime_type: 'image/jp2',
            display_record: PATHLESS_ENVELOPE,
        });
        const dr = JSON.parse(build_payload(row, fresh_single()).display_record);
        expect(dr.object).toBe('dip/objects/u1-thing.jp2');
        expect(dr.thumbnail).toBe('dip/thumbnails/col.jpg');
        expect(dr.mime_type).toBe('image/jp2');
    });

    it.each([
        ['has no "/"', 'u1-thing.jp2'],
        ['is blank', '   '],
        ['is a folder', 'dip/objects/'],
        ['is an absolute URL', 'https://repo.example/dip/objects/u1-thing.jp2'],
        ['is exactly 255 characters (cut off by the column)', 'dip/objects/'.padEnd(255, 'x')],
        ['is a DuraCloud chunk manifest', 'dip/objects/u1-thing.tif.dura-manifest'],
        ['is a DuraCloud chunk', 'dip/objects/u1-thing.tif.dura-chunk-0001'],
    ])('skips a file_name that %s', (_label, file_name) => {
        const row = single_row({ file_name, display_record: PATHLESS_ENVELOPE });
        const dr = JSON.parse(build_payload(row, fresh_single()).display_record);
        expect(dr.object).toBeNull();
        /* The other two columns are still used. */
        expect(dr.thumbnail).toBe('dip/thumbnails/u1.jpg');
        expect(dr.mime_type).toBe('image/tiff');
    });

    it('treats a blank old-envelope value as missing', () => {
        const row = single_row({
            display_record: JSON.stringify(
                single_envelope({ object: '   ', thumbnail: '\n', mime_type: ' ' })
            ),
        });
        const dr = JSON.parse(build_payload(row, fresh_single()).display_record);
        expect(dr.object).toBe('dip/objects/u1-thing.tif');
        expect(dr.thumbnail).toBe('dip/thumbnails/u1.jpg');
        expect(dr.mime_type).toBe('image/tiff');
    });

    it('uses a file_name one character under the column limit', () => {
        const file_name = 'dip/objects/'.padEnd(254, 'x');
        const row = single_row({ file_name, display_record: PATHLESS_ENVELOPE });
        const dr = JSON.parse(build_payload(row, fresh_single()).display_record);
        expect(dr.object).toBe(file_name);
    });

    it('leaves them null when neither the old envelope nor the columns have them', () => {
        const dr = JSON.parse(build_payload({ pid: 'x' }, { title: 'X' }).display_record);
        expect(dr.object).toBeNull();
        expect(dr.thumbnail).toBeNull();
        expect(dr.mime_type).toBeNull();
        expect(dr.type).toBeNull();
    });

    it("keeps the old envelope's top-level values over the parts' (a v1 compound)", () => {
        /*
         * A v1-era compound names its TIFF master at the top while its
         * first part names the JP2 derivative; pick_master_part would swap
         * the JP2 in, changing the indexed path on every refresh.
         */
        const parts = [
            { order: '1', title: 'thing_view1.jp2', type: 'image/jp2', caption: null },
            { order: '2', title: 'thing_view2.jp2', type: 'image/jp2', caption: null },
        ];
        const row = fat_row({
            file_name: 'dip/objects/thing_view1.jp2',
            mime_type: 'image/jp2',
            is_compound: 1,
            display_record: JSON.stringify({
                ...JSON.parse(fat_row().display_record),
                object: 'dip/objects/thing_view1.tif',
                thumbnail: 'dip/thumbnails/master.jpg',
                mime_type: 'image/tiff',
                display_record: {
                    title: 'OLD',
                    parts: [
                        {
                            ...parts[0],
                            object: 'dip/objects/thing_view1.jp2',
                            thumbnail: 'dip/thumbnails/v1.jpg',
                        },
                        {
                            ...parts[1],
                            object: 'dip/objects/thing_view2.jp2',
                            thumbnail: 'dip/thumbnails/v2.jpg',
                        },
                    ],
                },
            }),
        });
        const dr = JSON.parse(
            build_payload(row, { title: 'NEW', is_compound: true, parts }).display_record
        );
        expect(dr.object).toBe('dip/objects/thing_view1.tif');
        expect(dr.thumbnail).toBe('dip/thumbnails/master.jpg');
        expect(dr.mime_type).toBe('image/tiff');
        /* The parts keep their own paths. */
        expect(dr.display_record.parts.map((p) => p.object)).toEqual([
            'dip/objects/thing_view1.jp2',
            'dip/objects/thing_view2.jp2',
        ]);
    });

    it("takes the parts' values only when the old envelope has none at the top level", () => {
        const fresh = {
            title: 'NEW',
            parts: [{ order: '1', title: 'thing.tif', type: 'image/tiff', caption: null }],
        };
        const dr = JSON.parse(build_payload(fat_row(), fresh).display_record);
        expect(dr.object).toBe('dip/objects/thing.tif');
        expect(dr.thumbnail).toBe('dip/thumbnails/t.jpg');
        expect(dr.mime_type).toBe('image/tiff');
    });

    it('re-derives type from the refilled MIME only when the record has no resource_type', () => {
        const untyped = { title: 'NEW', parts: fresh_single().parts };
        const dr = JSON.parse(build_payload(single_row(), untyped).display_record);
        expect(dr.type).toBe('still image');
        const typed = fresh_single({ resource_type: 'text' });
        expect(JSON.parse(build_payload(single_row(), typed).display_record).type).toBe('text');
    });

    it('keeps an absolute custom thumbnail over the refilled one', () => {
        const row = single_row({ thumbnail: 'https://repo.example/static/tn/p.jpg' });
        const dr = JSON.parse(build_payload(row, fresh_single()).display_record);
        expect(dr.thumbnail).toBe('https://repo.example/static/tn/p.jpg');
        expect(dr.object).toBe('dip/objects/u1-thing.tif');
    });
});
