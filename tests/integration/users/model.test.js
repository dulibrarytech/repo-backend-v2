'use strict';

const user_model = require('../../../users/model');
const db_helper = require('../../helpers/db');
const { NotFoundError, ConflictError } = require('../../../libs/errors');

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
});
