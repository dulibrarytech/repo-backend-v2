'use strict';

const { randomUUID } = require('node:crypto');

const collections_model = require('../../../collections/model');
const db_helper = require('../../helpers/db');
const { NotFoundError, ValidationError } = require('../../../libs/errors');

function dr(title, extra = {}) {
    return JSON.stringify({ title, thumbnail: `tn-${title}`, ...extra });
}

describe('collections/model — DB integration', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('list_collections()', () => {
        it('returns nothing when no collections exist', async () => {
            const r = await collections_model.list_collections();
            expect(r.total).toBe(0);
            expect(r.items).toEqual([]);
        });

        it('lists only object_type=collection rows', async () => {
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Collection One'),
            });
            await db_helper.seed_object({ object_type: 'object' });
            const r = await collections_model.list_collections();
            expect(r.total).toBe(1);
            expect(r.items[0].title).toBe('Collection One');
        });

        it('enriches each collection with member counts', async () => {
            const a = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('A'),
            });
            await db_helper.seed_object({
                is_member_of_collection: a.pid,
                is_published: 1,
            });
            await db_helper.seed_object({
                is_member_of_collection: a.pid,
                is_published: 0,
            });
            await db_helper.seed_object({
                is_member_of_collection: a.pid,
                is_active: 0, // soft-deleted — should not count
            });

            const r = await collections_model.list_collections();
            const got = r.items.find((c) => c.title === 'A');
            expect(got.member_count).toBe(2);
            expect(got.published_count).toBe(1);
        });

        it('sorts by member count desc by default', async () => {
            const big = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Big'),
            });
            const small = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Small'),
            });
            for (let i = 0; i < 5; i++) {
                await db_helper.seed_object({ is_member_of_collection: big.pid });
            }
            await db_helper.seed_object({ is_member_of_collection: small.pid });
            const r = await collections_model.list_collections();
            expect(r.items.map((c) => c.title)).toEqual(['Big', 'Small']);
        });

        it('sort=title orders alphabetically', async () => {
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Zoo'),
            });
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Apples'),
            });
            const r = await collections_model.list_collections({ sort: 'title' });
            expect(r.items.map((c) => c.title)).toEqual(['Apples', 'Zoo']);
        });

        it('filters by q (substring on title, case-insensitive)', async () => {
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Jewish Consumptives Relief Society'),
            });
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Clarion Newspaper'),
            });
            const r = await collections_model.list_collections({ q: 'JEWISH' });
            expect(r.total).toBe(1);
            expect(r.items[0].title).toContain('Jewish');
        });

        it('paginates correctly', async () => {
            for (let i = 0; i < 5; i++) {
                await db_helper.seed_object({
                    object_type: 'collection',
                    display_record: dr(`C${i}`),
                });
            }
            const p1 = await collections_model.list_collections({ page: 1, page_size: 2 });
            expect(p1.total).toBe(5);
            expect(p1.items).toHaveLength(2);
            const p3 = await collections_model.list_collections({ page: 3, page_size: 2 });
            expect(p3.items).toHaveLength(1);
        });

        it('rejects too-long q', async () => {
            await expect(
                collections_model.list_collections({ q: 'a'.repeat(500) })
            ).rejects.toBeInstanceOf(ValidationError);
        });

        it('skips soft-deleted collections', async () => {
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Alive'),
            });
            await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Dead'),
                is_active: 0,
            });
            const r = await collections_model.list_collections();
            expect(r.items.map((c) => c.title)).toEqual(['Alive']);
        });
    });

    describe('get_collection()', () => {
        it('returns the parsed collection with counts', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('JCRS', { handle: 'https://hdl/x' }),
            });
            for (let i = 0; i < 3; i++) {
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                    is_published: i % 2,
                });
            }
            const got = await collections_model.get_collection(c.pid);
            expect(got.title).toBe('JCRS');
            expect(got.handle).toBe('https://hdl/x');
            expect(got.member_count).toBe(3);
            expect(got.published_count).toBe(1);
        });

        it('throws NotFoundError when pid does not exist', async () => {
            await expect(collections_model.get_collection(randomUUID())).rejects.toBeInstanceOf(
                NotFoundError
            );
        });

        it('throws NotFoundError for an object that is not a collection', async () => {
            const obj = await db_helper.seed_object({ object_type: 'object' });
            await expect(collections_model.get_collection(obj.pid)).rejects.toBeInstanceOf(
                NotFoundError
            );
        });

        it('rejects malformed pid', async () => {
            await expect(collections_model.get_collection('not-a-uuid')).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });

    describe('members()', () => {
        it('returns member objects paginated', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('C'),
            });
            for (let i = 0; i < 4; i++) {
                await db_helper.seed_object({
                    is_member_of_collection: c.pid,
                });
            }
            // Also seed a sibling collection's object — must not bleed in.
            const other = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Other'),
            });
            await db_helper.seed_object({ is_member_of_collection: other.pid });

            const r = await collections_model.members(c.pid, { page_size: 10 });
            expect(r.total).toBe(4);
            expect(r.items).toHaveLength(4);
        });

        it('forwards is_published filter to the member query', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('C'),
            });
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_published: 1,
            });
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_published: 0,
            });
            const r = await collections_model.members(c.pid, { is_published: true });
            expect(r.total).toBe(1);
        });

        it('rejects bad collection pid', async () => {
            await expect(collections_model.members('bad')).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('publish_members / suppress_members (scope-based bulk)', () => {
        async function seed_collection_with_members({
            active_count = 3,
            nested_collection = false,
        }) {
            const collection = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent Collection'),
            });
            for (let i = 0; i < active_count; i++) {
                await db_helper.seed_object({
                    is_member_of_collection: collection.pid,
                    is_published: 0,
                    is_active: 1,
                });
            }
            // A soft-deleted member that should never be touched.
            await db_helper.seed_object({
                is_member_of_collection: collection.pid,
                is_published: 0,
                is_active: 0,
            });
            // A nested sub-collection — the scope action should leave
            // its own publish state alone (members-only).
            if (nested_collection) {
                await db_helper.seed_object({
                    is_member_of_collection: collection.pid,
                    object_type: 'collection',
                    is_published: 0,
                });
            }
            return collection;
        }

        it('publish_members flips every active non-collection member', async () => {
            const c = await seed_collection_with_members({ active_count: 4 });
            const result = await collections_model.publish_members(c.pid);
            expect(result.affected).toBe(4);
        });

        it('publish_members skips soft-deleted members', async () => {
            const c = await seed_collection_with_members({ active_count: 2 });
            const result = await collections_model.publish_members(c.pid);
            // 2 active + 0 (the inactive one) = 2
            expect(result.affected).toBe(2);
        });

        it('publish_members does not flip nested collection rows', async () => {
            const c = await seed_collection_with_members({
                active_count: 2,
                nested_collection: true,
            });
            const result = await collections_model.publish_members(c.pid);
            // 2 active objects affected, the sub-collection is NOT.
            expect(result.affected).toBe(2);
        });

        it('suppress_members is symmetric', async () => {
            const c = await seed_collection_with_members({ active_count: 3 });
            await collections_model.publish_members(c.pid);
            const result = await collections_model.suppress_members(c.pid);
            expect(result.affected).toBe(3);
        });

        it('returns affected=0 for a collection with no members', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Empty'),
            });
            const result = await collections_model.publish_members(c.pid);
            expect(result.affected).toBe(0);
        });

        it('throws NotFoundError when the collection pid does not exist', async () => {
            await expect(collections_model.publish_members(randomUUID())).rejects.toBeInstanceOf(
                NotFoundError
            );
        });

        it('rejects bad pid format', async () => {
            await expect(collections_model.publish_members('not-a-uuid')).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });
});
