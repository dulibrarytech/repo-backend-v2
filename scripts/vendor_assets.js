#!/usr/bin/env node
'use strict';

/*
 * Copies vendored client assets from node_modules into public/assets so the
 * app serves everything itself (CSP self-only, no CDNs — the dashboard must
 * stay usable when the VM has no outside network). Versions are pinned as
 * exact devDependencies; bumping one is: npm i -D -E <pkg>@<ver> && npm run
 * vendor, then commit the copied files.
 *
 * Run after npm install / a dependency bump:
 *   npm run vendor
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const ASSETS = [
    // Bootstrap 5 (css + bundle js, with sourcemaps)
    ['node_modules/bootstrap/dist/css/bootstrap.min.css', 'public/assets/vendor/bootstrap.min.css'],
    ['node_modules/bootstrap/dist/css/bootstrap.min.css.map', 'public/assets/vendor/bootstrap.min.css.map'],
    ['node_modules/bootstrap/dist/js/bootstrap.bundle.min.js', 'public/assets/vendor/bootstrap.bundle.min.js'],
    ['node_modules/bootstrap/dist/js/bootstrap.bundle.min.js.map', 'public/assets/vendor/bootstrap.bundle.min.js.map'],
    // HTMX
    ['node_modules/htmx.org/dist/htmx.min.js', 'public/assets/vendor/htmx.min.js'],
    // Open Sans (weights referenced by public/assets/styles.css @font-face rules)
    ['node_modules/@fontsource/open-sans/files/open-sans-latin-300-normal.woff2', 'public/assets/fonts/open-sans/open-sans-latin-300-normal.woff2'],
    ['node_modules/@fontsource/open-sans/files/open-sans-latin-400-normal.woff2', 'public/assets/fonts/open-sans/open-sans-latin-400-normal.woff2'],
    ['node_modules/@fontsource/open-sans/files/open-sans-latin-600-normal.woff2', 'public/assets/fonts/open-sans/open-sans-latin-600-normal.woff2'],
    ['node_modules/@fontsource/open-sans/files/open-sans-latin-700-normal.woff2', 'public/assets/fonts/open-sans/open-sans-latin-700-normal.woff2'],
];

function vendor() {
    let failed = false;
    for (const [src, dest] of ASSETS) {
        const src_path = path.join(ROOT, src);
        const dest_path = path.join(ROOT, dest);

        if (!fs.existsSync(src_path)) {
            console.error(`MISSING: ${src} — run npm install first.`);
            failed = true;
            continue;
        }

        fs.mkdirSync(path.dirname(dest_path), { recursive: true });
        fs.copyFileSync(src_path, dest_path);
        console.log(`vendored ${dest}`);
    }
    return failed;
}

if (require.main === module) {
    if (vendor()) process.exitCode = 1;
}

module.exports = { ASSETS, vendor };
