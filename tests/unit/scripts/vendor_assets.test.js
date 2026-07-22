'use strict';

/*
 * Guards the vendor-assets manifest: every source must exist in
 * node_modules (catches a dependency rename/removal on upgrade) and
 * every destination must land under public/assets — the self-hosted,
 * CSP-safe asset root the views reference.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ASSETS } = require('../../../scripts/vendor_assets');

const ROOT = path.join(__dirname, '..', '..', '..');

describe('scripts/vendor_assets', () => {
    it('every manifest source exists in node_modules', () => {
        const missing = ASSETS.filter(([src]) => !fs.existsSync(path.join(ROOT, src)));
        expect(missing.map(([src]) => src)).toEqual([]);
    });

    it('every destination is under public/assets/', () => {
        for (const [, dest] of ASSETS) {
            expect(dest.startsWith('public/assets/')).toBe(true);
        }
    });

    it('covers the files the views and styles reference', () => {
        const dests = ASSETS.map(([, d]) => d);
        for (const required of [
            'public/assets/vendor/bootstrap.min.css',
            'public/assets/vendor/bootstrap.bundle.min.js',
            'public/assets/vendor/htmx.min.js',
            'public/assets/fonts/open-sans/open-sans-latin-400-normal.woff2',
        ]) {
            expect(dests).toContain(required);
        }
    });
});
