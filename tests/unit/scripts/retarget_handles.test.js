'use strict';

/*
 * The retarget sweep is the one-off that fixes ~2,000 published identifiers,
 * so its decision logic is worth pinning down: which handles get written,
 * which are left alone, and — the trap the corpus actually sets — that the
 * write goes to the index that really holds each handle's URL.
 */

const script = require('../../../scripts/retarget_handles');
const app_config = require('../../../config/app');

const UUID = '2d569507-de89-41eb-9bb6-6be0d12b5eb8';

function url_value(index, value) {
    return { index, type: 'URL', data: { format: 'string', value } };
}

describe('scripts/retarget_handles', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.HANDLE_TARGET = 'https://digitalarchives.example.edu/object/';
        process.env.HANDLE_PREFIX = '10176';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('suffix_from_handle', () => {
        it('extracts the uuid from a stored handle URL', () => {
            expect(script.suffix_from_handle(`https://hdl.handle.net/10176/${UUID}`, '10176'))
                .toBe(UUID);
        });

        it('works regardless of scheme or host', () => {
            expect(script.suffix_from_handle(`http://hdl.handle.net/10176/${UUID}`, '10176'))
                .toBe(UUID);
        });

        /*
         * The handle column has carried v1-era mint-failure strings and bare
         * pids. Feeding those to the writer is how 10176/0 got into the
         * namespace in the first place.
         */
        it.each([
            ['a mint-failure error string', 'ERROR: unable to create handle'],
            ['a bare pid', UUID],
            ['a different prefix', `https://hdl.handle.net/99999/${UUID}`],
            ['a non-uuid suffix', 'https://hdl.handle.net/10176/du-test-handle04'],
            ['an empty value', ''],
            ['null', null],
        ])('rejects %s', (_label, value) => {
            expect(script.suffix_from_handle(value, '10176')).toBeNull();
        });
    });

    describe('classify', () => {
        const cfg = () => app_config().handles;

        function fake_handles(resolved) {
            const mod = require('../../../libs/handles');
            const spy = vi.spyOn(mod, 'get_handle');
            if (resolved instanceof Error) spy.mockRejectedValue(resolved);
            else spy.mockResolvedValue(resolved);
            return spy;
        }
        afterEach(() => { vi.restoreAllMocks(); });

        it('marks a live object whose URL differs as retarget, carrying the real index', async () => {
            fake_handles({ values: [url_value(1, 'https://specialcollections.example.edu/object/x')] });
            const out = await script.classify(
                { suffix: UUID, pid: UUID, in_db: true, live: true }, cfg()
            );
            expect(out.state).toBe('retarget');
            expect(out.index).toBe(1);
            expect(out.desired).toBe(`https://digitalarchives.example.edu/object/${UUID}`);
        });

        it('skips a handle already pointing at the target', async () => {
            fake_handles({
                values: [url_value(2, `https://digitalarchives.example.edu/object/${UUID}`)],
            });
            const out = await script.classify(
                { suffix: UUID, pid: UUID, in_db: true, live: true }, cfg()
            );
            expect(out.state).toBe('already_correct');
        });

        it('marks a handle with no repository row as withdrawn', async () => {
            fake_handles({ values: [url_value(2, 'https://specialcollections.example.edu/object/x')] });
            const out = await script.classify(
                { suffix: UUID, pid: UUID, in_db: false, live: false }, cfg()
            );
            expect(out.state).toBe('withdrawn');
        });

        /*
         * Suppression is reversible. An object still in the repository
         * belongs on the repository's domain whether or not it is public —
         * leaving it on the legacy redirect would just break it later.
         */
        it('retargets a suppressed object rather than treating it as withdrawn', async () => {
            fake_handles({ values: [url_value(2, 'https://specialcollections.example.edu/object/x')] });
            const out = await script.classify(
                { suffix: UUID, pid: UUID, in_db: true, live: false }, cfg()
            );
            expect(out.state).toBe('retarget');
            expect(out.live).toBe(false);
        });

        it('reports a handle that no longer exists without proposing a re-mint', async () => {
            fake_handles(null);
            const out = await script.classify(
                { suffix: UUID, pid: UUID, in_db: true, live: true }, cfg()
            );
            expect(out.state).toBe('missing');
            expect(out.index).toBeUndefined();
        });

        it('reports a handle with no URL value rather than guessing an index', async () => {
            fake_handles({ values: [{ index: 100, type: 'HS_ADMIN', data: {} }] });
            const out = await script.classify(
                { suffix: UUID, pid: UUID, in_db: true, live: true }, cfg()
            );
            expect(out.state).toBe('no_url_value');
        });

        it('flags a handle carrying more than one URL value', async () => {
            fake_handles({
                values: [
                    url_value(1, 'https://old.example.edu/object/x'),
                    url_value(2, 'https://other.example.edu/object/x'),
                ],
            });
            const out = await script.classify(
                { suffix: UUID, pid: UUID, in_db: true, live: true }, cfg()
            );
            expect(out.multiple_url_values).toEqual([1, 2]);
        });

        it('does not classify a resolve failure as missing', async () => {
            fake_handles(new Error('ECONNRESET'));
            const out = await script.classify(
                { suffix: UUID, pid: UUID, in_db: true, live: true }, cfg()
            );
            expect(out.state).toBe('resolve_failed');
        });
    });

    describe('parse_args', () => {
        it('defaults to a dry run', () => {
            expect(script.parse_args(['node', 'x']).execute).toBe(false);
        });

        it('rejects a tombstone that is not an absolute URL', () => {
            expect(() => script.parse_args(['node', 'x', '--tombstone', '/tombstone']))
                .toThrow(/absolute http/);
        });

        it('rejects unknown arguments rather than ignoring them', () => {
            expect(() => script.parse_args(['node', 'x', '--dry-run'])).toThrow(/unknown arg/);
        });

        it('rejects --tombstone together with --leave-orphans', () => {
            expect(() => script.parse_args([
                'node', 'x', '--tombstone', 'https://example.edu/gone', '--leave-orphans',
            ])).toThrow(/mutually exclusive/);
        });

        it('includes orphans by default', () => {
            expect(script.parse_args(['node', 'x']).leave_orphans).toBe(false);
        });
    });
});
