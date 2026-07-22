'use strict';

/*
 * Unit tests for libs/duracloud — URL composition, auth header,
 * and the is_configured() gate. The actual stream-fetch path is
 * exercised in the e2e tests with axios mocked there (axios isn't
 * safely stub-able at the module level without uglier tooling
 * than this codebase needs).
 */

const duracloud = require('../../../libs/duracloud');
const app_config = require('../../../config/app');

describe('libs/duracloud', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        // Clear any leftover state from sibling tests.
        delete process.env.DURACLOUD_API;
        delete process.env.DURACLOUD_USER;
        delete process.env.DURACLOUD_PWD;
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('is_configured', () => {
        it('returns false when no env vars are set', () => {
            expect(duracloud.is_configured()).toBe(false);
        });

        it('returns false when API is set but credentials are missing', () => {
            process.env.DURACLOUD_API = 'duracloud.example/durastore/';
            app_config._reset();
            expect(duracloud.is_configured()).toBe(false);
        });

        it('returns true when api + user + password are all populated', () => {
            process.env.DURACLOUD_API = 'duracloud.example/durastore/';
            process.env.DURACLOUD_USER = 'svc';
            process.env.DURACLOUD_PWD = 's3cret';
            app_config._reset();
            expect(duracloud.is_configured()).toBe(true);
        });
    });

    describe('build_endpoint', () => {
        beforeEach(() => {
            process.env.DURACLOUD_USER = 'svc';
            process.env.DURACLOUD_PWD = 's3cret';
        });

        it('prepends https:// and joins under dip-store/', () => {
            process.env.DURACLOUD_API = 'duracloud.example/durastore/';
            app_config._reset();
            expect(duracloud.build_endpoint('foo/thumbnails/abc.jpg')).toBe(
                'https://duracloud.example/durastore/dip-store/foo/thumbnails/abc.jpg'
            );
        });

        it('strips an existing https:// prefix from DURACLOUD_API', () => {
            /*
             * v1 stored DURACLOUD_API without scheme, but operators
             * sometimes paste a full URL. Don't double up.
             */
            process.env.DURACLOUD_API = 'https://duracloud.example/durastore/';
            app_config._reset();
            expect(duracloud.build_endpoint('foo.jpg')).toBe(
                'https://duracloud.example/durastore/dip-store/foo.jpg'
            );
        });

        it('strips trailing slashes from DURACLOUD_API', () => {
            process.env.DURACLOUD_API = 'duracloud.example/durastore///';
            app_config._reset();
            expect(duracloud.build_endpoint('x.jpg')).toBe(
                'https://duracloud.example/durastore/dip-store/x.jpg'
            );
        });

        it('strips leading slashes from the path tail', () => {
            /*
             * Belt-and-braces against an accidentally absolute-looking
             * path. Without this we'd build .../dip-store//foo which
             * some upstreams treat as a different resource.
             */
            process.env.DURACLOUD_API = 'duracloud.example/durastore/';
            app_config._reset();
            expect(duracloud.build_endpoint('/foo.jpg')).toBe(
                'https://duracloud.example/durastore/dip-store/foo.jpg'
            );
        });

        it('throws when API is not configured', () => {
            app_config._reset();
            expect(() => duracloud.build_endpoint('x.jpg')).toThrow(/DURACLOUD_API/);
        });
    });

    describe('build_auth_header', () => {
        it('produces a base64-encoded Basic header', () => {
            process.env.DURACLOUD_API = 'duracloud.example/durastore/';
            process.env.DURACLOUD_USER = 'alice';
            process.env.DURACLOUD_PWD = 'wonderland';
            app_config._reset();
            // base64("alice:wonderland") == "YWxpY2U6d29uZGVybGFuZA=="
            expect(duracloud.build_auth_header()).toBe('Basic YWxpY2U6d29uZGVybGFuZA==');
        });

        it('handles non-ASCII chars in the password correctly (utf-8)', () => {
            process.env.DURACLOUD_API = 'duracloud.example/durastore/';
            process.env.DURACLOUD_USER = 'svc';
            process.env.DURACLOUD_PWD = 'pässwörd';
            app_config._reset();
            const header = duracloud.build_auth_header();
            const decoded = Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8');
            expect(decoded).toBe('svc:pässwörd');
        });
    });

    describe('mets_path', () => {
        it('builds the conventional METS path directly under <dip_path>/', () => {
            expect(duracloud.mets_path('sip-1', 'aabb/ccdd/folder-A')).toBe(
                'aabb/ccdd/folder-A/METS.sip-1.xml'
            );
        });

        it('throws when sip_uuid or dip_path is missing', () => {
            expect(() => duracloud.mets_path('', 'x')).toThrow();
            expect(() => duracloud.mets_path('x', '')).toThrow();
        });
    });

    describe('ping (Services Health probe)', () => {
        /*
         * Like the stream-fetch path, ping's HTTP behavior is left to
         * the e2e tier (axios isn't cleanly stub-able at the module
         * level here — see file header). What we CAN assert without a
         * network is the is_configured() short-circuit: an unconfigured
         * DuraCloud must resolve false, never throw, and never attempt
         * a request.
         */
        it('returns false when DuraCloud is not configured', async () => {
            // env vars cleared in beforeEach.
            await expect(duracloud.ping()).resolves.toBe(false);
        });
    });
});
