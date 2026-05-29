'use strict';

const replay_guard = require('../../../../auth/sso/replay_guard');
const { UnauthorizedError, ValidationError } = require('../../../../libs/errors');

const NOW_S = 1_700_000_000;
const now = () => NOW_S * 1000;

describe('auth/sso/replay_guard', () => {
    beforeEach(() => replay_guard._reset());

    describe('input validation', () => {
        it('rejects missing timestamp', () => {
            expect(() =>
                replay_guard.check(undefined, 'nonceABC123', { max_skew_seconds: 60, now })
            ).toThrow(ValidationError);
        });

        it('rejects non-numeric timestamp', () => {
            expect(() =>
                replay_guard.check('not-a-number', 'nonceABC123', { max_skew_seconds: 60, now })
            ).toThrow(ValidationError);
        });

        it('rejects missing nonce', () => {
            expect(() =>
                replay_guard.check(NOW_S, undefined, { max_skew_seconds: 60, now })
            ).toThrow(ValidationError);
        });

        it('rejects too-short nonce (< 8 chars)', () => {
            expect(() => replay_guard.check(NOW_S, 'short', { max_skew_seconds: 60, now })).toThrow(
                ValidationError
            );
        });

        it('rejects too-long nonce (> 128 chars)', () => {
            expect(() =>
                replay_guard.check(NOW_S, 'x'.repeat(200), { max_skew_seconds: 60, now })
            ).toThrow(ValidationError);
        });
    });

    describe('freshness window', () => {
        it('accepts a fresh timestamp', () => {
            expect(replay_guard.check(NOW_S, 'nonce-fresh-1', { max_skew_seconds: 60, now })).toBe(
                true
            );
        });

        it('accepts a timestamp within +/- max_skew_seconds', () => {
            expect(
                replay_guard.check(NOW_S - 30, 'nonce-skew-back', { max_skew_seconds: 60, now })
            ).toBe(true);
            expect(
                replay_guard.check(NOW_S + 30, 'nonce-skew-fwd', { max_skew_seconds: 60, now })
            ).toBe(true);
        });

        it('rejects a stale timestamp', () => {
            expect(() =>
                replay_guard.check(NOW_S - 3600, 'nonce-stale', { max_skew_seconds: 60, now })
            ).toThrow(UnauthorizedError);
        });

        it('rejects a future timestamp beyond skew', () => {
            expect(() =>
                replay_guard.check(NOW_S + 3600, 'nonce-future', { max_skew_seconds: 60, now })
            ).toThrow(UnauthorizedError);
        });

        it('accepts string-form timestamps (proxies often serialize)', () => {
            expect(
                replay_guard.check(String(NOW_S), 'nonce-str-form', { max_skew_seconds: 60, now })
            ).toBe(true);
        });
    });

    describe('uniqueness window', () => {
        it('rejects a re-used (timestamp, nonce) pair', () => {
            replay_guard.check(NOW_S, 'reuse-nonce-1', { max_skew_seconds: 60, now });
            expect(() =>
                replay_guard.check(NOW_S, 'reuse-nonce-1', { max_skew_seconds: 60, now })
            ).toThrow(/replay/i);
        });

        it('accepts the same nonce paired with a different timestamp', () => {
            replay_guard.check(NOW_S, 'shared-nonce', { max_skew_seconds: 60, now });
            expect(
                replay_guard.check(NOW_S + 1, 'shared-nonce', { max_skew_seconds: 60, now })
            ).toBe(true);
        });

        it('accepts the same timestamp paired with different nonces', () => {
            replay_guard.check(NOW_S, 'nonce-A1', { max_skew_seconds: 60, now });
            expect(replay_guard.check(NOW_S, 'nonce-B2', { max_skew_seconds: 60, now })).toBe(true);
        });
    });

    describe('config sanity', () => {
        it('throws when max_skew_seconds is missing', () => {
            expect(() => replay_guard.check(NOW_S, 'nonce-conf-x')).toThrow();
        });

        it('throws when max_skew_seconds is zero', () => {
            expect(() =>
                replay_guard.check(NOW_S, 'nonce-conf-y', { max_skew_seconds: 0, now })
            ).toThrow();
        });
    });
});
