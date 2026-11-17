'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const { STATE_LABELS } = require('../../../aspace_links/controller');

const ROOT = path.join(__dirname, '..', '..', '..');
const PAGE = path.join(ROOT, 'views', 'dashboard', 'admin', 'aspace_links.ejs');
const PARTIAL = path.join(ROOT, 'views', 'dashboard', 'partials', 'aspace_links_status.ejs');
const SCRIPT = path.join(ROOT, 'public', 'assets', 'dashboard.js');

const STALL = 'ArchivesSpace could not list /repositories/2/archival_objects (HTTP 503)';
const OTHER_STALL = '5 updates in a row failed. Last: HTTP 503';

function status_locals(waiting_error) {
    return {
        dashboard_base: '/repo/dashboard',
        table_missing: false,
        summary: { waiting: 3, checked: 9, states: {}, last_checked_at: null, waiting_error },
        labels: STATE_LABELS,
        worker_enabled: true,
        writes_enabled: true,
        writes_requested: true,
    };
}

async function mount(waiting_error = null) {
    const html = await ejs.renderFile(PAGE, {
        ...status_locals(waiting_error),
        rows: [],
        total: 0,
        state_filter: '',
    });
    const dom = new JSDOM(
        `<!doctype html><body data-dashboard-base="/repo/dashboard">${html}</body>`,
        {
            runScripts: 'outside-only',
            url: 'http://localhost/repo/dashboard/admin/aspace-links',
        }
    );
    dom.window.htmx = { process() {} };
    dom.window.eval(fs.readFileSync(SCRIPT, 'utf8'));
    return dom;
}

async function refresh(dom, waiting_error, id = 'aspace-links-status') {
    const target = dom.window.document.getElementById(id);
    target.innerHTML = await ejs.renderFile(PARTIAL, status_locals(waiting_error));
    target.dispatchEvent(
        new dom.window.CustomEvent('htmx:afterSwap', { bubbles: true, detail: { target } })
    );
}

const announced = (dom) => dom.window.document.getElementById('aspace-links-announce').textContent;

describe('Admin > ArchivesSpace Links stall announcement', () => {
    it('announces a stall that appears while the page is open, once', async () => {
        const dom = await mount();
        expect(announced(dom)).toBe('');

        await refresh(dom, STALL);
        expect(announced(dom)).toBe(
            `The last check could not be completed. It will be tried again in a few minutes. ${STALL}`
        );

        dom.window.document.getElementById('aspace-links-announce').textContent = '';
        await refresh(dom, STALL);
        expect(announced(dom)).toBe('');
    });

    it('leaves the stall the page opened with to the page itself', async () => {
        const dom = await mount(STALL);
        await refresh(dom, STALL);
        expect(announced(dom)).toBe('');
    });

    it('announces a different stall, and the same one again after it cleared', async () => {
        const dom = await mount(STALL);
        await refresh(dom, OTHER_STALL);
        expect(announced(dom)).toContain(OTHER_STALL);

        await refresh(dom, null);
        expect(announced(dom)).toBe('');

        await refresh(dom, OTHER_STALL);
        expect(announced(dom)).toContain(OTHER_STALL);
    });

    it('ignores swaps elsewhere on the page', async () => {
        const dom = await mount();
        await refresh(dom, STALL, 'aspace-links-list');
        expect(announced(dom)).toBe('');
    });
});
