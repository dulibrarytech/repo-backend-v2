'use strict';

// Unit tests for libs/elasticsearch. The default export hits the real
// @elastic/elasticsearch client; we test via create_client(factory)
// with a fake client that captures every call and scripts responses.

const es_module = require('../../../libs/elasticsearch');
const app_config = require('../../../config/app');
const { UpstreamError } = require('../../../libs/errors');

function make_fake_client() {
    const calls = { index: [], delete: [], exists: [], create: [], health: [], count: [] };
    const scripts = {
        exists: { value: true },
        create: { value: {} },
        index: { value: {} },
        delete: { value: {} },
        health: { value: { status: 'green' } },
        count: { value: { count: 0 } },
    };
    function run(name, args) {
        calls[name].push(args);
        const s = scripts[name];
        if (s && s.throw) throw s.throw;
        return s ? s.value : undefined;
    }
    return {
        calls,
        script(name, value, opts = {}) {
            scripts[name] = { value, throw: opts.throw };
        },
        indices: {
            exists: async (a) => run('exists', a),
            create: async (a) => run('create', a),
        },
        index: async (a) => run('index', a),
        delete: async (a) => run('delete', a),
        cluster: {
            health: async (a) => run('health', a),
        },
        count: async (a) => run('count', a),
    };
}

describe('libs/elasticsearch', () => {
    let original_env;
    let fake;
    let client;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.ELASTICSEARCH_HOST = 'http://es.example:9200';
        process.env.ELASTICSEARCH_FRONT_INDEX = 'repo_test';
        process.env.ELASTICSEARCH_SHARDS = '1';
        process.env.ELASTICSEARCH_REPLICAS = '0';
        app_config._reset();
        fake = make_fake_client();
        client = es_module.create_client(() => fake);
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('build_tls_options', () => {
        // The TLS option block is pure config-to-object translation,
        // so we test it in isolation — no Client mocking required.
        const os = require('node:os');
        const fs = require('node:fs');
        const path = require('node:path');

        it('returns undefined when no TLS config is provided', () => {
            // beforeEach() at the outer scope already set HOST/USER/PASSWORD
            // but no TLS knobs.
            expect(es_module.build_tls_options()).toBeUndefined();
        });

        it('loads ELASTICSEARCH_CA_CERT_FILE into tls.ca', () => {
            const tmp = path.join(os.tmpdir(), `ca-test-${Date.now()}.pem`);
            const fake_ca = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n';
            fs.writeFileSync(tmp, fake_ca);
            process.env.ELASTICSEARCH_CA_CERT_FILE = tmp;
            app_config._reset();
            try {
                const tls = es_module.build_tls_options();
                expect(tls).toBeDefined();
                expect(tls.ca).toBeDefined();
                expect(tls.ca.toString('utf8')).toContain('FAKE');
                // The escape hatch is still on by default.
                expect(tls.rejectUnauthorized).toBeUndefined();
            } finally {
                fs.unlinkSync(tmp);
                delete process.env.ELASTICSEARCH_CA_CERT_FILE;
                app_config._reset();
            }
        });

        it('falls back to the default trust store when ca_cert_file is missing', () => {
            // A bad path is treated as a soft failure: we log and keep
            // going with Node's default trust store rather than refuse
            // to construct a client.
            process.env.ELASTICSEARCH_CA_CERT_FILE = '/nonexistent/path.pem';
            app_config._reset();
            try {
                const tls = es_module.build_tls_options();
                // tls is undefined (no ca loaded, no reject flag).
                expect(tls).toBeUndefined();
            } finally {
                delete process.env.ELASTICSEARCH_CA_CERT_FILE;
                app_config._reset();
            }
        });

        it('disables verification when ELASTICSEARCH_REJECT_UNAUTHORIZED=0', () => {
            process.env.ELASTICSEARCH_REJECT_UNAUTHORIZED = '0';
            app_config._reset();
            try {
                const tls = es_module.build_tls_options();
                expect(tls).toBeDefined();
                expect(tls.rejectUnauthorized).toBe(false);
            } finally {
                delete process.env.ELASTICSEARCH_REJECT_UNAUTHORIZED;
                app_config._reset();
            }
        });

        it('treats ELASTICSEARCH_REJECT_UNAUTHORIZED=1 as secure default (no opt-out)', () => {
            process.env.ELASTICSEARCH_REJECT_UNAUTHORIZED = '1';
            app_config._reset();
            try {
                expect(es_module.build_tls_options()).toBeUndefined();
            } finally {
                delete process.env.ELASTICSEARCH_REJECT_UNAUTHORIZED;
                app_config._reset();
            }
        });

        it('combines CA file + rejectUnauthorized=false when both are set', () => {
            const tmp = path.join(os.tmpdir(), `combo-${Date.now()}.pem`);
            fs.writeFileSync(tmp, '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----');
            process.env.ELASTICSEARCH_CA_CERT_FILE = tmp;
            process.env.ELASTICSEARCH_REJECT_UNAUTHORIZED = '0';
            app_config._reset();
            try {
                const tls = es_module.build_tls_options();
                expect(tls.ca).toBeDefined();
                expect(tls.rejectUnauthorized).toBe(false);
            } finally {
                fs.unlinkSync(tmp);
                delete process.env.ELASTICSEARCH_CA_CERT_FILE;
                delete process.env.ELASTICSEARCH_REJECT_UNAUTHORIZED;
                app_config._reset();
            }
        });
    });

    describe('is_configured', () => {
        it('returns true when host is set', () => {
            expect(es_module.is_configured()).toBe(true);
        });
        it('returns false when host is empty', () => {
            delete process.env.ELASTICSEARCH_HOST;
            app_config._reset();
            expect(es_module.is_configured()).toBe(false);
        });
    });

    describe('ensure_index', () => {
        it('no-ops when the index already exists', async () => {
            fake.script('exists', true);
            const res = await client.ensure_index();
            expect(res.created).toBe(false);
            expect(fake.calls.create).toHaveLength(0);
        });

        it('creates the index with configured shards/replicas when absent', async () => {
            fake.script('exists', false);
            const res = await client.ensure_index();
            expect(res.created).toBe(true);
            expect(fake.calls.create).toHaveLength(1);
            const call = fake.calls.create[0];
            expect(call.index).toBe('repo_test');
            expect(call.settings.number_of_shards).toBe(1);
            expect(call.settings.number_of_replicas).toBe(0);
        });

        it('declares explicit mappings for all queryable top-level fields', async () => {
            fake.script('exists', false);
            await client.ensure_index();
            const props = fake.calls.create[0].mappings.properties;
            // Booleans (was the v1 long-mapping bug).
            expect(props.is_compound).toEqual({ type: 'boolean' });
            expect(props.is_published).toEqual({ type: 'boolean' });
            // id-shaped keyword filters.
            expect(props.pid).toEqual({ type: 'keyword' });
            expect(props.handle).toEqual({ type: 'keyword' });
            expect(props.uri).toEqual({ type: 'keyword' });
            expect(props.is_member_of_collection).toEqual({ type: 'keyword' });
            // Range-able date.
            expect(props.created).toEqual({ type: 'date' });
            // Full-text searchable with a .keyword sub-field for
            // sort + exact-value aggregation. Mirrors v1's pattern.
            expect(props.title).toEqual({
                type: 'text',
                fields: { keyword: { type: 'keyword', ignore_above: 256 } },
            });
            expect(props.abstract).toEqual({
                type: 'text',
                fields: { keyword: { type: 'keyword', ignore_above: 256 } },
            });
            // Faceted filter.
            expect(props.subjects).toEqual({ type: 'keyword' });
        });

        it('makes display_record opaque (dynamic:false) to avoid shape collisions', async () => {
            // Source records have inconsistent display_record sub-
            // field shapes (extents string vs object, parts varies,
            // etc.). dynamic:false stores the blob in _source for
            // retrieval but skips per-field type inference so we
            // can never hit mapper_parsing_exception inside the
            // display_record subtree.
            fake.script('exists', false);
            await client.ensure_index();
            const props = fake.calls.create[0].mappings.properties;
            expect(props.display_record).toEqual({
                type: 'object',
                dynamic: false,
            });
        });

        it('treats a race-condition "already exists" error as success', async () => {
            fake.script('exists', false);
            const err = new Error('resource_already_exists_exception');
            err.meta = { body: { error: { type: 'resource_already_exists_exception' } } };
            fake.script('create', null, { throw: err });
            const res = await client.ensure_index();
            expect(res.created).toBe(false);
        });

        it('throws UpstreamError on any other create failure', async () => {
            fake.script('exists', false);
            fake.script('create', null, { throw: new Error('cluster_block_exception') });
            await expect(client.ensure_index()).rejects.toBeInstanceOf(UpstreamError);
        });

        it('throws UpstreamError when ES is not configured', async () => {
            delete process.env.ELASTICSEARCH_HOST;
            app_config._reset();
            await expect(client.ensure_index()).rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('index_document', () => {
        it('upserts by pid using the configured index', async () => {
            await client.index_document('abc-123', { title: 'X' });
            expect(fake.calls.index).toHaveLength(1);
            const call = fake.calls.index[0];
            expect(call.index).toBe('repo_test');
            expect(call.id).toBe('abc-123');
            expect(call.document.title).toBe('X');
            // refresh=false: don't force a flush per write
            expect(call.refresh).toBe(false);
        });

        it('wraps network failures as UpstreamError', async () => {
            fake.script('index', null, { throw: new Error('ECONNRESET') });
            await expect(client.index_document('p', {})).rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('delete_document', () => {
        it('treats a 404 as a soft success (already gone)', async () => {
            const err = new Error('not_found');
            err.meta = { statusCode: 404 };
            fake.script('delete', null, { throw: err });
            const res = await client.delete_document('gone');
            expect(res.ok).toBe(true);
            expect(res.deleted).toBe(false);
        });

        it('returns ok+deleted=true on a successful delete', async () => {
            const res = await client.delete_document('p');
            expect(res.deleted).toBe(true);
        });

        it('throws UpstreamError on non-404 failures', async () => {
            const err = new Error('cluster_block');
            err.meta = { statusCode: 503 };
            fake.script('delete', null, { throw: err });
            await expect(client.delete_document('p')).rejects.toBeInstanceOf(UpstreamError);
        });
    });

    describe('health', () => {
        it('returns ok:true on green/yellow status', async () => {
            fake.script('health', { status: 'green' });
            expect(await client.health()).toEqual({ ok: true, status: 'green' });
            fake.script('health', { status: 'yellow' });
            expect(await client.health()).toEqual({ ok: true, status: 'yellow' });
        });

        it('returns ok:false on red status', async () => {
            fake.script('health', { status: 'red' });
            const r = await client.health();
            expect(r.ok).toBe(false);
        });

        it('returns ok:false + unreachable on transport error', async () => {
            fake.script('health', null, { throw: new Error('ETIMEDOUT') });
            const r = await client.health();
            expect(r.ok).toBe(false);
            expect(r.status).toBe('unreachable');
        });

        it('returns unconfigured when host is not set', async () => {
            delete process.env.ELASTICSEARCH_HOST;
            app_config._reset();
            const r = await client.health();
            expect(r.ok).toBe(false);
            expect(r.status).toBe('unconfigured');
        });
    });

    describe('project_for_index', () => {
        it('emits JSON booleans for is_compound + is_published (matches new boolean mapping)', () => {
            const row = {
                pid: 'p1',
                handle: 'https://hdl/x',
                uri: '/r/1',
                is_member_of_collection: 'col',
                object_type: 'object',
                mime_type: 'image/tiff',
                thumbnail: 'tn.jpg',
                is_compound: 0,
                is_published: 1,
                sip_uuid: 'sip-1',
                created: '2024-01-01',
            };
            const dr = { title: 'Hello', f_subjects: ['a', 'b'] };
            const body = es_module.project_for_index(row, dr);
            expect(body.pid).toBe('p1');
            // booleans, not numbers. The boolean mapping rejects 0/1.
            expect(body.is_compound).toBe(false);
            expect(body.is_published).toBe(true);
            expect(body.display_record).toBe(dr);
        });

        it('promotes title/abstract/subjects to top-level fields', () => {
            // The dashboard's display_record envelope carries
            // denormalized title/abstract on the OUTER level (from
            // ingest); the fresh ASpace fetch lives on the INNER
            // dr.display_record. The projection should prefer the
            // inner (fresh) value when both are present.
            const dr = {
                title: 'OLD outer title',
                abstract: 'OLD outer abstract',
                f_subjects: ['Photography', 'Tuberculosis'],
                display_record: {
                    title: 'NEW inner title',
                    abstract: ['NEW inner abstract', 'second paragraph'],
                },
            };
            const body = es_module.project_for_index({ pid: 'p' }, dr);
            expect(body.title).toBe('NEW inner title');
            // first_string picks the first array entry.
            expect(body.abstract).toBe('NEW inner abstract');
            expect(body.subjects).toEqual(['Photography', 'Tuberculosis']);
        });

        it('falls back to outer envelope when inner display_record is absent', () => {
            const dr = {
                title: 'Outer-only title',
                abstract: 'Outer-only abstract',
            };
            const body = es_module.project_for_index({ pid: 'p' }, dr);
            expect(body.title).toBe('Outer-only title');
            expect(body.abstract).toBe('Outer-only abstract');
            expect(body.subjects).toEqual([]);
        });

        it('emits null/empty for missing searchable fields', () => {
            const body = es_module.project_for_index({ pid: 'p' }, {});
            expect(body.title).toBeNull();
            expect(body.abstract).toBeNull();
            expect(body.subjects).toEqual([]);
        });

        it('drops non-string entries from subjects', () => {
            const dr = { f_subjects: ['valid', null, 42, 'another'] };
            const body = es_module.project_for_index({ pid: 'p' }, dr);
            expect(body.subjects).toEqual(['valid', 'another']);
        });

        it('normalizes tinyint(1) values to proper booleans', () => {
            // mysql2 + better-sqlite3 both return tinyint(1) as 0/1
            // numerics. Boolean(...) normalizes both to actual
            // JS booleans so the JSON serialization stays correct.
            const dr = {};
            expect(es_module.project_for_index({ is_compound: 1 }, dr).is_compound).toBe(true);
            expect(es_module.project_for_index({ is_compound: 0 }, dr).is_compound).toBe(false);
            expect(es_module.project_for_index({ is_compound: null }, dr).is_compound).toBe(false);
            expect(es_module.project_for_index({ is_compound: undefined }, dr).is_compound).toBe(
                false
            );
            expect(es_module.project_for_index({ is_published: true }, dr).is_published).toBe(true);
            expect(es_module.project_for_index({ is_published: false }, dr).is_published).toBe(
                false
            );
        });
    });
});
