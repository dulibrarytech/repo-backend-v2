'use strict';

const jwt = require('../../../libs/jwt');

// Lightweight res stub that records cookie() / clearCookie() calls.
function fake_res() {
    return {
        cookies: [],
        cleared: [],
        cookie(name, value, options) {
            this.cookies.push({ name, value, options });
        },
        clearCookie(name, options) {
            this.cleared.push({ name, options });
        },
    };
}

function fake_req({ cookies = {}, authorization } = {}) {
    return {
        cookies,
        get(name) {
            if (name.toLowerCase() === 'authorization') return authorization;
            return undefined;
        },
    };
}

describe('libs/jwt', () => {
    describe('sign / verify roundtrip', () => {
        it('verify returns the payload signed', () => {
            const token = jwt.sign({ sub: 'user-1', role: 'staff' });
            const decoded = jwt.verify(token);
            expect(decoded.sub).toBe('user-1');
            expect(decoded.role).toBe('staff');
            expect(decoded.iss).toBe(process.env.TOKEN_ISSUER);
        });

        it('rejects an unsigned token', () => {
            expect(() => jwt.verify('not.a.token')).toThrow();
        });

        it('rejects a token signed with a different secret', () => {
            const real = process.env.TOKEN_SECRET;
            process.env.TOKEN_SECRET = 'other-secret';
            const token = jwt.sign({ sub: 'attacker' });
            process.env.TOKEN_SECRET = real;
            expect(() => jwt.verify(token)).toThrow();
        });

        it('rejects expired tokens', () => {
            const token = jwt.sign({ sub: 'u' }, { expiresIn: '-1s' });
            expect(() => jwt.verify(token)).toThrow(/expired/i);
        });
    });

    describe('issue_cookie / clear_cookie', () => {
        it('sets a signed, httpOnly, SameSite=Lax cookie', () => {
            const res = fake_res();
            const token = jwt.issue_cookie(res, { sub: 'u' });
            expect(token).toBeTruthy();
            expect(res.cookies).toHaveLength(1);
            expect(res.cookies[0].name).toBe(jwt.COOKIE_NAME);
            expect(res.cookies[0].value).toBe(token);
            expect(res.cookies[0].options.httpOnly).toBe(true);
            expect(res.cookies[0].options.sameSite).toBe('lax');
            // Not Secure in test (NODE_ENV !== production)
            expect(res.cookies[0].options.secure).toBe(false);
        });

        it('clear_cookie targets the same name', () => {
            const res = fake_res();
            jwt.clear_cookie(res);
            expect(res.cleared).toHaveLength(1);
            expect(res.cleared[0].name).toBe(jwt.COOKIE_NAME);
        });
    });

    describe('extract', () => {
        it('prefers cookie over bearer', () => {
            const req = fake_req({
                cookies: { [jwt.COOKIE_NAME]: 'cookie-tok' },
                authorization: 'Bearer header-tok',
            });
            expect(jwt.extract(req)).toBe('cookie-tok');
        });

        it('falls back to bearer header', () => {
            const req = fake_req({ authorization: 'Bearer header-tok' });
            expect(jwt.extract(req)).toBe('header-tok');
        });

        it('case-insensitive bearer prefix', () => {
            const req = fake_req({ authorization: 'bearer header-tok' });
            expect(jwt.extract(req)).toBe('header-tok');
        });

        it('returns null when neither present', () => {
            expect(jwt.extract(fake_req())).toBeNull();
        });

        it('ignores non-Bearer Authorization schemes', () => {
            const req = fake_req({ authorization: 'Basic dXNlcjpwYXNz' });
            expect(jwt.extract(req)).toBeNull();
        });
    });
});
