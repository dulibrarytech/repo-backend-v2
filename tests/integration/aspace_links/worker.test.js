'use strict';

const { create_worker } = require('../../../aspace_links/worker');
const model = require('../../../aspace_links/model');
const app_config = require('../../../config/app');
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
} = require('../../helpers/aspace_links');

const SECOND = '/repositories/2/archival_objects/2';

const row_for = (uri) => db_queue()(tables.aspace_links).where({ uri }).first();
const worker_for = (aspace) => create_worker({ aspace, request: (call) => call('tok') });

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
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
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
            await db_helper.seed_object({ pid: PID, uri: `${AO}\n`, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);

            expect(await worker_for(aspace).tick()).toBe('worked');
            expect(aspace.calls.posts.map((post) => post.uri)).toEqual([DO, AO]);
            expect(aspace.store.get(AO).external_documents).toEqual([link_doc(handle(PID))]);
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'updated' });
        });

        it('leaves an up-to-date record alone', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
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
            await db_helper.seed_object({
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

        it('keeps a record that still links to a deleted object', async () => {
            await db_helper.seed_object({
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
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'orphan_link' });
            expect(JSON.parse(row.pids)).toEqual([GONE]);
        });

        it('reports a record two live objects share, without reading or writing', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
            await db_helper.seed_object({ pid: TWIN, uri: AO, handle: handle(TWIN) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()]);

            await worker_for(aspace).tick();
            expect(aspace.calls.sets).toEqual([]);
            expect(aspace.calls.posts).toEqual([]);
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'contested' });
            expect(JSON.parse(row.pids).sort()).toEqual([PID, TWIN].sort());
        });

        it('puts the batch off and records why when ArchivesSpace cannot be read', async () => {
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([], { fail_reads: true });

            expect(await worker_for(aspace).tick()).toBe('failed');
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'PENDING', state: null });
            expect(row.error).toMatch(/could not list .*archival_objects \(HTTP 503/);
            expect(row.next_attempt_at).not.toBeNull();
            expect(await model.claim(10)).toHaveLength(0);
        });

        it('marks a refused update failed at once, so it shows without waiting', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
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
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
            await model.enqueue([AO]);
            const aspace = make_aspace([archival_object(), digital_object()], {
                update_statuses: [403],
            });

            expect(await worker_for(aspace).tick()).toBe('worked');
            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'failed' });
            expect(row.error).toMatch(/HTTP 403: refused 403 \(the ArchivesSpace account may not/);
            expect(aspace.store.get(AO).external_documents).toEqual([link_doc(handle(PID))]);
        });

        it('does not let one record that keeps failing hold up the record behind it', async () => {
            set_env({ ASPACE_WRITES_ENABLED: '1' });
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
            await db_helper.seed_object({ pid: TWIN, uri: SECOND, handle: handle(TWIN) });
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
                await db_helper.seed_object({
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

            expect(await worker_for(aspace).tick()).toBe('failed');
            expect(aspace.calls.posts).toHaveLength(5);
            for (const n of [1, 2, 3, 4, 5]) {
                expect(await row_for(uri_of(n))).toMatchObject({ status: 'DONE', state: 'failed' });
            }
            for (const n of [6, 7]) {
                const row = await row_for(uri_of(n));
                expect(row).toMatchObject({ status: 'PENDING', state: null });
                expect(row.error).toMatch(/^5 updates in a row failed\. Last: .*HTTP 400/);
                expect(row.next_attempt_at).not.toBeNull();
            }
            expect((await model.summary()).waiting_error).toMatch(/^5 updates in a row failed/);
        });

        it('checks no more records per tick than the batch size', async () => {
            set_env({ ASPACE_LINKS_BATCH_SIZE: '1' });
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
            await db_helper.seed_object({ pid: TWIN, uri: SECOND, handle: handle(TWIN) });
            await model.enqueue([AO, SECOND]);
            const aspace = make_aspace([]);

            await worker_for(aspace).tick();
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'record_not_found' });
            expect(await row_for(SECOND)).toMatchObject({ status: 'PENDING' });
        });
    });

    describe('start and stop', () => {
        it('does not start unless ASPACE_LINKS_WORKER_ENABLED is on', async () => {
            const worker = worker_for(make_aspace([]));
            await worker.start();
            expect(worker._is_running()).toBe(false);
            await worker.stop();
        });

        it('starts when enabled, works the queue, and stops', async () => {
            set_env({ ASPACE_LINKS_WORKER_ENABLED: '1' });
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
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
