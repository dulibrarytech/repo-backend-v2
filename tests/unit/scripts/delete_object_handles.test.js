'use strict';

/*
 * Guards on the ingest-handle cleanup script.
 *
 * These matter more than most tests in this repo: the thing being guarded is
 * the permanent deletion of a persistent identifier. The selection rule that
 * looks obvious — "the object was deleted, so bin its handle" — would match
 * 1,640 rows in the dev database, an unknown number of which were public and
 * cited, because soft_delete() refuses published objects and so leaves every
 * deleted row reading is_published=0 regardless of its history.
 *
 * So each guard is pinned individually, and the age guard (the only one that
 * relies on the handle server rather than our own DB) is pinned hardest.
 */

const script = require('../../../scripts/delete_object_handles');
const app_config = require('../../../config/app');

const PID = '2d569507-de89-41eb-9bb6-6be0d12b5eb8';
const NOW = Date.parse('2026-07-31T12:00:00Z');

function url_value(value, timestamp) {
    return { index: 2, type: 'URL', data: { format: 'string', value }, timestamp };
}

function target(pid) {
    return `https://digitalarchives.du.edu/object/${pid}`;
}

/*
 * Guards are exercised through assess()'s injected deps rather than module
 * mocking. The script destructures `const { db } = require(...)` at load, so
 * the binding is captured and a spy on the module export never applies —
 * injection is both simpler and the pattern the rest of this codebase uses.
 */
function deps({ row = {}, resolved = undefined } = {}) {
    const object_row = row === null ? undefined : {
        pid: PID,
        handle: `https://hdl.handle.net/10176/${PID}`,
        is_active: 0,
        is_published: 0,
        ...row,
    };
    return {
        fetch_row: async () => object_row,
        handles: {
            async get_handle() {
                if (resolved instanceof Error) throw resolved;
                if (resolved === undefined) {
                    return { values: [url_value(target(PID), '2026-07-30T12:00:00Z')] };
                }
                return resolved;
            },
        },
    };
}

const assess = (opts = {}, over = {}) =>
    script.assess(PID, { max_age_days: 7, ...over }, NOW, deps(opts));

describe('scripts/delete_object_handles', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.HANDLE_TARGET = 'https://digitalarchives.du.edu/object/';
        process.env.HANDLE_PREFIX = '10176';
        process.env.HANDLE_SERVER = 'https://hdl.handle.net/';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
        vi.restoreAllMocks();
    });

    describe('parse_args', () => {
        /* No --all, no filters: the set must be named. */
        it('requires explicit pids', () => {
            expect(() => script.parse_args(['node', 'x'])).toThrow(/--pids is required/);
            expect(() => script.parse_args(['node', 'x', '--pids', '']))
                .toThrow(/--pids is required/);
        });

        it('defaults to a dry run and a 7-day age limit', () => {
            const a = script.parse_args(['node', 'x', '--pids', 'a,b']);
            expect(a.execute).toBe(false);
            expect(a.max_age_days).toBe(7);
            expect(a.pids).toEqual(['a', 'b']);
        });

        it('rejects a nonsensical age limit rather than treating it as zero', () => {
            expect(() => script.parse_args(['node', 'x', '--pids', 'a', '--max-age-days', '0']))
                .toThrow(/positive number/);
            expect(() => script.parse_args(['node', 'x', '--pids', 'a', '--max-age-days', 'soon']))
                .toThrow(/positive number/);
        });

        it('rejects unknown arguments rather than ignoring them', () => {
            expect(() => script.parse_args(['node', 'x', '--pids', 'a', '--force']))
                .toThrow(/unknown arg/);
        });
    });

    describe('guards', () => {
        it('accepts a recently minted handle on a deleted, unpublished object', async () => {
            const v = await assess();
            expect(v.ok).toBe(true);
            expect(v.minted_at).toBe('2026-07-30T12:00:00Z');
        });

        it('refuses a LIVE object', async () => {
            const v = await assess({ row: { is_active: 1 } });
            expect(v.ok).toBe(false);
            expect(v.reason).toMatch(/ACTIVE/);
        });

        it('refuses a PUBLISHED object', async () => {
            const v = await assess({ row: { is_published: 1 } });
            expect(v.ok).toBe(false);
            expect(v.reason).toMatch(/PUBLISHED/);
        });

        it('refuses a pid with no object row', async () => {
            expect((await assess({ row: null })).reason).toMatch(/no tbl_objects row/);
        });

        it('refuses an object that carries no handle', async () => {
            expect((await assess({ row: { handle: null } })).reason).toMatch(/no handle/);
        });

        /*
         * The age guard. The only check independent of our own database, and
         * the one that makes an old identifier unreachable by this script no
         * matter what the DB says.
         */
        it('refuses a handle older than the age limit', async () => {
            const v = await assess({
                resolved: { values: [url_value(target(PID), '2019-01-01T00:00:00Z')] },
            });
            expect(v.ok).toBe(false);
            expect(v.reason).toMatch(/older than --max-age-days/);
        });

        it('honours a tightened age limit', async () => {
            /* minted 1 day before NOW; allowed at 7 days, refused at 0.5 */
            expect((await assess({}, { max_age_days: 7 })).ok).toBe(true);
            expect((await assess({}, { max_age_days: 0.5 })).ok).toBe(false);
        });

        it('refuses when the handle carries no timestamp to judge by', async () => {
            expect((await assess({ resolved: { values: [url_value(target(PID), undefined)] } })).reason).toMatch(/no timestamp/);
        });

        /*
         * A handle pointing somewhere else is not this object's to delete,
         * even though the pid names it.
         */
        it('refuses when the handle points at something else', async () => {
            const v = await assess({
                resolved: {
                    values: [url_value('https://exhibits.library.du.edu/exhibit/x',
                        '2026-07-30T12:00:00Z')],
                },
            });
            expect(v.ok).toBe(false);
            expect(v.reason).toMatch(/not this object/);
        });

        it('refuses when the handle does not exist on the server', async () => {
            expect((await assess({ resolved: null })).reason).toMatch(/does not exist/);
        });

        /* A resolve failure must never be read as "safe to delete". */
        it('refuses when resolution errors', async () => {
            const v = await assess({ resolved: new Error('ECONNRESET') });
            expect(v.ok).toBe(false);
            expect(v.reason).toMatch(/resolve failed/);
        });
    });
});
