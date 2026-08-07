'use strict';

/*
 * Unit tests for kaltura/controller — focuses on the pure helpers and
 * the per-file resolution rules. The DB + HTTP layers are integration
 * concerns covered by tests/integration/kaltura.
 */

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
    /*
     * Fake service injected via deps so the SDK never runs in unit
     * tests. The controller's _resolve_file accepts `{ service }` as
     * its 4th arg precisely so callers (and tests) can override.
     */
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

describe('kaltura/controller — resolve_packages', () => {
    /*
     * In-memory model: queue_packages stores rows the way the DB does
     * (files JSON-stringified), get_next_package drains them in order.
     */
    function make_fake_model() {
        const calls = { order: [], saved: [] };
        let queue = [];
        return {
            calls,
            async clear_packages(names) {
                calls.order.push(`clear:${names.join(',')}`);
                return { ids: 0, queue: 0 };
            },
            async queue_packages(packages) {
                calls.order.push('queue');
                queue = packages.map((p) => ({
                    package: p.package,
                    files: JSON.stringify(p.files),
                }));
                return { count: queue.length };
            },
            async get_next_package() {
                return queue.length > 0 ? queue[0] : null;
            },
            async mark_package_processed(name) {
                calls.order.push(`processed:${name}`);
                queue = queue.filter((q) => q.package !== name);
                return { affected: 1 };
            },
            async save_entry_ids(rows) {
                calls.saved.push(...rows);
                return { count: rows.length };
            },
        };
    }

    function make_service_for(responses) {
        return {
            async start_session() {
                return 'minted-ks';
            },
            async search_metadata(term) {
                return responses[term] || { totalCount: 0, objects: [] };
            },
        };
    }

    const configured = { is_configured: () => true };

    it('clears, queues, drains, and returns + persists the resolved rows', async () => {
        const model = make_fake_model();
        const service = make_service_for({
            'a.mp4': { totalCount: 1, objects: [{ object: { id: '1_a' } }] },
        });

        const rows = await controller.resolve_packages(
            [{ package: 'pkg_a', files: ['a.mp4'] }],
            { ks: 'ks', deps: { model, service, config: configured } }
        );

        expect(model.calls.order).toEqual(['clear:pkg_a', 'queue', 'processed:pkg_a']);
        expect(rows).toEqual([
            {
                package: 'pkg_a',
                file: 'a.mp4',
                entry_id: '1_a',
                status: 1,
                message: 'Success.',
            },
        ]);
        expect(model.calls.saved).toEqual(rows);
    });

    it('mints a session when none is supplied', async () => {
        const model = make_fake_model();
        const service = make_service_for({});
        const rows = await controller.resolve_packages(
            [{ package: 'pkg_b', files: ['b.wav'] }],
            { deps: { model, service, config: configured } }
        );
        // A miss on both lookups records the status=0 placeholder row.
        expect(rows[0].status).toBe(0);
    });

    it('throws ServiceUnavailable when Kaltura is not configured', async () => {
        await expect(
            controller.resolve_packages([{ package: 'p', files: [] }], {
                deps: { config: { is_configured: () => false } },
            })
        ).rejects.toThrow(/not configured/i);
    });

    it('rejects a malformed packages array before touching the queue', async () => {
        const model = make_fake_model();
        await expect(
            controller.resolve_packages([{ files: ['x.mp4'] }], {
                ks: 'ks',
                deps: { model, config: configured },
            })
        ).rejects.toThrow(/validation failed/i);
        expect(model.calls.order).toEqual([]);
    });
});
