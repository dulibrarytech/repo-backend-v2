'use strict';

const workspace = require('../../../ingester/workspace');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
// model is imported through workspace.js — no direct use in this file.

/*
 * Tiny fake astools — returns scripted responses keyed by call name.
 * Two list endpoints (workspace / processed) match the curation-service
 * shape; default empty response uses the canonical `{result: []}` envelope.
 */
function make_astools(script = {}) {
    const calls = {
        list_workspace: [],
        list_processed: [],
        list_packages: [],
        get_uri: [],
        make_digital_objects: [],
        revert_to_mdo: [],
    };
    function next(name, ...args) {
        const fn = script[name];
        if (typeof fn === 'function') return fn(...args);
        if (Array.isArray(fn)) return fn.length > 1 ? fn.shift() : fn[0];
        return fn || { status: 200, data: { result: [] } };
    }
    return {
        is_configured: () => script.is_configured !== false,
        async list_workspace() {
            calls.list_workspace.push({});
            return next('list_workspace');
        },
        async list_processed() {
            calls.list_processed.push({});
            return next('list_processed');
        },
        async list_packages(folder) {
            calls.list_packages.push({ folder });
            return next('list_packages', folder);
        },
        async get_uri(folder, pkg) {
            calls.get_uri.push({ folder, pkg });
            return next('get_uri', folder, pkg);
        },
        async make_digital_objects(folder) {
            calls.make_digital_objects.push({ folder });
            return next('make_digital_objects', folder);
        },
        async revert_to_mdo(folder) {
            calls.revert_to_mdo.push({ folder });
            return next('revert_to_mdo', folder);
        },
        _calls: calls,
    };
}

function make_aspace({ records = {} } = {}) {
    return {
        is_configured: () => true,
        async get_session_token() {
            return 'tok';
        },
        async get_record(uri) {
            return records[uri] || { status: 404, data: null };
        },
        async destroy_session_token() {},
    };
}

function make_validator(errors_for = {}) {
    return {
        validate_record: (metadata) => {
            const k = metadata && metadata.uri;
            return errors_for[k] || [];
        },
    };
}

describe('ingester/workspace', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        /*
         * QA-passed state used to live in an in-process Set with a
         * _reset_for_tests escape hatch. It now lives in
         * tbl_ingest_jobs, so the reset is just the regular table
         * truncate that db_helper.reset_data already performs.
         */
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('list_workspace', () => {
        it('unprocessed scope hits /workspace; folder names come from result envelope', async () => {
            const astools = make_astools({
                list_workspace: {
                    status: 200,
                    data: { result: ['col-a', 'col-b'], errors: [] },
                },
                list_packages: (folder) =>
                    folder === 'col-a'
                        ? { status: 200, data: { result: ['pkg-1', 'pkg-2'], errors: [] } }
                        : { status: 200, data: { result: ['pkg-x'], errors: [] } },
            });
            const data = await workspace.list_workspace({ scope: 'unprocessed', astools });
            /*
             * Server pre-filters — every folder list_workspace returns
             * is by definition unprocessed; we render all of them.
             */
            expect(data.folders.map((f) => f.name)).toEqual(['col-a', 'col-b']);
            expect(data.total_folders).toBe(2);
            expect(data.total_packages).toBe(3);
            // And we should NOT have called the /processed endpoint.
            expect(astools._calls.list_processed).toHaveLength(0);
        });

        it('processed scope hits /processed (not /workspace)', async () => {
            const astools = make_astools({
                list_processed: {
                    status: 200,
                    data: { result: ['col-with-uri'], errors: [] },
                },
                list_packages: { status: 200, data: { result: ['pkg-x'], errors: [] } },
            });
            const data = await workspace.list_workspace({ scope: 'processed', astools });
            expect(data.folders.map((f) => f.name)).toEqual(['col-with-uri']);
            expect(astools._calls.list_processed).toHaveLength(1);
            expect(astools._calls.list_workspace).toHaveLength(0);
        });

        it('honors the q search filter (case-insensitive substring)', async () => {
            const astools = make_astools({
                list_workspace: {
                    status: 200,
                    data: { result: ['Special-Coll-2024', 'random-other'], errors: [] },
                },
                list_packages: { status: 200, data: { result: [], errors: [] } },
            });
            const data = await workspace.list_workspace({
                scope: 'unprocessed',
                q: 'special',
                astools,
            });
            expect(data.folders.map((f) => f.name)).toEqual(['Special-Coll-2024']);
        });

        it('respects exclude_qa_passed (suppresses qa-passed folders from /processed)', async () => {
            const astools = make_astools({
                list_processed: {
                    status: 200,
                    data: { result: ['col-a', 'col-b'], errors: [] },
                },
                list_packages: { status: 200, data: { result: ['p'], errors: [] } },
            });
            /*
             * QA-passed state is now sourced from tbl_ingest_jobs.
             * The simplest test stub is a `jobs` shim that returns
             * a fixed Set — avoids having to seed the actual table.
             */
            const jobs = {
                get_qa_passed_folders: async () => new Set(['col-a']),
            };
            const data = await workspace.list_workspace({
                scope: 'processed',
                exclude_qa_passed: true,
                astools,
                jobs,
            });
            expect(data.folders.map((f) => f.name)).toEqual(['col-b']);
        });

        it('skips the qa-passed lookup when exclude_qa_passed is false (no unnecessary DB hit)', async () => {
            const astools = make_astools({
                list_processed: {
                    status: 200,
                    data: { result: ['col-a'], errors: [] },
                },
                list_packages: { status: 200, data: { result: ['p'], errors: [] } },
            });
            let called = false;
            const jobs = {
                get_qa_passed_folders: async () => {
                    called = true;
                    return new Set(['col-a']);
                },
            };
            const data = await workspace.list_workspace({
                scope: 'processed',
                exclude_qa_passed: false,
                astools,
                jobs,
            });
            // col-a is NOT filtered out, and the jobs query was never made.
            expect(data.folders.map((f) => f.name)).toEqual(['col-a']);
            expect(called).toBe(false);
        });

        it('falls back to "no folders hidden" when the qa-passed lookup throws', async () => {
            const astools = make_astools({
                list_processed: {
                    status: 200,
                    data: { result: ['col-a'], errors: [] },
                },
                list_packages: { status: 200, data: { result: ['p'], errors: [] } },
            });
            const jobs = {
                get_qa_passed_folders: async () => {
                    throw new Error('DB unreachable');
                },
            };
            const data = await workspace.list_workspace({
                scope: 'processed',
                exclude_qa_passed: true,
                astools,
                jobs,
            });
            /*
             * Soft-fail: folder still shown. Better UX than a hard
             * error page; the operator just sees the folder until
             * the DB recovers.
             */
            expect(data.folders.map((f) => f.name)).toEqual(['col-a']);
        });

        it('surfaces an error envelope when curation-API is down', async () => {
            const astools = make_astools({
                list_workspace: { status: 503, data: null },
                list_packages: { status: 200, data: { result: [], errors: [] } },
            });
            const data = await workspace.list_workspace({ scope: 'unprocessed', astools });
            expect(data.folders).toEqual([]);
            expect(data.error).toMatch(/HTTP 503/);
        });

        it('returns the not-configured envelope when astools env is unset', async () => {
            const astools = { is_configured: () => false };
            const data = await workspace.list_workspace({ scope: 'unprocessed', astools });
            expect(data.error).toMatch(/not configured/i);
        });

        it('flags packages_error on a folder when its package fetch fails', async () => {
            const astools = make_astools({
                list_workspace: { status: 200, data: { result: ['col-a'], errors: [] } },
                list_packages: { status: 500, data: null },
            });
            const data = await workspace.list_workspace({ scope: 'unprocessed', astools });
            expect(data.folders[0].packages_error).toMatch(/HTTP 500/);
        });

        it('also tolerates legacy { folders: [...] } and bare-array shapes', async () => {
            /*
             * Mocks + older staging builds returned these shapes; keep
             * them working so we don't have to revise every test mock.
             */
            const astools_a = make_astools({
                list_workspace: { status: 200, data: { folders: ['legacy-a'] } },
                list_packages: { status: 200, data: { result: [], errors: [] } },
            });
            const a = await workspace.list_workspace({ scope: 'unprocessed', astools: astools_a });
            expect(a.folders.map((f) => f.name)).toEqual(['legacy-a']);

            const astools_b = make_astools({
                list_workspace: { status: 200, data: ['bare-a'] },
                list_packages: { status: 200, data: ['p1'] },
            });
            const b = await workspace.list_workspace({ scope: 'unprocessed', astools: astools_b });
            expect(b.folders.map((f) => f.name)).toEqual(['bare-a']);
            expect(b.folders[0].packages).toEqual(['p1']);
        });
    });

    describe('run_make_digital_objects', () => {
        it('returns { ok: true } on 2xx', async () => {
            const astools = make_astools({
                make_digital_objects: { status: 200, data: { result: { success: true } } },
            });
            const r = await workspace.run_make_digital_objects('col-a', { astools });
            expect(r.ok).toBe(true);
            expect(r.status).toBe(200);
        });

        it('returns { ok: false } with errors on failure', async () => {
            const astools = make_astools({
                make_digital_objects: () => {
                    throw new Error('curation down');
                },
            });
            const r = await workspace.run_make_digital_objects('col-a', { astools });
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(/curation down/);
        });
    });

    describe('revert_to_mdo', () => {
        /*
         * QA-passed state is no longer a per-process marker; it's
         * derived from tbl_ingest_jobs. Revert doesn't (and doesn't
         * need to) explicitly clear it because (a) revert removes
         * uri.txt and the folder drops from /processed; (b) any
         * future activity for that folder records a newer job that
         * supersedes the SUCCESSFUL QA marker via
         * jobs.get_qa_passed_folders' "latest job per folder" rule.
         */
        it('returns ok=true on a 200 from astools.revert_to_mdo', async () => {
            const astools = make_astools({
                revert_to_mdo: { status: 200, data: { result: { removed: ['p1'] } } },
            });
            const r = await workspace.revert_to_mdo('col-a', { astools });
            expect(r.ok).toBe(true);
        });
    });

    describe('run_qa_check', () => {
        it('validates each package via uri.txt + AS fetch + validator', async () => {
            const astools = make_astools({
                list_packages: {
                    status: 200,
                    data: { packages: [{ name: 'p1' }, { name: 'p2' }] },
                },
                get_uri: (folder, pkg) =>
                    pkg === 'p1'
                        ? { status: 200, data: '/repositories/2/resources/1' }
                        : { status: 200, data: { uri: '/repositories/2/resources/2' } },
            });
            const aspace = make_aspace({
                records: {
                    '/repositories/2/resources/1': {
                        status: 200,
                        data: { uri: '/repositories/2/resources/1', title: 'ok' },
                    },
                    '/repositories/2/resources/2': {
                        status: 200,
                        data: { uri: '/repositories/2/resources/2', title: '' },
                    },
                },
            });
            const validator = make_validator({
                '/repositories/2/resources/2': ['Title field is missing'],
            });
            const r = await workspace.run_qa_check('col-a', { astools, aspace, validator });
            expect(r.packages).toHaveLength(2);
            const by_name = Object.fromEntries(r.packages.map((p) => [p.name, p]));
            expect(by_name.p1.ok).toBe(true);
            expect(by_name.p2.ok).toBe(false);
            expect(by_name.p2.errors).toContain('Title field is missing');
            expect(r.ok).toBe(false); // overall fails because p2 failed
        });

        it('returns ok=true overall when every package validates cleanly', async () => {
            const astools = make_astools({
                list_packages: { status: 200, data: { packages: [{ name: 'p1' }] } },
                get_uri: { status: 200, data: '/repositories/2/resources/1' },
            });
            const aspace = make_aspace({
                records: {
                    '/repositories/2/resources/1': {
                        status: 200,
                        data: { uri: '/repositories/2/resources/1', title: 'fine' },
                    },
                },
            });
            const r = await workspace.run_qa_check('col-a', {
                astools,
                aspace,
                validator: make_validator(),
            });
            expect(r.ok).toBe(true);
        });

        it('flags a missing uri.txt for the package', async () => {
            const astools = make_astools({
                list_packages: { status: 200, data: { packages: [{ name: 'p1' }] } },
                get_uri: { status: 404, data: null },
            });
            const r = await workspace.run_qa_check('col-a', {
                astools,
                aspace: make_aspace(),
                validator: make_validator(),
            });
            expect(r.packages[0].ok).toBe(false);
            expect(r.packages[0].errors).toContain('uri.txt missing');
        });

        it('reads the canonical curation-service URI shape `{result:{uris:[..]}}`', async () => {
            /*
             * The real curation-service wraps uri.txt content as
             * `{result: {uris: ['/repositories/2/resources/1'], files: [...]}}`.
             * Make sure we handle the canonical shape, not just the
             * legacy bare-string fallback.
             */
            const astools = make_astools({
                list_packages: { status: 200, data: { result: ['p1'], errors: [] } },
                get_uri: {
                    status: 200,
                    data: {
                        result: { uris: ['/repositories/2/resources/1'], files: ['uri.txt'] },
                        errors: [],
                    },
                },
            });
            const aspace = make_aspace({
                records: {
                    '/repositories/2/resources/1': {
                        status: 200,
                        data: { uri: '/repositories/2/resources/1', title: 'fine' },
                    },
                },
            });
            const r = await workspace.run_qa_check('col-a', {
                astools,
                aspace,
                validator: make_validator(),
            });
            expect(r.ok).toBe(true);
            expect(r.packages[0].uri).toBe('/repositories/2/resources/1');
        });

        it('treats `{result:{uris:[]}}` (empty array) as missing uri.txt', async () => {
            const astools = make_astools({
                list_packages: { status: 200, data: { result: ['p1'], errors: [] } },
                get_uri: { status: 200, data: { result: { uris: [], files: [] }, errors: [] } },
            });
            const r = await workspace.run_qa_check('col-a', {
                astools,
                aspace: make_aspace(),
                validator: make_validator(),
            });
            expect(r.packages[0].ok).toBe(false);
            expect(r.packages[0].errors).toContain('uri.txt is empty');
        });
    });

    describe('submit_to_ingest', () => {
        /*
         * Submit no longer explicitly clears the qa-passed marker.
         * The controller records a `packaging_and_ingesting` job
         * around the submit call, which (being more recent than the
         * SUCCESSFUL QA row) wins jobs.get_qa_passed_folders' "latest
         * job per folder" tie-break and removes the folder from the
         * hidden set on the next list query.
         * 
         * Pre-flight gate: every submit now requires the folder name
         * to end in `-resources_<N>` (or `-archival_objects_<N>`) AND
         * a local collection mirror to exist. The tests below inject
         * a `repo_model` stub that says the collection is already
         * present, so the gate fast-paths without hitting AS. The
         * dedicated `gate` describe block below exercises the parse +
         * fetch + create paths directly.
         */
        const FOLDER = 'col-a-resources_1';
        const COLLECTION_URI = '/repositories/2/resources/1';
        function gated_repo() {
            return {
                find_collection_by_uri: async (uri) =>
                    uri === COLLECTION_URI
                        ? { pid: 'pre-existing-collection-pid', uri: COLLECTION_URI }
                        : undefined,
                create_collection: async () => {
                    throw new Error('should not be called — collection pre-exists');
                },
            };
        }

        it('queues one package per archival object', async () => {
            const astools = make_astools({
                list_packages: {
                    status: 200,
                    data: { packages: [{ name: 'p1' }, { name: 'p2' }] },
                },
                get_uri: (folder, pkg) => ({
                    status: 200,
                    data: `/repositories/2/resources/${pkg}`,
                }),
            });
            const r = await workspace.submit_to_ingest(FOLDER, 'staff-1', {
                astools,
                repo_model: gated_repo(),
            });
            expect(r.ok).toBe(true);
            expect(r.count).toBe(2);
            const rows = await db_queue()(tables.ingest_queue).orderBy('id', 'asc');
            expect(rows).toHaveLength(2);
            expect(rows[0].package).toBe('p1');
            expect(rows[0].metadata_uri).toBe('/repositories/2/resources/p1');
            expect(rows[1].package).toBe('p2');
            /*
             * The queue row's collection_uuid carries the local
             * collection's PID (resolved by the pre-flight gate),
             * NOT the staff-facing folder name. The folder name still
             * lives in `batch` for traceability + Stage 3's SFTP
             * path. This is the contract task #119 enforced.
             */
            for (const row of rows) {
                expect(row.collection_uuid).toBe('pre-existing-collection-pid');
                expect(row.batch).toBe(FOLDER);
            }
            /*
             * Regression guard for task #128: the SFTP folder
             * namespace IS row.collection_uuid (matches v1 — one
             * SFTP folder per collection, shared across packages).
             * collection_uuid is minted by the pre-flight gate ONCE
             * when a new collection is created, then reused for
             * existing collections — sibling packages in the same
             * submit land in the same SFTP folder.
             */
            const collection_uuids = rows.map((r) => r.collection_uuid);
            for (const u of collection_uuids) {
                /*
                 * Stable value from the gate (the fake repo-model
                 * returns 'pre-existing-collection-pid' here).
                 */
                expect(u).toBe('pre-existing-collection-pid');
            }
            /*
             * All sibling packages share the same collection_uuid —
             * they all land in the same SFTP folder downstream.
             */
            expect(collection_uuids[0]).toBe(collection_uuids[1]);
        });

        it('rejects the batch when any package is missing uri.txt', async () => {
            const astools = make_astools({
                list_packages: {
                    status: 200,
                    data: { packages: [{ name: 'p1' }, { name: 'p2' }] },
                },
                get_uri: (folder, pkg) =>
                    pkg === 'p1' ? { status: 200, data: '/x' } : { status: 404, data: null },
            });
            const r = await workspace.submit_to_ingest(FOLDER, 'staff', {
                astools,
                repo_model: gated_repo(),
            });
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(/p2 is missing uri.txt/);
            // No rows should have been queued.
            const rows = await db_queue()(tables.ingest_queue);
            expect(rows).toHaveLength(0);
        });
    });

    describe('submit_to_ingest pre-flight gate', () => {
        /*
         * Direct coverage of _ensure_collection_exists (via the
         * public submit_to_ingest entry point). The "fast path" case
         * — collection already exists — is implicit in the previous
         * describe block; here we exercise the parse failure, the
         * AS-fetch failure, and the auto-create success paths.
         */

        function make_ok_astools() {
            /*
             * ASTools doesn't matter for these — the gate fails (or
             * creates) before we touch the package listing. Stub
             * minimally so submit_to_ingest doesn't NPE if the gate
             * happens to fall through.
             */
            return make_astools({
                list_packages: { status: 200, data: { packages: [{ name: 'p1' }] } },
                get_uri: { status: 200, data: '/repositories/2/resources/1' },
            });
        }

        it('halts with a clear error when the folder name does not parse', async () => {
            const r = await workspace.submit_to_ingest('plain-folder-name', 'staff', {
                astools: make_ok_astools(),
            });
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(/Could not parse resource ID/);
            const rows = await db_queue()(tables.ingest_queue);
            expect(rows).toHaveLength(0);
        });

        it('halts when AS returns 404 for the parsed resource URI', async () => {
            const aspace = {
                is_configured: () => true,
                get_session_token: async () => 'tok',
                get_record: async () => ({ status: 404, data: null }),
                destroy_session_token: async () => {},
            };
            const repo_model = {
                // Local collection does NOT exist — gate must consult AS.
                find_collection_by_uri: async () => undefined,
                create_collection: async () => {
                    throw new Error('should not be called on AS 404');
                },
            };
            const r = await workspace.submit_to_ingest('col-x-resources_9999', 'staff', {
                astools: make_ok_astools(),
                aspace,
                repo_model,
            });
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(/does not exist in ArchivesSpace/);
            const rows = await db_queue()(tables.ingest_queue);
            expect(rows).toHaveLength(0);
        });

        it('halts when AS transport fails (network / login error)', async () => {
            const aspace = {
                is_configured: () => true,
                get_session_token: async () => {
                    throw new Error('aspace down');
                },
                get_record: async () => ({ status: 200, data: {} }),
                destroy_session_token: async () => {},
            };
            const repo_model = {
                find_collection_by_uri: async () => undefined,
                create_collection: async () => null,
            };
            const r = await workspace.submit_to_ingest('col-x-resources_42', 'staff', {
                astools: make_ok_astools(),
                aspace,
                repo_model,
            });
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(/ArchivesSpace login failed/);
        });

        it('auto-creates the local collection from the AS record on the first submit', async () => {
            const aspace = {
                is_configured: () => true,
                get_session_token: async () => 'tok',
                get_record: async () => ({
                    status: 200,
                    data: { title: 'Glenn Miller Collection', abstract: 'A collection.' },
                }),
                destroy_session_token: async () => {},
            };
            let create_called_with = null;
            const repo_model = {
                find_collection_by_uri: async () => undefined,
                create_collection: async (payload) => {
                    create_called_with = payload;
                    return { pid: 'newly-minted-pid', uri: payload.uri };
                },
            };
            const astools = make_astools({
                list_packages: { status: 200, data: { packages: [{ name: 'p1' }] } },
                get_uri: { status: 200, data: '/repositories/2/resources/1' },
            });
            const r = await workspace.submit_to_ingest('col-x-resources_1', 'staff', {
                astools,
                aspace,
                repo_model,
            });
            expect(r.ok).toBe(true);
            expect(create_called_with).toBeTruthy();
            expect(create_called_with.uri).toBe('/repositories/2/resources/1');
            expect(create_called_with.mods.title).toBe('Glenn Miller Collection');
            /*
             * The queue row's collection_uuid is the just-created
             * collection's pid — NOT the folder name. Direct
             * regression guard for the bug the user reported in
             * task #119.
             */
            const rows = await db_queue()(tables.ingest_queue).orderBy('id', 'asc');
            expect(rows).toHaveLength(1);
            expect(rows[0].collection_uuid).toBe('newly-minted-pid');
            expect(rows[0].batch).toBe('col-x-resources_1');
        });

        it('also accepts the archival_objects_<N> suffix', async () => {
            const repo_model = {
                find_collection_by_uri: async (uri) => {
                    expect(uri).toBe('/repositories/2/archival_objects/777');
                    return { pid: 'ao-pid', uri };
                },
                create_collection: async () => null,
            };
            const r = await workspace.submit_to_ingest('item-archival_objects_777', 'staff', {
                astools: make_ok_astools(),
                repo_model,
            });
            expect(r.ok).toBe(true);
        });

        describe('handle minting on auto-create', () => {
            /*
             * The pre-flight gate generates a PID up front, mints a
             * handle against THAT pid, then passes both to
             * create_collection so the inserted row's handle and pid
             * are linked. Handle minting is best-effort — a failed
             * mint must NOT block collection creation. These tests
             * exercise both the happy path and the three failure
             * modes (not configured, non-201 status, transport throw).
             */

            function make_aspace_ok() {
                return {
                    is_configured: () => true,
                    get_session_token: async () => 'tok',
                    get_record: async () => ({
                        status: 200,
                        data: { title: 'Handle Test Collection' },
                    }),
                    destroy_session_token: async () => {},
                };
            }

            it('mints a handle against the new collection PID and stores it on the row', async () => {
                let mint_called_with_pid = null;
                const handles = {
                    is_configured: () => true,
                    create_handle: async (pid) => {
                        mint_called_with_pid = pid;
                        return {
                            status: 201,
                            handle: `https://hdl.invalid/20.500.12345/${pid}`,
                        };
                    },
                };
                let create_called_with = null;
                const repo_model = {
                    find_collection_by_uri: async () => undefined,
                    create_collection: async (payload) => {
                        create_called_with = payload;
                        return { pid: payload.pid, uri: payload.uri, handle: payload.handle };
                    },
                };
                const r = await workspace.submit_to_ingest('xyz-resources_42', 'staff', {
                    astools: make_ok_astools(),
                    aspace: make_aspace_ok(),
                    repo_model,
                    handles,
                });
                expect(r.ok).toBe(true);
                /*
                 * The PID passed to create_handle is the SAME PID
                 * ultimately stored on the row.
                 */
                expect(mint_called_with_pid).toBeTruthy();
                expect(create_called_with.pid).toBe(mint_called_with_pid);
                // The handle URL is what got minted.
                expect(create_called_with.handle).toBe(
                    `https://hdl.invalid/20.500.12345/${mint_called_with_pid}`
                );
            });

            it('falls through to empty handle when the handle service is not configured', async () => {
                const handles = {
                    is_configured: () => false,
                    create_handle: async () => {
                        throw new Error('should not be called when not configured');
                    },
                };
                let stored_handle = null;
                const repo_model = {
                    find_collection_by_uri: async () => undefined,
                    create_collection: async (payload) => {
                        stored_handle = payload.handle;
                        return { pid: payload.pid, uri: payload.uri, handle: payload.handle };
                    },
                };
                const r = await workspace.submit_to_ingest('xyz-resources_43', 'staff', {
                    astools: make_ok_astools(),
                    aspace: make_aspace_ok(),
                    repo_model,
                    handles,
                });
                expect(r.ok).toBe(true);
                expect(stored_handle).toBe('');
            });

            it('falls through to empty handle when the handle service returns a non-201', async () => {
                const handles = {
                    is_configured: () => true,
                    create_handle: async () => ({ status: 503, handle: null }),
                };
                let stored_handle = null;
                const repo_model = {
                    find_collection_by_uri: async () => undefined,
                    create_collection: async (payload) => {
                        stored_handle = payload.handle;
                        return { pid: payload.pid, uri: payload.uri };
                    },
                };
                const r = await workspace.submit_to_ingest('xyz-resources_44', 'staff', {
                    astools: make_ok_astools(),
                    aspace: make_aspace_ok(),
                    repo_model,
                    handles,
                });
                expect(r.ok).toBe(true);
                expect(stored_handle).toBe('');
            });

            it('falls through to empty handle when the handle service throws', async () => {
                const handles = {
                    is_configured: () => true,
                    create_handle: async () => {
                        /*
                         * libs/handles.create_handle throws UpstreamError
                         * on transport failure.
                         */
                        throw new Error('handle service unreachable');
                    },
                };
                let stored_handle = null;
                const repo_model = {
                    find_collection_by_uri: async () => undefined,
                    create_collection: async (payload) => {
                        stored_handle = payload.handle;
                        return { pid: payload.pid, uri: payload.uri };
                    },
                };
                const r = await workspace.submit_to_ingest('xyz-resources_45', 'staff', {
                    astools: make_ok_astools(),
                    aspace: make_aspace_ok(),
                    repo_model,
                    handles,
                });
                /*
                 * Collection still created — minting failure does NOT
                 * halt the gate.
                 */
                expect(r.ok).toBe(true);
                expect(stored_handle).toBe('');
            });

            it('skips minting entirely on the fast path (collection already exists)', async () => {
                /*
                 * The collection mirror is already there — no AS
                 * fetch, no handle mint. Confirms minting is gated
                 * on the auto-create branch only.
                 */
                let mint_called = false;
                const handles = {
                    is_configured: () => true,
                    create_handle: async () => {
                        mint_called = true;
                        return { status: 201, handle: 'x' };
                    },
                };
                const repo_model = {
                    find_collection_by_uri: async () => ({
                        pid: 'already-here',
                        uri: '/repositories/2/resources/46',
                    }),
                    create_collection: async () => {
                        throw new Error('should not be called on fast path');
                    },
                };
                const r = await workspace.submit_to_ingest('xyz-resources_46', 'staff', {
                    astools: make_ok_astools(),
                    repo_model,
                    handles,
                });
                expect(r.ok).toBe(true);
                expect(mint_called).toBe(false);
            });
        });
    });
});
