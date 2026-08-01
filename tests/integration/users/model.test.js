'use strict';

const user_model = require('../../../users/model');
const db_helper = require('../../helpers/db');
const { db } = require('../../../config/db');
const tables = require('../../../config/db_tables');
const { NotFoundError, ConflictError, ValidationError } = require('../../../libs/errors');

describe('users/model — DB integration', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('round-trips a user via create + get', async () => {
        const created = await user_model.create({
            du_id: 'staff-1',
            email: 'STAFF1@DU.EDU',
            first_name: 'Staff',
            last_name: 'One',
        });
        expect(created.id).toBeGreaterThan(0);
        // email is lowercased on insert
        expect(created.email).toBe('staff1@du.edu');
        expect(created.is_active).toBe(1);

        const fetched = await user_model.get(created.id);
        expect(fetched.du_id).toBe('staff-1');
    });

    it('rejects duplicate du_id with ConflictError', async () => {
        await user_model.create({
            du_id: 'dup',
            email: 'a@x.com',
            first_name: 'a',
            last_name: 'b',
        });
        await expect(
            user_model.create({
                du_id: 'dup',
                email: 'b@x.com',
                first_name: 'c',
                last_name: 'd',
            })
        ).rejects.toBeInstanceOf(ConflictError);
    });

    it('list returns only active users by default', async () => {
        const a = await user_model.create({
            du_id: 'a',
            email: 'a@x.com',
            first_name: 'a',
            last_name: 'a',
        });
        await user_model.create({
            du_id: 'b',
            email: 'b@x.com',
            first_name: 'b',
            last_name: 'b',
        });
        await user_model.soft_delete(a.id);

        const active = await user_model.list();
        expect(active).toHaveLength(1);
        expect(active[0].du_id).toBe('b');

        const all = await user_model.list({ include_inactive: true });
        expect(all).toHaveLength(2);
    });

    it('update modifies fields and bumps email casing', async () => {
        const u = await user_model.create({
            du_id: 'u',
            email: 'u@x.com',
            first_name: 'U',
            last_name: 'X',
        });
        const updated = await user_model.update(u.id, {
            email: 'NEW@X.COM',
            last_name: 'Y',
        });
        expect(updated.email).toBe('new@x.com');
        expect(updated.last_name).toBe('Y');
        expect(updated.first_name).toBe('U');
    });

    it('get(id) throws NotFoundError when row absent', async () => {
        await expect(user_model.get(9999)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('soft_delete makes the user invisible to list() but get() still finds them', async () => {
        const u = await user_model.create({
            du_id: 'sd',
            email: 'sd@x.com',
            first_name: 's',
            last_name: 'd',
        });
        await user_model.soft_delete(u.id);
        const found = await user_model.get(u.id);
        expect(found.is_active).toBe(0);
        const list = await user_model.list();
        expect(list.find((x) => x.id === u.id)).toBeUndefined();
    });

    it('activate flips is_active back to 1', async () => {
        const u = await user_model.create({
            du_id: 'reactivated',
            email: 'r@x.com',
            first_name: 'R',
            last_name: 'A',
        });
        await user_model.soft_delete(u.id);
        const after_delete = await user_model.get(u.id);
        expect(after_delete.is_active).toBe(0);

        const reactivated = await user_model.activate(u.id);
        expect(reactivated.is_active).toBe(1);
        // The user should now reappear in the default list().
        const list = await user_model.list();
        expect(list.find((x) => x.id === u.id)).toBeTruthy();
    });

    it('activate(id) on an unknown id throws NotFoundError', async () => {
        await expect(user_model.activate(9999)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('get_by_du_id returns active users only by default', async () => {
        const u = await user_model.create({
            du_id: 'lookup',
            email: 'l@x.com',
            first_name: 'l',
            last_name: 'k',
        });
        const active = await user_model.get_by_du_id('lookup');
        expect(active.id).toBe(u.id);

        await user_model.soft_delete(u.id);
        expect(await user_model.get_by_du_id('lookup')).toBeUndefined();
        expect((await user_model.get_by_du_id('lookup', { include_inactive: true })).id).toBe(u.id);
    });

    /*
     * Batch sibling of actor_label, for list columns that need a name per
     * row (Admin > Handles "Minted by"). One query, not one per row.
     */
    describe('names_by_du_id (display names for a list column)', () => {
        it('resolves several du_ids in a single map', async () => {
            await db_helper.seed_user({
                du_id: 'a1', first_name: 'Ada', last_name: 'Lovelace',
            });
            await db_helper.seed_user({
                du_id: 'b2', first_name: 'Alan', last_name: 'Turing',
            });

            const map = await user_model.names_by_du_id(['a1', 'b2']);
            expect(map.get('a1')).toBe('Ada Lovelace');
            expect(map.get('b2')).toBe('Alan Turing');
        });

        /* Past actions should still carry a name after deactivation. */
        it('includes deactivated users', async () => {
            const u = await db_helper.seed_user({
                du_id: 'c3', first_name: 'Grace', last_name: 'Hopper',
            });
            await user_model.soft_delete(u.id);
            expect((await user_model.names_by_du_id(['c3'])).get('c3')).toBe('Grace Hopper');
        });

        /* Omitted, not blanked — the caller falls back to showing the du_id. */
        it('omits du_ids with no user row', async () => {
            const map = await user_model.names_by_du_id(['ghost']);
            expect(map.has('ghost')).toBe(false);
        });

        /*
         * first_name/last_name are nullable in tbl_users, so a nameless row
         * is possible. Inserted directly: seed_user substitutes defaults for
         * empty names (`overrides.first_name || 'Test'`) and so cannot
         * produce this state.
         */
        it('omits a user whose name was never filled in', async () => {
            await db()(tables.users).insert({
                du_id: 'd4',
                email: 'nameless@du.edu',
                first_name: null,
                last_name: null,
                role: 'staff',
                is_active: 1,
                token: '0',
            });
            expect((await user_model.names_by_du_id(['d4'])).has('d4')).toBe(false);
        });

        it('de-duplicates and ignores empty input', async () => {
            await db_helper.seed_user({
                du_id: 'e5', first_name: 'Edsger', last_name: 'Dijkstra',
            });
            const map = await user_model.names_by_du_id(['e5', 'e5', null, undefined, '']);
            expect(map.size).toBe(1);
            expect(await user_model.names_by_du_id([])).toEqual(new Map());
            expect(await user_model.names_by_du_id(undefined)).toEqual(new Map());
        });
    });

    describe('actor_label (audit "Deleted by ..." label)', () => {
        it('returns "First Last (du_id)" when the user resolves', async () => {
            await db_helper.seed_user({
                du_id: '871095226',
                first_name: 'Fernando',
                last_name: 'Reyes',
            });
            const label = await user_model.actor_label({
                du_id: '871095226',
                sub: '7',
                email: 'f@du.edu',
            });
            expect(label).toBe('Fernando Reyes (871095226)');
        });

        it('resolves a just-deactivated (still-authenticated) user by name', async () => {
            const u = await db_helper.seed_user({
                du_id: 'gone',
                first_name: 'Grace',
                last_name: 'Hopper',
            });
            await user_model.soft_delete(u.id);
            const label = await user_model.actor_label({ du_id: 'gone' });
            expect(label).toBe('Grace Hopper (gone)');
        });

        it('falls back to the du_id when no matching user row exists', async () => {
            const label = await user_model.actor_label({
                du_id: 'ghost',
                email: 'g@du.edu',
                sub: '9',
            });
            expect(label).toBe('ghost');
        });

        it('falls back to the du_id when the row has no name', async () => {
            // Direct insert — seed_user coerces empty names to defaults.
            await db()(tables.users).insert({
                du_id: 'noname',
                email: 'n@du.edu',
                first_name: '',
                last_name: '',
                is_active: 1,
                token: '0',
            });
            const label = await user_model.actor_label({ du_id: 'noname' });
            expect(label).toBe('noname');
        });

        it('falls back to email, then sub, when du_id is absent', async () => {
            expect(await user_model.actor_label({ email: 'e@du.edu', sub: '5' })).toBe('e@du.edu');
            expect(await user_model.actor_label({ sub: '5' })).toBe('5');
        });

        it('returns null for a missing principal', async () => {
            expect(await user_model.actor_label(null)).toBeNull();
            expect(await user_model.actor_label(undefined)).toBeNull();
        });
    });

    describe('role (RBAC)', () => {
        it('create persists a valid role', async () => {
            const u = await user_model.create({
                du_id: 'role-admin',
                email: 'ra@du.edu',
                first_name: 'R',
                last_name: 'A',
                role: 'admin',
            });
            expect(u.role).toBe('admin');
            expect((await user_model.get_by_du_id('role-admin')).role).toBe('admin');
        });

        it('create defaults role to staff when omitted', async () => {
            const u = await user_model.create({
                du_id: 'role-default',
                email: 'rd@du.edu',
                first_name: 'R',
                last_name: 'D',
            });
            expect(u.role).toBe('staff');
        });

        it('create rejects an unknown role', async () => {
            await expect(
                user_model.create({
                    du_id: 'role-bad',
                    email: 'rb@du.edu',
                    first_name: 'R',
                    last_name: 'B',
                    role: 'superuser',
                })
            ).rejects.toBeInstanceOf(ValidationError);
        });

        it('update changes role; omitting role leaves it unchanged', async () => {
            const u = await user_model.create({
                du_id: 'role-upd',
                email: 'ru@du.edu',
                first_name: 'R',
                last_name: 'U',
                role: 'viewer',
            });
            const promoted = await user_model.update(u.id, { role: 'admin' });
            expect(promoted.role).toBe('admin');
            // A patch without role keeps the current role.
            const renamed = await user_model.update(u.id, { first_name: 'Ray' });
            expect(renamed.role).toBe('admin');
            expect(renamed.first_name).toBe('Ray');
        });

        it('update rejects an unknown role', async () => {
            const u = await user_model.create({
                du_id: 'role-upd-bad',
                email: 'rub@du.edu',
                first_name: 'R',
                last_name: 'U',
            });
            await expect(user_model.update(u.id, { role: 'root' })).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });
});
