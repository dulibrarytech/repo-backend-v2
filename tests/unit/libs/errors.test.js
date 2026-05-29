'use strict';

const {
    AppError,
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    PayloadTooLargeError,
    RateLimitError,
    UpstreamError,
    ServiceUnavailableError,
} = require('../../../libs/errors');

describe('libs/errors', () => {
    it('AppError carries status and code', () => {
        const e = new AppError('boom', 418, 'TEAPOT');
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(AppError);
        expect(e.message).toBe('boom');
        expect(e.status).toBe(418);
        expect(e.code).toBe('TEAPOT');
        expect(e.name).toBe('AppError');
    });

    it('AppError defaults to 500 / INTERNAL_ERROR', () => {
        const e = new AppError('oops');
        expect(e.status).toBe(500);
        expect(e.code).toBe('INTERNAL_ERROR');
    });

    it.each([
        [ValidationError, 400, 'VALIDATION_ERROR'],
        [UnauthorizedError, 401, 'UNAUTHORIZED'],
        [ForbiddenError, 403, 'FORBIDDEN'],
        [NotFoundError, 404, 'NOT_FOUND'],
        [ConflictError, 409, 'CONFLICT'],
        [PayloadTooLargeError, 413, 'PAYLOAD_TOO_LARGE'],
        [RateLimitError, 429, 'RATE_LIMITED'],
        [UpstreamError, 502, 'UPSTREAM_ERROR'],
        [ServiceUnavailableError, 503, 'SERVICE_UNAVAILABLE'],
    ])('%p maps to status %i / code %s', (Cls, status, code) => {
        const e = new Cls('msg');
        expect(e).toBeInstanceOf(AppError);
        expect(e.status).toBe(status);
        expect(e.code).toBe(code);
        expect(e.name).toBe(Cls.name);
    });

    it('ValidationError carries details', () => {
        const details = [{ field: 'email', error: 'invalid' }];
        const e = new ValidationError('bad input', details);
        expect(e.details).toEqual(details);
    });

    it('stack trace is captured', () => {
        const e = new NotFoundError();
        expect(e.stack).toBeDefined();
        expect(e.stack).toContain('NotFoundError');
    });
});
