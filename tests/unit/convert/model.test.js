'use strict';

// Unit coverage for the pure parts of the convert model. The DB-backed
// functions (enqueue/claim/status) are exercised by integration tests
// against the sqlite pool; here we pin down build_payload, which is the
// faithful port of post_tiff_convert.py's build_object() and the thing
// most likely to drift.
//
// describe / it / expect are vitest globals (see vitest.config.js).

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
        // Stored paths are POSIX on the source filesystem; we must not
        // let a Windows test host change basename behavior.
        const payload = model.build_payload({ file_name: 'a/b/c/deep.tiff' });
        expect(payload.object_name).toBe('deep.tiff');
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
