'use strict';

/*
 * Copy-to-clipboard on minted handles (Admin > Handles).
 *
 * What matters beyond "it calls writeText": that it copies the RESOLVER url
 * rather than the bare handle (staff paste these into other sites, where
 * "10176/<uuid>" is not clickable), that a failure is never silent, and that
 * the buttons keep working after htmx replaces the table — the handler is
 * delegated precisely so nothing needs re-initialising.
 */

const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', '..');
const PARTIAL = path.join(ROOT, 'views', 'dashboard', 'partials', 'handles_list.ejs');
const SCRIPT = path.join(ROOT, 'public', 'assets', 'dashboard.js');

function row(overrides) {
    return {
        id: 1,
        handle: '10176/6940110d-832c-4c53-a87d-5a14bf0f237e',
        suffix: '6940110d-832c-4c53-a87d-5a14bf0f237e',
        target_url: 'https://exhibits.library.du.edu/exhibit/abc',
        note: 'handle mint test',
        status: 'minted',
        message: null,
        created_by: '871095226',
        linked_pid: null,
        resolver_url: 'https://hdl.handle.net/10176/6940110d-832c-4c53-a87d-5a14bf0f237e',
        ...overrides,
    };
}

function render(rows) {
    return ejs.renderFile(PARTIAL, {
        dashboard_base: '/repo/dashboard',
        status_filter: '',
        statuses: ['minted'],
        rows,
    }, { filename: PARTIAL });
}

async function mount(rows, { clipboard = 'ok' } = {}) {
    const html = await render(rows);
    const dom = new JSDOM(
        `<!doctype html><body data-dashboard-base="/repo/dashboard">
            <div id="handles-list">${html}</div>
            <p id="handles-copy-status" class="visually-hidden" role="status" aria-live="polite"></p>
        </body>`,
        { runScripts: 'outside-only', url: 'http://localhost/repo/dashboard/admin/handles' }
    );
    dom.window.htmx = { process() {} };

    const written = [];
    if (clipboard !== 'absent') {
        Object.defineProperty(dom.window.navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText(text) {
                    written.push(text);
                    return clipboard === 'ok'
                        ? Promise.resolve()
                        : Promise.reject(new Error('permission denied'));
                },
            },
        });
    }
    Object.defineProperty(dom.window, 'isSecureContext', {
        configurable: true,
        value: clipboard !== 'absent',
    });

    dom.window.eval(fs.readFileSync(SCRIPT, 'utf8'));

    /* Capture the restore timer so the 1.6s wait need not be real. */
    const timers = [];
    dom.window.setTimeout = function (fn) { timers.push(fn); return timers.length; };
    dom.window.clearTimeout = function () {};

    return { dom, written, timers };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const copy_btns = (dom) => dom.window.document.querySelectorAll('.handle-copy');
const announced = (dom) =>
    dom.window.document.getElementById('handles-copy-status').textContent;

describe('Admin > Handles copy to clipboard', () => {
    it('offers Copy on a minted handle, naming it for screen readers', async () => {
        const { dom } = await mount([row()]);
        const btn = copy_btns(dom)[0];

        expect(btn.getAttribute('aria-label'))
            .toBe('Copy link for 10176/6940110d-832c-4c53-a87d-5a14bf0f237e to clipboard');
        expect(btn.textContent.trim()).toBe('Copy');
    });

    /*
     * A pending or failed row's handle does not resolve. Distributing a dead
     * identifier is worse than not copying at all.
     */
    it.each([
        ['failed', { status: 'failed', message: 'AUTHENTICATION FAILED' }],
        ['pending', { status: 'pending' }],
    ])('offers no Copy on a %s row', async (_label, overrides) => {
        const { dom } = await mount([row(overrides)]);
        expect(copy_btns(dom)).toHaveLength(0);
    });

    /* Still copyable when linked — only deletion is blocked in that case. */
    it('offers Copy on a handle that is in use by an object', async () => {
        const { dom } = await mount([row({ linked_pid: 'pid-9' })]);
        expect(copy_btns(dom)).toHaveLength(1);
        expect(dom.window.document.querySelectorAll('.btn-outline-danger')).toHaveLength(0);
    });

    it('copies the resolver URL, not the bare handle', async () => {
        const { dom, written } = await mount([row()]);
        copy_btns(dom)[0].click();
        await settle();

        expect(written).toEqual([
            'https://hdl.handle.net/10176/6940110d-832c-4c53-a87d-5a14bf0f237e',
        ]);
    });

    it('confirms inline and announces the copy', async () => {
        const { dom, timers } = await mount([row()]);
        const btn = copy_btns(dom)[0];

        btn.click();
        await settle();

        expect(btn.textContent).toBe('Copied');
        expect(announced(dom)).toContain('Copied https://hdl.handle.net/10176/');

        timers.forEach((fn) => fn());
        expect(btn.textContent).toBe('Copy');
    });

    /*
     * Clicking again while the label still reads "Copied" must not make
     * "Copied" the label it restores to.
     */
    it('restores the original label after repeated clicks', async () => {
        const { dom, timers } = await mount([row()]);
        const btn = copy_btns(dom)[0];

        btn.click();
        await settle();
        btn.click();
        await settle();

        timers.forEach((fn) => fn());
        expect(btn.textContent).toBe('Copy');
    });

    /*
     * Silently copying nothing is the worst outcome — the operator would
     * paste stale clipboard content somewhere public.
     */
    it('raises a toast and announces when the clipboard is refused', async () => {
        const { dom } = await mount([row()], { clipboard: 'reject' });
        const btn = copy_btns(dom)[0];

        btn.click();
        await settle();

        expect(btn.textContent.trim()).toBe('Copy');
        expect(announced(dom)).toBe('Could not copy the handle.');
        const toast = dom.window.document.querySelector('#toast-stack');
        expect(toast && toast.textContent).toMatch(/Could not copy/);
    });

    /* Delegated from document, so swapped-in rows need no re-init. */
    it('keeps working on rows that arrive via an htmx swap', async () => {
        const { dom, written } = await mount([row()]);
        const container = dom.window.document.getElementById('handles-list');

        container.innerHTML = await render([
            row({ id: 2, resolver_url: 'https://hdl.handle.net/10176/second' }),
        ]);
        copy_btns(dom)[0].click();
        await settle();

        expect(written).toEqual(['https://hdl.handle.net/10176/second']);
    });
});
