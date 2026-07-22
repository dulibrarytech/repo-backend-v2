'use strict';

/*
 * Unit tests for libs/elasticsearch. The default export hits the real
 * @elastic/elasticsearch client; we test via create_client(factory)
 * with a fake client that captures every call and scripts responses.
 */

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
        /*
         * The TLS option block is pure config-to-object translation,
         * so we test it in isolation — no Client mocking required.
         */
        const os = require('node:os');
        const fs = require('node:fs');
        const path = require('node:path');

        it('returns undefined when no TLS config is provided', () => {
            /*
             * beforeEach() at the outer scope already set HOST/USER/PASSWORD
             * but no TLS knobs.
             */
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
            /*
             * A bad path is treated as a soft failure: we log and keep
             * going with Node's default trust store rather than refuse
             * to construct a client.
             */
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

        it('declares prod-compatible mappings for queryable top-level fields', async () => {
            fake.script('exists', false);
            await client.ensure_index();
            const props = fake.calls.create[0].mappings.properties;
            /*
             * Integer flags — prod's 0/1 wire format (project_for_index now
             * emits 1/0, matching the production repo_public mapping).
             */
            expect(props.is_compound).toEqual({ type: 'long' });
            expect(props.is_published).toEqual({ type: 'long' });
            // Range-able date.
            expect(props.created).toEqual({ type: 'date' });
            /*
             * text + .keyword for the sort/facet surface (object_type.keyword,
             * creator.keyword, f_subjects.keyword, type.keyword, …).
             */
            for (const f of ['title', 'abstract', 'creator', 'f_subjects', 'type', 'object_type']) {
                expect(props[f].type).toBe('text');
                expect(props[f].fields.keyword.type).toBe('keyword');
            }
            // Facets use f_subjects; there is no top-level `subjects` field.
            expect(props.subjects).toBeUndefined();
            expect(props.f_subjects).toBeDefined();
        });

        it('maps the display_record sub-fields the frontend queries, kept dynamic:false', async () => {
            /*
             * The public site queries INSIDE display_record (dates range,
             * creator facet, etc.), so it can't be a fully opaque blob.
             * dynamic:false keeps the mapped sub-fields queryable while
             * storing odd-shaped extras in _source without inferring them
             * (no mapper_parsing_exception on shape collisions).
             */
            fake.script('exists', false);
            await client.ensure_index();
            const props = fake.calls.create[0].mappings.properties;
            const dr = props.display_record;
            expect(dr.type).toBe('object');
            expect(dr.dynamic).toBe(false);
            // Nested types the frontend's date-range + call-number queries need.
            expect(dr.properties.dates.type).toBe('nested');
            expect(dr.properties.identifiers.type).toBe('nested');
            // Creator facet hits display_record.names.title.keyword.
            expect(dr.properties.names.properties.title.fields.keyword.type).toBe('keyword');
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
        /*
         * The canonical object input: a row + a display_record envelope whose
         * inner `display_record` is the raw ArchivesSpace record.
         */
        const objRow = {
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

        it('emits the 2-level prod shape: integer flags, no outer envelope, raw record at display_record', () => {
            const dr = {
                object: 'dip/objects/x.tif',
                display_record: {
                    title: 'Hello',
                    resource_type: 'still image',
                    subjects: [{ title: 'a' }, { title: 'b' }],
                    names: [{ title: 'Doe, J', role: 'creator' }],
                    notes: [{ type: 'abstract', content: 'An abstract' }],
                    parts: [{ order: '1', title: 'f.tif', type: 'object' }],
                },
            };
            const body = es_module.project_for_index(objRow, dr);
            // Integer 1/0 flags (prod), NOT JS booleans.
            expect(body.is_published).toBe(1);
            expect(body.is_compound).toBe(0);
            // Denormalized top-level query/display surface, derived from inner.
            expect(body.title).toBe('Hello');
            expect(body.creator).toBe('Doe, J');
            expect(body.f_subjects).toEqual(['a', 'b']);
            expect(body.abstract).toBe('An abstract');
            expect(body.type).toBe('still image');
            expect(body.object).toBe('dip/objects/x.tif');
            // 2-level: display_record IS the raw record — no third nesting level.
            expect(body.display_record.display_record).toBeUndefined();
            expect(body.display_record.title).toBe('Hello');
            // No redundant outer-envelope leftovers.
            expect(body.subjects).toBeUndefined();
            expect('compound' in body).toBe(false);
        });

        it('normalizes object_type "compound" to "object" (keeps is_compound=1)', () => {
            const dr = { display_record: { title: 'C', is_compound: true } };
            const body = es_module.project_for_index(
                { ...objRow, object_type: 'compound', is_compound: 1 },
                dr
            );
            expect(body.object_type).toBe('object');
            expect(body.is_compound).toBe(1);
        });

        it('stores the parts manifest once (enriched) at display_record.parts; no top-level compound[]', () => {
            const enriched = [
                { order: '1', type: 'object', object: 'dip/o1.jp2', thumbnail: 'dip/t1.jpg' },
            ];
            const dr = {
                // inner record's own parts are un-enriched (no object path)…
                display_record: {
                    title: 'C',
                    is_compound: true,
                    parts: [{ order: '1', type: 'object' }],
                },
                // …the enriched manifest lives on the envelope.
                parts: enriched,
            };
            const body = es_module.project_for_index({ ...objRow, object_type: 'compound' }, dr);
            expect('compound' in body).toBe(false);
            expect(body.display_record.parts).toBe(enriched);
            expect(body.display_record.parts[0].object).toBe('dip/o1.jp2');
            // Master path resolved from the enriched parts.
            expect(body.object).toBe('dip/o1.jp2');
        });

        it('derives creator/f_subjects/abstract from the inner record for a sparse (native-ingest) envelope', () => {
            const dr = {
                title: 'X',
                abstract: 'envelope abstract',
                handle: 'h',
                display_record: {
                    title: 'X',
                    resource_type: 'text',
                    names: [{ title: 'Smith', role: 'creator' }],
                    subjects: [{ title: 'S1' }],
                    notes: [{ type: 'abstract', content: 'note abstract' }],
                },
            };
            const body = es_module.project_for_index(objRow, dr);
            expect(body.creator).toBe('Smith');
            expect(body.f_subjects).toEqual(['S1']);
            expect(body.abstract).toBe('note abstract');
        });

        it('prefers the inner (fresh ASpace) title over the outer envelope title', () => {
            const dr = { title: 'OLD outer', display_record: { title: 'NEW inner' } };
            const body = es_module.project_for_index(objRow, dr);
            expect(body.title).toBe('NEW inner');
            expect(body.display_record.title).toBe('NEW inner');
        });

        it('emits the stripped collection shape (title/abstract only)', () => {
            const dr = {
                display_record: {
                    title: 'A Collection',
                    jsonmodel_type: 'resource',
                    notes: [{ type: 'abstract', content: 'coll abstract' }],
                },
            };
            const body = es_module.project_for_index({ ...objRow, object_type: 'collection' }, dr);
            expect(body.object_type).toBe('collection');
            expect(body.title).toBe('A Collection');
            expect(body.abstract).toBe('coll abstract');
            expect(body.display_record).toEqual({
                title: 'A Collection',
                abstract: 'coll abstract',
            });
            // Collections don't carry the object-only fields.
            expect('mime_type' in body).toBe(false);
            expect('creator' in body).toBe(false);
            expect('type' in body).toBe(false);
            expect('object' in body).toBe(false);
        });

        it('drops non-string subject titles', () => {
            const dr = {
                display_record: {
                    subjects: [
                        { title: 'valid' },
                        { title: null },
                        { title: 42 },
                        { title: 'another' },
                    ],
                },
            };
            const body = es_module.project_for_index(objRow, dr);
            expect(body.f_subjects).toEqual(['valid', 'another']);
        });

        it('emits integer flags from tinyint(1) and boolean inputs', () => {
            const o = { pid: 'p', object_type: 'object' };
            expect(es_module.project_for_index({ ...o, is_published: 1 }, {}).is_published).toBe(1);
            expect(es_module.project_for_index({ ...o, is_published: 0 }, {}).is_published).toBe(0);
            expect(es_module.project_for_index({ ...o, is_published: true }, {}).is_published).toBe(
                1
            );
            expect(es_module.project_for_index({ ...o, is_compound: 1 }, {}).is_compound).toBe(1);
            expect(es_module.project_for_index({ ...o, is_compound: 0 }, {}).is_compound).toBe(0);
        });

        it('falls back to a mime-derived type when neither record carries resource_type', () => {
            const o = { pid: 'p', object_type: 'object' };
            const t = (mime) =>
                es_module.project_for_index({ ...o, mime_type: mime }, { display_record: {} }).type;
            expect(t('image/tiff')).toBe('still image');
            expect(t('image/jp2')).toBe('still image');
            expect(t('application/pdf')).toBe('text');
            expect(t('video/quicktime')).toBe('moving image');
            expect(t('audio/x-wav')).toBe('sound recording');
            expect(t(null)).toBeNull();
            // Real resource_type always wins over the mime fallback.
            expect(
                es_module.project_for_index(
                    { ...o, mime_type: 'application/pdf' },
                    { display_record: { resource_type: 'mixed materials' } }
                ).type
            ).toBe('mixed materials');
        });

        it('reads entry_id off the envelope (or inner record) when no part carries one', () => {
            const o = { pid: 'p', object_type: 'object', mime_type: 'video/mp4' };
            expect(
                es_module.project_for_index(o, { entry_id: '1_abc', display_record: {} }).entry_id
            ).toBe('1_abc');
            expect(
                es_module.project_for_index(o, { display_record: { kaltura_id: '1_k' } }).entry_id
            ).toBe('1_k');
            // Parts still win when present.
            expect(
                es_module.project_for_index(o, {
                    entry_id: '1_envelope',
                    display_record: { parts: [{ order: '1', entry_id: '1_part' }] },
                }).entry_id
            ).toBe('1_part');
        });

        it('falls back to row.file_name for the master object path', () => {
            const o = { pid: 'p', object_type: 'object', file_name: 'dip/objects/from-row.tif' };
            expect(
                es_module.project_for_index(o, { display_record: {} }).object
            ).toBe('dip/objects/from-row.tif');
            // Envelope path still wins when present.
            expect(
                es_module.project_for_index(o, { object: 'dip/objects/x.tif', display_record: {} })
                    .object
            ).toBe('dip/objects/x.tif');
        });

        it('projects transcripts from the row columns under both field names', () => {
            const o = { pid: 'p', object_type: 'object' };
            const body = es_module.project_for_index(
                { ...o, transcript: 'Full display text', transcript_search: 'searchable text' },
                { display_record: {} }
            );
            expect(body.transcript).toBe('Full display text');
            expect(body.transcript_search).toBe('searchable text');
            // Either column alone still populates both fields.
            const only_search = es_module.project_for_index(
                { ...o, transcript_search: 'only search' },
                { display_record: {} }
            );
            expect(only_search.transcript).toBe('only search');
            expect(only_search.transcript_search).toBe('only search');
            // No transcript -> fields absent (not null noise).
            const none = es_module.project_for_index(o, { display_record: {} });
            expect('transcript' in none).toBe(false);
            // Junk placeholder values are not transcripts.
            const junk = es_module.project_for_index(
                { ...o, transcript: '{}', transcript_search: 'real searchable text' },
                { display_record: {} }
            );
            expect(junk.transcript).toBe('real searchable text');
            const all_junk = es_module.project_for_index(
                { ...o, transcript: '{}', transcript_search: '[]' },
                { display_record: {} }
            );
            expect('transcript' in all_junk).toBe(false);
        });
    });
});
