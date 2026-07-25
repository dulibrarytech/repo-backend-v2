'use strict';

/*
 * Render the workspace_table partial directly with ejs and assert the
 * structure-QA affordances (feature-batch-packaging-qa):
 *
 *   - staff-facing notices render with severity styling
 *   - "Needs attention" badge appears on blocked folders
 *   - Make Digital Objects action is a disabled <span> (not a link)
 *     for blocked folders, and stays a live link otherwise
 *   - Submit to Ingest is disabled for blocked folders in the
 *     packaging view
 *   - folders without the new fields (older callers/mocks) still render
 */

const path = require('node:path');
const ejs = require('ejs');

const PARTIAL = path.resolve(
    __dirname,
    '../../../views/dashboard/partials/workspace_table.ejs'
);

function render(locals) {
    return ejs.renderFile(
        PARTIAL,
        {
            dashboard_base: '/repo/dashboard',
            q: '',
            total_folders: (locals.folders || []).length,
            total_packages: 0,
            ...locals,
        },
        { async: false }
    );
}

const BLOCKED_FOLDER = {
    name: 'new_broken-resources_2',
    packages: [],
    structure_errors: [
        { code: 'loose_files', severity: 'error', items: ['scan1.tif'], total: 1 },
    ],
    structure_notices: [
        {
            severity: 'error',
            code: 'loose_files',
            text: '1 file is sitting directly inside the collection folder: scan1.tif. Move each file into its archival object folder.',
        },
    ],
    blocked: true,
};

const CLEAN_FOLDER = {
    name: 'new_clean-resources_1',
    packages: ['pkg_a'],
    structure_notices: [],
    blocked: false,
};

describe('workspace_table partial — structure-QA rendering', () => {
    it('renders notices + "Needs attention" badge for blocked folders', async () => {
        const html = await render({
            folders: [BLOCKED_FOLDER],
            view: 'make-digital-objects',
            actions: ['make_digital_objects'],
        });
        expect(html).toContain('Needs attention');
        expect(html).toContain('scan1.tif');
        expect(html).toContain('Move each file into its archival object folder');
        expect(html).toContain('structure-notice sev-error');
    });

    it('disables Make Digital Objects for blocked folders only', async () => {
        const html = await render({
            folders: [BLOCKED_FOLDER, CLEAN_FOLDER],
            view: 'make-digital-objects',
            actions: ['make_digital_objects'],
        });
        /*
         * Blocked folder: disabled span, no hx-post for it. Clean
         * folder: the live link remains. Count the hx-post occurrences —
         * exactly one (the clean folder's).
         */
        const mdo_posts = html.match(/hx-post="[^"]*\/make-digital-objects"/g) || [];
        expect(mdo_posts.length).toBe(1);
        expect(mdo_posts[0]).toContain(encodeURIComponent('new_clean-resources_1'));
        expect(html).toContain('Fix the folder structure problems listed for this folder first.');
    });

    it('disables Submit to Ingest for blocked folders in the packaging view', async () => {
        const html = await render({
            folders: [BLOCKED_FOLDER, CLEAN_FOLDER],
            view: 'packaging-and-ingesting',
            actions: ['submit_ingest', 'revert_to_mdo'],
            ingest_in_progress: false,
            ingest_in_progress_count: 0,
        });
        const submit_posts = html.match(/hx-post="[^"]*\/submit-ingest"/g) || [];
        expect(submit_posts.length).toBe(1);
        expect(submit_posts[0]).toContain(encodeURIComponent('new_clean-resources_1'));
    });

    it('renders folders without structure fields unchanged (legacy shape)', async () => {
        const html = await render({
            folders: [{ name: 'new_legacy-resources_9', packages: ['pkg_a'] }],
            view: 'make-digital-objects',
            actions: ['make_digital_objects'],
        });
        expect(html).toContain('new_legacy-resources_9');
        expect(html).not.toContain('Needs attention');
        const mdo_posts = html.match(/hx-post="[^"]*\/make-digital-objects"/g) || [];
        expect(mdo_posts.length).toBe(1);
    });

    it('empty folder with notices shows the notices, not the bare "No packages" stub', async () => {
        const html = await render({
            folders: [BLOCKED_FOLDER],
            view: 'make-digital-objects',
            actions: ['make_digital_objects'],
        });
        expect(html).not.toContain('<em>No packages</em>');
    });
});
