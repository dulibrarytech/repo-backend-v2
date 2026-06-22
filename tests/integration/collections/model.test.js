'use strict';

const { randomUUID } = require('node:crypto');

const collections_model = require('../../../collections/model');
const db_helper = require('../../helpers/db');
const { db } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { NotFoundError, ValidationError, ConflictError } = require('../../../libs/errors');

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

        it('excludes nested sub-collections (members are objects, matches member_count)', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent'),
            });
            await db_helper.seed_object({ is_member_of_collection: c.pid });
            await db_helper.seed_object({ is_member_of_collection: c.pid });
            // A nested sub-collection — must not show up among member objects.
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                object_type: 'collection',
                display_record: dr('Child'),
            });
            const r = await collections_model.members(c.pid, { page_size: 10 });
            expect(r.total).toBe(2);
            expect(r.items.every((o) => o.object_type !== 'collection')).toBe(true);
            // Agrees with the collection's own member_count.
            const got = await collections_model.get_collection(c.pid);
            expect(got.member_count).toBe(r.total);
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

    describe('get_collection() — nested sub-collections', () => {
        it('excludes nested sub-collections from member_count', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent'),
            });
            // Two real member objects.
            await db_helper.seed_object({ is_member_of_collection: parent.pid });
            await db_helper.seed_object({ is_member_of_collection: parent.pid });
            // A nested sub-collection — counts in its own section, NOT as a
            // member object.
            await db_helper.seed_object({
                is_member_of_collection: parent.pid,
                object_type: 'collection',
                display_record: dr('Child'),
            });
            const got = await collections_model.get_collection(parent.pid);
            expect(got.member_count).toBe(2);
        });
    });

    describe('sub_collections()', () => {
        it('returns [] when the collection has no children', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Lonely'),
            });
            await db_helper.seed_object({ is_member_of_collection: c.pid });
            const subs = await collections_model.sub_collections(c.pid);
            expect(subs).toEqual([]);
        });

        it('returns nested collections enriched with member counts, sorted by title', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent'),
            });
            const zoo = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Zoo'),
            });
            const apples = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Apples'),
            });
            // Give 'Apples' two members (one published) to verify counts.
            await db_helper.seed_object({
                is_member_of_collection: apples.pid,
                is_published: 1,
            });
            await db_helper.seed_object({
                is_member_of_collection: apples.pid,
                is_published: 0,
            });
            // A plain object member of the parent — must NOT appear as a sub.
            await db_helper.seed_object({ is_member_of_collection: parent.pid });

            const subs = await collections_model.sub_collections(parent.pid);
            expect(subs.map((s) => s.title)).toEqual(['Apples', 'Zoo']);
            const a = subs.find((s) => s.title === 'Apples');
            expect(a.pid).toBe(apples.pid);
            expect(a.member_count).toBe(2);
            expect(a.published_count).toBe(1);
            const z = subs.find((s) => s.title === 'Zoo');
            expect(z.pid).toBe(zoo.pid);
            expect(z.member_count).toBe(0);
            // is_empty: Apples has members → not empty; Zoo has none → empty.
            expect(a.is_empty).toBe(false);
            expect(z.is_empty).toBe(true);
        });

        it('flags is_empty=false when a sub holds only a nested sub-collection (no member objects)', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent'),
            });
            const mid = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Mid'),
            });
            // 'Mid' has no member OBJECTS (member_count 0) but DOES have a nested
            // sub-collection, so it must not be reported empty.
            await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: mid.pid,
                display_record: dr('Leaf'),
            });
            const subs = await collections_model.sub_collections(parent.pid);
            const m = subs.find((s) => s.pid === mid.pid);
            expect(m.member_count).toBe(0);
            expect(m.is_empty).toBe(false);
        });

        it('skips soft-deleted sub-collections', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent'),
            });
            await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Alive'),
            });
            await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Dead'),
                is_active: 0,
            });
            const subs = await collections_model.sub_collections(parent.pid);
            expect(subs.map((s) => s.title)).toEqual(['Alive']);
        });

        it('rejects bad pid format', async () => {
            await expect(collections_model.sub_collections('nope')).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });

    describe('titles_by_pids()', () => {
        it('maps collection PIDs to their titles in one call', async () => {
            const a = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Alpha Collection'),
            });
            const b = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Beta Collection'),
            });
            const map = await collections_model.titles_by_pids([a.pid, b.pid]);
            expect(map.get(a.pid)).toBe('Alpha Collection');
            expect(map.get(b.pid)).toBe('Beta Collection');
        });

        it('omits non-collection pids, unknown pids, and empty/blank values', async () => {
            const coll = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Real Collection'),
            });
            const obj = await db_helper.seed_object({ object_type: 'object' });
            const map = await collections_model.titles_by_pids([
                coll.pid,
                obj.pid, // an object, not a collection → absent
                randomUUID(), // unknown → absent
                '', // no-collection sentinel → filtered out
            ]);
            expect(map.get(coll.pid)).toBe('Real Collection');
            expect(map.has(obj.pid)).toBe(false);
            expect(map.size).toBe(1);
        });

        it('returns an empty map for empty / missing input', async () => {
            expect((await collections_model.titles_by_pids([])).size).toBe(0);
            expect((await collections_model.titles_by_pids()).size).toBe(0);
        });
    });

    describe('add_members() — move existing objects into a collection', () => {
        it('reassigns membership and sets is_updated, returning the count moved', async () => {
            const dest = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Destination'),
            });
            const a = await db_helper.seed_object({ is_member_of_collection: 'codu:root' });
            const b = await db_helper.seed_object({ is_member_of_collection: 'codu:other' });

            const result = await collections_model.add_members(dest.pid, [a.pid, b.pid]);
            expect(result.added).toBe(2);

            const rows = await db()(tables.objects)
                .whereIn('pid', [a.pid, b.pid])
                .select('pid', 'is_member_of_collection', 'is_updated');
            for (const r of rows) {
                expect(r.is_member_of_collection).toBe(dest.pid);
                expect(r.is_updated).toBe(1);
            }
        });

        it('skips soft-deleted rows and collection rows', async () => {
            const dest = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Destination'),
            });
            const ok = await db_helper.seed_object({ is_member_of_collection: 'codu:root' });
            const deleted = await db_helper.seed_object({
                is_member_of_collection: 'codu:root',
                is_active: 0,
            });
            const a_collection = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Cannot be a member'),
            });

            const result = await collections_model.add_members(dest.pid, [
                ok.pid,
                deleted.pid,
                a_collection.pid,
            ]);
            // Only the one active, non-collection object moves.
            expect(result.added).toBe(1);

            const moved = await db()(tables.objects)
                .where({ pid: ok.pid })
                .first('is_member_of_collection');
            expect(moved.is_member_of_collection).toBe(dest.pid);

            // The other collection's membership is untouched.
            const stillColl = await db()(tables.objects)
                .where({ pid: a_collection.pid })
                .first('is_member_of_collection');
            expect(stillColl.is_member_of_collection).not.toBe(dest.pid);
        });

        it('throws ValidationError when no pids are given', async () => {
            const dest = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Destination'),
            });
            await expect(collections_model.add_members(dest.pid, [])).rejects.toBeInstanceOf(
                ValidationError
            );
        });

        it('throws ValidationError for more than 100 pids', async () => {
            const dest = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Destination'),
            });
            const pids = Array.from({ length: 101 }, () => randomUUID());
            await expect(collections_model.add_members(dest.pid, pids)).rejects.toBeInstanceOf(
                ValidationError
            );
        });

        it('throws NotFoundError when the destination is not an active collection', async () => {
            const obj = await db_helper.seed_object({ object_type: 'object' });
            await expect(
                collections_model.add_members(randomUUID(), [obj.pid])
            ).rejects.toBeInstanceOf(NotFoundError);
            // An object PID (not a collection) is also rejected.
            await expect(
                collections_model.add_members(obj.pid, [obj.pid])
            ).rejects.toBeInstanceOf(NotFoundError);
        });

        it('rejects bad collection pid format', async () => {
            await expect(collections_model.add_members('bad', [randomUUID()])).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });

    describe('delete_collection() — soft-delete an empty (sub-)collection', () => {
        it('soft-deletes an empty collection (is_active=0, is_updated=1, delete_id stamped)', async () => {
            const parent = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Parent'),
            });
            const empty = await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent.pid,
                display_record: dr('Empty Child'),
            });

            const result = await collections_model.delete_collection(empty.pid, {
                actor: 'Test User (tuser)',
            });
            expect(result.ok).toBe(true);
            expect(result.pid).toBe(empty.pid);
            expect(result.parent_pid).toBe(parent.pid);

            const row = await db()(tables.objects)
                .where({ pid: empty.pid })
                .first('is_active', 'is_updated', 'delete_id');
            expect(row.is_active).toBe(0);
            expect(row.is_updated).toBe(1);
            expect(row.delete_id).toBeTruthy();

            // It no longer appears among the parent's sub-collections.
            const subs = await collections_model.sub_collections(parent.pid);
            expect(subs.map((s) => s.pid)).not.toContain(empty.pid);
        });

        it('refuses a collection that still has member objects (ConflictError)', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Has Members'),
            });
            await db_helper.seed_object({ is_member_of_collection: c.pid });
            await expect(collections_model.delete_collection(c.pid)).rejects.toBeInstanceOf(
                ConflictError
            );
            // Still active.
            const row = await db()(tables.objects).where({ pid: c.pid }).first('is_active');
            expect(row.is_active).toBe(1);
        });

        it('refuses a collection that still has a nested sub-collection (ConflictError)', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Has Sub'),
            });
            await db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: c.pid,
                display_record: dr('Nested'),
            });
            await expect(collections_model.delete_collection(c.pid)).rejects.toBeInstanceOf(
                ConflictError
            );
        });

        it('ignores soft-deleted children when judging emptiness', async () => {
            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Only Dead Children'),
            });
            // A soft-deleted member doesn't keep the collection "non-empty".
            await db_helper.seed_object({
                is_member_of_collection: c.pid,
                is_active: 0,
            });
            const result = await collections_model.delete_collection(c.pid);
            expect(result.ok).toBe(true);
        });

        it('throws NotFoundError for a missing / non-collection / already-deleted pid', async () => {
            await expect(
                collections_model.delete_collection(randomUUID())
            ).rejects.toBeInstanceOf(NotFoundError);

            const obj = await db_helper.seed_object({ object_type: 'object' });
            await expect(collections_model.delete_collection(obj.pid)).rejects.toBeInstanceOf(
                NotFoundError
            );

            const c = await db_helper.seed_object({
                object_type: 'collection',
                display_record: dr('Gone'),
            });
            await collections_model.delete_collection(c.pid);
            // Second delete: already inactive → NotFound.
            await expect(collections_model.delete_collection(c.pid)).rejects.toBeInstanceOf(
                NotFoundError
            );
        });

        it('rejects bad pid format', async () => {
            await expect(collections_model.delete_collection('nope')).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });

    describe('move_collection() — re-parent an existing collection', () => {
        async function colln(title, parent) {
            return db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent || 'codu:root',
                display_record: dr(title),
            });
        }

        it('nests a top-level collection under a parent (sets is_member_of_collection + is_updated)', async () => {
            const parent = await colln('Parent');
            const child = await colln('Child'); // top-level (codu:root)
            const r = await collections_model.move_collection(child.pid, parent.pid);
            expect(r).toMatchObject({ ok: true, parent_pid: parent.pid, changed: true });

            const row = await db()(tables.objects)
                .where({ pid: child.pid })
                .first('is_member_of_collection', 'is_updated');
            expect(row.is_member_of_collection).toBe(parent.pid);
            expect(row.is_updated).toBe(1);
            // It now shows up under the parent.
            const subs = await collections_model.sub_collections(parent.pid);
            expect(subs.map((s) => s.pid)).toContain(child.pid);
        });

        it('re-parents from one collection to another', async () => {
            const a = await colln('A');
            const b = await colln('B');
            const child = await colln('Child', a.pid);
            await collections_model.move_collection(child.pid, b.pid);
            const row = await db()(tables.objects)
                .where({ pid: child.pid })
                .first('is_member_of_collection');
            expect(row.is_member_of_collection).toBe(b.pid);
        });

        it('moves a sub-collection to the top level when new parent is empty', async () => {
            const parent = await colln('Parent');
            const child = await colln('Child', parent.pid);
            const r = await collections_model.move_collection(child.pid, '');
            expect(r).toMatchObject({ ok: true, parent_pid: '', changed: true });
            const row = await db()(tables.objects)
                .where({ pid: child.pid })
                .first('is_member_of_collection');
            expect(row.is_member_of_collection).toBe('');
        });

        it('rejects making a collection its own parent', async () => {
            const c = await colln('Self');
            await expect(collections_model.move_collection(c.pid, c.pid)).rejects.toBeInstanceOf(
                ValidationError
            );
        });

        it('rejects a cycle (moving a collection under its own descendant)', async () => {
            const a = await colln('A');
            const b = await colln('B', a.pid); // b under a
            const c = await colln('C', b.pid); // c under b (a > b > c)
            // Moving A under C would create a cycle.
            await expect(collections_model.move_collection(a.pid, c.pid)).rejects.toBeInstanceOf(
                ValidationError
            );
        });

        it('throws NotFoundError for a missing collection or missing parent', async () => {
            const c = await colln('C');
            await expect(
                collections_model.move_collection(randomUUID(), c.pid)
            ).rejects.toBeInstanceOf(NotFoundError);
            await expect(
                collections_model.move_collection(c.pid, randomUUID())
            ).rejects.toBeInstanceOf(NotFoundError);
        });

        it('rejects when the target parent is not a collection', async () => {
            const c = await colln('C');
            const obj = await db_helper.seed_object({ object_type: 'object' });
            await expect(
                collections_model.move_collection(c.pid, obj.pid)
            ).rejects.toBeInstanceOf(NotFoundError);
        });

        it('is a no-op (changed:false) when already under that parent', async () => {
            const parent = await colln('Parent');
            const child = await colln('Child', parent.pid);
            const r = await collections_model.move_collection(child.pid, parent.pid);
            expect(r).toMatchObject({ ok: true, changed: false });
        });

        it('rejects bad pid format', async () => {
            await expect(collections_model.move_collection('nope', null)).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });

    describe('eligible_parents()', () => {
        async function colln(title, parent) {
            return db_helper.seed_object({
                object_type: 'collection',
                is_member_of_collection: parent || 'codu:root',
                display_record: dr(title),
            });
        }

        it('excludes the collection itself and all its descendants, sorted by title', async () => {
            const a = await colln('Alpha'); // the one being moved
            const b = await colln('Bravo', a.pid); // descendant
            await colln('Charlie', b.pid); // deeper descendant
            const z = await colln('Zulu'); // unrelated top-level
            const w = await colln('Whiskey'); // unrelated

            const parents = await collections_model.eligible_parents(a.pid);
            const pids = parents.map((p) => p.pid);
            expect(pids).not.toContain(a.pid); // self
            expect(pids).not.toContain(b.pid); // descendant
            expect(pids).toContain(z.pid);
            expect(pids).toContain(w.pid);
            // Sorted by title.
            const titles = parents.map((p) => p.title);
            expect(titles).toEqual([...titles].sort((x, y) => x.localeCompare(y)));
        });

        it('rejects bad pid format', async () => {
            await expect(collections_model.eligible_parents('nope')).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });
});
