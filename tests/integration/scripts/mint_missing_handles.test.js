'use strict';

const script = require('../../../scripts/mint_missing_handles');
const app_config = require('../../../config/app');
const db_helper = require('../../helpers/db');
const { db, db_queue } = require('../../../config/db');
const tables = require('../../../config/db_tables');

const MISSING = '2d569507-de89-41eb-9bb6-6be0d12b5eb8';
const PRESENT = 'c363ed8b-c90c-4102-b810-6bae8927c006';
const BROKEN = '11895f17-8ca0-44cf-8d5f-672bc1284a95';
const DELETED = 'f9746482-fc85-4046-93f1-2a191f2bfe14';
const TEST = '49986393-2f99-4c20-aebe-3a6d4c9b61f0';
const UNKNOWN = 'eb3a1409-ea0e-48b5-a0c4-20e9b9800c18';

const V1_FAILURE =
    'Error: [/libs/handles lib (create_handle)] Unable to create new handle ' +
    'Error: getaddrinfo ENOTFOUND hdl.example.org hdl.example.org:8080';

const handle = (pid) => `https://hdl.handle.net/10176/${pid}`;
const target = (pid) => `https://digitalarchives.du.edu/object/${pid}`;
const row_of = (pid) => db()(tables.objects).where({ pid }).first();

function handle_server({ creates = true, unreachable = [] } = {}) {
    const held = new Map();
    const handles = {
        get_handle: vi.fn(async (pid) => {
            if (unreachable.includes(pid)) throw new Error('Handle resolve returned 500');
            return held.has(pid)
                ? {
                      values: [
                          {
                              index: 2,
                              type: 'URL',
                              data: { format: 'string', value: held.get(pid) },
                          },
                      ],
                  }
                : null;
        }),
    };
    const writer = {
        batch: vi.fn(async (operations) => {
            if (creates) for (const entry of operations) held.set(entry.uuid, entry.url);
            return {
                results: operations.map((entry) => ({
                    suffix: entry.uuid,
                    ok: creates,
                    message: creates ? 'SUCCESS' : 'INVALID ADMIN',
                })),
            };
        }),
    };
    return { held, handles, writer };
}

async function seed() {
    await db_helper.seed_object({
        pid: MISSING,
        handle: handle(MISSING),
        created: '2023-09-13 22:53:18',
        display_record: JSON.stringify({ pid: MISSING, handle: handle(MISSING), title: 'Part 3' }),
    });
    await db_helper.seed_object({
        pid: PRESENT,
        handle: handle(PRESENT),
        created: '2023-08-22 18:22:15',
    });
    await db_helper.seed_object({
        pid: BROKEN,
        uri: '/repositories/2/archival_objects/147084',
        handle: V1_FAILURE,
        created: '2023-09-13 23:08:07',
        is_published: 1,
        is_indexed: 1,
        index_attempts: 4,
        index_error: 'boom',
        display_record: JSON.stringify({ pid: BROKEN, handle: V1_FAILURE, title: 'Part 6' }),
    });
    await db_helper.seed_object({
        pid: DELETED,
        handle: handle(DELETED),
        created: '2023-09-13 23:13:09',
        is_active: 0,
    });
    await db_helper.seed_object({
        pid: TEST,
        handle: 'test-handle',
        object_type: 'collection',
        created: '2023-09-14 00:00:00',
    });
}

function run(args, server) {
    const lines = [];
    return script
        .run(
            { execute: false, pids: null, from: null, to: null, ...args },
            { handles: server.handles, writer: server.writer, print: (line) => lines.push(line) }
        )
        .then((plans) => ({
            plans,
            lines,
            by_pid: new Map(plans.map((plan) => [plan.pid, plan])),
        }));
}

const WINDOW = { from: '2023-09-01', to: '2023-10-01' };
const EVERYTHING = { from: '2000-01-01', to: '2100-01-01' };

describe('scripts/mint_missing_handles run', () => {
    let original_env;

    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        original_env = { ...process.env };
        process.env.HANDLE_TARGET = 'https://digitalarchives.du.edu/object/';
        process.env.HANDLE_PREFIX = '10176';
        process.env.HANDLE_SERVER = 'https://hdl.handle.net/';
        app_config._reset();
        await db_helper.reset_data();
        await seed();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('writes nothing on a dry run', async () => {
        const server = handle_server();
        server.held.set(PRESENT, target(PRESENT));
        const before = await db()(tables.objects).orderBy('id');

        const { by_pid, lines } = await run(EVERYTHING, server);

        expect(server.writer.batch).not.toHaveBeenCalled();
        expect(await db()(tables.objects).orderBy('id')).toEqual(before);
        expect(by_pid.get(MISSING)).toMatchObject({ mint: true, store: false });
        expect(by_pid.get(BROKEN)).toMatchObject({ mint: true, store: true });
        expect(lines.join('\n')).toMatch(/DRY RUN \(nothing written\): 5 object\(s\)/);
        expect(lines.join('\n')).toMatch(/to do: create and store\s+11895f17/);
    });

    it('creates only the handles the server does not have', async () => {
        const server = handle_server();
        server.held.set(PRESENT, target(PRESENT));

        const { plans } = await run({ ...EVERYTHING, execute: true }, server);

        expect(server.writer.batch).toHaveBeenCalledTimes(1);
        expect(server.writer.batch.mock.calls[0][0]).toEqual([
            { op: 'create', uuid: MISSING, index: 2, url: target(MISSING) },
            { op: 'create', uuid: BROKEN, index: 2, url: target(BROKEN) },
        ]);
        expect([...server.held.keys()].sort()).toEqual([MISSING, PRESENT, BROKEN].sort());
        expect(plans.some((plan) => plan.failed)).toBe(false);
    });

    it('stores the handle in both places and queues the row for indexing', async () => {
        const server = handle_server();

        await run({ pids: [BROKEN], execute: true }, server);

        const row = await row_of(BROKEN);
        expect(row.handle).toBe(handle(BROKEN));
        expect(JSON.parse(row.display_record)).toEqual({
            pid: BROKEN,
            handle: handle(BROKEN),
            title: 'Part 6',
        });
        expect(row).toMatchObject({ is_updated: 1, index_attempts: 0, index_error: null });
        expect(
            await db_queue()(tables.aspace_links)
                .where({ uri: '/repositories/2/archival_objects/147084' })
                .first()
        ).toMatchObject({ status: 'PENDING' });
    });

    it('leaves a row alone when only its handle was missing', async () => {
        const server = handle_server();
        const before = await row_of(MISSING);

        await run({ pids: [MISSING], execute: true }, server);

        expect(server.held.get(MISSING)).toBe(target(MISSING));
        expect(await row_of(MISSING)).toEqual(before);
    });

    it('never creates a handle for a deleted object or an unexpected stored value', async () => {
        const server = handle_server();
        const before = [await row_of(DELETED), await row_of(TEST)];

        const { by_pid } = await run({ ...EVERYTHING, execute: true }, server);

        expect(server.held.has(DELETED)).toBe(false);
        expect(server.held.has(TEST)).toBe(false);
        expect(by_pid.get(DELETED).skipped).toBe('deleted object');
        expect(by_pid.get(TEST).skipped).toBe('unexpected stored handle');
        expect([await row_of(DELETED), await row_of(TEST)]).toEqual(before);
    });

    it('does not store a handle the server does not show afterwards', async () => {
        const server = handle_server({ creates: false });
        const before = await row_of(BROKEN);

        const { by_pid, lines } = await run({ pids: [BROKEN], execute: true }, server);

        expect(server.writer.batch).toHaveBeenCalledTimes(1);
        expect(by_pid.get(BROKEN).failed).toBe(
            'the handle server does not show the new handle (the helper said: INVALID ADMIN)'
        );
        expect(await row_of(BROKEN)).toEqual(before);
        expect(lines.join('\n')).toMatch(/FAILED\s+11895f17.*the helper said: INVALID ADMIN/);
    });

    it('does not accept a new handle that points somewhere else', async () => {
        const server = handle_server({ creates: false });
        server.writer.batch.mockImplementation(async (operations) => {
            for (const entry of operations) server.held.set(entry.uuid, target(UNKNOWN));
            return { results: [] };
        });
        const before = await row_of(BROKEN);

        const { by_pid } = await run({ pids: [BROKEN], execute: true }, server);

        expect(by_pid.get(BROKEN).failed).toBe(
            'the handle server does not show the new handle (the helper said: nothing)'
        );
        expect(await row_of(BROKEN)).toEqual(before);
    });

    it.each([
        ['asks again before giving up on a new handle', [2, 3], true],
        ['gives up on a new handle after three unanswered lookups', [2, 3, 4], false],
    ])('%s', async (_label, unanswered, stored) => {
        const server = handle_server();
        const answer = server.handles.get_handle.getMockImplementation();
        let lookups = 0;
        server.handles.get_handle.mockImplementation(async (pid) => {
            lookups += 1;
            if (unanswered.includes(lookups)) throw new Error('Handle resolve returned 500');
            return answer(pid);
        });

        const { by_pid } = await run({ pids: [BROKEN], execute: true }, server);

        expect(lookups).toBe(4);
        expect(Boolean(by_pid.get(BROKEN).failed)).toBe(!stored);
        expect((await row_of(BROKEN)).handle).toBe(stored ? handle(BROKEN) : V1_FAILURE);
    });

    it('skips an object it could not ask about and carries on with the rest', async () => {
        const server = handle_server({ unreachable: [MISSING] });

        const { by_pid } = await run({ ...WINDOW, execute: true }, server);

        expect(by_pid.get(MISSING)).toMatchObject({
            mint: false,
            failed: 'Handle resolve returned 500',
        });
        expect(server.held.has(MISSING)).toBe(false);
        expect(server.held.get(BROKEN)).toBe(target(BROKEN));
        expect((await row_of(BROKEN)).handle).toBe(handle(BROKEN));
    });

    it('only stores when the handle is already on the server', async () => {
        const server = handle_server();
        server.held.set(BROKEN, 'https://specialcollections.du.edu/object/' + BROKEN);

        await run({ pids: [BROKEN], execute: true }, server);

        expect(server.writer.batch).not.toHaveBeenCalled();
        expect(await row_of(BROKEN)).toMatchObject({ handle: handle(BROKEN), is_updated: 1 });
    });

    it('keeps a display record it cannot read and still stores the handle', async () => {
        const server = handle_server();
        await db()(tables.objects).where({ pid: BROKEN }).update({ display_record: 'not json' });

        await run({ pids: [BROKEN], execute: true }, server);

        expect(await row_of(BROKEN)).toMatchObject({
            handle: handle(BROKEN),
            display_record: 'not json',
            is_updated: 1,
        });
    });

    it('takes the objects ingested inside the window, the end excluded', async () => {
        const server = handle_server();

        const { plans } = await run(
            { from: '2023-09-13 22:53:18', to: '2023-09-13 23:13:09' },
            server
        );

        expect(plans.map((plan) => plan.pid)).toEqual([MISSING, BROKEN]);
    });

    it('reports a pid it cannot find', async () => {
        const server = handle_server();

        const { by_pid } = await run({ pids: [UNKNOWN, MISSING], execute: true }, server);

        expect(by_pid.get(UNKNOWN)).toMatchObject({
            mint: false,
            store: false,
            skipped: 'no such object',
        });
        expect(server.held.has(UNKNOWN)).toBe(false);
        expect(server.held.has(MISSING)).toBe(true);
    });

    it('does nothing the second time', async () => {
        const server = handle_server();
        await run({ ...WINDOW, execute: true }, server);
        const after_first = await db()(tables.objects).orderBy('id');
        server.writer.batch.mockClear();

        const { plans, lines } = await run({ ...WINDOW, execute: true }, server);

        expect(server.writer.batch).not.toHaveBeenCalled();
        expect(plans.filter((plan) => plan.mint || plan.store)).toEqual([]);
        expect(await db()(tables.objects).orderBy('id')).toEqual(after_first);
        expect(lines.join('\n')).toMatch(/\s2\s+exists/);
    });
});
