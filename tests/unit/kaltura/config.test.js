'use strict';

// Unit tests for kaltura/config — is_configured() boolean predicate.

const config = require('../../../kaltura/config');
const app_config = require('../../../config/app');

describe('kaltura/config — is_configured', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        delete process.env.KALTURA_PARTNER_ID;
        delete process.env.KALTURA_USER_ID;
        delete process.env.KALTURA_SECRET_KEY;
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    it('returns false when nothing is set', () => {
        expect(config.is_configured()).toBe(false);
    });

    it('returns false when only one or two of the three creds are set', () => {
        process.env.KALTURA_PARTNER_ID = '12345';
        app_config._reset();
        expect(config.is_configured()).toBe(false);
        process.env.KALTURA_USER_ID = 'admin';
        app_config._reset();
        expect(config.is_configured()).toBe(false);
    });

    it('returns true when all three creds are set', () => {
        process.env.KALTURA_PARTNER_ID = '12345';
        process.env.KALTURA_USER_ID = 'admin';
        process.env.KALTURA_SECRET_KEY = 'secret-xyz';
        app_config._reset();
        expect(config.is_configured()).toBe(true);
    });

    it('returns the configured block from get()', () => {
        process.env.KALTURA_PARTNER_ID = '999';
        process.env.KALTURA_USER_ID = 'u';
        process.env.KALTURA_SECRET_KEY = 's';
        app_config._reset();
        const cfg = config.get();
        expect(cfg.partner_id).toBe('999');
        expect(cfg.user_id).toBe('u');
        expect(cfg.secret_key).toBe('s');
    });
});
