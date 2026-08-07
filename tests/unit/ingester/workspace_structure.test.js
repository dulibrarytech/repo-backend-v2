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

function make_astools({
    workspace_data,
    packages_data,
    packages_status = 200,
    /*
     * Per-package file listings for the MDO Kaltura pre-flight
     * (astools.get_uri). Keyed by package name; defaults to a
     * media-free package so non-Kaltura tests exercise the plain
     * MDO path unchanged.
     */
    package_files = {},
} = {}) {
    const calls = {
        list_workspace: 0,
        list_packages: [],
        get_uri: [],
        make_digital_objects: [],
    };
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
        async get_uri(folder, pkg) {
            calls.get_uri.push({ folder, pkg });
            if (package_files.throw) throw new Error(package_files.throw);
            const files = package_files[pkg] || ['uri.txt', 'scan_001.tif'];
            return { status: 200, data: { result: { uris: [], files }, errors: [] } };
        },
        async make_digital_objects(folder, opts) {
            calls.make_digital_objects.push(opts ? { folder, opts } : folder);
            return { status: 200, data: { result: { success: true }, errors: [] } };
        },
    };
}

/*
 * Fake Kaltura collaborator for run_make_digital_objects. `rows` is
 * what resolve_packages returns; `configured` gates the media branch.
 */
function make_kaltura({ rows = [], configured = true, throw_error = null } = {}) {
    const calls = { resolve_packages: [] };
    return {
        calls,
        is_configured: () => configured,
        async resolve_packages(packages) {
            calls.resolve_packages.push(packages);
            if (throw_error) throw new Error(throw_error);
            return rows;
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

    it('carries total_bytes through the entry normalizer (regression)', async () => {
        /*
         * REGRESSION: _normalize_workspace_entries WHITELISTS fields,
         * so total_bytes from the curation scan was silently dropped
         * — the Size column rendered dashes against a healthy API.
         * This test goes through the real normalizer (astools client
         * injected, not list_workspace stubbed) so a future field
         * drop fails here.
         */
        const astools = make_astools({
            workspace_data: {
                result: [
                    {
                        name: 'new_sized-resources_1',
                        packages: ['pkg_a'],
                        processed: [],
                        structure_errors: [],
                        total_bytes: 142400592265,
                    },
                    {
                        name: 'new_unsized-resources_2',
                        packages: ['pkg_b'],
                        processed: [],
                        structure_errors: [],
                        total_bytes: null,
                    },
                ],
                errors: [],
            },
        });

        const data = await workspace.list_workspace({ scope: 'unprocessed', astools });
        expect(data.folders[0].total_bytes).toBe(142400592265);
        expect(data.folders[1].total_bytes).toBeNull();
    });

    it('falls back to per-folder fetch for legacy flat-name entries', async () => {
        const astools = make_astools({
            workspace_data: { result: ['new_legacy-resources_3'], errors: [] },
            packages_data: { result: ['pkg_a'], total_bytes: 987654, errors: [] },
        });

        const data = await workspace.list_workspace({ scope: 'unprocessed', astools });

        expect(astools.calls.list_packages).toEqual(['new_legacy-resources_3']);
        expect(data.folders[0].packages).toEqual(['pkg_a']);
        expect(data.folders[0].blocked).toBe(false);
        /*
         * Size flows from the per-batch fetch too (2026-07-30) — this
         * is the path the ASpace QA / Packaging views use, where the
         * Size column was blank until the folder-state response
         * carried total_bytes.
         */
        expect(data.folders[0].total_bytes).toBe(987654);
    });

    it('per-folder fetch without total_bytes (older curation) yields null size', async () => {
        const astools = make_astools({
            workspace_data: { result: ['new_old-resources_5'], errors: [] },
            packages_data: { result: ['pkg_a'], errors: [] },
        });
        const data = await workspace.list_workspace({ scope: 'unprocessed', astools });
        expect(data.folders[0].total_bytes).toBeNull();
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

describe('workspace.run_make_digital_objects — Kaltura pre-flight', () => {
    const FOLDER = 'new_media-resources_9';

    function media_astools(package_files) {
        return make_astools({
            packages_data: { result: ['pkg_a', 'pkg_b'], errors: [] },
            package_files,
        });
    }

    it('resolves media files and passes is_kaltura + files to MDO', async () => {
        const astools = media_astools({
            pkg_a: ['uri.txt', 'interview.MP4', 'notes.txt'],
            pkg_b: ['song.wav'],
        });
        const kaltura = make_kaltura({
            rows: [
                { package: 'pkg_a', file: 'interview.MP4', entry_id: '1_aaa', status: 1 },
                { package: 'pkg_b', file: 'song.wav', entry_id: '1_bbb', status: 1 },
            ],
        });

        const result = await workspace.run_make_digital_objects(FOLDER, { astools, kaltura });

        expect(result.ok).toBe(true);
        expect(kaltura.calls.resolve_packages).toEqual([
            [
                { package: 'pkg_a', files: ['interview.MP4'] },
                { package: 'pkg_b', files: ['song.wav'] },
            ],
        ]);
        expect(astools.calls.make_digital_objects).toEqual([
            {
                folder: FOLDER,
                opts: {
                    is_kaltura: 1,
                    files: [
                        { package: 'pkg_a', file: 'interview.MP4', entry_id: '1_aaa' },
                        { package: 'pkg_b', file: 'song.wav', entry_id: '1_bbb' },
                    ],
                },
            },
        ]);
        expect(result.kaltura).toEqual({ attached: 2 });
    });

    it('calls MDO without options when the folder has no media files', async () => {
        const astools = media_astools({});
        const kaltura = make_kaltura();

        const result = await workspace.run_make_digital_objects(FOLDER, { astools, kaltura });

        expect(result.ok).toBe(true);
        expect(kaltura.calls.resolve_packages).toEqual([]);
        expect(astools.calls.make_digital_objects).toEqual([FOLDER]);
        expect(result.kaltura).toBeUndefined();
    });

    it('blocks (422) when a media file has no Kaltura match', async () => {
        const astools = media_astools({ pkg_a: ['clip.mov'] });
        const kaltura = make_kaltura({
            rows: [
                {
                    package: 'pkg_a',
                    file: 'clip.mov',
                    entry_id: '0_0',
                    status: 0,
                    message: 'File does not have an Entry ID. Please check Kaltura record for all required fields.',
                },
            ],
        });

        const result = await workspace.run_make_digital_objects(FOLDER, { astools, kaltura });

        expect(result.ok).toBe(false);
        expect(result.status).toBe(422);
        expect(result.error).toContain('pkg_a/clip.mov');
        expect(result.error).toContain('does not have an Entry ID');
        expect(astools.calls.make_digital_objects).toEqual([]);
    });

    it('blocks when a media file matches more than one Kaltura entry', async () => {
        const astools = media_astools({ pkg_a: ['clip.mov'] });
        const kaltura = make_kaltura({
            rows: [
                {
                    package: 'pkg_a',
                    file: 'clip.mov',
                    entry_id: '["1_a","1_b"]',
                    status: 2,
                    message: 'File has more than 1 Entry ID. Please check Kaltura record(s).',
                },
            ],
        });

        const result = await workspace.run_make_digital_objects(FOLDER, { astools, kaltura });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('more than 1 Entry ID');
        expect(astools.calls.make_digital_objects).toEqual([]);
    });

    it('blocks when the resolver returns no row at all for a media file', async () => {
        const astools = media_astools({ pkg_a: ['clip.mov'] });
        const kaltura = make_kaltura({ rows: [] });

        const result = await workspace.run_make_digital_objects(FOLDER, { astools, kaltura });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('No result came back');
        expect(astools.calls.make_digital_objects).toEqual([]);
    });

    it('blocks when media exists but Kaltura is not configured', async () => {
        const astools = media_astools({ pkg_a: ['clip.mov'] });
        const kaltura = make_kaltura({ configured: false });

        const result = await workspace.run_make_digital_objects(FOLDER, { astools, kaltura });

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Kaltura connection is not set up/);
        expect(kaltura.calls.resolve_packages).toEqual([]);
        expect(astools.calls.make_digital_objects).toEqual([]);
    });

    it('blocks with a retry message when the Kaltura lookup itself fails', async () => {
        const astools = media_astools({ pkg_a: ['clip.mov'] });
        const kaltura = make_kaltura({ throw_error: 'Kaltura session.start timed out' });

        const result = await workspace.run_make_digital_objects(FOLDER, { astools, kaltura });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('try again');
        expect(astools.calls.make_digital_objects).toEqual([]);
    });

    it('blocks when a per-package file listing fails mid-enumeration', async () => {
        const astools = media_astools({ throw: 'ECONNRESET' });
        const kaltura = make_kaltura();

        const result = await workspace.run_make_digital_objects(FOLDER, { astools, kaltura });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Could not check');
        expect(astools.calls.make_digital_objects).toEqual([]);
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
