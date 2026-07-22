'use strict';

const sanitize = require('../../../libs/sanitize');

function run_middleware(mw, req) {
    return new Promise((resolve, reject) => {
        mw(req, {}, (err) => (err ? reject(err) : resolve()));
    });
}

describe('libs/sanitize', () => {
    describe('clean_string', () => {
        /*
         * Security property under test:
         *   After sanitization, no raw `<` or `>` survives. Any payload
         *   that would have executed JS in a browser parser is now inert
         *   text. We do NOT assert the *words* are gone — `alert`,
         *   `onerror` etc. survive as harmless characters.
         */
        it('renders <script> tags inert by entity-encoding angle brackets', () => {
            const out = sanitize.clean_string('<script>alert(1)</script>hello');
            expect(out).not.toMatch(/<script/i);
            expect(out).not.toMatch(/<\/script/i);
            expect(out).not.toContain('<');
            expect(out).not.toContain('>');
            expect(out).toContain('hello');
        });

        it('escapes ampersand / lt / gt / quotes', () => {
            expect(sanitize.clean_string('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&#x27;f');
        });

        it('leaves plain text untouched (after escape)', () => {
            expect(sanitize.clean_string('hello world')).toBe('hello world');
        });

        it('trims leading/trailing whitespace', () => {
            expect(sanitize.clean_string('  hello  ')).toBe('hello');
        });

        it('passes through empty string', () => {
            expect(sanitize.clean_string('')).toBe('');
        });

        it('neutralizes onerror payloads by encoding angle brackets', () => {
            const out = sanitize.clean_string('<img src=x onerror=alert(1)>');
            /*
             * Once `<` is entity-encoded, no element is constructed, so the
             * surviving "onerror" text is just inert characters.
             */
            expect(out).not.toContain('<');
            expect(out).not.toContain('>');
            expect(out.startsWith('&lt;')).toBe(true);
        });

        it('does not coerce non-strings', () => {
            expect(sanitize.clean_string(123)).toBe(123);
            expect(sanitize.clean_string(null)).toBe(null);
        });
    });

    describe('clean_value (recursive)', () => {
        it('walks nested objects + arrays', () => {
            const input = {
                a: '<b>hi</b>',
                nested: { tags: ['<i>x</i>', 'plain'] },
                n: 42,
                flag: true,
                empty: null,
            };
            const out = sanitize.clean_value(input);
            expect(out.a).not.toContain('<b>');
            expect(out.nested.tags[0]).not.toContain('<i>');
            expect(out.nested.tags[1]).toBe('plain');
            expect(out.n).toBe(42);
            expect(out.flag).toBe(true);
            expect(out.empty).toBe(null);
        });

        it('drops prototype-pollution keys', () => {
            const out = sanitize.clean_value({ __proto__: { x: 1 }, ok: 'yes' });
            expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
            expect(out.ok).toBe('yes');
        });

        it('preserves arrays as arrays', () => {
            const out = sanitize.clean_value(['<x>', 'y']);
            expect(Array.isArray(out)).toBe(true);
        });
    });

    describe('req_body middleware', () => {
        it('mutates string fields in req.body', async () => {
            const req = { body: { title: '<script>x</script>ok', n: 7 } };
            await run_middleware(sanitize.req_body, req);
            expect(req.body.title).not.toContain('<script>');
            expect(req.body.n).toBe(7);
        });

        it('is a noop when req.body is absent', async () => {
            const req = {};
            await expect(run_middleware(sanitize.req_body, req)).resolves.toBeUndefined();
        });
    });

    describe('req_query middleware', () => {
        it('mutates string fields in req.query', async () => {
            const req = { query: { q: '<svg/onload=alert(1)>' } };
            await run_middleware(sanitize.req_query, req);
            // Angle brackets entity-encoded → no element constructed
            expect(req.query.q).not.toContain('<');
            expect(req.query.q).not.toContain('>');
        });
    });

    describe('validate_uuid middleware', () => {
        it('passes when uuid param is valid', async () => {
            const req = { params: { uuid: '550e8400-e29b-41d4-a716-446655440000' } };
            await expect(run_middleware(sanitize.validate_uuid, req)).resolves.toBeUndefined();
        });

        it('rejects malformed uuid path param', async () => {
            const req = { params: { uuid: 'not-a-uuid' } };
            await expect(run_middleware(sanitize.validate_uuid, req)).rejects.toMatchObject({
                status: 400,
                code: 'INVALID_UUID',
            });
        });

        it('is a noop when no uuid-shaped params present', async () => {
            const req = { params: { other: 'whatever' } };
            await expect(run_middleware(sanitize.validate_uuid, req)).resolves.toBeUndefined();
        });
    });
});
