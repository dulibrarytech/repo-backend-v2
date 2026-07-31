'use strict';

/*
 * Admin > Handles mint form: the repeatable-row behaviour in
 * public/assets/dashboard.js.
 *
 * Driven through jsdom against the REAL rendered template, so the test
 * breaks if the markup and the script drift apart — the failure mode that
 * matters here, since the script reaches into the DOM by class and id.
 *
 * Focus and the live region are asserted, not just the row count: they are
 * the whole reason this is more than `appendChild`. A sighted mouse user
 * sees a row appear; a keyboard or screen-reader user gets nothing at all
 * unless focus moves and the change is announced.
 */

const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', '..');
const VIEW = path.join(ROOT, 'views', 'dashboard', 'admin', 'handles.ejs');
const SCRIPT = path.join(ROOT, 'public', 'assets', 'dashboard.js');

const LOCALS = {
    dashboard_base: '/repo/dashboard',
    rows: [],
    status_filter: '',
    statuses: ['minted'],
    max_per_submission: 5,
    allowed_hosts: ['du.edu'],
    configured: true,
    handle_prefix: '10176',
};

async function mount() {
    const html = await ejs.renderFile(VIEW, LOCALS);
    const dom = new JSDOM(
        `<!doctype html><body data-dashboard-base="/repo/dashboard">${html}</body>`,
        /*
         * outside-only: window.eval gets a real script context, but nothing
         * in the markup itself is executed. 
         */
        { runScripts: 'outside-only' }
    );
    /* dashboard.js bails out early without htmx; it is only used for events. */
    dom.window.htmx = { process() {} };
    dom.window.eval(fs.readFileSync(SCRIPT, 'utf8'));
    return dom;
}

const rows = (d) => d.window.document.querySelectorAll('.handle-row');
const add_btn = (d) => d.window.document.getElementById('handle-add-row');
const status = (d) => d.window.document.getElementById('handle-rows-status').textContent;
const focused = (d) => d.window.document.activeElement;

describe('Admin > Handles mint form rows', () => {
    it('starts with a single row and reveals the add control', async () => {
        const d = await mount();
        expect(rows(d)).toHaveLength(1);
        expect(add_btn(d).hidden).toBe(false);
        expect(add_btn(d).disabled).toBe(false);
    });

    /*
     * Nothing to remove when it is the only row — a dead control is worse
     * than no control. 
     */
    it('hides Remove while only one row exists', async () => {
        const d = await mount();
        expect(rows(d)[0].querySelector('.handle-row-remove').hidden).toBe(true);
    });

    it('adds a row, moves focus into it, and announces the change', async () => {
        const d = await mount();
        add_btn(d).click();

        expect(rows(d)).toHaveLength(2);
        expect(focused(d).id).toBe('target-2');
        expect(status(d)).toBe('Handle 2 added. 3 more can be added.');
    });

    it('gives the new row its own ids and bound labels', async () => {
        const d = await mount();
        add_btn(d).click();

        const second = rows(d)[1];
        expect(second.querySelector('input[name="target_url"]').id).toBe('target-2');
        expect(second.querySelector('label[data-for="target"]').getAttribute('for')).toBe('target-2');
        expect(second.querySelector('label[data-for="target"]').textContent.trim())
            .toBe('Target URL 2');
        expect(second.querySelector('.handle-row-remove').getAttribute('aria-label'))
            .toBe('Remove handle 2');
    });

    it('does not carry the first row\'s values into the clone', async () => {
        const d = await mount();
        rows(d)[0].querySelector('input[name="target_url"]').value = 'https://du.edu/a';
        rows(d)[0].querySelector('input[name="note"]').value = 'first';
        add_btn(d).click();

        expect(rows(d)[1].querySelector('input[name="target_url"]').value).toBe('');
        expect(rows(d)[1].querySelector('input[name="note"]').value).toBe('');
        /* and the original is untouched */
        expect(rows(d)[0].querySelector('input[name="target_url"]').value).toBe('https://du.edu/a');
    });

    it('shows Remove on every row once there is more than one', async () => {
        const d = await mount();
        add_btn(d).click();
        rows(d).forEach((row) => {
            expect(row.querySelector('.handle-row-remove').hidden).toBe(false);
        });
    });

    it('stops at the maximum and says so', async () => {
        const d = await mount();
        for (let i = 0; i < 4; i++) add_btn(d).click();

        expect(rows(d)).toHaveLength(5);
        expect(add_btn(d).disabled).toBe(true);
        expect(status(d)).toBe('Handle 5 added. Maximum of 5 reached.');

        add_btn(d).click();
        expect(rows(d)).toHaveLength(5);
    });

    it('removes a row, renumbers what is left, and re-enables adding', async () => {
        const d = await mount();
        for (let i = 0; i < 4; i++) add_btn(d).click();
        expect(add_btn(d).disabled).toBe(true);

        rows(d)[2].querySelector('.handle-row-remove').click();

        expect(rows(d)).toHaveLength(4);
        expect(add_btn(d).disabled).toBe(false);
        expect(status(d)).toBe('Handle 3 removed. 4 remaining.');
        /* ids are contiguous again, so "Remove handle 3" names row 3 */
        const ids = Array.from(rows(d)).map((r) =>
            r.querySelector('input[name="target_url"]').id);
        expect(ids).toEqual(['target-1', 'target-2', 'target-3', 'target-4']);
    });

    it('lands focus on the row above the one removed', async () => {
        const d = await mount();
        add_btn(d).click();
        add_btn(d).click();

        rows(d)[2].querySelector('.handle-row-remove').click();
        expect(focused(d).id).toBe('target-2');
    });

    it('keeps focus in the form when the first row is removed', async () => {
        const d = await mount();
        add_btn(d).click();

        rows(d)[0].querySelector('.handle-row-remove').click();
        expect(rows(d)).toHaveLength(1);
        expect(focused(d).id).toBe('target-1');
    });

    /*
     * Fired by the mint POST via HX-Trigger, and only on a fully successful
     * mint — see handles_controller. Guards against a second click minting a
     * duplicate handle for the same page.
     */
    it('resets to one empty row on handles-reset', async () => {
        const d = await mount();
        add_btn(d).click();
        add_btn(d).click();
        rows(d)[0].querySelector('input[name="target_url"]').value = 'https://du.edu/a';

        d.window.document.body.dispatchEvent(
            new d.window.CustomEvent('handles-reset', { bubbles: true })
        );

        expect(rows(d)).toHaveLength(1);
        expect(rows(d)[0].querySelector('input[name="target_url"]').value).toBe('');
        expect(rows(d)[0].querySelector('.handle-row-remove').hidden).toBe(true);
        expect(add_btn(d).disabled).toBe(false);
    });
});
