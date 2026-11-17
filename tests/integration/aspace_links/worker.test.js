'use strict';

const { create_worker } = require('../../../aspace_links/worker');
const model = require('../../../aspace_links/model');
const app_config = require('../../../config/app');
const log = require('../../../libs/log');
const repo_model = require('../../../repository/model');
const aspace_session = require('../../../libs/aspace_session');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const {
    PID,
    TWIN,
    GONE,
    AO,
    DO,
    handle,
    old_handle,
    link_doc,
    archival_object,
    digital_object,
    make_aspace,
    request,
    UNREACHABLE,
} = require('../../helpers/aspace_links');

const SECOND = '/repositories/2/archival_objects/2';

const seed = db_helper.seed_object;

const row_for = (uri) => db_queue()(tables.aspace_links).where({ uri }).first();
const changes_for = (record_uri) =>
    db_queue()(tables.aspace_link_changes).where({ record_uri }).orderBy('id', 'asc');
const worker_for = (aspace) => create_worker({ aspace, request });

function set_env(values) {
    Object.assign(process.env, values);
    app_config._reset();
}

describe('aspace_links/worker', () => {
    let saved_env;
    beforeAll(async () => {
        saved_env = { ...process.env };
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        process.env = { ...saved_env, HANDLE_PREFIX: '10176' };
        delete process.env.ASPACE_WRITES_ENABLED;
        delete process.env.ASPACE_LINKS_WORKER_ENABLED;
        app_config._reset();
        await db_helper.reset_data();
    });
    afterAll(async () => {
        process.env = saved_env;
        app_config._reset();
        await db_helper.teardown();
    });

    describe('tick', () => {
        it('does nothing when no record is waiting', async () => {
            const aspace = make_aspace([]);
            expect(await worker_for(aspace).tick()).toBe('idle');
            expect(aspace.calls.sets).toEqual([]);
        });

        it('stays idle when ArchivesSpace or the handle prefix is not configured', async () => {
            await model.enqueue([AO]);
            const unconfigured = make_aspace([], { configured: false });
            expect(await worker_for(unconfigured).tick()).toBe('idle');

            delete process.env.HANDLE_PREFIX;
            app_config._reset();
            const aspace = make_aspace([]);
            expect(await worker_for(aspace).tick()).toBe('idle');
            expect(aspace.calls.sets).toEqual([]);
            expect(await row_for(AO)).toMatchObject({ status: 'PENDING' });
        });

        it('reports what a record needs and writes nothing while writes are off', async () => {
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);

            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(aspace.calls.posts).toEqual([]);
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'pending' });
            expect(JSON.parse(row.pids)).toEqual([PID]);
            expect(JSON.parse(row.detail)).toMatchObject({ link: 'add', digital_object: 'update' });
        });

        it('writes the identifier and then the link when writes are on', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: `${AO}\n`, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);

            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
            expect(aspace.store.get(AO).external_documents).toEqual([link_doc(handle(PID))]);
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'updated' });
        });

        it('keeps every write, with the value it replaced, in the change history', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);

            await worker_for(aspace).tick();
            await model.requeue_state('updated');
            await worker_for(aspace).tick();

            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'in_sync' });
            const changes = await changes_for(AO);
            expect(
                changes.map((change) => ({
                    uri: change.uri,
                    field: change.field,
                    action: change.action,
                    previous: change.previous,
                    value: change.value,
                    pids: JSON.parse(change.pids),
                }))
            ).toEqual([
                {
                    uri: DO,
                    field: 'digital_object_id',
                    action: 'update',
                    previous: 'B133.01.0003.00001',
                    value: handle(PID),
                    pids: [PID],
                },
                {
                    uri: AO,
                    field: 'link',
                    action: 'add',
                    previous: null,
                    value: handle(PID),
                    pids: [PID],
                },
            ]);
            expect(changes[0].created_at).toBeTruthy();
        });

        it('keeps what it already wrote when ArchivesSpace goes away before a later listing', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            const resource_of = (n) => `/repositories/2/resources/${900 + n}`;
            const pid_of = (n) => `00000000-0000-4000-8000-00000000090${n}`;
            const numbers = [1, 2];
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            for (const n of numbers) {
                await seed({
                    pid: pid_of(n),
                    uri: resource_of(n),
                    handle: handle(pid_of(n)),
                    object_type: 'collection',
                });
            }
            await model.enqueue([AO, ...numbers.map(resource_of)]);
            const aspace = make_aspace([archival_object(), digital_object()]);
            const list = aspace.get_native_set;
            aspace.get_native_set = async (listing, ids) => {
                if (listing.endsWith('/resources')) aspace.go_down();
                return list(listing, ids);
            };

            expect(await worker_for(aspace).tick()).toBe('failed');
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'updated' });
            expect((await changes_for(AO)).map((change) => change.uri)).toEqual([DO, AO]);
            for (const n of numbers) {
                const row = await row_for(resource_of(n));
                expect(row).toMatchObject({ status: 'PENDING', state: null, error: UNREACHABLE });
                expect(row.next_attempt_at).not.toBeNull();
            }
        });

        it('checks again, once writes are on, the records it could only report before', async () => {
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);
            await worker_for(aspace).tick();
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'pending' });

            set_env({ ASPACE_WRITES_ENABLED: '1' });
            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'updated' });
        });

        it('waits while the queue tables are missing, and says so once', async () => {
            await model.enqueue([AO]);
            const aspace = make_aspace([]);
            const missing = { ...model, is_ready: async () => false };
            const worker = create_worker({
                aspace,
                model: missing,
                request,
            });
            const error = vi.spyOn(log, 'error').mockImplementation(() => {});
            try {
                expect(await worker.tick()).toBe('idle');
                expect(await worker.tick()).toBe('idle');
                expect(error).toHaveBeenCalledTimes(1);
                expect(error.mock.calls[0][0]).toMatchObject({
                    event: 'aspace_links_table_missing',
                });
            } finally {
                error.mockRestore();
            }
            expect(aspace.calls.sets).toEqual([]);
            expect(await row_for(AO)).toMatchObject({ status: 'PENDING' });
        });

        it('leaves an up-to-date record alone', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([
                archival_object({ external_documents: [link_doc(old_handle(PID))] }),
                digital_object({ digital_object_id: old_handle(PID) }),
            ]);

            await worker_for(aspace).tick();
            expect(aspace.calls.posts).toEqual([]);
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'in_sync' });
        });

        it('drops a queued record that no repository object points at', async () => {
            await model.enqueue([SECOND]);
            const aspace = make_aspace([]);

            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(await row_for(SECOND)).toBeUndefined();
            expect(aspace.calls.sets).toEqual([]);
        });

        it('drops a record only a deleted object pointed at, when no link is left', async () => {
            await seed({
                pid: GONE,
                uri: AO,
                handle: handle(GONE),
                is_active: 0,
            });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object({ instances: [] })]);

            await worker_for(aspace).tick();
            expect(await row_for(AO)).toBeUndefined();
        });

        it('only reports a published link to a deleted object, even with writes on', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({
                pid: GONE,
                uri: AO,
                handle: handle(GONE),
                is_active: 0,
            });
            await model.enqueue([AO]);
            const aspace = make_aspace([
                archival_object({
                    instances: [],
                    external_documents: [link_doc(old_handle(GONE))],
                }),
            ]);

            await worker_for(aspace).tick();
            expect(aspace.calls.posts).toEqual([]);
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'orphan_link' });
            expect(JSON.parse(row.pids)).toEqual([GONE]);
            expect(await changes_for(AO)).toEqual([]);
        });

        it('reports a record two live objects share, without reading or writing', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await seed({ pid: TWIN, uri: AO, handle: handle(TWIN) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);

            await worker_for(aspace).tick();
            expect(aspace.calls.sets).toEqual([]);
            expect(aspace.calls.posts).toEqual([]);
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'contested' });
            expect(JSON.parse(row.pids).sort()).toEqual([PID, TWIN].sort());
        });

        it('puts the batch off and records why when ArchivesSpace cannot be reached', async () => {
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([], { down: true });

            expect(await worker_for(aspace).tick()).toBe('failed');
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'PENDING', state: null, error: UNREACHABLE });
            expect(row.next_attempt_at).not.toBeNull();
            expect(await model.claim(10)).toHaveLength(0);
        });

        it('reports a record ArchivesSpace cannot return, instead of trying it again and again', async () => {
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([], { fail_reads: true });

            expect(await worker_for(aspace).tick()).toBe('worked');
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'needs_review' });
            expect(row.error).toBe(
                'ArchivesSpace /repositories/2/archival_objects returned HTTP 503: unavailable'
            );
            expect(await model.claim(10)).toHaveLength(0);
        });

        it('hands back, on its next tick, rows it could not put off', async () => {
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            let refusals = 1;
            const flaky = {
                ...model,
                defer: async (rows, reason) => {
                    if (refusals > 0) {
                        refusals -= 1;
                        throw new Error('Connection lost: The server closed the connection.');
                    }
                    return model.defer(rows, reason);
                },
            };
            let reachable = false;
            const worker = create_worker({
                aspace: make_aspace([archival_object(), digital_object()]),
                model: flaky,
                request: (call, label) => {
                    if (!reachable) throw new Error(UNREACHABLE);
                    return request(call, label);
                },
            });
            const error = vi.spyOn(log, 'error').mockImplementation(() => {});
            try {
                expect(await worker.tick()).toBe('failed');
                expect(await row_for(AO)).toMatchObject({ status: 'IN_PROGRESS' });
                expect(error).toHaveBeenCalledWith(
                    expect.objectContaining({ event: 'aspace_links_defer_failed', rows: 1 })
                );
            } finally {
                error.mockRestore();
            }

            reachable = true;
            expect(await worker.tick()).toBe('worked');
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'pending' });
        });

        it('marks a refused update failed at once, so it shows without waiting', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [400],
            });

            expect(await worker_for(aspace).tick()).toBe('worked');
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'failed', next_attempt_at: null });
            expect(row.error).toBe(`${DO}: HTTP 400: refused 400`);
            expect(await model.claim(10)).toHaveLength(0);
        });

        it('records a refusal for lack of permission against that record only', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [403],
            });

            expect(await worker_for(aspace).tick()).toBe('worked');
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'failed' });
            expect(row.error).toMatch(/HTTP 403: refused 403 \(the ArchivesSpace account may not/);
            expect(aspace.store.get(AO).external_documents).toEqual([]);
        });

        it('does not let one record that keeps failing hold up the record behind it', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await seed({ pid: TWIN, uri: SECOND, handle: handle(TWIN) });
            await model.enqueue([AO, SECOND]);
            const aspace = make_aspace([
                archival_object(),
                digital_object(),
                archival_object({ uri: SECOND, instances: [] }),
            ]);
            const update = aspace.update_record;
            aspace.update_record = async (uri, record) => {
                if (uri === DO || uri === AO) {
                    throw new Error('ArchivesSpace update failed: timeout of 15000ms exceeded');
                }
                return update(uri, record);
            };

            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'failed' });
            expect(await row_for(SECOND)).toMatchObject({ status: 'DONE', state: 'updated' });
            expect(aspace.store.get(SECOND).external_documents).toEqual([link_doc(handle(TWIN))]);
        });

        it('stops after five failures in a row, keeps what it learned, and puts the rest off', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            const pid_of = (n) => `00000000-0000-4000-8000-00000000000${n}`;
            const uri_of = (n) => `/repositories/2/archival_objects/${100 + n}`;
            const numbers = [1, 2, 3, 4, 5, 6, 7];
            for (const n of numbers) {
                await seed({
                    pid: pid_of(n),
                    uri: uri_of(n),
                    handle: handle(pid_of(n)),
                });
            }
            await model.enqueue(numbers.map(uri_of));
            const aspace = make_aspace(
                numbers.map((n) => archival_object({ uri: uri_of(n), instances: [] })),
                { update_statuses: Array(7).fill(503) }
            );

            expect(await worker_for(aspace).tick()).toBe('halted');
            expect(aspace.calls.posts).toHaveLength(5);
            for (const n of [1, 2, 3, 4, 5]) {
                expect(await row_for(uri_of(n))).toMatchObject({ status: 'DONE', state: 'failed' });
            }
            for (const n of [6, 7]) {
                const row = await row_for(uri_of(n));
                expect(row).toMatchObject({ status: 'PENDING', state: null });
                expect(row.error).toMatch(/^5 updates in a row failed\. Last: .*HTTP 503/);
                expect(row.next_attempt_at).not.toBeNull();
            }
            expect((await model.summary()).waiting_error).toMatch(/^5 updates in a row failed/);
        });

        it('does not stop for updates ArchivesSpace refuses for a reason of the record', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            const pid_of = (n) => `00000000-0000-4000-8000-00000000000${n}`;
            const uri_of = (n) => `/repositories/2/archival_objects/${100 + n}`;
            const numbers = [1, 2, 3, 4, 5, 6, 7];
            for (const n of numbers) {
                await seed({
                    pid: pid_of(n),
                    uri: uri_of(n),
                    handle: handle(pid_of(n)),
                });
            }
            await model.enqueue(numbers.map(uri_of));
            const aspace = make_aspace(
                numbers.map((n) => archival_object({ uri: uri_of(n), instances: [] })),
                { update_statuses: Array(7).fill(400) }
            );

            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(aspace.calls.posts).toHaveLength(7);
            for (const n of numbers) {
                expect(await row_for(uri_of(n))).toMatchObject({ status: 'DONE', state: 'failed' });
            }
        });

        it('counts failures across ticks, so failures spread over batches still stop it', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1', ASPACE_LINKS_BATCH_SIZE: '4' });
            const pid_of = (n) => `00000000-0000-4000-8000-00000000000${n}`;
            const uri_of = (n) => `/repositories/2/archival_objects/${100 + n}`;
            const numbers = [1, 2, 3, 4, 5, 6];
            for (const n of numbers) {
                await seed({
                    pid: pid_of(n),
                    uri: uri_of(n),
                    handle: handle(pid_of(n)),
                });
            }
            await model.enqueue(numbers.map(uri_of));
            const aspace = make_aspace(
                numbers.map((n) => archival_object({ uri: uri_of(n), instances: [] })),
                { update_statuses: Array(6).fill(503) }
            );
            const worker = worker_for(aspace);

            expect(await worker.tick()).toBe('worked');
            expect(await worker.tick()).toBe('halted');
            expect(aspace.calls.posts).toHaveLength(5);
            const left = await row_for(uri_of(6));
            expect(left).toMatchObject({ status: 'PENDING', state: null });
            expect(left.error).toMatch(/^5 updates in a row failed/);
        });

        it('needs only one more failure to stop again after it has stopped', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            const pid_of = (n) => `00000000-0000-4000-8000-00000000000${n}`;
            const uri_of = (n) => `/repositories/2/archival_objects/${100 + n}`;
            const first = [1, 2, 3, 4, 5];
            for (const n of [...first, 6, 7]) {
                await seed({
                    pid: pid_of(n),
                    uri: uri_of(n),
                    handle: handle(pid_of(n)),
                });
            }
            await model.enqueue(first.map(uri_of));
            const aspace = make_aspace(
                [1, 2, 3, 4, 5, 6, 7].map((n) =>
                    archival_object({ uri: uri_of(n), instances: [] })
                ),
                { update_statuses: Array(7).fill(503) }
            );
            const worker = worker_for(aspace);
            expect(await worker.tick()).toBe('halted');

            await model.enqueue([uri_of(6), uri_of(7)]);
            expect(await worker.tick()).toBe('halted');
            expect(aspace.calls.posts).toHaveLength(6);
            expect(await row_for(uri_of(6))).toMatchObject({ status: 'DONE', state: 'failed' });
            expect(await row_for(uri_of(7))).toMatchObject({ status: 'PENDING' });
        });

        it('checks no more records per tick than the batch size', async () => {
            set_env({ ASPACE_LINKS_BATCH_SIZE: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await seed({ pid: TWIN, uri: SECOND, handle: handle(TWIN) });
            await model.enqueue([AO, SECOND]);
            const aspace = make_aspace([]);

            await worker_for(aspace).tick();
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'record_not_found' });
            expect(await row_for(SECOND)).toMatchObject({ status: 'PENDING' });
        });
    });

    describe('reading and pacing', () => {
        it('loads only the object rows of the records it checks', async () => {
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const every_row = vi.spyOn(model, 'load_object_rows');
            try {
                await worker_for(make_aspace([archival_object(), digital_object()])).tick();
                expect(every_row).not.toHaveBeenCalled();
                expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'pending' });
            } finally {
                every_row.mockRestore();
            }
        });

        it('reads every row before dropping a record whose object rows it cannot find', async () => {
            await model.enqueue([SECOND]);
            const every_row = vi.spyOn(model, 'load_object_rows');
            try {
                await worker_for(make_aspace([])).tick();
                expect(every_row).toHaveBeenCalledTimes(1);
                expect(await row_for(SECOND)).toBeUndefined();
            } finally {
                every_row.mockRestore();
            }
        });

        it('paces its requests by ASPACE_LINKS_MIN_INTERVAL_MS, not the ingest setting', async () => {
            set_env({
                ARCHIVESPACE_HOST: 'https://aspace.example',
                ARCHIVESPACE_USER: 'links',
                ARCHIVESPACE_PASSWORD: 'secret',
                ASPACE_FETCH_MIN_INTERVAL_MS: '0',
                ASPACE_LINKS_MIN_INTERVAL_MS: '2500',
            });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const request = vi
                .spyOn(aspace_session, 'request_with_retry')
                .mockResolvedValue({ status: 200, data: [] });
            try {
                await create_worker().tick();
                expect(request).toHaveBeenCalled();
                expect(request.mock.calls[0][1]).toMatchObject({ min_interval_ms: 2500 });
                expect(await row_for(AO)).toMatchObject({ state: 'record_not_found' });
            } finally {
                request.mockRestore();
            }
        });
    });

    describe('linking once, leases and logins', () => {
        it('links the record of a new object before it is published, then never touches it again', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await db_helper.seed_object({
                pid: PID,
                uri: AO,
                handle: handle(PID),
                is_published: 0,
            });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);

            await worker_for(aspace).tick();
            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
            expect(aspace.store.get(AO).external_documents).toEqual([link_doc(handle(PID))]);
            expect(aspace.store.get(DO).digital_object_id).toBe(handle(PID));
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'updated' });

            await repo_model.publish(PID);
            await repo_model.suppress(PID);
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'updated' });

            aspace.store.set(AO, archival_object({ lock_version: 30 }));
            expect(await model.enqueue_all()).toBe(0);
            expect(await worker_for(aspace).tick()).toBe('idle');
            expect(aspace.calls.posts).toHaveLength(2);
            expect(
                (await changes_for(AO)).map((change) => `${change.field} ${change.action}`)
            ).toEqual(['digital_object_id update', 'link add']);
        });

        it('reports a link staff removed when asked to check again, and never adds it back', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);
            await worker_for(aspace).tick();
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'updated' });

            aspace.store.set(AO, archival_object({ lock_version: 30 }));
            for (const state of ['updated', 'link_removed']) {
                expect(await model.requeue_state(state)).toBe(1);
                expect(await worker_for(aspace).tick()).toBe('worked');
                expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'link_removed' });
                expect(await model.enqueue_all()).toBe(0);
            }
            expect(aspace.calls.posts).toHaveLength(2);
            expect(aspace.store.get(AO).external_documents).toEqual([]);

            aspace.store.set(
                AO,
                archival_object({ lock_version: 31, external_documents: [link_doc(handle(PID))] })
            );
            await model.requeue_state('link_removed');
            await worker_for(aspace).tick();
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'in_sync' });
            expect(aspace.calls.posts).toHaveLength(2);
            expect(
                (await changes_for(AO)).map((change) => `${change.field} ${change.action}`)
            ).toEqual(['digital_object_id update', 'link add']);
        });

        it('does not link a record again after a second object came and went', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);
            await worker_for(aspace).tick();
            aspace.store.set(AO, archival_object({ lock_version: 30 }));

            await seed({ pid: TWIN, uri: AO, handle: handle(TWIN) });
            await model.enqueue([AO]);
            await worker_for(aspace).tick();
            const shared = await row_for(AO);
            expect(shared).toMatchObject({ status: 'DONE', state: 'contested' });
            expect(JSON.parse(shared.detail)).toEqual({ linked: handle(PID) });

            await repo_model.soft_delete(TWIN, { delete_reason: 'duplicate', actor: 'tester' });
            expect(await row_for(AO)).toMatchObject({ status: 'PENDING' });
            await worker_for(aspace).tick();
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'link_removed' });
            expect(aspace.calls.posts).toHaveLength(2);
            expect(aspace.store.get(AO).external_documents).toEqual([]);
        });

        it('clears a report once staff have fixed the record and ask for another check', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await seed({ pid: GONE, uri: SECOND, handle: handle(GONE), is_active: 0 });
            const left_behind = { uri: SECOND, lock_version: 3, instances: [] };
            const aspace = make_aspace([
                archival_object({
                    external_documents: [link_doc(handle(PID), { publish: false })],
                }),
                { ...left_behind, external_documents: [link_doc(handle(GONE))] },
            ]);
            await model.enqueue([AO, SECOND]);
            await worker_for(aspace).tick();
            expect(await row_for(AO)).toMatchObject({ state: 'unpublished_link' });
            expect(await row_for(SECOND)).toMatchObject({ state: 'orphan_link' });

            aspace.store.set(AO, archival_object({ external_documents: [link_doc(handle(PID))] }));
            aspace.store.set(SECOND, { ...left_behind, external_documents: [] });
            expect(await model.enqueue_all()).toBe(0);
            await model.requeue_state('unpublished_link');
            await model.requeue_state('orphan_link');
            await worker_for(aspace).tick();

            expect(aspace.calls.posts).toEqual([]);
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'in_sync' });
            expect(await row_for(SECOND)).toBeUndefined();
        });

        it('writes nothing for an object deleted while its batch was being checked', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);
            const list = aspace.get_native_set;
            let deleted = false;
            aspace.get_native_set = async (listing, ids) => {
                if (!deleted) {
                    deleted = true;
                    await repo_model.soft_delete(PID, { delete_reason: 'test', actor: 'tester' });
                }
                return list(listing, ids);
            };

            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(aspace.calls.posts).toEqual([]);
            expect(await row_for(AO)).toMatchObject({ status: 'PENDING' });
            await worker_for(aspace).tick();
            expect(aspace.calls.posts).toEqual([]);
            expect(await row_for(AO)).toBeUndefined();
        });

        it('tries again at start, once writes are on, what failed or was held back', async () => {
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await seed({ pid: TWIN, uri: SECOND, handle: handle(TWIN) });
            await model.enqueue([AO, SECOND]);
            const aspace = make_aspace([
                archival_object(),
                { uri: SECOND, lock_version: 1, instances: [], external_documents: [] },
            ]);
            await worker_for(aspace).tick();
            const held = await row_for(AO);
            expect(held).toMatchObject({ status: 'DONE', state: 'needs_review' });
            expect(JSON.parse(held.detail)).toMatchObject({ digital_object: 'not_found' });
            await db_queue()(tables.aspace_links)
                .where({ uri: SECOND })
                .update({ state: 'failed', error: 'HTTP 503' });

            aspace.store.set(DO, digital_object());
            expect(await worker_for(aspace).tick()).toBe('idle');

            set_env({ ASPACE_WRITES_ENABLED: '1' });
            const worker = worker_for(aspace);
            expect(await worker.tick()).toBe('worked');
            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO, SECOND]);
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'updated' });
            expect(await row_for(SECOND)).toMatchObject({ status: 'DONE', state: 'updated' });

            await db_queue()(tables.aspace_links)
                .where({ uri: SECOND })
                .update({ state: 'failed', error: 'HTTP 503' });
            expect(await worker.tick()).toBe('idle');
            expect(await row_for(SECOND)).toMatchObject({ status: 'DONE', state: 'failed' });
        });

        it('checks a record again when it is queued while it is being checked', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);
            const list = aspace.get_native_set;
            let queued_again = false;
            aspace.get_native_set = async (listing, ids) => {
                if (!queued_again) {
                    queued_again = true;
                    await model.enqueue([AO]);
                }
                return list(listing, ids);
            };

            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(await row_for(AO)).toMatchObject({ status: 'PENDING' });
            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'in_sync' });
        });

        it('hands back records a stopped worker left in progress', async () => {
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            await model.claim(10);
            const aspace = make_aspace([archival_object(), digital_object()]);

            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'pending' });
        });

        it('pauses, and puts the batch off, when ArchivesSpace refuses the login', async () => {
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const refused = Object.assign(new Error('ArchivesSpace login rejected: HTTP 403'), {
                status: 401,
            });
            const worker = create_worker({
                aspace: make_aspace([]),
                request: async () => {
                    throw refused;
                },
            });

            expect(await worker.tick()).toBe('halted');
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'PENDING' });
            expect(row.error).toMatch(/login rejected/);
        });
    });

    describe('start and stop', () => {
        it('does not start unless ASPACE_LINKS_WORKER_ENABLED is on', async () => {
            const worker = worker_for(make_aspace([]));
            await worker.start();
            expect(worker._is_running()).toBe(false);
            await worker.stop();
        });

        it('pauses for the retry time after it stops on failed updates', async () => {
            set_env({ ASPACE_LINKS_WORKER_ENABLED: '1', ASPACE_WRITES_ENABLED: '1' });
            const pid_of = (n) => `00000000-0000-4000-8000-00000000000${n}`;
            const uri_of = (n) => `/repositories/2/archival_objects/${100 + n}`;
            const numbers = [1, 2, 3, 4, 5];
            for (const n of numbers) {
                await seed({
                    pid: pid_of(n),
                    uri: uri_of(n),
                    handle: handle(pid_of(n)),
                });
            }
            await model.enqueue(numbers.map(uri_of));
            const aspace = make_aspace(
                numbers.map((n) => archival_object({ uri: uri_of(n), instances: [] })),
                { update_statuses: Array(5).fill(503) }
            );
            const timeout = vi.spyOn(global, 'setTimeout');
            const worker = worker_for(aspace);
            try {
                await worker.start();
                await vi.waitFor(() => {
                    expect(timeout.mock.calls.some(([, ms]) => ms === model.RETRY_MS)).toBe(true);
                });
            } finally {
                await worker.stop({ timeout_ms: 200 });
                timeout.mockRestore();
            }
        });

        it('starts when enabled, works the queue, and stops', async () => {
            set_env({ ASPACE_LINKS_WORKER_ENABLED: '1' });
            await seed({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const worker = worker_for(make_aspace([archival_object(), digital_object()]));

            await worker.start();
            expect(worker._is_running()).toBe(true);
            await vi.waitFor(async () => {
                expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'pending' });
            });
            await worker.stop({ timeout_ms: 200 });
            expect(worker._is_running()).toBe(false);
        });
    });
});
