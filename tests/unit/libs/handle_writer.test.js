'use strict';

/*
 * handle_writer spawns a JVM, so the subprocess itself is covered by
 * scripts/verify_handle_auth.js against the real server. What is worth
 * unit-testing is the pure logic either side of that boundary: parsing
 * HANDLE_ADMIN_ID, and mapping Handle protocol response codes onto the
 * statuses libs/handles.js branches on.
 */

const writer = require('../../../libs/handle_writer');
const { UpstreamError } = require('../../../libs/errors');

const app_config = require('../../../config/app');

describe('libs/handle_writer', () => {
    /*
     * The classpath is derived rather than configured: the jar ships in the
     * checkout so its path follows the deploy, and only the handle client's
     * lib/ varies per host. Absolute classpaths in .env were an easy thing
     * to get wrong and failed opaquely at runtime when they were.
     */
    describe('derived helper classpath', () => {
        let original_env;
        beforeEach(() => {
            original_env = { ...process.env };
            delete process.env.HANDLE_HELPER_CLASSPATH;
            app_config._reset();
        });
        afterEach(() => {
            process.env = original_env;
            app_config._reset();
        });

        it('joins the in-checkout jar with the configured client lib', () => {
            process.env.HANDLE_CLIENT_LIB = '/opt/handle-client/lib';
            app_config._reset();
            const cp = app_config().handles.helper_classpath;

            expect(cp).toMatch(/java[/\\]duhandletool\.jar/);
            expect(cp.endsWith('/opt/handle-client/lib/*')).toBe(true);
            /* absolute, so it does not depend on the process working dir */
            expect(cp.startsWith('/')).toBe(true);
        });

        it('is empty when HANDLE_CLIENT_LIB is unset, so is_configured() fails closed', () => {
            delete process.env.HANDLE_CLIENT_LIB;
            app_config._reset();
            expect(app_config().handles.helper_classpath).toBe('');
        });

        it('honours an explicit HANDLE_HELPER_CLASSPATH override', () => {
            process.env.HANDLE_CLIENT_LIB = '/opt/handle-client/lib';
            process.env.HANDLE_HELPER_CLASSPATH = '/custom/one.jar:/custom/two.jar';
            app_config._reset();
            expect(app_config().handles.helper_classpath)
                .toBe('/custom/one.jar:/custom/two.jar');
        });
    });

    describe('split_admin_id', () => {
        it('splits "<index>:<handle>"', () => {
            expect(writer.split_admin_id('300:0.NA/10176'))
                .toEqual({ index: 300, handle: '0.NA/10176' });
        });

        it('keeps colons that appear inside the handle', () => {
            expect(writer.split_admin_id('301:0.NA/20.500.12345:extra'))
                .toEqual({ index: 301, handle: '0.NA/20.500.12345:extra' });
        });

        it.each([
            ['no index', '0.NA/10176'],
            ['a non-numeric index', 'admin:0.NA/10176'],
            ['an empty string', ''],
            ['undefined', undefined],
        ])('throws on %s', (_label, bad) => {
            expect(() => writer.split_admin_id(bad)).toThrow(UpstreamError);
        });
    });

    describe('status_for', () => {
        it.each([
            ['RC_SUCCESS', 1, 200],
            ['RC_HANDLE_NOT_FOUND', 100, 404],
            ['RC_HANDLE_ALREADY_EXISTS', 101, 409],
            ['RC_INVALID_ADMIN', 400, 502],
            ['RC_AUTHENTICATION_NEEDED', 402, 502],
            ['a helper-side failure', -1, 502],
        ])('maps %s (%i) to %i', (_label, code, expected) => {
            expect(writer.status_for(code)).toBe(expected);
        });
    });
});
