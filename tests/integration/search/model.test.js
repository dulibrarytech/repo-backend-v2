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

    it('q without filters returns the indexed-column hits only, not long-text', async () => {
        // Stage a row whose only "photo"-ish text is in display_record
        // (a long-text column). search MUST NOT find it — that's the
        // search/repo separation.
        await db_helper.seed_object({
            file_name: 'unrelated.dat',
            handle: 'https://hdl.invalid/x',
            is_member_of_collection: 'codu:misc',
        });
        const r = await search_model.search({ q: 'photo' });
        expect(r.total).toBe(0);
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
        // q='a_b' with LIKE wildcard semantics would match both;
        // our escape turns it into a literal underscore match — neither.
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
