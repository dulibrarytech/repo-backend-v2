'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = require('../../../scripts/sync_aspace_links');
const sync = require('../../../aspace_links/sync');
const app_config = require('../../../config/app');
const {
    PID,
    TWIN,
    GONE,
    COLLECTION,
    AO,
    DO,
    RESOURCE,
    handle,
    old_handle,
    row,
    link_doc,
    archival_object,
    digital_object,
    make_aspace,
    make_deps,
} = require('../../helpers/aspace_links');

const args = (extra = []) => script.parse_args(['node', 'sync_aspace_links.js', ...extra]);

describe('scripts/sync_aspace_links', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.HANDLE_PREFIX = '10176';
        process.env.ARCHIVESPACE_HOST = 'https://aspace.example';
        delete process.env.ASPACE_WRITES_ENABLED;
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('parse_args', () => {
        it('defaults to a dry run over everything', () => {
            expect(args()).toEqual({
                execute: false,
                publish: false,
                help: false,
                pids: null,
                since: null,
                out: null,
                batch_size: 100,
            });
        });

        it('reads every option', () => {
            const parsed = args([
                '--execute',
                '--publish',
                '--pids',
                `${PID}, ${TWIN}`,
                '--since',
                '2026-06-01',
                '--out',
                'results.ndjson',
                '--batch-size',
                '250',
            ]);
            expect(parsed).toMatchObject({
                execute: true,
                publish: true,
                pids: [PID, TWIN],
                since: '2026-06-01',
                out: 'results.ndjson',
                batch_size: 250,
            });
        });

        it('accepts a leap day and says which time zone the date is in', () => {
            expect(args(['--since', '2028-02-29']).since).toBe('2028-02-29');
            expect(script.USAGE).toContain("(the date in the database server's time zone)");
        });

        it.each([
            [['--since', '06/01/2026'], /--since must be YYYY-MM-DD/],
            [['--since', '2026-13-01'], /--since must be YYYY-MM-DD, a date that exists/],
            [['--since', '2026-02-30'], /--since must be YYYY-MM-DD, a date that exists/],
            [['--since', '0000-01-01'], /--since must be YYYY-MM-DD, a date that exists/],
            [['--batch-size', '0'], /--batch-size must be between 1 and 250/],
            [['--batch-size', '251'], /--batch-size must be between 1 and 250/],
            [['--batch-size', 'many'], /--batch-size must be between 1 and 250/],
            [['--all'], /unknown arg: --all/],
        ])('rejects %j', (extra, message) => {
            expect(() => args(extra)).toThrow(message);
        });
    });

    describe('select_targets', () => {
        const built = () =>
            sync.build_targets([
                row({ created: new Date('2026-08-02T00:00:00Z') }),
                row({ pid: GONE, handle: handle(GONE), is_active: 0 }),
                row({
                    pid: COLLECTION,
                    uri: RESOURCE,
                    object_type: 'collection',
                    created: new Date('2021-03-01T00:00:00Z'),
                }),
                row({ pid: TWIN, uri: '', created: new Date('2020-07-06T00:00:00Z') }),
            ]);

        it('keeps everything without a filter', () => {
            const selected = script.select_targets(built(), args());
            expect(selected.targets).toHaveLength(2);
            expect(selected.invalid).toHaveLength(1);
        });

        it('keeps a record when any of its rows is named by --pids', () => {
            const selected = script.select_targets(built(), args(['--pids', GONE]));
            expect(selected.targets.map((t) => t.uri)).toEqual([AO]);
            expect(selected.targets[0].live).toHaveLength(1);
            expect(selected.invalid).toEqual([]);
        });

        it('keeps a record when any of its rows was created on or after --since', () => {
            const selected = script.select_targets(built(), args(['--since', '2026-08-01']));
            expect(selected.targets.map((t) => t.uri)).toEqual([AO]);
            expect(selected.invalid).toEqual([]);
        });
    });

    describe('run', () => {
        const rows = () => [
            row(),
            row({
                pid: COLLECTION,
                handle: handle(COLLECTION),
                uri: RESOURCE,
                object_type: 'collection',
            }),
        ];
        const records = () => [
            archival_object(),
            digital_object(),
            {
                uri: RESOURCE,
                lock_version: 8,
                external_documents: [link_doc(old_handle(COLLECTION))],
            },
        ];

        it('reports a record ArchivesSpace cannot return, and carries on with the rest', async () => {
            const aspace = make_aspace(records());
            const list = aspace.get_native_set;
            aspace.get_native_set = async (listing, ids) =>
                listing.endsWith('/resources')
                    ? { status: 500, data: { error: 'boom' } }
                    : list(listing, ids);
            const deps = make_deps(aspace, rows());
            const code = await script.run(args(), deps);
            const text = deps.output.join('');

            expect(code).toBe(0);
            expect(text).toMatch(/1 {2}pending/);
            expect(text).toMatch(/1 {2}needs_review/);
            expect(text).toContain(
                `${RESOURCE}  [${COLLECTION}]  ` +
                    'ArchivesSpace /repositories/2/resources returned HTTP 500: boom'
            );
        });

        it('stores nothing for the admin page in a dry run', async () => {
            const stored = [];
            const deps = {
                ...make_deps(make_aspace(records()), rows()),
                store: async (result) => stored.push(result),
            };
            await script.run(args(), deps);
            expect(stored).toEqual([]);
            expect(deps.output.join('')).not.toContain('admin page');
        });

        it('reports what a dry run would change and writes nothing', async () => {
            const aspace = make_aspace(records());
            const deps = make_deps(aspace, rows());
            const code = await script.run(args(), deps);
            const text = deps.output.join('');

            expect(code).toBe(0);
            expect(aspace.calls.posts).toEqual([]);
            expect(text).toContain('ArchivesSpace  https://aspace.example');
            expect(text).toContain('dry run (no writes)');
            expect(text).toMatch(/1 {2}pending/);
            expect(text).toMatch(/1 {2}in_sync/);
            expect(text).toMatch(/1 {2}link add/);
            expect(text).toMatch(/1 {2}digital object identifier/);
            expect(text).toContain('Dry run: 1 record(s) would be updated');
        });

        it('names the second switch when a development host would write to another machine', async () => {
            process.env.NODE_ENV = 'development';
            process.env.ASPACE_WRITES_ENABLED = '1';
            delete process.env.ASPACE_WRITES_FROM_DEV;
            app_config._reset();
            const aspace = make_aspace(records());
            const deps = make_deps(aspace, rows());
            const code = await script.run(args(['--execute']), deps);

            expect(code).toBe(1);
            expect(deps.output.join('')).toContain('also needs ASPACE_WRITES_FROM_DEV=1');
            expect(aspace.calls.sets).toEqual([]);
            expect(aspace.calls.posts).toEqual([]);

            process.env.ASPACE_WRITES_FROM_DEV = '1';
            app_config._reset();
            expect(await script.run(args(['--execute']), make_deps(aspace, rows()))).toBe(0);
            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
        });

        it('counts the links a dry run would remove', async () => {
            const aspace = make_aspace([
                archival_object({ instances: [], external_documents: [link_doc(handle(PID))] }),
            ]);
            const deps = make_deps(aspace, [row({ is_published: 0 })]);
            await script.run(args(), deps);
            expect(deps.output.join('')).toMatch(/1 {2}link remove/);
            expect(aspace.calls.posts).toEqual([]);
        });

        it('refuses --execute, before any request, while writes are disabled', async () => {
            const aspace = make_aspace(records());
            const deps = make_deps(aspace, rows());
            const code = await script.run(args(['--execute']), deps);

            expect(code).toBe(1);
            expect(deps.output.join('')).toContain('--execute needs ASPACE_WRITES_ENABLED=1');
            expect(aspace.calls.sets).toEqual([]);
            expect(aspace.calls.posts).toEqual([]);
        });

        it('stops when ArchivesSpace or the handle prefix is not configured', async () => {
            const unconfigured = make_aspace(records(), { configured: false });
            expect(await script.run(args(), make_deps(unconfigured, rows()))).toBe(1);

            delete process.env.HANDLE_PREFIX;
            app_config._reset();
            const aspace = make_aspace(records());
            expect(await script.run(args(), make_deps(aspace, rows()))).toBe(1);
            expect(aspace.calls.sets).toEqual([]);
        });

        describe('with ASPACE_WRITES_ENABLED on', () => {
            beforeEach(() => {
                process.env.ASPACE_WRITES_ENABLED = '1';
                app_config._reset();
            });

            it('writes the identifier, then the link, and leaves in-sync records alone', async () => {
                const aspace = make_aspace(records());
                const deps = make_deps(aspace, rows());
                const code = await script.run(args(['--execute']), deps);

                expect(code).toBe(0);
                expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
                expect(aspace.store.get(DO).digital_object_id).toBe(handle(PID));
                expect(aspace.store.get(AO).external_documents).toEqual([link_doc(handle(PID))]);
                expect(aspace.store.get(RESOURCE).lock_version).toBe(8);
                expect(deps.output.join('')).toContain('1 updated, 0 failed');
            });

            it('stores each result for the admin page, and each write, as it goes', async () => {
                const aspace = make_aspace(records());
                const stored = [];
                const written = [];
                const deps = {
                    ...make_deps(aspace, rows()),
                    store: async (result) => stored.push(result),
                    log_change: async (entry) => written.push(entry),
                };
                await script.run(args(['--execute']), deps);

                expect(stored.map((result) => `${result.uri} ${result.state}`)).toEqual([
                    `${AO} updated`,
                    `${RESOURCE} in_sync`,
                ]);
                expect(written.map((entry) => `${entry.uri} ${entry.field}`)).toEqual([
                    `${DO} digital_object_id`,
                    `${AO} link`,
                ]);
                expect(deps.output.join('')).toContain('admin page     updated with each result');
            });

            it('says when the admin page cannot be updated', async () => {
                const deps = make_deps(make_aspace(records()), rows());
                await script.run(args(['--execute']), deps);
                expect(deps.output.join('')).toContain(
                    'admin page     not updated (queue tables missing)'
                );
            });

            it('finds nothing to do on a second run', async () => {
                const aspace = make_aspace(records());
                await script.run(args(['--execute']), make_deps(aspace, rows()));
                aspace.calls.posts.length = 0;

                const deps = make_deps(aspace, rows());
                expect(await script.run(args(['--execute']), deps)).toBe(0);
                expect(aspace.calls.posts).toEqual([]);
                expect(deps.output.join('')).toMatch(/2 {2}in_sync/);
            });

            it('returns 1 and names the record when an update is refused', async () => {
                const aspace = make_aspace(records(), { update_statuses: [400] });
                const deps = make_deps(aspace, rows());
                const code = await script.run(args(['--execute']), deps);
                const text = deps.output.join('');

                expect(code).toBe(1);
                expect(text).toContain('0 updated, 1 failed');
                expect(text).toContain(`${DO}: HTTP 400: refused 400`);
                expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
            });
        });

        it('stops the run when five updates in a row fail, even across batches', async () => {
            process.env.ASPACE_WRITES_ENABLED = '1';
            app_config._reset();
            const pid_of = (n) => `00000000-0000-4000-8000-00000000000${n}`;
            const uri_of = (n) => `/repositories/2/archival_objects/${100 + n}`;
            const numbers = [1, 2, 3, 4, 5, 6, 7];
            const aspace = make_aspace(
                numbers.map((n) => archival_object({ uri: uri_of(n), instances: [] })),
                { update_statuses: Array(7).fill(503) }
            );
            const deps = make_deps(
                aspace,
                numbers.map((n) =>
                    row({ pid: pid_of(n), handle: handle(pid_of(n)), uri: uri_of(n) })
                )
            );

            const code = await script.run(args(['--execute', '--batch-size', '2']), deps);
            const text = deps.output.join('');
            expect(code).toBe(1);
            expect(aspace.calls.posts).toHaveLength(5);
            expect(text).toContain(
                `Stopped early: 5 updates in a row failed. Last: ${uri_of(5)}: ` +
                    `ArchivesSpace ${uri_of(5)} returned HTTP 503: refused 503`
            );
            expect(text).toContain('0 updated, 5 failed');
        });

        it('carries on past updates the account is not allowed to make', async () => {
            process.env.ASPACE_WRITES_ENABLED = '1';
            app_config._reset();
            const pid_of = (n) => `00000000-0000-4000-8000-00000000000${n}`;
            const uri_of = (n) => `/repositories/2/archival_objects/${100 + n}`;
            const numbers = [1, 2, 3, 4, 5, 6, 7];
            const aspace = make_aspace(
                numbers.map((n) => archival_object({ uri: uri_of(n), instances: [] })),
                { update_statuses: Array(7).fill(403) }
            );
            const deps = make_deps(
                aspace,
                numbers.map((n) =>
                    row({ pid: pid_of(n), handle: handle(pid_of(n)), uri: uri_of(n) })
                )
            );

            const code = await script.run(args(['--execute', '--batch-size', '2']), deps);
            const text = deps.output.join('');
            expect(code).toBe(1);
            expect(aspace.calls.posts).toHaveLength(7);
            expect(text).not.toContain('Stopped early');
            expect(text).toContain('may not be allowed to update this kind of record');
            expect(text).toContain('0 updated, 7 failed');
        });

        it('checks each batch against the objects as they are when it is reached', async () => {
            process.env.ASPACE_WRITES_ENABLED = '1';
            app_config._reset();
            const second = '/repositories/2/archival_objects/7';
            const aspace = make_aspace([
                archival_object({ instances: [] }),
                archival_object({
                    uri: second,
                    instances: [],
                    external_documents: [link_doc(handle(TWIN))],
                }),
            ]);
            const objects = [row(), row({ pid: TWIN, handle: handle(TWIN), uri: second })];
            const stored = [];
            const deps = {
                ...make_deps(aspace, objects),
                store: async (result) => {
                    stored.push(`${result.uri} ${result.state} ${result.link}`);
                    if (result.uri === AO) objects[1] = { ...objects[1], is_published: 0 };
                },
            };

            await script.run(args(['--execute', '--batch-size', '1']), deps);
            expect(stored).toEqual([`${AO} updated add`, `${second} updated remove`]);
            expect(aspace.store.get(second).external_documents).toEqual([]);
        });

        it('says why a record needs a review', async () => {
            const aspace = make_aspace([
                archival_object({
                    instances: [],
                    external_documents: [link_doc(old_handle(PID)), link_doc(old_handle(GONE))],
                }),
            ]);
            const deps = make_deps(aspace, [row()]);
            await script.run(args(), deps);
            const text = deps.output.join('');
            expect(text).toMatch(/1 {2}needs_review/);
            expect(text).toContain(
                `${AO}  [${PID}]  The record has more than one repository link.`
            );
        });

        it('reads in batches, one listing at a time', async () => {
            const second = '/repositories/2/archival_objects/2';
            const third = '/repositories/2/archival_objects/3';
            const aspace = make_aspace([]);
            const deps = make_deps(aspace, [
                row({ pid: COLLECTION, handle: handle(COLLECTION), uri: RESOURCE }),
                row(),
                row({ pid: TWIN, handle: handle(TWIN), uri: second }),
                row({ pid: GONE, handle: handle(GONE), uri: third }),
            ]);
            await script.run(args(['--batch-size', '2']), deps);

            expect(aspace.calls.sets).toEqual([
                { listing: '/repositories/2/archival_objects', ids: [192976, 2] },
                { listing: '/repositories/2/archival_objects', ids: [3] },
                { listing: '/repositories/2/resources', ids: [1277] },
            ]);
            expect(deps.output.join('')).toMatch(/4 {2}record_not_found/);
        });

        it('writes one JSON line per record to --out', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-aspace-links-'));
            const out = path.join(dir, 'results.ndjson');
            try {
                const aspace = make_aspace(records());
                const deps = make_deps(aspace, [...rows(), row({ pid: TWIN, uri: '' })]);
                await script.run(args(['--out', out]), deps);

                const lines = fs
                    .readFileSync(out, 'utf8')
                    .trim()
                    .split('\n')
                    .map((line) => JSON.parse(line));
                expect(lines.map((line) => line.state).sort()).toEqual([
                    'in_sync',
                    'invalid_uri',
                    'pending',
                ]);
                expect(lines.find((line) => line.state === 'pending')).toMatchObject({
                    uri: AO,
                    pids: [PID],
                    link: 'add',
                    digital_object: 'update',
                });
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
