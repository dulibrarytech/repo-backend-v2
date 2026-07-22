'use strict';

/*
 * Unit tests for api/model.js. The query builder + result projection
 * are pure functions, so most tests are direct calls without any
 * fake-ES setup. The integration of those pieces through the model
 * surface uses a tiny fake ES client that records calls + returns
 * scripted responses.
 */

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
    it('always pins is_published=1 (eligibility defense-in-depth)', () => {
        const q = model_module.build_query({});
        expect(q.bool.filter).toContainEqual({ term: { is_published: 1 } });
    });

    it('returns match_all when no q is given', () => {
        const q = model_module.build_query({});
        expect(q.bool.must).toEqual([{ match_all: {} }]);
    });

    it('builds a multi_match against title/abstract/f_subjects when q present', () => {
        const q = model_module.build_query({ q: 'tuberculosis' });
        expect(q.bool.must[0]).toEqual({
            multi_match: {
                query: 'tuberculosis',
                fields: ['title^3', 'abstract', 'f_subjects'],
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

    it('builds a terms filter on f_subjects.keyword (OR semantics)', () => {
        const q = model_module.build_query({ subject: ['Photography', 'Tuberculosis'] });
        expect(q.bool.filter).toContainEqual({
            terms: { 'f_subjects.keyword': ['Photography', 'Tuberculosis'] },
        });
    });

    it('rejects >50 subject filters', () => {
        const huge = Array.from({ length: 51 }, (_, i) => `s${i}`);
        expect(() => model_module.build_query({ subject: huge })).toThrow(ValidationError);
    });

    it('builds an integer (0/1) filter on is_compound', () => {
        const yes = model_module.build_query({ is_compound: 'true' });
        expect(yes.bool.filter).toContainEqual({ term: { is_compound: 1 } });
        const no = model_module.build_query({ is_compound: 'false' });
        expect(no.bool.filter).toContainEqual({ term: { is_compound: 0 } });
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
        expect(q.bool.filter).toEqual([{ term: { is_published: 1 } }]);
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
    /*
     * New 2-level index shape: denormalized fields top-level, raw ASpace
     * record (with uri) under display_record.
     */
    const doc = {
        pid: 'p1',
        title: 'Hello',
        creator: 'Doe, Jane',
        abstract: 'World',
        handle: 'https://hdl/x',
        object_type: 'object',
        mime_type: 'image/tiff',
        type: 'still image',
        is_compound: 1,
        is_member_of_collection: 'col-1',
        f_subjects: ['A', 'B'],
        object: 'dip/objects/x.tif',
        thumbnail: 'archivematica/foo.jpg',
        sip_uuid: 'OPERATIONAL_LEAK_SHOULD_NOT_SHOW',
        display_record: { title: 'deep', uri: '/r/1' },
    };

    it('mirrors the index field names (creator/f_subjects/type/object) and booleanizes is_compound', () => {
        const out = model_module.project_to_public(doc, 'detail', make_thumbnail_url);
        expect(out.pid).toBe('p1');
        expect(out.creator).toBe('Doe, Jane');
        expect(out.f_subjects).toEqual(['A', 'B']);
        expect(out.type).toBe('still image');
        expect(out.object).toBe('dip/objects/x.tif');
        // index stores integer 1/0; the API exposes a JS boolean.
        expect(out.is_compound).toBe(true);
        expect(out.thumbnail_url).toBe('/repo/api/v1/objects/p1/thumbnail');
    });

    it('produces a list-shaped projection (no display_record envelope)', () => {
        const out = model_module.project_to_public(doc, 'list', make_thumbnail_url);
        expect(out.display_record).toBeUndefined();
        // top-level facet field is still present in the slim form.
        expect(out.f_subjects).toEqual(['A', 'B']);
    });

    it('produces a detail-shaped projection with the raw record + uri sourced from it', () => {
        const out = model_module.project_to_public(doc, 'detail', make_thumbnail_url);
        expect(out.display_record).toEqual({ title: 'deep', uri: '/r/1' });
        // uri lives inside display_record now; surfaced on the detail endpoint.
        expect(out.uri).toBe('/r/1');
    });

    it('returns uri=null on a slim list doc (display_record excluded from _source)', () => {
        const slim = { pid: 'p', f_subjects: [] };
        const out = model_module.project_to_public(slim, 'list', make_thumbnail_url);
        expect(out.uri).toBeNull();
    });

    it('surfaces a Kaltura entry_id only when present', () => {
        const withId = model_module.project_to_public(
            { ...doc, entry_id: 'kalt-1' },
            'list',
            make_thumbnail_url
        );
        expect(withId.entry_id).toBe('kalt-1');
        expect('entry_id' in model_module.project_to_public(doc, 'list', make_thumbnail_url)).toBe(
            false
        );
    });

    it('handles the stripped collection shape (no object-only fields)', () => {
        const coll = {
            pid: 'c1',
            object_type: 'collection',
            title: 'Coll',
            abstract: 'A',
            handle: 'h',
            is_published: 1,
            is_member_of_collection: 'root',
            display_record: { title: 'Coll', abstract: 'A' },
        };
        const out = model_module.project_to_public(coll, 'detail', make_thumbnail_url);
        expect(out.object_type).toBe('collection');
        expect(out.creator).toBeNull();
        expect(out.type).toBeNull();
        expect(out.object).toBeNull();
        expect(out.f_subjects).toEqual([]);
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

    it('normalizes missing f_subjects to an empty array', () => {
        const out = model_module.project_to_public(
            { pid: 'p', f_subjects: undefined },
            'list',
            make_thumbnail_url
        );
        expect(out.f_subjects).toEqual([]);
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

    it('get: returns detail projection when doc has is_published=1', async () => {
        const pid = randomUUID();
        const es = make_fake_es();
        es.set_get({ pid, title: 'X', is_published: 1 });
        const m = model_module.create_model({ es });
        const r = await m.get(pid, { make_thumbnail_url });
        expect(r.pid).toBe(pid);
        expect(r.title).toBe('X');
    });

    it('get: returns null when doc is not published (is_published=0, defense in depth)', async () => {
        const pid = randomUUID();
        const es = make_fake_es();
        es.set_get({ pid, title: 'X', is_published: 0 });
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
        expect(opts.query.bool.filter).toContainEqual({ term: { is_published: 1 } });
        expect(opts.sort).toEqual([{ 'title.keyword': 'asc' }]);
    });

    it('is_eligible: true iff doc.is_published is truthy (integer 1)', async () => {
        const pid = randomUUID();
        const es = make_fake_es();
        const m = model_module.create_model({ es });
        es.set_get({ pid, is_published: 1 });
        expect(await m.is_eligible(pid)).toBe(true);
        es.set_get({ pid, is_published: 0 });
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
