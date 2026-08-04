'use strict';

/*
 * Unit tests for libs/display_envelope — the canonical v1-contract
 * envelope builder shared by ingest, metadata refresh, the ES
 * projection, and the prod backfill script. The merge fixtures mirror
 * the real 2026-07/08 damage (repo/REPOV2_DISPLAY_RECORD_FINDINGS.md):
 * kaltura_id stranded in the ASpace copy, mimes swapped by the METS
 * positional bug, uri.txt sidecars in the DIP list.
 */

const lib = require('../../../libs/display_envelope');

/* The two parts copies of the Nancy McElroy oral history, abridged. */
const INNER_AV_PART = {
    order: '1',
    title: 'D009.mov',
    kaltura_id: '1_abc',
    type: 'video/quicktime',
    caption: null,
};
const DIP_AV_PARTS = [
    {
        uuid: 'u-txt',
        file_id: 'uri',
        file: 'uri.txt',
        mime_type: 'video/quicktime', // the METS positional bug's swap
        type: 'txt',
        object: 'dip/objects/uri.txt',
        thumbnail: 'dip/thumbnails/u-txt.jpg',
    },
    {
        uuid: 'u-mov',
        file_id: 'D009',
        file: 'D009.mov',
        mime_type: null, // swapped away
        type: 'object',
        object: 'dip/objects/D009.mov',
        thumbnail: 'dip/thumbnails/u-mov.jpg',
    },
];

describe('libs/display_envelope — merge_parts', () => {
    it('reunites ASpace metadata with DIP paths and drops txt sidecars', () => {
        const merged = lib.merge_parts([INNER_AV_PART], DIP_AV_PARTS);
        expect(merged).toHaveLength(1);
        expect(merged[0]).toEqual({
            order: '1',
            title: 'D009.mov',
            type: 'video/quicktime',
            caption: null,
            kaltura_id: '1_abc',
            object: 'dip/objects/D009.mov',
            thumbnail: 'dip/thumbnails/u-mov.jpg',
        });
    });

    it('prefers the ASpace MIME over the METS-derived one', () => {
        const merged = lib.merge_parts(
            [{ order: '1', title: 'a.tif', type: 'image/tiff', caption: null }],
            [{ uuid: 'u', file: 'a.tif', mime_type: 'text/plain', type: 'object', object: 'o' }]
        );
        expect(merged[0].type).toBe('image/tiff');
    });

    it('falls back to the DIP mime when the ASpace part has none', () => {
        const merged = lib.merge_parts(
            [{ order: '1', title: 'a.tif', caption: null }],
            [{ uuid: 'u', file: 'a.tif', mime_type: 'image/tiff', type: 'object', object: 'o' }]
        );
        expect(merged[0].type).toBe('image/tiff');
    });

    it('matches case-insensitively and via file_id when extensions differ', () => {
        const merged = lib.merge_parts(
            [{ order: '1', title: 'Thing.TIF', caption: null }],
            [{ uuid: 'u', file: 'thing.tif', mime_type: 'image/tiff', type: 'object', object: 'o' }]
        );
        expect(merged[0].object).toBe('o');
    });

    it('keeps unmatched ASpace parts (no paths) and appends unmatched DIP files', () => {
        const merged = lib.merge_parts(
            [{ order: '1', title: 'gone.tif', type: 'image/tiff', caption: 'Kept' }],
            [{ uuid: 'u', file: 'extra.tif', mime_type: 'image/tiff', type: 'object', object: 'o' }]
        );
        expect(merged).toHaveLength(2);
        expect(merged[0].title).toBe('gone.tif');
        expect(merged[0].object).toBeUndefined();
        expect(merged[1]).toMatchObject({ order: '2', title: 'extra.tif', object: 'o' });
    });

    it('synthesizes parts from the DIP list when ASpace has none', () => {
        const merged = lib.merge_parts(undefined, DIP_AV_PARTS);
        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({
            order: '1',
            title: 'D009.mov',
            object: 'dip/objects/D009.mov',
        });
    });

    it('never emits a txt sidecar even when it is the only DIP entry', () => {
        expect(lib.merge_parts([], [DIP_AV_PARTS[0]])).toEqual([]);
    });
});

describe('libs/display_envelope — is_dip_parts', () => {
    it('detects the METS/DIP shape', () => {
        expect(lib.is_dip_parts(DIP_AV_PARTS)).toBe(true);
    });
    it('rejects canonical/ASpace-shaped parts and empties', () => {
        expect(lib.is_dip_parts([INNER_AV_PART])).toBe(false);
        expect(lib.is_dip_parts([])).toBe(false);
        expect(lib.is_dip_parts(null)).toBe(false);
    });
});

describe('libs/display_envelope — build_envelope', () => {
    const metadata = {
        title: 'Nancy McElroy Oral History, 2024',
        uri: '/repositories/2/archival_objects/190992',
        identifiers: [{ type: 'local', identifier: 'D009.23.0007.0044.00001' }],
        subjects: [{ title: 'Administration' }, { title: 'McElroy, Nancy' }],
        notes: [{ type: 'abstract', content: 'Interview with Nancy McElroy.' }],
        names: [{ title: 'Shead, Rhetta', role: 'creator' }],
        parts: [INNER_AV_PART],
        is_compound: false,
    };

    function build(overrides = {}) {
        return lib.build_envelope({
            pid: 'pid-1',
            is_member_of_collection: 'col-1',
            handle: 'https://hdl.example/pid-1',
            is_published: 0,
            is_compound: 0,
            metadata,
            dip_parts: DIP_AV_PARTS,
            ...overrides,
        });
    }

    it('emits the full v1 contract with one merged parts manifest', () => {
        const { envelope } = build();
        expect(envelope).toMatchObject({
            pid: 'pid-1',
            is_member_of_collection: 'col-1',
            handle: 'https://hdl.example/pid-1',
            thumbnail: 'dip/thumbnails/u-mov.jpg',
            mime_type: 'video/quicktime',
            object_type: 'object',
            is_published: 0,
            is_compound: 0,
            title: 'Nancy McElroy Oral History, 2024',
            creator: 'Shead, Rhetta',
            f_subjects: ['Administration', 'McElroy, Nancy'],
            abstract: 'Interview with Nancy McElroy.',
            type: 'moving image',
            object: 'dip/objects/D009.mov',
            entry_id: '1_abc',
        });
        expect(envelope.display_record.parts).toHaveLength(1);
        expect(envelope.display_record.parts[0].kaltura_id).toBe('1_abc');
        // The raw record's other fields ride along untouched.
        expect(envelope.display_record.identifiers[0].identifier).toBe('D009.23.0007.0044.00001');
        // No second parts copy at the top level.
        expect(envelope.parts).toBeUndefined();
    });

    it('derives column values in lockstep with the envelope', () => {
        const built = build();
        expect(built.mime_type).toBe('video/quicktime');
        expect(built.thumbnail).toBe('dip/thumbnails/u-mov.jpg');
        expect(built.file_name).toBe('D009.mov');
        expect(built.object).toBe('dip/objects/D009.mov');
        expect(built.compound_parts).toBe('[]');
    });

    it('prefers resource_type over the mime-derived type', () => {
        const { envelope } = build({ metadata: { ...metadata, resource_type: 'sound recording' } });
        expect(envelope.type).toBe('sound recording');
    });

    it('populates compound_parts for compounds', () => {
        const built = build({ is_compound: 1 });
        expect(built.envelope.is_compound).toBe(1);
        expect(JSON.parse(built.compound_parts)).toHaveLength(1);
    });

    it('omits entry_id when no part carries a kaltura id', () => {
        const { envelope } = lib.build_envelope({
            pid: 'p',
            is_member_of_collection: '',
            handle: null,
            is_published: 0,
            is_compound: 0,
            metadata: { ...metadata, parts: [{ order: '1', title: 'a.tif', caption: null }] },
            dip_parts: [],
        });
        expect(envelope.entry_id).toBeUndefined();
        expect('entry_id' in envelope).toBe(false);
    });

    it('handles a record with no parts and no DIP files (master=null)', () => {
        const built = lib.build_envelope({
            pid: 'p',
            is_member_of_collection: '',
            handle: null,
            is_published: 1,
            is_compound: 0,
            metadata: { title: 'Bare', parts: [] },
            dip_parts: [],
        });
        expect(built.mime_type).toBeNull();
        expect(built.thumbnail).toBeNull();
        expect(built.file_name).toBeNull();
        expect(built.envelope.is_published).toBe(1);
        expect(built.envelope.display_record.parts).toEqual([]);
    });

    it('throws without a metadata record', () => {
        expect(() => lib.build_envelope({ pid: 'p', dip_parts: [] })).toThrow(/metadata/);
    });
});
