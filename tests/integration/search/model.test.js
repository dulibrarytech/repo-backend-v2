'use strict';

const { randomUUID } = require('node:crypto');
const search_model = require('../../../search/model');
const db_helper = require('../../helpers/db');

describe('search/model — DB integration', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('returns empty result set when table is empty', async () => {
        const r = await search_model.search({ q: 'whatever' });
        expect(r.total).toBe(0);
        expect(r.items).toEqual([]);
    });

    it('searches by file_name substring (case-insensitive)', async () => {
        await db_helper.seed_object({ file_name: 'photo-001.jpg' });
        await db_helper.seed_object({ file_name: 'photo-002.jpg' });
        await db_helper.seed_object({ file_name: 'document.pdf' });
        const lower = await search_model.search({ q: 'photo' });
        expect(lower.total).toBe(2);
        const upper = await search_model.search({ q: 'PHOTO' });
        expect(upper.total).toBe(2);
    });

    it('matches against pid (UUID)', async () => {
        const pid = '11111111-2222-3333-4444-555555555555';
        await db_helper.seed_object({ pid });
        await db_helper.seed_object();
        // Search by partial UUID
        const r = await search_model.search({ q: '1111-2222' });
        expect(r.total).toBe(1);
        expect(r.items[0].pid).toBe(pid);
    });

    it('matches against handle', async () => {
        const pid = randomUUID();
        await db_helper.seed_object({ pid, handle: `https://hdl.invalid/codu/${pid}` });
        const r = await search_model.search({ q: 'codu/' });
        expect(r.total).toBe(1);
    });

    it('matches against is_member_of_collection', async () => {
        await db_helper.seed_object({ is_member_of_collection: 'codu:photos' });
        await db_helper.seed_object({ is_member_of_collection: 'codu:texts' });
        const r = await search_model.search({ q: 'photos' });
        expect(r.total).toBe(1);
    });

    it('not_member_of_collection + exclude_collections scope the add-objects picker', async () => {
        // Eligible: an active object not already in the target collection.
        const eligible = await db_helper.seed_object({ is_member_of_collection: 'codu:root' });
        // Excluded: already a member of the target collection.
        await db_helper.seed_object({ is_member_of_collection: 'codu:target' });
        // Excluded: a collection row (can't be a member).
        await db_helper.seed_object({
            object_type: 'collection',
            is_member_of_collection: 'codu:root',
        });
        const r = await search_model.search({
            is_active: true,
            exclude_collections: true,
            not_member_of_collection: 'codu:target',
        });
        expect(r.total).toBe(1);
        expect(r.items[0].pid).toBe(eligible.pid);
    });

    it('matches text stored only in display_record (title + descriptive metadata)', async () => {
        /*
         * The title lives ONLY in the display_record JSON envelope —
         * there's no dedicated title column. Searching it is the whole
         * point of including display_record in SEARCHABLE_COLUMNS.
         */
        await db_helper.seed_object({
            file_name: 'unrelated.dat',
            handle: 'https://hdl.invalid/x',
            is_member_of_collection: 'codu:misc',
            display_record: JSON.stringify({
                title: 'A photo of the quad',
                abstract: 'springtime',
            }),
        });
        const r = await search_model.search({ q: 'photo' });
        expect(r.total).toBe(1);
    });

    it('finds a title by plural query (singularization): "Former patients" → "Former patient ..."', async () => {
        /*
         * The exact scenario reported by staff: searching the plural
         * "patients" must surface a record titled "Former patient ...".
         */
        await db_helper.seed_object({
            display_record: JSON.stringify({
                title: 'Former patient in Ford county sanatorium, 1938',
            }),
        });
        await db_helper.seed_object({
            display_record: JSON.stringify({ title: 'Unrelated landscape' }),
        });
        const r = await search_model.search({ q: 'Former patients' });
        expect(r.total).toBe(1);
        const enriched = require('../../../libs/object_projection').enrich(r.items[0]);
        expect(enriched.title).toMatch(/^Former patient in Ford county/);
    });

    it('ANDs multi-word queries across the whole display_record, order-independent', async () => {
        await db_helper.seed_object({
            display_record: JSON.stringify({
                title: 'Former patient in Ford county sanatorium',
            }),
        });
        // Both tokens present (out of order) → match.
        const hit = await search_model.search({ q: 'county Former' });
        expect(hit.total).toBe(1);
        // One token absent → no match (AND semantics, not OR).
        const miss = await search_model.search({ q: 'Former zebra' });
        expect(miss.total).toBe(0);
    });

    it('searches descriptive metadata beyond the title (subjects, names, dates)', async () => {
        await db_helper.seed_object({
            display_record: JSON.stringify({
                title: 'Untitled photograph',
                f_subjects: ['Tuberculosis', 'Public health'],
                display_record: { dates: [{ expression: '1938' }] },
            }),
        });
        expect((await search_model.search({ q: 'tuberculosis' })).total).toBe(1);
        expect((await search_model.search({ q: '1938' })).total).toBe(1);
    });

    it('respects the is_published filter alongside q', async () => {
        await db_helper.seed_object({ file_name: 'photo-a.jpg', is_published: 1 });
        await db_helper.seed_object({ file_name: 'photo-b.jpg', is_published: 0 });
        const r = await search_model.search({ q: 'photo', is_published: true });
        expect(r.total).toBe(1);
        expect(r.items[0].is_published).toBe(1);
    });

    it('paginates correctly', async () => {
        for (let i = 0; i < 5; i++) {
            await db_helper.seed_object({ file_name: `photo-${i}.jpg` });
        }
        const p1 = await search_model.search({ q: 'photo', page: 1, page_size: 2 });
        expect(p1.total).toBe(5);
        expect(p1.items).toHaveLength(2);
        const p3 = await search_model.search({ q: 'photo', page: 3, page_size: 2 });
        expect(p3.items).toHaveLength(1);
    });

    it('does not match underscore as a wildcard (LIKE-escape)', async () => {
        await db_helper.seed_object({ file_name: 'aXb.jpg' });
        await db_helper.seed_object({ file_name: 'aZb.jpg' });
        /*
         * q='a_b' with LIKE wildcard semantics would match both;
         * our escape turns it into a literal underscore match — neither.
         */
        const r = await search_model.search({ q: 'a_b' });
        expect(r.total).toBe(0);
    });

    it('hides soft-deleted rows by default', async () => {
        await db_helper.seed_object({ file_name: 'visible.jpg' });
        await db_helper.seed_object({ file_name: 'gone.jpg', is_active: 0 });
        const r = await search_model.search({});
        expect(r.total).toBe(1);
        expect(r.items[0].file_name).toBe('visible.jpg');
    });

    it('quick_lookup short-circuits on UUID exact match', async () => {
        const pid = randomUUID();
        await db_helper.seed_object({ pid });
        const r = await search_model.quick_lookup(pid);
        expect(r).toHaveLength(1);
        expect(r[0].pid).toBe(pid);
    });

    it('quick_lookup ignores too-short queries (< 3 chars)', async () => {
        expect(await search_model.quick_lookup('a')).toEqual([]);
    });
});
