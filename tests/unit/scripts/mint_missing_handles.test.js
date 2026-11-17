'use strict';

const script = require('../../../scripts/mint_missing_handles');

const PID = '2d569507-de89-41eb-9bb6-6be0d12b5eb8';
const OTHER = '11895f17-8ca0-44cf-8d5f-672bc1284a95';
const HANDLE = `https://hdl.handle.net/10176/${PID}`;
const TARGET = `https://digitalarchives.du.edu/object/${PID}`;
const V1_FAILURE =
    'Error: [/libs/handles lib (create_handle)] Unable to create new handle ' +
    'Error: getaddrinfo ENOTFOUND hdl.example.org hdl.example.org:8080';

const on_server = (value = TARGET) => ({
    values: [{ index: 2, type: 'URL', data: { format: 'string', value } }],
});

function resolver(answers) {
    return {
        get_handle: vi.fn(async () => {
            const answer = answers.length > 1 ? answers.shift() : answers[0];
            if (answer instanceof Error) throw answer;
            return answer;
        }),
    };
}

function assess(row, ...answers) {
    const handles = resolver(answers);
    const plan = script.assess(
        { pid: PID, handle: HANDLE, is_active: 1, ...row },
        handles,
        '10176'
    );
    return plan.then((result) => ({ ...result, asked: handles.get_handle.mock.calls.length }));
}

const args = (...list) => script.parse_args(['node', 'mint_missing_handles.js', ...list]);

describe('scripts/mint_missing_handles', () => {
    describe('parse_args', () => {
        it('is a dry run unless --execute is given', () => {
            expect(args('--pids', PID).execute).toBe(false);
            expect(args('--pids', PID, '--execute').execute).toBe(true);
        });

        it('reads a comma-separated list of pids', () => {
            expect(args('--pids', ` ${PID}, ${OTHER} ,`).pids).toEqual([PID, OTHER]);
        });

        it('reads a window of ingest times', () => {
            const parsed = args('--from', '2023-09-01', '--to', '2023-10-01 00:00:00');
            expect(parsed).toMatchObject({
                from: '2023-09-01',
                to: '2023-10-01 00:00:00',
                pids: null,
            });
        });

        it('refuses to run without naming objects or a window', () => {
            expect(() => args()).toThrow(/--pids/);
            expect(() => args('--execute')).toThrow(/--pids/);
            expect(() => args('--pids', ' , ')).toThrow(/--pids/);
        });

        it('needs both ends of the window', () => {
            expect(() => args('--from', '2023-09-01')).toThrow(/both required/);
            expect(() => args('--to', '2023-10-01')).toThrow(/both required/);
        });

        it('accepts a leap day and the last second of a day', () => {
            expect(args('--from', '2024-02-29', '--to', '2024-02-29 23:59:59')).toMatchObject({
                from: '2024-02-29',
                to: '2024-02-29 23:59:59',
            });
        });

        it.each([
            '09/01/2023',
            '2023-9-1',
            'yesterday',
            '2023-09-01T00:00:00Z',
            '',
            '2023-02-30',
            '2023-02-29',
            '2023-13-01',
            '2023-00-10',
            '2023-09-00',
            '2023-09-12 24:00',
            '2023-09-12 25:00:00',
            '2023-09-12 23:60',
            '2023-09-12 23:59:60',
        ])('refuses the date %j', (value) => {
            expect(() => args('--from', value, '--to', '2023-10-01')).toThrow(/both required/);
            expect(() => args('--from', '2023-09-01', '--to', value)).toThrow(/both required/);
        });

        it('refuses pids together with a window', () => {
            expect(() => args('--pids', PID, '--from', '2023-09-01', '--to', '2023-10-01')).toThrow(
                /not both/
            );
        });

        it('refuses an unknown argument', () => {
            expect(() => args('--pids', PID, '--all')).toThrow(/unknown arg: --all/);
        });
    });

    describe('assess', () => {
        it('leaves an object alone when its handle is on the server', async () => {
            expect(await assess({}, on_server())).toMatchObject({
                mint: false,
                store: false,
                skipped: null,
                failed: null,
            });
        });

        it('creates the handle when the server does not have it', async () => {
            expect(await assess({}, null)).toMatchObject({ mint: true, store: false });
        });

        it('creates and stores when the row holds the v1 failure text', async () => {
            expect(await assess({ handle: V1_FAILURE }, null)).toMatchObject({
                mint: true,
                store: true,
            });
        });

        it('only stores when the handle exists and the row holds the v1 failure text', async () => {
            expect(await assess({ handle: V1_FAILURE }, on_server())).toMatchObject({
                mint: false,
                store: true,
            });
        });

        it.each([
            ['an http address', `http://hdl.handle.net/10176/${PID}`],
            [
                'upper case',
                HANDLE.toUpperCase().replace('HTTPS://HDL.HANDLE.NET', 'https://hdl.handle.net'),
            ],
            ['surrounding spaces', ` ${HANDLE}\n`],
        ])('accepts the stored handle written with %s', async (_label, handle) => {
            expect(await assess({ handle }, null)).toMatchObject({ mint: true, store: false });
        });

        it('never asks about a deleted object', async () => {
            expect(await assess({ is_active: 0 }, null)).toMatchObject({
                mint: false,
                store: false,
                skipped: 'deleted object',
                asked: 0,
            });
        });

        it.each([
            ['a test value', 'test-handle'],
            ['nothing', null],
            ['an empty string', ''],
            ['another object’s handle', `https://hdl.handle.net/10176/${OTHER}`],
            ['a bare pid', PID],
            ['another error text', 'Error: something else went wrong'],
        ])('skips an object whose stored handle is %s', async (_label, handle) => {
            expect(await assess({ handle }, null)).toMatchObject({
                mint: false,
                store: false,
                skipped: 'unexpected stored handle',
                asked: 0,
            });
        });

        it('does not treat an unanswered lookup as a missing handle', async () => {
            expect(await assess({}, new Error('Handle resolve returned 500'))).toMatchObject({
                mint: false,
                store: false,
                skipped: null,
                failed: 'Handle resolve returned 500',
                asked: 3,
            });
        });

        it('asks again when a lookup goes unanswered', async () => {
            const unanswered = new Error('Handle resolve returned 500');

            expect(await assess({}, unanswered, unanswered, null)).toMatchObject({
                mint: true,
                failed: null,
                asked: 3,
            });
            expect(await assess({}, unanswered, on_server())).toMatchObject({
                mint: false,
                failed: null,
                asked: 2,
            });
        });
    });

    describe('points_at', () => {
        it('is true when a URL value is the address', () => {
            expect(script.points_at(on_server(), TARGET)).toBe(true);
        });

        it.each([
            ['no handle', null],
            ['no values', {}],
            ['another address', on_server(`https://digitalarchives.du.edu/object/${OTHER}`)],
            [
                'a value of another type',
                { values: [{ type: 'HS_ADMIN', data: { value: TARGET } }] },
            ],
            ['a URL value without data', { values: [{ type: 'URL' }] }],
        ])('is false for %s', (_label, found) => {
            expect(script.points_at(found, TARGET)).toBe(false);
        });
    });

    describe('with_handle', () => {
        it('replaces the handle and keeps everything else in place', () => {
            const before = JSON.stringify({
                pid: PID,
                handle: V1_FAILURE,
                title: 'Part 4',
                parts: [1],
            });
            expect(script.with_handle(before, HANDLE)).toBe(
                JSON.stringify({ pid: PID, handle: HANDLE, title: 'Part 4', parts: [1] })
            );
        });

        it('adds the handle when the record has none', () => {
            expect(JSON.parse(script.with_handle('{"title":"Part 4"}', HANDLE))).toEqual({
                title: 'Part 4',
                handle: HANDLE,
            });
        });

        it.each([null, undefined, '', 'not json', '[1,2]', '"text"', '7', 'null'])(
            'gives nothing for %j',
            (value) => {
                expect(script.with_handle(value, HANDLE)).toBeNull();
            }
        );
    });

    describe('outcome', () => {
        const plan = (over) => ({
            mint: false,
            store: false,
            skipped: null,
            failed: null,
            ...over,
        });

        it.each([
            [plan({}), false, 'exists'],
            [plan({}), true, 'exists'],
            [plan({ mint: true }), false, 'to do: create'],
            [plan({ mint: true, store: true }), false, 'to do: create and store'],
            [plan({ store: true }), false, 'to do: store'],
            [plan({ mint: true }), true, 'done: create'],
            [plan({ mint: true, store: true }), true, 'done: create and store'],
            [plan({ store: true }), true, 'done: store'],
            [plan({ skipped: 'deleted object' }), true, 'skipped'],
            [plan({ mint: true, failed: 'no' }), true, 'FAILED'],
        ])('%j (execute %j) reads %j', (entry, execute, label) => {
            expect(script.outcome(entry, execute)).toBe(label);
        });
    });
});
