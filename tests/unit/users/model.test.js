'use strict';

/*
 * Pure-validation unit tests for users/model.
 * Behavioral tests (DB-backed) live in tests/integration/users/.
 */

const user_model = require('../../../users/model');
const { ValidationError } = require('../../../libs/errors');

describe('users/model — input validation', () => {
    describe('create', () => {
        it('rejects when du_id missing', async () => {
            await expect(
                user_model.create({ email: 'a@b.com', first_name: 'a', last_name: 'b' })
            ).rejects.toBeInstanceOf(ValidationError);
        });

        it('rejects malformed email', async () => {
            await expect(
                user_model.create({
                    du_id: 'x',
                    email: 'not-an-email',
                    first_name: 'a',
                    last_name: 'b',
                })
            ).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
                details: expect.arrayContaining([{ field: 'email', error: 'invalid' }]),
            });
        });

        it('rejects when first_name missing', async () => {
            await expect(
                user_model.create({ du_id: 'x', email: 'a@b.com', last_name: 'b' })
            ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('aggregates multiple errors in details[]', async () => {
            try {
                await user_model.create({});
                throw new Error('should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(ValidationError);
                expect(err.details.length).toBeGreaterThanOrEqual(3);
            }
        });
    });

    describe('update', () => {
        it('rejects empty patch', async () => {
            await expect(user_model.update(1, {})).rejects.toBeInstanceOf(ValidationError);
        });

        it('accepts a partial patch with valid email', async () => {
            /*
             * Will fail at the DB layer (no DB in unit tests) — but the
             * validation step throws synchronously before any query runs.
             * We check that the rejection is NOT a ValidationError.
             */
            await expect(user_model.update(1, { email: 'new@b.com' })).rejects.not.toBeInstanceOf(
                ValidationError
            );
        });

        it('rejects malformed email even in patch', async () => {
            await expect(user_model.update(1, { email: 'bad' })).rejects.toBeInstanceOf(
                ValidationError
            );
        });
    });
});
