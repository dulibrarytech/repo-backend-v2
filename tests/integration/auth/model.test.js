'use strict';

const auth_model = require('../../../auth/model');
const db_helper = require('../../helpers/db');

describe('auth/model — DB integration', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    it('find_active_user returns active row by du_id', async () => {
        await db_helper.seed_user({ du_id: 'alice', email: 'a@x.com' });
        const u = await auth_model.find_active_user('alice');
        expect(u).toBeDefined();
        expect(u.email).toBe('a@x.com');
    });

    it('find_active_user returns undefined for inactive user', async () => {
        await db_helper.seed_user({ du_id: 'bob', is_active: 0 });
        expect(await auth_model.find_active_user('bob')).toBeUndefined();
    });

    it('rotate_refresh_token stamps a fresh UUID and returns it', async () => {
        const u = await db_helper.seed_user({ du_id: 'r1', token: '0' });
        const t1 = await auth_model.rotate_refresh_token(u.id);
        expect(t1).toMatch(/-/);
        const t2 = await auth_model.rotate_refresh_token(u.id);
        expect(t2).not.toBe(t1);
        // Stored value matches the latest rotate
        const fresh = await auth_model.find_by_id(u.id);
        expect(fresh.token).toBe(t2);
    });

    it('verify_refresh_token returns true only for the current stored token', async () => {
        const u = await db_helper.seed_user({ du_id: 'v1', token: '0' });
        const t1 = await auth_model.rotate_refresh_token(u.id);
        expect(await auth_model.verify_refresh_token(u.id, t1)).toBe(true);
        const t2 = await auth_model.rotate_refresh_token(u.id);
        expect(await auth_model.verify_refresh_token(u.id, t1)).toBe(false);
        expect(await auth_model.verify_refresh_token(u.id, t2)).toBe(true);
    });

    it('verify_refresh_token rejects empty / zero tokens', async () => {
        const u = await db_helper.seed_user({ du_id: 'z' });
        expect(await auth_model.verify_refresh_token(u.id, '')).toBe(false);
        expect(await auth_model.verify_refresh_token(u.id, '0')).toBe(false);
    });

    it('clear_refresh_token zeroes the column', async () => {
        const u = await db_helper.seed_user({ du_id: 'c', token: 'something' });
        const r = await auth_model.clear_refresh_token(u.id);
        expect(r.cleared).toBe(true);
        const fresh = await auth_model.find_by_id(u.id);
        expect(fresh.token).toBe('0');
    });

    it('rotate_refresh_token throws when user is inactive', async () => {
        const u = await db_helper.seed_user({ du_id: 'inact', is_active: 0 });
        await expect(auth_model.rotate_refresh_token(u.id)).rejects.toThrow(
            /not found or inactive/
        );
    });
});
