'use strict';

// Unit tests for api/model.js. The query builder + result projection
// are pure functions, so most tests are direct calls without any
// fake-ES setup. The integration of those pieces through the model
// surface uses a tiny fake ES client that records calls + returns
// scripted responses.

const { randomUUID } = require('node:crypto');

const model_module = require('../../../api/model');
const app_config = require('../../../config/app');
const { ValidationError } = require('../../../libs/errors');

function make_fake_es() {
    const calls = [];
    let next_search = { total: 0, hits: [] };
    let next_get = null;
    return {
        calls,
        set_search(v) {
            next_search = v;
        },
        set_get(v) {
            next_get = v;
        },
        async search_documents(opts) {
            calls.push({ method: 'search', opts });
            return next_search;
        },
        async get_document(pid) {
            calls.push({ method: 'get', pid });
            return next_get;
        },
    };
}

const make_thumbnail_url = (pid) => `/repo/api/v1/objects/${pid}/thumbnail`;

describe('api/model — build_query', () => {
    it('always pins is_published=true (eligibility defense-in-depth)', () => {
        const q = model_module.build_query({});
        expect(q.bool.filter).toContainEqual({ term: { is_published: true } });
    });

    it('returns match_all when no q is given', () => {
        const q = model_module.build_query({});
        expect(q.bool.must).toEqual([{ match_all: {} }]);
    });

    it('builds a multi_match against title/abstract/subjects when q present', () => {
        const q = model_module.build_query({ q: 'tuberculosis' });
        expect(q.bool.must[0]).toEqual({
            multi_match: {
                query: 'tuberculosis',
                fields: ['title^3', 'abstract', 'subjects'],
                type: 'best_fields',
            },
        });
    });

    it('rejects an overly long q', () => {
        expect(() => model_module.build_query({ q: 'x'.repeat(201) })).toThrow(ValidationError);
    });

    it('accepts a single collection as a string', () => {
        const cid = randomUUID();
        const q = model_module.build_query({ collection: cid });
        expect(q.bool.filter).toContainEqual({
            terms: { is_member_of_collection: [cid] },
        });
    });

    it('accepts multiple collections as an array', () => {
        const a = randomUUID();
        const b = randomUUID();
        const q = model_module.build_query({ collection: [a, b] });
        expect(q.bool.filter).toContainEqual({
            terms: { is_member_of_collection: [a, b] },
        });
    });

    it('rejects non-UUID collection ids', () => {
        expect(() => model_module.build_query({ collection: 'not-a-uuid' })).toThrow(
            ValidationError
        );
    });

    it('filters by object_type from the closed set', () => {
        const q = model_module.build_query({ object_type: 'collection' });
        expect(q.bool.filter).toContainEqual({ term: { object_type: 'collection' } });
    });

    it('rejects unknown object_type values', () => {
        expect(() => model_module.build_query({ object_type: 'video' })).toThrow(ValidationError);
    });

    it('builds a terms filter on subjects (OR semantics)', () => {
        const q = model_module.build_query({ subject: ['Photography', 'Tuberculosis'] });
        expect(q.bool.filter).toContainEqual({
            terms: { subjects: ['Photography', 'Tuberculosis'] },
        });
    });

    it('rejects >50 subject filters', () => {
        const huge = Array.from({ length: 51 }, (_, i) => `s${i}`);
        expect(() => model_module.build_query({ subject: huge })).toThrow(ValidationError);
    });

    it('builds a boolean filter on is_compound', () => {
        const yes = model_module.build_query({ is_compound: 'true' });
        expect(yes.bool.filter).toContainEqual({ term: { is_compound: true } });
        const no = model_module.build_query({ is_compound: 'false' });
        expect(no.bool.filter).toContainEqual({ term: { is_compound: false } });
    });

    it('rejects non-boolean is_compound values', () => {
        expect(() => model_module.build_query({ is_compound: 'yes' })).toThrow(ValidationError);
    });

    it('ignores empty-string filter params (treated as absent)', () => {
        const q = model_module.build_query({
            object_type: '',
            is_compound: '',
            collection: '',
        });
        // Only the always-present eligibility filter.
        expect(q.bool.filter).toEqual([{ term: { is_published: true } }]);
    });
});

describe('api/model — build_sort', () => {
    it('returns undefined for relevance (ES default)', () => {
        expect(model_module.build_sort('relevance')).toBeUndefined();
        expect(model_module.build_sort()).toBeUndefined();
    });

    it('sorts on title.keyword for sort=title', () => {
        expect(model_module.build_sort('title')).toEqual([{ 'title.keyword': 'asc' }]);
    });

    it('sorts on created for created_desc / created_asc', () => {
        expect(model_module.build_sort('created_desc')).toEqual([{ created: 'desc' }]);
        expect(model_module.build_sort('created_asc')).toEqual([{ created: 'asc' }]);
    });

    it('rejects unknown sort keys', () => {
        expect(() => model_module.build_sort('random')).toThrow(ValidationError);
    });
});

describe('api/model — project_to_public', () => {
    const doc = {
        pid: 'p1',
        title: 'Hello',
        abstract: 'World',
        handle: 'https://hdl/x',
        uri: '/r/1',
        object_type: 'object',
        mime_type: 'image/tiff',
        is_compound: true,
        is_member_of_collection: 'col-1',
        subjects: ['A', 'B'],
        created: '2024-01-01',
        thumbnail: 'archivematica/foo.jpg',
        sip_uuid: 'OPERATIONAL_LEAK_SHOULD_NOT_SHOW',
        display_record: { title: 'deep' },
    };

    it('produces a list-shaped projection (no display_record)', () => {
        const out = model_module.project_to_public(doc, 'list', make_thumbnail_url);
        expect(out.pid).toBe('p1');
        expect(out.thumbnail_url).toBe('/repo/api/v1/objects/p1/thumbnail');
        expect(out.display_record).toBeUndefined();
    });

    it('produces a detail-shaped projection (with display_record)', () => {
        const out = model_module.project_to_public(doc, 'detail', make_thumbnail_url);
        expect(out.display_record).toEqual({ title: 'deep' });
    });

    it('NEVER includes sip_uuid (operational metadata)', () => {
        const list = model_module.project_to_public(doc, 'list', make_thumbnail_url);
        const detail = model_module.project_to_public(doc, 'detail', make_thumbnail_url);
        expect(list.sip_uuid).toBeUndefined();
        expect(detail.sip_uuid).toBeUndefined();
    });

    it('returns null when the source doc is null/undefined', () => {
        expect(model_module.project_to_public(null, 'list', make_thumbnail_url)).toBeNull();
        expect(model_module.project_to_public(undefined, 'detail', make_thumbnail_url)).toBeNull();
    });

    it('normalizes missing subjects to an empty array', () => {
        const out = model_module.project_to_public(
            { pid: 'p', subjects: undefined },
            'list',
            make_thumbnail_url
        );
        expect(out.subjects).toEqual([]);
    });
});

describe('api/model — model surface (search/get/list/eligible)', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.APP_PATH = '/repo';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    it('search: paginates, calls ES with from/size, returns projected items', async () => {
        const es = make_fake_es();
        es.set_search({
            total: 42,
            hits: [
                { pid: 'p1', body: { pid: 'p1', title: 'one' } },
                { pid: 'p2', body: { pid: 'p2', title: 'two' } },
            ],
        });
        const m = model_module.create_model({ es });
        const r = await m.search({ q: 'foo', page: '2', page_size: '10' }, { make_thumbnail_url });
        expect(r.page).toBe(2);
        expect(r.page_size).toBe(10);
        expect(r.total).toBe(42);
        expect(r.items).toHaveLength(2);
        expect(r.items[0].pid).toBe('p1');
        expect(r.items[0].thumbnail_url).toBe('/repo/api/v1/objects/p1/thumbnail');
        // ES called with from=(page-1)*size=10
        expect(es.calls[0].opts.from).toBe(10);
        expect(es.calls[0].opts.size).toBe(10);
        // display_record excluded from search hits.
        expect(es.calls[0].opts.source).toEqual({ excludes: ['display_record'] });
    });

    it('search: page_size capped at 100', async () => {
        const es = make_fake_es();
        const m = model_module.create_model({ es });
        await m.search({ page_size: '999' }, { make_thumbnail_url });
        expect(es.calls[0].opts.size).toBe(100);
    });

    it('get: returns detail projection when doc has is_published=true', async () => {
        const pid = randomUUID();
        const es = make_fake_es();
        es.set_get({ pid, title: 'X', is_published: true });
        const m = model_module.create_model({ es });
        const r = await m.get(pid, { make_thumbnail_url });
        expect(r.pid).toBe(pid);
        expect(r.title).toBe('X');
    });

    it('get: returns null when doc.is_published is not true (defense in depth)', async () => {
        const pid = randomUUID();
        const es = make_fake_es();
        es.set_get({ pid, title: 'X', is_published: false });
        const m = model_module.create_model({ es });
        const r = await m.get(pid, { make_thumbnail_url });
        expect(r).toBeNull();
    });

    it('get: returns null for a 404 from ES', async () => {
        const pid = randomUUID();
        const es = make_fake_es();
        es.set_get(null);
        const m = model_module.create_model({ es });
        const r = await m.get(pid, { make_thumbnail_url });
        expect(r).toBeNull();
    });

    it('get: rejects non-UUID pids', async () => {
        const m = model_module.create_model({ es: make_fake_es() });
        await expect(m.get('not-a-uuid', { make_thumbnail_url })).rejects.toBeInstanceOf(
            ValidationError
        );
    });

    it('list_collections: filters object_type=collection + sorts by title', async () => {
        const es = make_fake_es();
        es.set_search({ total: 0, hits: [] });
        const m = model_module.create_model({ es });
        await m.list_collections({}, { make_thumbnail_url });
        const opts = es.calls[0].opts;
        expect(opts.query.bool.filter).toContainEqual({
            term: { object_type: 'collection' },
        });
        expect(opts.query.bool.filter).toContainEqual({ term: { is_published: true } });
        expect(opts.sort).toEqual([{ 'title.keyword': 'asc' }]);
    });

    it('is_eligible: true iff doc.is_published is strictly true', async () => {
        const pid = randomUUID();
        const es = make_fake_es();
        const m = model_module.create_model({ es });
        es.set_get({ pid, is_published: true });
        expect(await m.is_eligible(pid)).toBe(true);
        es.set_get({ pid, is_published: false });
        expect(await m.is_eligible(pid)).toBe(false);
        es.set_get(null);
        expect(await m.is_eligible(pid)).toBe(false);
    });

    it('is_eligible: false on malformed pid (no ES round-trip)', async () => {
        const es = make_fake_es();
        const m = model_module.create_model({ es });
        const r = await m.is_eligible('not-a-uuid');
        expect(r).toBe(false);
        expect(es.calls).toHaveLength(0);
    });
});
