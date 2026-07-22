'use strict';

/*
 * Unit coverage for the byte-progress parser added for the Tier 2
 * upload-% feature. The curation API's check_sftp in_progress shape
 * carries remote_package_size_bytes (uploaded) + local_package_size_bytes
 * (total); pick_bytes normalizes it and signals "leave progress as-is"
 * (null) when the shape lacks the uploaded byte count.
 */

const { _pick_bytes } = require('../../../ingester/stages/upload');

describe('upload _pick_bytes', () => {
    it('extracts uploaded + total from the in_progress shape', () => {
        expect(
            _pick_bytes({
                message: 'in_progress',
                remote_package_size_bytes: 100,
                local_package_size_bytes: 500,
            })
        ).toEqual({ uploaded: 100, total: 500 });
    });

    it('reports total 0 ("unknown") when the local total is missing or zero', () => {
        expect(_pick_bytes({ remote_package_size_bytes: 100 })).toEqual({ uploaded: 100, total: 0 });
        expect(
            _pick_bytes({ remote_package_size_bytes: 100, local_package_size_bytes: 0 })
        ).toEqual({ uploaded: 100, total: 0 });
    });

    it('returns null when uploaded bytes are absent (upload_complete / older build)', () => {
        expect(_pick_bytes({ message: 'upload_complete', data: [[], 2] })).toBeNull();
        expect(_pick_bytes({})).toBeNull();
        expect(_pick_bytes(null)).toBeNull();
        expect(_pick_bytes(42)).toBeNull();
    });
});
