'use strict';

/*
 * Handle-link tooltips (Admin > Handles).
 *
 * The interesting part is not "a tooltip appears" — it is the swap
 * lifecycle. #handles-list is replaced by htmx on mint, delete and the
 * status filter, so tooltips must be re-initialised on the new rows and
 * disposed on the old ones. Skipping the dispose strands a bubble in the
 * body when a row is replaced while its tooltip is showing, which is
 * exactly what clicking Delete mid-hover does.
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
        created_by_label: 'Fernando Reyes',
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

/*
 * Stand-in for Bootstrap's Tooltip, recording what the page asks of it.
 */
function fake_bootstrap() {
    const instances = new Map();
    const calls = { created: [], disposed: [], hidden: [] };

    class Tooltip {
        constructor(el, opts) { this.el = el; this.opts = opts; }
        dispose() { instances.delete(this.el); calls.disposed.push(this.el); }
        hide() { calls.hidden.push(this.el); }
        static getOrCreateInstance(el, opts) {
            if (!instances.has(el)) {
                instances.set(el, new Tooltip(el, opts));
                calls.created.push({ el, opts });
            }
            return instances.get(el);
        }
        static getInstance(el) { return instances.get(el) || null; }
    }

    return { api: { Tooltip }, calls };
}

async function mount(rows, { with_bootstrap = true } = {}) {
    const html = await render(rows);
    const dom = new JSDOM(
        `<!doctype html><body data-dashboard-base="/repo/dashboard">
            <div id="handles-list">${html}</div>
        </body>`,
        /*
         * a real origin: dashboard.js touches localStorage, which jsdom
         * refuses on the default opaque origin 
         */
        { runScripts: 'outside-only', url: 'http://localhost/repo/dashboard/admin/handles' }
    );
    dom.window.htmx = { process() {} };
    const fake = fake_bootstrap();
    if (with_bootstrap) dom.window.bootstrap = fake.api;
    dom.window.eval(fs.readFileSync(SCRIPT, 'utf8'));
    return { dom, calls: fake.calls };
}

const links = (dom) => dom.window.document.querySelectorAll('a.handle-link');

describe('Admin > Handles link tooltips', () => {
    it('marks a minted handle link up for a tooltip carrying the resolver URL', async () => {
        const { dom } = await mount([row()]);
        const link = links(dom)[0];

        expect(link.getAttribute('data-bs-toggle')).toBe('tooltip');
        expect(link.getAttribute('title')).toContain('https://hdl.handle.net/10176/');
        expect(link.getAttribute('title')).toContain('opens in a new tab');
        /* the link really does open elsewhere, so say so and protect it */
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('gives a row that never minted no link and no tooltip', async () => {
        const { dom } = await mount([
            row({ status: 'failed', message: 'AUTHENTICATION FAILED' }),
        ]);
        expect(links(dom)).toHaveLength(0);
        expect(dom.window.document.querySelectorAll('[data-bs-toggle="tooltip"]'))
            .toHaveLength(0);
    });

    it('initialises the prominent tooltip on load', async () => {
        const { calls } = await mount([row()]);
        expect(calls.created).toHaveLength(1);
        expect(calls.created[0].opts.customClass).toBe('handle-tooltip');
        expect(calls.created[0].opts.placement).toBe('top');
    });

    it('initialises tooltips on rows that arrive via a swap', async () => {
        const { dom, calls } = await mount([row()]);
        const container = dom.window.document.getElementById('handles-list');

        container.innerHTML = await render([row({ id: 2 }), row({ id: 3 })]);
        container.dispatchEvent(new dom.window.CustomEvent('htmx:afterSwap', {
            bubbles: true,
            detail: { target: container },
        }));

        /* one from load, two from the swapped-in rows */
        expect(calls.created).toHaveLength(3);
    });

    /*
     * Without this, a tooltip showing when its row is replaced is left
     * anchored to a detached node — a bubble stranded mid-page.
     */
    it('disposes tooltips before their rows are swapped away', async () => {
        const { dom, calls } = await mount([row()]);
        const container = dom.window.document.getElementById('handles-list');
        const link = links(dom)[0];

        container.dispatchEvent(new dom.window.CustomEvent('htmx:beforeSwap', {
            bubbles: true,
            detail: { target: container },
        }));

        expect(calls.disposed).toContain(link);
    });

    /* WCAG 2.1 SC 1.4.13: hover/focus content must be dismissible in place. */
    it('hides a visible tooltip on Escape', async () => {
        const { dom, calls } = await mount([row()]);
        const doc = dom.window.document;
        const link = links(dom)[0];

        /* mimic Bootstrap having shown one */
        const bubble = doc.createElement('div');
        bubble.className = 'tooltip';
        bubble.id = 'tooltip-1';
        doc.body.appendChild(bubble);
        link.setAttribute('aria-describedby', 'tooltip-1');

        doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
        expect(calls.hidden).toContain(link);
    });

    /*
     * "Minted by" shows the staff member's name; created_by (the du_id) is
     * the stored key and stays available as the native tooltip.
     */
    it('shows the minter\'s name with the du_id as its tooltip', async () => {
        const { dom } = await mount([row()]);
        const cells = Array.from(dom.window.document.querySelectorAll('td'));
        const cell = cells.find((td) => td.textContent.trim() === 'Fernando Reyes');

        expect(cell).toBeDefined();
        expect(cell.getAttribute('title')).toBe('871095226');
    });

    /*
     * No user record resolved: show the du_id itself, without a redundant
     * tooltip repeating it. 
     */
    it('falls back to the du_id when no name resolves', async () => {
        const { dom } = await mount([
            row({ created_by: '999999999', created_by_label: '999999999' }),
        ]);
        const cells = Array.from(dom.window.document.querySelectorAll('td'));
        const cell = cells.find((td) => td.textContent.trim() === '999999999');

        expect(cell).toBeDefined();
        expect(cell.getAttribute('title')).toBeNull();
    });

    /* Progressive enhancement: the native title still works without JS. */
    it('does not throw when Bootstrap is unavailable', async () => {
        const { dom } = await mount([row()], { with_bootstrap: false });
        expect(links(dom)[0].getAttribute('title')).toContain('hdl.handle.net');
    });
});
