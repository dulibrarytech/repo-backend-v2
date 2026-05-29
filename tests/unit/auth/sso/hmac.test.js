'use strict';

const hmac = require('../../../../auth/sso/hmac');
const { UnauthorizedError, ValidationError } = require('../../../../libs/errors');

const SECRET = 'shared-secret-32-chars-or-longer-abcd';

function payload(overrides = {}) {
    const employee_id = '871095226';
    const timestamp = '1700000000';
    const nonce = 'nonce-abc-12345';
    return {
        employeeID: employee_id,
        timestamp,
        nonce,
        signature: hmac.sign(employee_id, timestamp, nonce, SECRET),
        ...overrides,
    };
}

describe('auth/sso/hmac', () => {
    describe('sign', () => {
        it('produces a 64-char hex digest', () => {
            const sig = hmac.sign('123', '1', 'nonce-xy', SECRET);
            expect(sig).toMatch(/^[0-9a-f]{64}$/);
        });

        it('is deterministic for identical inputs', () => {
            const a = hmac.sign('123', '1', 'nonce-xyz', SECRET);
            const b = hmac.sign('123', '1', 'nonce-xyz', SECRET);
            expect(a).toBe(b);
        });

        it('changes when any input changes', () => {
            const base = hmac.sign('123', '1', 'nonce-xyz', SECRET);
            expect(hmac.sign('124', '1', 'nonce-xyz', SECRET)).not.toBe(base);
            expect(hmac.sign('123', '2', 'nonce-xyz', SECRET)).not.toBe(base);
            expect(hmac.sign('123', '1', 'nonce-xyZ', SECRET)).not.toBe(base);
            expect(hmac.sign('123', '1', 'nonce-xyz', SECRET + 'X')).not.toBe(base);
        });

        it('throws if secret is empty', () => {
            expect(() => hmac.sign('1', '1', 'nonce-abcd', '')).toThrow(/secret/);
        });
    });

    describe('verify — happy path', () => {
        it('returns true when the signature matches', () => {
            expect(hmac.verify(payload(), [SECRET])).toBe(true);
        });
    });

    describe('verify — rejections', () => {
        it('rejects a missing signature', () => {
            const body = payload();
            delete body.signature;
            expect(() => hmac.verify(body, [SECRET])).toThrow(ValidationError);
        });

        it('rejects a too-short signature', () => {
            expect(() => hmac.verify(payload({ signature: 'abc' }), [SECRET])).toThrow(
                ValidationError
            );
        });

        it('rejects non-hex characters in signature', () => {
            const bogus = payload({ signature: 'g'.repeat(64) });
            expect(() => hmac.verify(bogus, [SECRET])).toThrow(ValidationError);
        });

        it('rejects a tampered employeeID', () => {
            const body = payload();
            body.employeeID = '999999999';
            expect(() => hmac.verify(body, [SECRET])).toThrow(UnauthorizedError);
        });

        it('rejects a tampered timestamp', () => {
            const body = payload();
            body.timestamp = '1';
            expect(() => hmac.verify(body, [SECRET])).toThrow(UnauthorizedError);
        });

        it('rejects a tampered nonce', () => {
            const body = payload();
            body.nonce = 'replaced-nonce-1';
            expect(() => hmac.verify(body, [SECRET])).toThrow(UnauthorizedError);
        });

        it('rejects a payload signed with a different secret', () => {
            const body = payload();
            // re-sign with a different secret
            body.signature = hmac.sign(body.employeeID, body.timestamp, body.nonce, 'evil-secret');
            expect(() => hmac.verify(body, [SECRET])).toThrow(UnauthorizedError);
        });

        it('throws if no secrets are configured', () => {
            expect(() => hmac.verify(payload(), [])).toThrow(/secret/);
        });
    });

    describe('verify — key rotation', () => {
        it('accepts either secret in a two-secret config', () => {
            const NEW = 'new-shared-secret-32-chars-long-xy';
            // Sign with the OLD secret
            const old_signed = payload();
            // Sign with the NEW secret
            const new_signed = {
                ...old_signed,
                signature: hmac.sign(
                    old_signed.employeeID,
                    old_signed.timestamp,
                    old_signed.nonce,
                    NEW
                ),
            };
            expect(hmac.verify(old_signed, [SECRET, NEW])).toBe(true);
            expect(hmac.verify(new_signed, [SECRET, NEW])).toBe(true);
        });

        it('skips empty/undefined entries in the secrets list', () => {
            // Edge: caller passes [undefined, SECRET] — should still verify.
            expect(hmac.verify(payload(), [undefined, '', SECRET])).toBe(true);
        });
    });
});
