'use strict';

// Unit tests for kaltura/controller — focuses on the pure helpers and
// the per-file resolution rules. The DB + HTTP layers are integration
// concerns covered by tests/integration/kaltura.

const controller = require('../../../kaltura/controller');

describe('kaltura/controller — _basename', () => {
    it('strips the last extension', () => {
        expect(controller._basename('foo.mp4')).toBe('foo');
        expect(controller._basename('foo.bar.mp4')).toBe('foo.bar');
    });

    it('returns the input unchanged when there is no extension', () => {
        expect(controller._basename('foo')).toBe('foo');
    });

    it('does not strip a leading-dot file (treats as no extension)', () => {
        expect(controller._basename('.hidden')).toBe('.hidden');
    });
});

describe('kaltura/controller — _extract_entry_ids', () => {
    it('returns a single status=1 row when totalCount=1', () => {
        const out = controller._extract_entry_ids(
            {
                totalCount: 1,
                objects: [{ object: { id: '1_abc' } }],
            },
            'a.mp4',
            'pkg-1'
        );
        expect(out).toEqual([
            {
                package: 'pkg-1',
                file: 'a.mp4',
                entry_id: '1_abc',
                status: 1,
                message: 'Success.',
            },
        ]);
    });

    it('returns one status=2 row with a JSON-array entry_id when totalCount>1', () => {
        const out = controller._extract_entry_ids(
            {
                totalCount: 2,
                objects: [{ object: { id: '1_a' } }, { object: { id: '1_b' } }],
            },
            'b.mp4',
            'pkg-2'
        );
        expect(out).toHaveLength(1);
        expect(out[0].status).toBe(2);
        expect(out[0].entry_id).toBe('["1_a","1_b"]');
        expect(out[0].message).toMatch(/more than 1/i);
    });

    it('returns an empty array when totalCount=0', () => {
        expect(controller._extract_entry_ids({ totalCount: 0, objects: [] }, 'x', 'y')).toEqual([]);
    });

    it('tolerates malformed objects in the response', () => {
        // One valid id, two malformed entries that must be filtered.
        const out = controller._extract_entry_ids(
            {
                totalCount: 3,
                objects: [{ object: { id: '1_z' } }, { object: {} }, null],
            },
            'c.mp4',
            'pkg-3'
        );
        expect(out).toEqual([
            {
                package: 'pkg-3',
                file: 'c.mp4',
                entry_id: '1_z',
                status: 1,
                message: 'Success.',
            },
        ]);
    });
});

describe('kaltura/controller — _resolve_file', () => {
    // Fake service injected via deps so the SDK never runs in unit
    // tests. The controller's _resolve_file accepts `{ service }` as
    // its 4th arg precisely so callers (and tests) can override.
    function make_fake_service({ first, second } = {}) {
        let calls = 0;
        return {
            async search_metadata() {
                calls += 1;
                if (calls === 1) {
                    if (first && first.throw) throw first.throw;
                    return first;
                }
                if (second && second.throw) throw second.throw;
                return second;
            },
        };
    }

    it('returns an Invalid file name row for empty input', async () => {
        const out = await controller._resolve_file('', 'pkg', 'ks');
        expect(out).toEqual([
            {
                package: 'pkg',
                file: 'unknown',
                entry_id: '0_0',
                status: 0,
                message: 'Invalid file name.',
            },
        ]);
    });

    it('returns an Invalid file name row for null input', async () => {
        const out = await controller._resolve_file(null, 'pkg', 'ks');
        expect(out[0].file).toBe('unknown');
    });

    it('returns a single match on the first lookup', async () => {
        const fake = make_fake_service({
            first: { totalCount: 1, objects: [{ object: { id: '1_a' } }] },
        });
        const out = await controller._resolve_file('vid.mp4', 'pkg', 'ks', { service: fake });
        expect(out).toEqual([
            {
                package: 'pkg',
                file: 'vid.mp4',
                entry_id: '1_a',
                status: 1,
                message: 'Success.',
            },
        ]);
    });

    it('falls back to basename when full-filename lookup misses', async () => {
        const fake = make_fake_service({
            first: { totalCount: 0, objects: [] },
            second: { totalCount: 1, objects: [{ object: { id: '1_b' } }] },
        });
        const out = await controller._resolve_file('vid.mp4', 'pkg', 'ks', { service: fake });
        expect(out[0].entry_id).toBe('1_b');
    });

    it('records a not-found row when both lookups miss', async () => {
        const fake = make_fake_service({
            first: { totalCount: 0, objects: [] },
            second: { totalCount: 0, objects: [] },
        });
        const out = await controller._resolve_file('vid.mp4', 'pkg', 'ks', { service: fake });
        expect(out[0].status).toBe(0);
        expect(out[0].entry_id).toBe('0_0');
        expect(out[0].message).toMatch(/does not have an Entry ID/i);
    });

    it('catches upstream errors and records a status=0 row', async () => {
        const fake = make_fake_service({
            first: { throw: new Error('SDK boom') },
        });
        const out = await controller._resolve_file('vid.mp4', 'pkg', 'ks', { service: fake });
        expect(out[0].status).toBe(0);
        expect(out[0].message).toMatch(/Processing error: SDK boom/);
    });
});
