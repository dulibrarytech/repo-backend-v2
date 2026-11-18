'use strict';

const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const PARTIAL = path.resolve(__dirname, '../../../views/dashboard/partials/ingest_row.ejs');

function base_row(over) {
    return {
        id: 7,
        package: 'D009.22.0007.0041.00001',
        batch: 'new_U358_LDT',
        sip_uuid: '8fd73006-4c1c-478a-989f-153cb8afdf13',
        pipeline_state: 'COMPLETE',
        severity: 'INFO',
        suggested_action: 'Ingest Complete',
        created: '2026-11-17T12:29:35Z',
        actions: [],
        bytes_uploaded: 0,
        total_bytes: 0,
        ...over,
    };
}

async function details_cell(over) {
    const html = await ejs.renderFile(PARTIAL, {
        dashboard_base: '/repo/dashboard',
        row: base_row(over),
    });
    const dom = new JSDOM(`<table><tbody>${html}</tbody></table>`);
    return dom.window.document.querySelectorAll(`#queue-row-7 > td`)[2];
}

describe('ingest_row ArchivesSpace link line', () => {
    it('shows the line under the details, with its style', async () => {
        const cell = await details_cell({
            aspace_link: {
                text: 'ArchivesSpace link: not added — contact LDT',
                css: 'fw-semibold',
            },
        });
        expect(cell.textContent).toContain('Ingest Complete');
        const line = cell.querySelector('div.small.fw-semibold');
        expect(line.textContent.trim()).toBe('ArchivesSpace link: not added — contact LDT');
    });

    it('shows no line when the row has none', async () => {
        for (const over of [{ aspace_link: null }, {}]) {
            const cell = await details_cell(over);
            expect(cell.textContent).toContain('Ingest Complete');
            expect(cell.textContent).not.toContain('ArchivesSpace link');
        }
    });
});
