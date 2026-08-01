#!/usr/bin/env node
'use strict';

/*
 * Captures the dashboard screenshots used in README.md. Drives a headless
 * Chromium at a fixed 1440x900 viewport so every shot crops identically —
 * pass --full to capture the entire scroll height instead of the fold.
 *
 * Playwright is NOT a dependency here (it would follow package.json onto the
 * deploy target for no runtime benefit). The binary is borrowed from the
 * exhibits-backend install, which pins 1.59.1; override with PLAYWRIGHT_DIR
 * if that tree moves.
 *
 * Auth: POSTs a DU ID to the dashboard's script-only login route, which is
 * the one path that still issues a repo_session cookie without SSO. The user
 * must exist and be active in tbl_users.
 *
 * Usage (app already running on APP_PORT):
 *   node scripts/screenshots.js
 *   node scripts/screenshots.js --full
 *   node scripts/screenshots.js --only 02-objects --retina
 *   BASE_URL=https://localhost/repo node scripts/screenshots.js
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');

const PLAYWRIGHT_DIR =
    process.env.PLAYWRIGHT_DIR ||
    path.join(ROOT, '..', '..', 'exhibits', 'exhibits-backend', 'node_modules', 'playwright');

const APP_PATH = process.env.APP_PATH || '';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.APP_PORT || 8765}${APP_PATH}`).replace(/\/$/, '');
const DU_ID = process.env.SCREENSHOT_DU_ID || process.env.DU_ID || '';

const VIEWPORT = { width: 1440, height: 900 };

/*
 * README order. `wait` is a selector that must be present before the shot —
 * the dashboard fills most panels over HTMX, so networkidle alone races the
 * swap and captures empty cards.
 */
const TARGETS = [
    { name: '01-dashboard-home', url: '/dashboard/', wait: '#recent-ingests, .card' },
    { name: '02-objects', url: '/dashboard/objects', wait: 'table tbody tr' },
    { name: '03-ingest-workspace', url: '/dashboard/ingest/workspace', wait: '.card' },
    { name: '04-aips', url: '/dashboard/aips', wait: 'table tbody tr' },
    { name: '05-services-health', url: '/dashboard/admin/services', wait: '.card' },
];

function arg_flag(name) {
    return process.argv.includes(`--${name}`);
}

function arg_value(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 ? process.argv[i + 1] : null;
}

async function login(request) {
    if (!DU_ID) {
        throw new Error('Set SCREENSHOT_DU_ID to an active tbl_users du_id (SSO cannot be driven headlessly).');
    }

    const res = await request.post(`${BASE_URL}/dashboard/login`, {
        form: { du_id: DU_ID },
        maxRedirects: 0,
        failOnStatusCode: false,
    });

    /* 303 = credential accepted; 200 = the login partial came back with an error. */
    if (res.status() !== 303 && res.status() !== 204) {
        throw new Error(`Login failed (HTTP ${res.status()}) — is "${DU_ID}" active in tbl_users?`);
    }
}

async function main() {
    const { chromium } = require(PLAYWRIGHT_DIR);

    const only = arg_value('only');
    const full_page = arg_flag('full');
    const targets = only ? TARGETS.filter((t) => t.name.includes(only)) : TARGETS;

    if (targets.length === 0) {
        throw new Error(`No target matched "${only}". Known: ${TARGETS.map((t) => t.name).join(', ')}`);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const browser = await chromium.launch();
    const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: arg_flag('retina') ? 2 : 1,
        /* The nginx reverse proxy in front of :8765 uses a self-signed cert. */
        ignoreHTTPSErrors: true,
    });

    try {
        await login(context.request);

        const page = await context.newPage();

        for (const target of targets) {
            const url = `${BASE_URL}${target.url}`;
            await page.goto(url, { waitUntil: 'networkidle' });

            if (target.wait) {
                await page.waitForSelector(target.wait, { timeout: 15000 }).catch(() => {
                    console.warn(`  ! "${target.wait}" never appeared on ${url} — shooting anyway`);
                });
            }

            const file = path.join(OUT_DIR, `${target.name}.png`);
            await page.screenshot({ path: file, fullPage: full_page });
            console.log(`✓ ${path.relative(ROOT, file)}`);
        }
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
});
