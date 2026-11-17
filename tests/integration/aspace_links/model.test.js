'use strict';

const model = require('../../../aspace_links/model');
const db_helper = require('../../helpers/db');
const { db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const log = require('../../../libs/log');
const { provision_collection } = require('../../../repository/collection_provision');
const { PID, GONE, AO, RESOURCE, handle } = require('../../helpers/aspace_links');

const SECOND = '/repositories/2/archival_objects/2';
const THIRD = '/repositories/2/archival_objects/3';

const all_rows = () => db_queue()(tables.aspace_links).orderBy('id', 'asc');
const row_for = (uri) => db_queue()(tables.aspace_links).where({ uri }).first();

function result(overrides = {}) {
    return {
        uri: AO,
        pids: [PID],
        state: 'updated',
        handle: handle(PID),
        link: 'add',
        digital_object: 'update',
        digital_object_uri: '/repositories/2/digital_objects/48380',
        digital_object_previous: 'B133.01.0003.00001',
        ...overrides,
    };
}

describe('aspace_links/model', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        vi.useRealTimers();
    });
    afterAll(async () => {
        vi.useRealTimers();
        await db_helper.teardown();
    });

    describe('enqueue', () => {
        it('stores one waiting row per usable uri, trimmed and de-duplicated', async () => {
            const count = await model.enqueue([
                AO,
                `${AO}\n`,
                RESOURCE,
                '',
                null,
                '&#x2F;repositories&#x2F;2&#x2F;resources&#x2F;196',
            ]);
            expect(count).toBe(2);
            const rows = await all_rows();
            expect(rows.map((row) => row.uri)).toEqual([AO, RESOURCE]);
            expect(rows.every((row) => row.status === 'PENDING')).toBe(true);
        });

        it('puts a checked row back in the queue and keeps its last result', async () => {
            await model.enqueue([AO]);
            await model.record(await row_for(AO), result({ state: 'contested' }));
            await model.enqueue([AO]);

            const rows = await all_rows();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: 'PENDING', state: 'contested' });
        });

        it('handles more rows than one insert statement carries', async () => {
            const uris = Array.from(
                { length: 1203 },
                (_, i) => `/repositories/2/archival_objects/${i + 1}`
            );
            expect(await model.enqueue(uris)).toBe(1203);
            const counted = await db_queue()(tables.aspace_links).count({ n: '*' }).first();
            expect(Number(counted.n)).toBe(1203);
        });
    });

    describe('enqueue_all', () => {
        it('queues every record a repository row points at, live or deleted', async () => {
            await db_helper.seed_object({ uri: AO });
            await db_helper.seed_object({ uri: `${AO}\n`, is_active: 0 });
            await db_helper.seed_object({ uri: SECOND, is_active: 0 });
            await db_helper.seed_object({ uri: RESOURCE, object_type: 'collection' });
            await db_helper.seed_object({ uri: '' });

            expect(await model.enqueue_all()).toBe(3);
            const rows = await all_rows();
            expect(rows.map((row) => row.uri).sort()).toEqual([AO, SECOND, RESOURCE].sort());
        });
    });

    describe('load_object_rows', () => {
        it('returns the columns the check needs for every row', async () => {
            await db_helper.seed_object({ pid: PID, uri: AO, handle: handle(PID) });
            const rows = await model.load_object_rows();
            expect(rows).toHaveLength(1);
            expect(Object.keys(rows[0]).sort()).toEqual(
                [
                    'created',
                    'handle',
                    'is_active',
                    'is_published',
                    'object_type',
                    'pid',
                    'uri',
                ].sort()
            );
            expect(rows[0]).toMatchObject({ pid: PID, uri: AO, is_active: 1 });
        });
    });

    describe('load_object_rows_for', () => {
        it('returns the rows of the named records, newline-ended uris included', async () => {
            await db_helper.seed_object({ pid: PID, uri: `${AO}\n` });
            await db_helper.seed_object({ uri: `${AO}7` });
            await db_helper.seed_object({ uri: SECOND });

            const rows = await model.load_object_rows_for([AO]);
            expect(rows.map((row) => row.uri).sort()).toEqual([`${AO}\n`, `${AO}7`].sort());
            expect(await model.load_object_rows_for([])).toEqual([]);
        });

        it('matches the characters of the uri literally', async () => {
            await db_helper.seed_object({
                uri: AO.replace('archival_objects', 'archivalXobjects'),
            });
            await db_helper.seed_object({ uri: '/repositories/2/resources/1%' });
            await db_helper.seed_object({ uri: '/repositories/2/resources/1!' });

            expect(await model.load_object_rows_for([AO])).toEqual([]);
            const rows = await model.load_object_rows_for(['/repositories/2/resources/1%']);
            expect(rows.map((row) => row.uri)).toEqual(['/repositories/2/resources/1%']);
        });
    });

    describe('claim', () => {
        it('returns waiting rows oldest first, up to the limit', async () => {
            await model.enqueue([AO, SECOND, THIRD]);
            const claimed = await model.claim(2);
            expect(claimed.map((row) => row.uri)).toEqual([AO, SECOND]);
        });

        it('skips checked rows and rows whose retry time has not come', async () => {
            await model.enqueue([AO, SECOND, THIRD]);
            await model.record(await row_for(AO), result({ state: 'in_sync' }));
            await model.defer([await row_for(SECOND)], 'ArchivesSpace is down');

            const claimed = await model.claim(10);
            expect(claimed.map((row) => row.uri)).toEqual([THIRD]);
        });

        it('returns a deferred row once its retry time has passed', async () => {
            await model.enqueue([AO]);
            await model.defer([await row_for(AO)], 'ArchivesSpace is down');
            expect(await model.claim(10)).toHaveLength(0);

            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(Date.now() + model.RETRY_MS + 1000);
            const claimed = await model.claim(10);
            expect(claimed.map((row) => row.uri)).toEqual([AO]);
        });
    });

    describe('claim (lease)', () => {
        it('marks the rows it hands out as in progress, still counted as waiting', async () => {
            await model.enqueue([AO, SECOND]);
            const claimed = await model.claim(1);
            expect(claimed).toEqual([expect.objectContaining({ uri: AO, status: 'IN_PROGRESS' })]);
            expect(await row_for(AO)).toMatchObject({ status: 'IN_PROGRESS' });
            expect((await model.claim(10)).map((row) => row.uri)).toEqual([SECOND]);
            expect((await model.summary()).waiting).toBe(2);
        });

        it('keeps a record queued again while it was checked: no stale result, no removal', async () => {
            await model.enqueue([AO, SECOND]);
            const [first, second] = await model.claim(10);
            await model.enqueue([AO, SECOND]);
            await model.record(first, result({ state: 'in_sync' }));
            await model.remove([second]);

            expect(await row_for(AO)).toMatchObject({ status: 'PENDING', state: null });
            expect(await row_for(SECOND)).toMatchObject({ status: 'PENDING' });
            expect((await model.claim(10)).map((row) => row.uri)).toEqual([AO, SECOND]);
        });

        it('hands rows left in progress back to the queue', async () => {
            await model.enqueue([AO]);
            await model.claim(10);
            expect(await model.release()).toBe(1);
            expect(await row_for(AO)).toMatchObject({ status: 'PENDING' });
        });
    });

    describe('store', () => {
        it('stores a result for a checked record and for one with no queue row', async () => {
            await model.enqueue([AO]);
            await model.record(await row_for(AO), result({ state: 'pending' }));
            await model.store(result({ state: 'updated' }));
            await model.store(result({ uri: `${SECOND}\n`, state: 'in_sync' }));
            expect(await row_for(AO)).toMatchObject({ status: 'DONE', state: 'updated' });
            expect(await row_for(SECOND)).toMatchObject({ status: 'DONE', state: 'in_sync' });
        });

        it('leaves a record that is waiting to be checked again as it is', async () => {
            await model.enqueue([AO, SECOND]);
            await model.claim(1);
            await model.store(result({ state: 'updated' }));
            await model.store(result({ uri: SECOND, state: 'in_sync' }));
            expect(await row_for(AO)).toMatchObject({ status: 'IN_PROGRESS', state: null });
            expect(await row_for(SECOND)).toMatchObject({ status: 'PENDING', state: null });
        });
    });

    describe('enqueue_safely', () => {
        it('logs a failure instead of throwing', async () => {
            const error = vi.spyOn(log, 'error').mockImplementation(() => {});
            try {
                expect(await model.enqueue_safely(null, 'a test')).toBe(0);
                expect(error).toHaveBeenCalledWith(
                    expect.objectContaining({
                        event: 'aspace_link_queue_failed',
                        context: 'a test',
                    })
                );
            } finally {
                error.mockRestore();
            }
        });
    });

    describe('record', () => {
        it('stores the result and marks the row checked', async () => {
            await model.enqueue([AO]);
            await model.record(await row_for(AO), result());

            const row = await row_for(AO);
            expect(row).toMatchObject({
                status: 'DONE',
                state: 'updated',
                error: null,
                next_attempt_at: null,
            });
            expect(JSON.parse(row.pids)).toEqual([PID]);
            expect(JSON.parse(row.detail)).toEqual({
                handle: handle(PID),
                link: 'add',
                digital_object: 'update',
                digital_object_uri: '/repositories/2/digital_objects/48380',
                digital_object_previous: 'B133.01.0003.00001',
            });
            expect(row.checked_at).toBeTruthy();
        });

        it('marks a failed row checked at once, with a shortened reason', async () => {
            await model.enqueue([AO]);
            await model.record(
                await row_for(AO),
                result({ state: 'failed', error: 'x'.repeat(1500) })
            );

            const row = await row_for(AO);
            expect(row).toMatchObject({ status: 'DONE', state: 'failed', next_attempt_at: null });
            expect(row.error).toHaveLength(1000);
            expect(await model.claim(10)).toHaveLength(0);
            expect((await model.list({ states: ['failed'] })).total).toBe(1);
        });

        it('keeps the note that says why a record needs a review', async () => {
            await model.enqueue([AO]);
            const note = 'The record has more than one repository link.';
            await model.record(await row_for(AO), {
                uri: AO,
                pids: [PID],
                state: 'needs_review',
                note,
            });

            const found = await model.list({ states: ['needs_review'] });
            expect(found.rows[0].detail).toEqual({ note });
        });

        it('clears an earlier failure when a later check succeeds', async () => {
            await model.enqueue([AO]);
            await model.record(await row_for(AO), result({ state: 'failed', error: 'refused' }));
            await model.record(await row_for(AO), result({ state: 'in_sync' }));
            expect(await row_for(AO)).toMatchObject({
                status: 'DONE',
                state: 'in_sync',
                error: null,
            });
        });
    });

    describe('defer', () => {
        it('leaves the rows waiting, with the reason and a later time to try', async () => {
            await model.enqueue([AO, SECOND]);
            await model.defer(await all_rows(), 'ArchivesSpace could not list records');

            const rows = await all_rows();
            expect(rows.every((row) => row.status === 'PENDING')).toBe(true);
            expect(rows.every((row) => row.error === 'ArchivesSpace could not list records')).toBe(
                true
            );
            expect(rows.every((row) => row.next_attempt_at !== null)).toBe(true);
        });

        it('does nothing for an empty list', async () => {
            await expect(model.defer([], 'unused')).resolves.toBeUndefined();
        });

        it('leaves a row that was already checked as it is', async () => {
            await model.enqueue([AO, SECOND]);
            const claimed = await all_rows();
            await model.record(await row_for(AO), result({ state: 'in_sync' }));
            await model.defer(claimed, 'the database went away');

            expect(await row_for(AO)).toMatchObject({
                status: 'DONE',
                state: 'in_sync',
                error: null,
                next_attempt_at: null,
            });
            expect(await row_for(SECOND)).toMatchObject({
                status: 'PENDING',
                error: 'the database went away',
            });
        });
    });

    describe('requeue_state', () => {
        it('puts every checked row with that result back in the queue', async () => {
            await model.enqueue([AO, SECOND, THIRD]);
            await model.record(await row_for(AO), result({ state: 'pending' }));
            await model.record(await row_for(SECOND), result({ state: 'pending' }));
            await model.record(await row_for(THIRD), result({ state: 'in_sync' }));

            expect(await model.requeue_state('pending')).toBe(2);
            expect((await model.claim(10)).map((row) => row.uri)).toEqual([AO, SECOND]);
            expect(await row_for(THIRD)).toMatchObject({ status: 'DONE' });
        });
    });

    describe('remove', () => {
        it('deletes the named rows only', async () => {
            await model.enqueue([AO, SECOND]);
            const first = await row_for(AO);
            await model.remove([first]);
            await model.remove([]);
            expect((await all_rows()).map((row) => row.uri)).toEqual([SECOND]);
        });
    });

    describe('is_ready', () => {
        it('is true once both queue tables exist', async () => {
            expect(await model.is_ready()).toBe(true);
        });
    });

    describe('log_change', () => {
        const changes = () => db_queue()(tables.aspace_link_changes).orderBy('id', 'asc');

        it('keeps one row per write, with the value it replaced', async () => {
            await model.log_change({
                record_uri: AO,
                uri: '/repositories/2/digital_objects/48380',
                field: 'digital_object_id',
                action: 'update',
                previous: 'B133.01.0003.00001',
                value: handle(PID),
                pids: [PID],
            });
            await model.log_change({
                record_uri: AO,
                uri: AO,
                field: 'link',
                action: 'add',
                value: handle(PID),
                pids: [PID],
            });

            const rows = await changes();
            expect(
                rows.map((row) => ({
                    record_uri: row.record_uri,
                    uri: row.uri,
                    field: row.field,
                    action: row.action,
                    previous: row.previous,
                    value: row.value,
                    pids: JSON.parse(row.pids),
                }))
            ).toEqual([
                {
                    record_uri: AO,
                    uri: '/repositories/2/digital_objects/48380',
                    field: 'digital_object_id',
                    action: 'update',
                    previous: 'B133.01.0003.00001',
                    value: handle(PID),
                    pids: [PID],
                },
                {
                    record_uri: AO,
                    uri: AO,
                    field: 'link',
                    action: 'add',
                    previous: null,
                    value: handle(PID),
                    pids: [PID],
                },
            ]);
            expect(rows.every((row) => Boolean(row.created_at))).toBe(true);
        });

        it('outlives a later check of the record and its removal from the queue', async () => {
            await model.enqueue([AO]);
            await model.log_change({
                record_uri: AO,
                uri: AO,
                field: 'link',
                action: 'update',
                previous: 'http://example.org/old',
                value: handle(PID),
                pids: [PID],
            });
            await model.record(await row_for(AO), result({ state: 'in_sync' }));
            await model.remove([await row_for(AO)]);

            const rows = await changes();
            expect(rows).toHaveLength(1);
            expect(rows[0].previous).toBe('http://example.org/old');
        });
    });

    describe('summary', () => {
        it('counts waiting rows and checked rows by result', async () => {
            await model.enqueue([AO, SECOND, THIRD, RESOURCE]);
            await model.record(await row_for(AO), result({ state: 'updated' }));
            await model.record(await row_for(SECOND), result({ state: 'contested' }));
            await model.record(await row_for(THIRD), result({ state: 'contested' }));

            const summary = await model.summary();
            expect(summary).toMatchObject({
                waiting: 1,
                checked: 3,
                states: { updated: 1, contested: 2 },
                waiting_error: null,
            });
            expect(summary.last_checked_at).toBeTruthy();
        });

        it('reports the reason when waiting rows were put off', async () => {
            await model.enqueue([AO]);
            await model.defer(await all_rows(), 'ArchivesSpace could not list records');
            const summary = await model.summary();
            expect(summary.waiting).toBe(1);
            expect(summary.waiting_error).toBe('ArchivesSpace could not list records');
            expect(summary.last_checked_at).toBeNull();
        });

        it('is all zeros for an empty table', async () => {
            expect(await model.summary()).toEqual({
                waiting: 0,
                checked: 0,
                states: {},
                last_checked_at: null,
                waiting_error: null,
            });
        });
    });

    describe('list', () => {
        it('returns checked rows with the wanted results, parsed, with the total', async () => {
            await model.enqueue([AO, SECOND, THIRD]);
            await model.record(
                await row_for(AO),
                result({ state: 'contested', pids: [PID, GONE] })
            );
            await model.record(await row_for(SECOND), result({ state: 'in_sync' }));

            const found = await model.list({ states: ['contested', 'failed'] });
            expect(found.total).toBe(1);
            expect(found.rows).toHaveLength(1);
            expect(found.rows[0]).toMatchObject({
                uri: AO,
                state: 'contested',
                pids: [PID, GONE],
                detail: { link: 'add' },
            });
        });

        it('caps the rows at the limit and still reports the full total', async () => {
            await model.enqueue([AO, SECOND, THIRD]);
            for (const row of await all_rows()) {
                await model.record(row, result({ state: 'orphan_link' }));
            }
            const found = await model.list({ states: ['orphan_link'], limit: 2 });
            expect(found.total).toBe(3);
            expect(found.rows).toHaveLength(2);
        });

        it('returns nothing without a list of results', async () => {
            expect(await model.list()).toEqual({ rows: [], total: 0 });
        });
    });

    describe('collection creation', () => {
        const uri = '/repositories/2/resources/4242';
        const aspace = {
            is_configured: () => true,
            get_session_token: async () => 'tok',
            get_record: async () => ({ status: 200, data: { title: 'Papers', uri } }),
            destroy_session_token: async () => {},
        };
        const handles = (configured) => ({
            is_configured: () => configured,
            create_handle: async (pid) => ({ status: 201, handle: handle(pid) }),
        });

        it('queues the new collection record for a link check', async () => {
            const out = await provision_collection({ uri }, { aspace, handles: handles(true) });
            expect(out).toMatchObject({ ok: true, created: true });
            expect((await all_rows()).map((row) => row.uri)).toEqual([uri]);
        });

        it('queues nothing when the collection has no handle', async () => {
            const out = await provision_collection({ uri }, { aspace, handles: handles(false) });
            expect(out).toMatchObject({ ok: true, created: true });
            expect(await all_rows()).toHaveLength(0);
        });
    });
});
