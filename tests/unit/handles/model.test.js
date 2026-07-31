'use strict';

/*
 * handles/model — the Admin Utils mint/delete surface.
 *
 * The security-critical logic here is the target-URL allowlist. An
 * operator-supplied target is the same open-redirect exposure that made us
 * drop the retired service's caller-supplied `target`: a DU persistent
 * identifier that points at an arbitrary site is worse than no handle,
 * because it carries DU's authority. These pin down the boundary.
 */

const model = require('../../../handles/model');
const app_config = require('../../../config/app');
const { ValidationError } = require('../../../libs/errors');

describe('handles/model', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.HANDLE_TARGET = 'https://digitalarchives.du.edu/object/';
        process.env.HANDLE_PREFIX = '10176';
        process.env.HANDLE_ALLOWED_TARGET_HOSTS = 'du.edu';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('validate_target_url', () => {
        it.each([
            ['the allowed host itself', 'https://du.edu/some/page'],
            ['a subdomain', 'https://digitalarchives.du.edu/object/x'],
            ['a deeper subdomain', 'https://a.b.du.edu/page'],
            ['a URL with query and fragment', 'https://library.du.edu/g.php?id=1#top'],
        ])('accepts %s', (_label, url) => {
            expect(model.validate_target_url(url)).toContain('du.edu');
        });

        /*
         * The suffix match is anchored on a dot precisely so these fail.
         * "du.edu.evil.com" and "notdu.edu" both END WITH the allowed string
         * under a naive endsWith check.
         */
        it.each([
            ['a lookalike parent domain', 'https://du.edu.evil.com/page'],
            ['a lookalike prefix', 'https://notdu.edu/page'],
            ['an unrelated host', 'https://example.com/page'],
        ])('rejects %s', (_label, url) => {
            expect(() => model.validate_target_url(url)).toThrow(ValidationError);
        });

        it('rejects http, since a persistent identifier should not downgrade', () => {
            expect(() => model.validate_target_url('http://du.edu/page'))
                .toThrow(/https/);
        });

        it('rejects credentials embedded in the URL', () => {
            expect(() => model.validate_target_url('https://user:pw@du.edu/page'))
                .toThrow(/credentials/);
        });

        it.each([
            ['empty', ''],
            ['whitespace', '   '],
            ['not a URL', 'du.edu/page'],
            ['a non-string', 42],
        ])('rejects %s input', (_label, value) => {
            expect(() => model.validate_target_url(value)).toThrow(ValidationError);
        });

        it('accepts multiple configured hosts', () => {
            process.env.HANDLE_ALLOWED_TARGET_HOSTS = 'du.edu, coalliance.org';
            app_config._reset();
            expect(model.validate_target_url('https://coalliance.org/x')).toBeTruthy();
            expect(model.validate_target_url('https://sub.du.edu/x')).toBeTruthy();
        });
    });

    /*
     * An unconfigured allowlist must not mean "anything goes". It falls back
     * to the host of HANDLE_TARGET, so a deployment that forgets the setting
     * is restricted to its own domain.
     */
    describe('allowed_hosts fallback', () => {
        it('falls back to the HANDLE_TARGET host when unset', () => {
            delete process.env.HANDLE_ALLOWED_TARGET_HOSTS;
            app_config._reset();
            expect(model.allowed_hosts()).toEqual(['digitalarchives.du.edu']);
        });

        it('fails closed when neither is set', () => {
            delete process.env.HANDLE_ALLOWED_TARGET_HOSTS;
            process.env.HANDLE_TARGET = '';
            app_config._reset();
            expect(model.allowed_hosts()).toEqual([]);
            expect(() => model.validate_target_url('https://du.edu/x'))
                .toThrow(/No allowed target hosts/);
        });
    });

    describe('validate_note', () => {
        it('trims and returns null for an empty note', () => {
            expect(model.validate_note('  ')).toBeNull();
            expect(model.validate_note('  hi  ')).toBe('hi');
        });

        it('rejects an over-long note rather than silently truncating', () => {
            expect(() => model.validate_note('x'.repeat(501))).toThrow(ValidationError);
        });
    });

    describe('mint guards', () => {
        it('refuses an empty submission', async () => {
            await expect(model.mint([])).rejects.toBeInstanceOf(ValidationError);
        });

        it('refuses more than the per-submission cap', async () => {
            const entries = Array.from({ length: 6 }, () => ({
                target_url: 'https://du.edu/x', note: '',
            }));
            await expect(model.mint(entries)).rejects.toThrow(/At most 5/);
        });

        /*
         * Validation must complete before ANY row is written, so a bad URL in
         * the last row cannot leave earlier ones half-minted. Reaching the
         * validation error without a writer proves nothing was attempted.
         */
        it('validates every entry before writing anything', async () => {
            const writer = { batch: vi.fn(), write: vi.fn() };
            const entries = [
                { target_url: 'https://du.edu/ok', note: '' },
                { target_url: 'https://evil.com/no', note: '' },
            ];
            await expect(model.mint(entries, { writer })).rejects.toBeInstanceOf(ValidationError);
            expect(writer.batch).not.toHaveBeenCalled();
        });
    });
});
