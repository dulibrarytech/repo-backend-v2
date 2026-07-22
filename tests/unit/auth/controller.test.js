'use strict';

/*
 * Pure-validation unit tests for the auth controllers. DB-backed
 * behavior (login round trip etc.) lives in tests/integration/auth/.
 */

const controller = require('../../../auth/controller');
const { ValidationError, UnauthorizedError } = require('../../../libs/errors');

function fake_res() {
    return {
        statusCode: 200,
        cookies: [],
        cleared: [],
        body: null,
        status(c) {
            this.statusCode = c;
            return this;
        },
        json(b) {
            this.body = b;
            return this;
        },
        end() {
            return this;
        },
        cookie(name, value, opts) {
            this.cookies.push({ name, value, opts });
            return this;
        },
        clearCookie(name, opts) {
            this.cleared.push({ name, opts });
            return this;
        },
    };
}

describe('auth/controller — login validation', () => {
    it('rejects missing body', async () => {
        await expect(controller.login({ body: null }, fake_res())).rejects.toBeInstanceOf(
            ValidationError
        );
    });

    it('rejects empty du_id', async () => {
        await expect(
            controller.login({ body: { du_id: '   ' } }, fake_res())
        ).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            details: expect.arrayContaining([{ field: 'du_id', error: 'required' }]),
        });
    });

    it('rejects non-object body', async () => {
        await expect(controller.login({ body: 'string' }, fake_res())).rejects.toBeInstanceOf(
            ValidationError
        );
    });
});

describe('auth/controller — refresh validation', () => {
    it('rejects missing fields', async () => {
        await expect(controller.refresh({ body: {} }, fake_res())).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
        });
    });

    it('rejects when only user_id is present', async () => {
        await expect(
            controller.refresh({ body: { user_id: 1 } }, fake_res())
        ).rejects.toBeInstanceOf(ValidationError);
    });
});

describe('auth/controller — me requires fresh user', () => {
    /*
     * This test does not hit the DB — it confirms that when the model
     * returns nothing (e.g. user deactivated), the controller raises 401.
     * We monkey-patch the model for this single case.
     */
    it('throws UnauthorizedError when user is inactive', async () => {
        const auth_model = require('../../../auth/model');
        const original = auth_model.find_by_id;
        auth_model.find_by_id = async () => ({ id: 1, is_active: 0 });
        try {
            await expect(controller.me({ user: { sub: '1' } }, fake_res())).rejects.toBeInstanceOf(
                UnauthorizedError
            );
        } finally {
            auth_model.find_by_id = original;
        }
    });
});
