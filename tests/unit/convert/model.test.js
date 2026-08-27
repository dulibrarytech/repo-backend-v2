'use strict';

/*
 * Unit coverage for the pure parts of the convert model. The DB-backed
 * functions (enqueue/claim/status) are exercised by integration tests
 * against the sqlite pool; here we pin down build_payload, which is the
 * faithful port of post_tiff_convert.py's build_object() and the thing
 * most likely to drift.
 * 
 * describe / it / expect are vitest globals (see vitest.config.js).
 */

const model = require('../../../convert/model');

describe('convert/model build_payload', () => {
    it('maps file_name → full_path and its basename → object_name', () => {
        const payload = model.build_payload({
            sip_uuid: '2a3e16ca-5aa0-428e-97ab-a189c40b29fc',
            file_name: '/data/collection/codu_123/codu_123.tif',
            mime_type: 'image/tiff',
        });
        expect(payload).toEqual({
            sip_uuid: '2a3e16ca-5aa0-428e-97ab-a189c40b29fc',
            full_path: '/data/collection/codu_123/codu_123.tif',
            object_name: 'codu_123.tif',
            mime_type: 'image/tiff',
        });
    });

    it('handles a bare filename (no directory)', () => {
        const payload = model.build_payload({
            sip_uuid: 'abc',
            file_name: 'lone.tif',
            mime_type: 'image/tiff',
        });
        expect(payload.full_path).toBe('lone.tif');
        expect(payload.object_name).toBe('lone.tif');
    });

    it('coerces missing fields to empty strings rather than undefined', () => {
        const payload = model.build_payload({});
        expect(payload).toEqual({
            sip_uuid: '',
            full_path: '',
            object_name: '',
            mime_type: '',
        });
    });

    it('uses POSIX basename semantics regardless of host OS', () => {
        /*
         * Stored paths are POSIX on the source filesystem; we must not
         * let a Windows test host change basename behavior.
         */
        const payload = model.build_payload({ file_name: 'a/b/c/deep.tiff' });
        expect(payload.object_name).toBe('deep.tiff');
    });
});

describe('convert/model eligible_mime', () => {
    it('accepts TIFF/JPG variants and unknown mimes, rejects everything else', () => {
        expect(model.eligible_mime('image/tiff')).toBe(true);
        expect(model.eligible_mime('image/tif')).toBe(true);
        expect(model.eligible_mime('IMAGE/TIFF')).toBe(true);
        /*
         * A handful of DuraCloud masters are .JPG — the service
         * re-encodes them to access derivatives like any TIFF. 
         */
        expect(model.eligible_mime('image/jpeg')).toBe(true);
        expect(model.eligible_mime('image/jpg')).toBe(true);
        expect(model.eligible_mime('IMAGE/JPEG')).toBe(true);
        expect(model.eligible_mime(null)).toBe(true);
        expect(model.eligible_mime('')).toBe(true);
        expect(model.eligible_mime('video/quicktime')).toBe(false);
        expect(model.eligible_mime('application/pdf')).toBe(false);
        /*
         * PNG stays ineligible: the service's RGB convert composites
         * transparency onto black (no flatten-white pass). 
         */
        expect(model.eligible_mime('image/png')).toBe(false);
    });
});

describe('convert/model expand_row', () => {
    /*
     * A compound row shaped like prod post-repair: merged manifest in
     * both compound_parts and display_record. 
     */
    function compound_row(overrides = {}) {
        const parts = [
            {
                order: '1',
                title: 'B463.0001.tif',
                type: 'image/tiff',
                caption: null,
                object: 'dip/objects/u1-B463.0001.tif',
                thumbnail: 'dip/thumbnails/u1.jpg',
            },
            {
                order: '2',
                title: 'B463.0002.tif',
                type: 'image/tiff',
                caption: null,
                object: 'dip/objects/u2-B463.0002.tif',
                thumbnail: 'dip/thumbnails/u2.jpg',
            },
        ];
        return {
            pid: 'pid-1',
            sip_uuid: 'pid-1',
            is_member_of_collection: 'col-1',
            file_name: 'dip/objects/u1-B463.0001.tif',
            mime_type: 'image/tiff',
            compound_parts: JSON.stringify(parts),
            display_record: JSON.stringify({
                pid: 'pid-1',
                display_record: { parts },
            }),
            ...overrides,
        };
    }

    it('expands a compound to one entry per part (the master alone is not enough)', () => {
        const entries = model.expand_row(compound_row());
        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual({
            pid: 'pid-1',
            sip_uuid: 'pid-1',
            collection: 'col-1',
            file_name: 'dip/objects/u1-B463.0001.tif',
            mime_type: 'image/tiff',
        });
        expect(entries[1].file_name).toBe('dip/objects/u2-B463.0002.tif');
    });

    it('falls back to display_record parts when compound_parts is empty', () => {
        const entries = model.expand_row(compound_row({ compound_parts: '[]' }));
        expect(entries).toHaveLength(2);
    });

    it('skips non-image parts (A/V, PDFs) instead of wasting paced POSTs', () => {
        const parts = [
            { order: '1', title: 'a.tif', type: 'image/tiff', object: 'dip/objects/u1-a.tif' },
            { order: '2', title: 'b.mov', type: 'video/quicktime', object: 'dip/objects/u2-b.mov' },
        ];
        const entries = model.expand_row(
            compound_row({
                compound_parts: JSON.stringify(parts),
                display_record: null,
            })
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].file_name).toBe('dip/objects/u1-a.tif');
    });

    it('keeps JPG parts (a handful of DuraCloud masters are .JPG)', () => {
        const parts = [
            { order: '1', title: 'a.tif', type: 'image/tiff', object: 'dip/objects/u1-a.tif' },
            { order: '2', title: 'b.JPG', type: 'image/jpeg', object: 'dip/objects/u2-b.JPG' },
        ];
        const entries = model.expand_row(
            compound_row({ compound_parts: JSON.stringify(parts), display_record: null })
        );
        expect(entries).toHaveLength(2);
        expect(entries[1]).toEqual({
            pid: 'pid-1',
            sip_uuid: 'pid-1',
            collection: 'col-1',
            file_name: 'dip/objects/u2-b.JPG',
            mime_type: 'image/jpeg',
        });
    });

    it('keeps parts with an unknown mime (sparse legacy metadata)', () => {
        const parts = [{ order: '1', title: 'a.tif', object: 'dip/objects/u1-a.tif' }];
        const entries = model.expand_row(
            compound_row({ compound_parts: JSON.stringify(parts), display_record: null })
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].mime_type).toBeNull();
    });

    it('collapses duplicate paths within a row', () => {
        const parts = [
            { order: '1', title: 'a.tif', type: 'image/tiff', object: 'dip/objects/u1-a.tif' },
            { order: '2', title: 'a.tif', type: 'image/tiff', object: 'dip/objects/u1-a.tif' },
        ];
        const entries = model.expand_row(
            compound_row({ compound_parts: JSON.stringify(parts), display_record: null })
        );
        expect(entries).toHaveLength(1);
    });

    it('falls back to file_name when no parts manifest exists (legacy rows)', () => {
        const entries = model.expand_row({
            pid: 'p',
            sip_uuid: 'p',
            is_member_of_collection: 'c',
            file_name: 'dip/objects/u-x.tif',
            mime_type: 'image/tiff',
            compound_parts: null,
            display_record: null,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0].file_name).toBe('dip/objects/u-x.tif');
    });

    it('legacy parts without object paths fall back to file_name too', () => {
        /* v1 simple objects: parts carry order/title/type but no paths. */
        const entries = model.expand_row({
            pid: 'p',
            sip_uuid: 'p',
            is_member_of_collection: 'c',
            file_name: 'dip/objects/u-x.tif',
            mime_type: 'image/tiff',
            compound_parts: '[]',
            display_record: JSON.stringify({
                pid: 'p',
                display_record: {
                    parts: [{ order: '1', title: 'x.tif', type: 'image/tiff', caption: null }],
                },
            }),
        });
        expect(entries).toHaveLength(1);
        expect(entries[0].file_name).toBe('dip/objects/u-x.tif');
    });

    it('returns nothing for a non-image simple object (e.g. a video master)', () => {
        const entries = model.expand_row({
            pid: 'p',
            file_name: 'dip/objects/u-x.mov',
            mime_type: 'video/quicktime',
            compound_parts: null,
            display_record: null,
        });
        expect(entries).toEqual([]);
    });

    it('queues a simple all-JPG object from file_name (the .JPG-master gap)', () => {
        const entries = model.expand_row({
            pid: 'p',
            sip_uuid: 'p',
            is_member_of_collection: 'c',
            file_name: 'dip/objects/u-x.JPG',
            mime_type: 'image/jpeg',
            compound_parts: null,
            display_record: null,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0].file_name).toBe('dip/objects/u-x.JPG');
    });

    it('survives unparsable JSON in either source column', () => {
        const entries = model.expand_row(
            compound_row({ compound_parts: '{nope', display_record: '{nope' })
        );
        expect(entries).toHaveLength(1); // file_name fallback
    });
});

describe('convert/model STATUS enum', () => {
    it('exposes the four queue states', () => {
        expect(model.STATUS).toEqual({
            PENDING: 'PENDING',
            IN_PROGRESS: 'IN_PROGRESS',
            COMPLETE: 'COMPLETE',
            FAILED: 'FAILED',
        });
    });
});
