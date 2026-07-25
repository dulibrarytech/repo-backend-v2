'use strict';

/*
 * Unit tests for the batch structure-QA pass-through and gating
 * (feature-batch-packaging-qa).
 *
 * Covers:
 *   - libs/structure_flags: staff wording, the "and N more" cap phrase,
 *     blocking detection, unknown-code fallback (version-skew safety).
 *   - workspace.list_workspace: consumes enriched /workspace entries
 *     (embedded packages + structure_errors → no per-folder fetch),
 *     still supports legacy flat-name entries, and picks up piggybacked
 *     flags from the per-folder packages fetch for the /processed scope.
 *   - workspace.run_make_digital_objects: refuses (422) when the folder
 *     has error-severity flags; fails OPEN when the structure check is
 *     unavailable (older curation-service / transport error).
 *   - workspace.submit_to_ingest: same refusal before any queue insert.
 */

const structure_flags = require('../../../ingester/libs/structure_flags');
const workspace = require('../../../ingester/workspace');

const LOOSE_FLAG = {
    code: 'loose_files',
    severity: 'error',
    items: ['scan1.tif', 'notes.docx'],
    total: 2,
};

function make_astools({ workspace_data, packages_data, packages_status = 200 } = {}) {
    const calls = { list_workspace: 0, list_packages: [], make_digital_objects: [] };
    return {
        calls,
        is_configured: () => true,
        async list_workspace() {
            calls.list_workspace += 1;
            return { status: 200, data: workspace_data };
        },
        async list_processed() {
            return { status: 200, data: workspace_data };
        },
        async list_packages(folder) {
            calls.list_packages.push(folder);
            if (packages_data && packages_data.throw) throw new Error(packages_data.throw);
            return { status: packages_status, data: packages_data };
        },
        async make_digital_objects(folder) {
            calls.make_digital_objects.push(folder);
            return { status: 200, data: { result: { success: true }, errors: [] } };
        },
    };
}

describe('ingester/libs/structure_flags', () => {
    it('formats loose_files with actionable wording', () => {
        const [notice] = structure_flags.format_structure_errors([LOOSE_FLAG], 'new_x-resources_1');
        expect(notice.severity).toBe('error');
        expect(notice.text).toContain('scan1.tif');
        expect(notice.text).toContain('directly inside the collection folder');
        expect(notice.text).toContain('Move each file into its archival object folder');
    });

    it('appends "and N more" when items were capped server-side', () => {
        const flag = { ...LOOSE_FLAG, items: ['a.tif'], total: 41 };
        const [notice] = structure_flags.format_structure_errors([flag], 'f');
        expect(notice.text).toContain('a.tif (and 40 more)');
        expect(notice.text).toContain('41 files are');
    });

    it('renders bad_folder_name subcodes as one naming rule', () => {
        const flag = {
            code: 'bad_folder_name',
            severity: 'error',
            items: ['missing_new_prefix', 'missing_resources_id_tail'],
            total: 2,
        };
        const [notice] = structure_flags.format_structure_errors([flag], 'my_folder');
        expect(notice.text).toContain('"my_folder"');
        expect(notice.text).toContain('start with "new_"');
        expect(notice.text).toContain('ArchivesSpace resource number');
    });

    it('degrades unknown codes to a generic-but-visible message', () => {
        const flag = { code: 'brand_new_check', severity: 'error', items: ['x'], total: 1 };
        const [notice] = structure_flags.format_structure_errors([flag], 'f');
        expect(notice.text).toContain('brand_new_check');
        expect(notice.severity).toBe('error');
    });

    it('has_blocking_errors keys off error severity only', () => {
        expect(structure_flags.has_blocking_errors([LOOSE_FLAG])).toBe(true);
        expect(
            structure_flags.has_blocking_errors([
                { code: 'name_hygiene', severity: 'warn', items: [], total: 0 },
                { code: 'partially_processed', severity: 'info', items: [], total: 0 },
            ])
        ).toBe(false);
        expect(structure_flags.has_blocking_errors([])).toBe(false);
        expect(structure_flags.has_blocking_errors(undefined)).toBe(false);
    });
});

describe('workspace.list_workspace — structure-QA entries', () => {
    it('consumes embedded packages + flags without per-folder fetches', async () => {
        const astools = make_astools({
            workspace_data: {
                result: [
                    {
                        name: 'new_clean-resources_1',
                        packages: ['pkg_a', 'pkg_b'],
                        processed: [],
                        structure_errors: [],
                    },
                    {
                        name: 'new_broken-resources_2',
                        packages: [],
                        processed: [],
                        structure_errors: [LOOSE_FLAG, { code: 'no_packages', severity: 'error', items: [], total: 0 }],
                    },
                ],
                errors: [],
            },
        });

        const data = await workspace.list_workspace({ scope: 'unprocessed', astools });

        expect(astools.calls.list_packages).toEqual([]);
        expect(data.total_folders).toBe(2);
        expect(data.total_packages).toBe(2);

        const clean = data.folders[0];
        expect(clean.packages).toEqual(['pkg_a', 'pkg_b']);
        expect(clean.blocked).toBe(false);
        expect(clean.structure_notices).toEqual([]);

        const broken = data.folders[1];
        expect(broken.blocked).toBe(true);
        expect(broken.structure_notices.length).toBe(2);
        expect(broken.structure_notices[0].text).toContain('scan1.tif');
    });

    it('falls back to per-folder fetch for legacy flat-name entries', async () => {
        const astools = make_astools({
            workspace_data: { result: ['new_legacy-resources_3'], errors: [] },
            packages_data: { result: ['pkg_a'], errors: [] },
        });

        const data = await workspace.list_workspace({ scope: 'unprocessed', astools });

        expect(astools.calls.list_packages).toEqual(['new_legacy-resources_3']);
        expect(data.folders[0].packages).toEqual(['pkg_a']);
        expect(data.folders[0].blocked).toBe(false);
    });

    it('picks up piggybacked flags from the packages fetch (processed scope)', async () => {
        const astools = make_astools({
            workspace_data: { result: ['new_p-resources_4'], errors: [] },
            packages_data: {
                result: ['pkg_a'],
                processed: ['pkg_a'],
                structure_errors: [LOOSE_FLAG],
                errors: [],
            },
        });

        const data = await workspace.list_workspace({ scope: 'processed', astools });

        expect(data.folders[0].blocked).toBe(true);
        expect(data.folders[0].structure_notices[0].text).toContain('scan1.tif');
    });
});

describe('workspace.run_make_digital_objects — structure gate', () => {
    it('refuses with 422 and never invokes MDO when flags block', async () => {
        const astools = make_astools({
            packages_data: { result: [], structure_errors: [LOOSE_FLAG], errors: [] },
        });

        const result = await workspace.run_make_digital_objects('new_broken-resources_2', { astools });

        expect(result.ok).toBe(false);
        expect(result.status).toBe(422);
        expect(result.error).toContain('scan1.tif');
        expect(astools.calls.make_digital_objects).toEqual([]);
    });

    it('proceeds when flags are warn/info only', async () => {
        const astools = make_astools({
            packages_data: {
                result: ['pkg_a'],
                structure_errors: [{ code: 'name_hygiene', severity: 'warn', items: ['a b'], total: 1 }],
                errors: [],
            },
        });

        const result = await workspace.run_make_digital_objects('new_ok-resources_5', { astools });

        expect(result.ok).toBe(true);
        expect(astools.calls.make_digital_objects).toEqual(['new_ok-resources_5']);
    });

    it('fails open when the structure check is unavailable', async () => {
        const astools = make_astools({ packages_data: { throw: 'ECONNREFUSED' } });

        const result = await workspace.run_make_digital_objects('new_x-resources_6', { astools });

        expect(result.ok).toBe(true);
        expect(astools.calls.make_digital_objects).toEqual(['new_x-resources_6']);
    });

    it('proceeds for older curation-services that send no flags', async () => {
        const astools = make_astools({ packages_data: { result: ['pkg_a'], errors: [] } });

        const result = await workspace.run_make_digital_objects('new_old-resources_7', { astools });

        expect(result.ok).toBe(true);
        expect(astools.calls.make_digital_objects.length).toBe(1);
    });
});

describe('workspace.submit_to_ingest — structure gate', () => {
    it('refuses before any queue insert when flags block', async () => {
        const astools = make_astools({
            packages_data: { result: [], structure_errors: [LOOSE_FLAG], errors: [] },
        });
        let queue_calls = 0;
        const model = {
            async queue_packages() {
                queue_calls += 1;
                throw new Error('queue_packages must not be called');
            },
        };

        const result = await workspace.submit_to_ingest('new_broken-resources_2', 'staff', {
            astools,
            model,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('structure');
        expect(queue_calls).toBe(0);
    });
});
