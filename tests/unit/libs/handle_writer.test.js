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

describe('libs/handle_writer', () => {
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
