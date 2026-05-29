'use strict';

const { require_auth, optional_auth } = require('../../../auth/middleware');
const jwt = require('../../../libs/jwt');
const { UnauthorizedError } = require('../../../libs/errors');

function fake_req({ cookies = {}, authorization } = {}) {
    return {
        cookies,
        get(name) {
            if (name.toLowerCase() === 'authorization') return authorization;
            return undefined;
        },
    };
}

function run(mw, req) {
    return new Promise((resolve) => {
        mw(req, {}, (err) => resolve({ err, req }));
    });
}

describe('auth/middleware', () => {
    describe('require_auth', () => {
        it('rejects when no token present', async () => {
            const { err } = await run(require_auth, fake_req());
            expect(err).toBeInstanceOf(UnauthorizedError);
            expect(err.code).toBe('UNAUTHORIZED');
        });

        it('accepts a valid bearer token and attaches req.user', async () => {
            const token = jwt.sign({ sub: 'u-1', role: 'staff' });
            const { err, req } = await run(
                require_auth,
                fake_req({ authorization: `Bearer ${token}` })
            );
            expect(err).toBeUndefined();
            expect(req.user.sub).toBe('u-1');
            expect(req.user.role).toBe('staff');
        });

        it('accepts a valid cookie token', async () => {
            const token = jwt.sign({ sub: 'u-2' });
            const { err, req } = await run(
                require_auth,
                fake_req({ cookies: { [jwt.COOKIE_NAME]: token } })
            );
            expect(err).toBeUndefined();
            expect(req.user.sub).toBe('u-2');
        });

        it('rejects an expired token with explicit message', async () => {
            const token = jwt.sign({ sub: 'u' }, { expiresIn: '-1s' });
            const { err } = await run(require_auth, fake_req({ authorization: `Bearer ${token}` }));
            expect(err).toBeInstanceOf(UnauthorizedError);
            expect(err.message).toMatch(/expired/i);
        });

        it('rejects a malformed token', async () => {
            const { err } = await run(require_auth, fake_req({ authorization: 'Bearer garbage' }));
            expect(err).toBeInstanceOf(UnauthorizedError);
        });
    });

    describe('optional_auth', () => {
        it('continues with no token, no req.user', async () => {
            const { err, req } = await run(optional_auth, fake_req());
            expect(err).toBeUndefined();
            expect(req.user).toBeUndefined();
        });

        it('attaches req.user when a valid token is present', async () => {
            const token = jwt.sign({ sub: 'opt' });
            const { err, req } = await run(
                optional_auth,
                fake_req({ authorization: `Bearer ${token}` })
            );
            expect(err).toBeUndefined();
            expect(req.user.sub).toBe('opt');
        });

        it('ignores an invalid token and continues anonymously', async () => {
            const { err, req } = await run(optional_auth, fake_req({ authorization: 'Bearer x' }));
            expect(err).toBeUndefined();
            expect(req.user).toBeUndefined();
        });
    });
});
