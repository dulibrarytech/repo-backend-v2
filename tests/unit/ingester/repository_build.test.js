'use strict';

const builder = require('../../../ingester/lib/repository_build');
const { ValidationError } = require('../../../libs/errors');

function mets_file(uuid, file, mime = 'image/tiff', type = 'object') {
    return {
        uuid,
        sip_uuid: 'sip-1',
        dip_path: 'd/p',
        file,
        file_id: file.split('.')[0],
        mime_type: mime,
        type,
    };
}

describe('ingester/lib/repository_build — enrich_parts', () => {
    it('builds one part per file with object + thumbnail paths', () => {
        const out = builder.enrich_parts(
            [
                mets_file('aaa', 'thing.tif', 'image/tiff'),
                mets_file('bbb', 'other.tif', 'image/tiff'),
            ],
            { dip_path: 'aabb/folder' }
        );
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({
            uuid: 'aaa',
            file_id: 'thing',
            file: 'thing.tif',
            mime_type: 'image/tiff',
            type: 'object',
            object: 'aabb/folder/objects/thing.tif',
            thumbnail: 'aabb/folder/thumbnails/aaa.jpg',
        });
    });

    it('de-duplicates by uuid (txt sidecars with the same uuid are dropped)', () => {
        const out = builder.enrich_parts(
            [
                mets_file('aaa', 'thing.tif', 'image/tiff', 'object'),
                mets_file('aaa', 'thing.txt', 'text/plain', 'txt'),
            ],
            { dip_path: 'd' }
        );
        expect(out).toHaveLength(1);
        expect(out[0].type).toBe('object');
    });

    it('preserves type=txt for genuinely distinct txt files', () => {
        const out = builder.enrich_parts(
            [
                mets_file('aaa', 'thing.tif', 'image/tiff', 'object'),
                mets_file('bbb', 'transcript.txt', 'text/plain', 'txt'),
            ],
            { dip_path: 'd' }
        );
        expect(out).toHaveLength(2);
        expect(out[1].type).toBe('txt');
    });

    it('throws on missing dip_path or non-array input', () => {
        expect(() => builder.enrich_parts(null, { dip_path: 'd' })).toThrow(ValidationError);
        expect(() => builder.enrich_parts([], {})).toThrow(ValidationError);
    });

    it('skips files without a uuid', () => {
        const out = builder.enrich_parts([{ file: 'x' }, mets_file('a', 'b.tif')], {
            dip_path: 'd',
        });
        expect(out).toHaveLength(1);
        expect(out[0].uuid).toBe('a');
    });
});

describe('ingester/lib/repository_build — pick_master', () => {
    it('returns null when parts is empty', () => {
        expect(builder.pick_master([])).toBeNull();
        expect(builder.pick_master(null)).toBeNull();
    });

    it('returns the single object-type part when there is one', () => {
        const parts = [{ uuid: 'a', file: 'x.tif', type: 'object' }];
        expect(builder.pick_master(parts).uuid).toBe('a');
    });

    it('returns the first object-type part by stable filename order', () => {
        const parts = [
            { uuid: 'c', file: 'c.tif', type: 'object' },
            { uuid: 'a', file: 'a.tif', type: 'object' },
            { uuid: 'b', file: 'b.tif', type: 'object' },
        ];
        expect(builder.pick_master(parts).uuid).toBe('a');
    });

    it('ignores txt-type parts when picking master', () => {
        const parts = [
            { uuid: 't', file: 'a-transcript.txt', type: 'txt' },
            { uuid: 'o', file: 'b-image.tif', type: 'object' },
        ];
        expect(builder.pick_master(parts).uuid).toBe('o');
    });

    it('returns null when only txt parts exist', () => {
        const parts = [{ uuid: 't', file: 't.txt', type: 'txt' }];
        expect(builder.pick_master(parts)).toBeNull();
    });
});

describe('ingester/lib/repository_build — build_object_row', () => {
    const base_queue_row = {
        sip_uuid: 'sip-1',
        collection_uuid: 'codu:parent',
        metadata_uri: '/repositories/2/resources/1',
    };
    const base_metadata = {
        title: 'A Title',
        notes: [
            { type: 'abstract', content: 'an abstract' },
            { type: 'userestrict', content: 'restricted' },
        ],
        parts: [{ type: 'image/tiff' }],
    };
    const base_parts = [
        {
            uuid: 'aaa',
            file: 'thing.tif',
            file_id: 'thing',
            mime_type: 'image/tiff',
            type: 'object',
            object: 'd/objects/thing.tif',
            thumbnail: 'd/thumbnails/aaa.jpg',
        },
    ];

    it('builds a tbl_objects-shaped record for a non-compound single-file object', () => {
        const row = builder.build_object_row({
            queue_row: base_queue_row,
            metadata: base_metadata,
            parts: base_parts,
            handle: 'https://hdl.example/sip-1',
        });
        expect(row.pid).toBe('sip-1');
        expect(row.sip_uuid).toBe('sip-1');
        expect(row.is_member_of_collection).toBe('codu:parent');
        expect(row.handle).toBe('https://hdl.example/sip-1');
        expect(row.uri).toBe('/repositories/2/resources/1');
        expect(row.object_type).toBe('object');
        expect(row.is_compound).toBe(0);
        expect(row.is_published).toBe(0);
        expect(row.is_active).toBe(1);
        expect(row.is_complete).toBe(1);
        expect(row.is_updated).toBe(1);
        expect(row.thumbnail).toBe('d/thumbnails/aaa.jpg');
        expect(row.file_name).toBe('thing.tif');
        expect(row.mime_type).toBe('image/tiff');
        expect(row.compound_parts).toBe('[]');
        // mods + display_record are JSON strings.
        expect(JSON.parse(row.mods).title).toBe('A Title');
        /*
         * The envelope is the full v1 contract (libs/display_envelope):
         * denormalized top level + raw AS record with ONE merged parts
         * manifest, not the thin 5-key shape that shipped on the
         * 2026-07/08 ingests.
         */
        const envelope = JSON.parse(row.display_record);
        expect(envelope.pid).toBe('sip-1');
        expect(envelope.is_member_of_collection).toBe('codu:parent');
        expect(envelope.handle).toBe('https://hdl.example/sip-1');
        expect(envelope.object_type).toBe('object');
        expect(envelope.is_published).toBe(0);
        expect(envelope.is_compound).toBe(0);
        expect(envelope.mime_type).toBe('image/tiff');
        expect(envelope.thumbnail).toBe('d/thumbnails/aaa.jpg');
        expect(envelope.object).toBe('d/objects/thing.tif');
        expect(envelope.title).toBe('A Title');
        expect(envelope.abstract).toBe('an abstract');
        // One merged parts copy inside the inner record; no top-level parts.
        expect(envelope.parts).toBeUndefined();
        expect(envelope.display_record.parts).toHaveLength(1);
        expect(envelope.display_record.parts[0]).toMatchObject({
            title: 'thing.tif',
            type: 'image/tiff',
            object: 'd/objects/thing.tif',
            thumbnail: 'd/thumbnails/aaa.jpg',
        });
    });

    it('merges ASpace part metadata (MIME, kaltura_id) with METS paths', () => {
        const metadata = {
            ...base_metadata,
            parts: [
                {
                    order: '1',
                    title: 'thing.tif',
                    type: 'image/tiff',
                    caption: 'A caption',
                    kaltura_id: '1_abc',
                },
            ],
        };
        /*
         * METS mime is null (the positional-association bug shipped
         * wrong/null mimes) — the ASpace copy must win, and the txt
         * sidecar must not become a part.
         */
        const parts = [
            { ...base_parts[0], mime_type: null },
            {
                uuid: 'ttt',
                file: 'uri.txt',
                file_id: 'uri',
                mime_type: 'video/quicktime',
                type: 'txt',
                object: 'd/objects/uri.txt',
                thumbnail: 'd/thumbnails/ttt.jpg',
            },
        ];
        const row = builder.build_object_row({
            queue_row: base_queue_row,
            metadata,
            parts,
            handle: null,
        });
        expect(row.mime_type).toBe('image/tiff');
        const envelope = JSON.parse(row.display_record);
        expect(envelope.entry_id).toBe('1_abc');
        expect(envelope.display_record.parts).toHaveLength(1);
        expect(envelope.display_record.parts[0]).toMatchObject({
            order: '1',
            title: 'thing.tif',
            type: 'image/tiff',
            caption: 'A caption',
            kaltura_id: '1_abc',
            object: 'd/objects/thing.tif',
            thumbnail: 'd/thumbnails/aaa.jpg',
        });
    });

    it('marks compound when metadata.is_compound=true', () => {
        const row = builder.build_object_row({
            queue_row: base_queue_row,
            metadata: { ...base_metadata, is_compound: true },
            parts: base_parts,
            handle: null,
        });
        expect(row.object_type).toBe('compound');
        expect(row.is_compound).toBe(1);
    });

    it('infers compound from multiple object parts when metadata is silent', () => {
        const parts = [
            { ...base_parts[0], uuid: 'a', file: 'a.tif' },
            { ...base_parts[0], uuid: 'b', file: 'b.tif' },
        ];
        const row = builder.build_object_row({
            queue_row: base_queue_row,
            metadata: { ...base_metadata, is_compound: undefined },
            parts,
            handle: null,
        });
        expect(row.is_compound).toBe(1);
    });

    it('honors explicit is_compound=false even with multiple parts', () => {
        const parts = [
            { ...base_parts[0], uuid: 'a', file: 'a.tif' },
            { ...base_parts[0], uuid: 'b', file: 'b.tif' },
        ];
        const row = builder.build_object_row({
            queue_row: base_queue_row,
            metadata: { ...base_metadata, is_compound: false },
            parts,
            handle: null,
        });
        expect(row.is_compound).toBe(0);
    });

    it('handles null handle (Handle service unavailable in dev)', () => {
        const row = builder.build_object_row({
            queue_row: base_queue_row,
            metadata: base_metadata,
            parts: base_parts,
            handle: null,
        });
        expect(row.handle).toBe('');
    });

    it('handles null master (METS yielded no object-type files)', () => {
        const row = builder.build_object_row({
            queue_row: base_queue_row,
            metadata: base_metadata,
            parts: [],
            handle: 'h',
        });
        expect(row.file_name).toBeNull();
        expect(row.mime_type).toBeNull();
        expect(row.thumbnail).toBeNull();
    });

    it('throws when sip_uuid is missing or unresolved', () => {
        expect(() =>
            builder.build_object_row({
                queue_row: { sip_uuid: 'PENDING', collection_uuid: 'x' },
                metadata: base_metadata,
                parts: [],
                handle: null,
            })
        ).toThrow(ValidationError);
    });

    it('throws when metadata is missing', () => {
        expect(() =>
            builder.build_object_row({
                queue_row: base_queue_row,
                metadata: null,
                parts: [],
                handle: null,
            })
        ).toThrow(ValidationError);
    });

    it('extracts an empty abstract gracefully when no abstract note is present', () => {
        const row = builder.build_object_row({
            queue_row: base_queue_row,
            metadata: { ...base_metadata, notes: [] },
            parts: base_parts,
            handle: null,
        });
        const envelope = JSON.parse(row.display_record);
        expect(envelope.abstract).toBe('');
    });
});

// --- attach_kaltura_ids -------------------------------------------------

describe('ingester/lib/repository_build — attach_kaltura_ids', () => {
    function make_fake_kaltura_model(map) {
        return {
            async get_entry_id_for_file(pkg, file) {
                const k = `${pkg}::${file}`;
                if (Object.prototype.hasOwnProperty.call(map, k)) return map[k];
                return null;
            },
        };
    }

    const parts_in = [
        {
            uuid: 'a',
            file: 'A123.mp4',
            mime_type: 'video/mp4',
            type: 'object',
            object: 'd/p/objects/A123.mp4',
            thumbnail: 'd/p/thumbnails/a.jpg',
        },
        {
            uuid: 'b',
            file: 'B456.mov',
            mime_type: 'video/quicktime',
            type: 'object',
            object: 'd/p/objects/B456.mov',
            thumbnail: 'd/p/thumbnails/b.jpg',
        },
    ];

    it('stamps kaltura_id when the lookup returns a value', async () => {
        const fake = make_fake_kaltura_model({
            'pkg-1::A123.mp4': '1_aaaa',
            'pkg-1::B456.mov': '1_bbbb',
        });
        const out = await builder.attach_kaltura_ids(parts_in, 'pkg-1', fake);
        expect(out).toHaveLength(2);
        expect(out[0].kaltura_id).toBe('1_aaaa');
        expect(out[1].kaltura_id).toBe('1_bbbb');
        // All the original fields are preserved (spread, not replacement).
        expect(out[0].file).toBe('A123.mp4');
        expect(out[0].object).toBe('d/p/objects/A123.mp4');
    });

    it('leaves kaltura_id absent when the lookup returns null', async () => {
        const fake = make_fake_kaltura_model({}); // no entries
        const out = await builder.attach_kaltura_ids(parts_in, 'pkg-1', fake);
        expect(out[0].kaltura_id).toBeUndefined();
        expect(out[1].kaltura_id).toBeUndefined();
    });

    it('attaches per-file independently (some hits, some misses)', async () => {
        const fake = make_fake_kaltura_model({
            'pkg-2::A123.mp4': '1_only_a',
        });
        const out = await builder.attach_kaltura_ids(parts_in, 'pkg-2', fake);
        expect(out[0].kaltura_id).toBe('1_only_a');
        expect(out[1].kaltura_id).toBeUndefined();
    });

    it('returns the input unchanged when kaltura_model is missing or malformed', async () => {
        expect(await builder.attach_kaltura_ids(parts_in, 'pkg-1', null)).toEqual(parts_in);
        expect(await builder.attach_kaltura_ids(parts_in, 'pkg-1', {})).toEqual(parts_in);
        expect(await builder.attach_kaltura_ids(parts_in, 'pkg-1', { foo: 'bar' })).toEqual(
            parts_in
        );
    });

    it('returns an empty array unchanged', async () => {
        const fake = make_fake_kaltura_model({});
        expect(await builder.attach_kaltura_ids([], 'pkg-1', fake)).toEqual([]);
    });

    it('does not halt on a thrown lookup; keeps the part as-is', async () => {
        const fake = {
            async get_entry_id_for_file() {
                throw new Error('DB unreachable');
            },
        };
        const out = await builder.attach_kaltura_ids(parts_in, 'pkg-1', fake);
        expect(out).toHaveLength(2);
        expect(out[0].kaltura_id).toBeUndefined();
        expect(out[0].file).toBe('A123.mp4');
    });

    it('skips parts with no file field', async () => {
        const fake = make_fake_kaltura_model({});
        const malformed = [
            { uuid: 'x' }, // no file
            ...parts_in,
        ];
        const out = await builder.attach_kaltura_ids(malformed, 'pkg-1', fake);
        expect(out).toHaveLength(3);
        // First part (no file) passed through unchanged.
        expect(out[0]).toEqual({ uuid: 'x' });
    });
});
