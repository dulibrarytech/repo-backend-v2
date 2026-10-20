'use strict';

/*
 * Unit tests for scripts/repair_compound_parts_from_dip.js, which rebuilds
 * a compound's part paths from its DIP: Archivematica's Storage Service
 * for the DIP record, the DIP's METS for the file list. plan_row is pure;
 * run() is driven with fake Archivematica, DIP-store and database deps
 * and the real METS parser. Fixtures follow 4cc77734 (Woodstock
 * Chronology): .tif originals and .jp2 access copies. Its parts list is
 * empty locally; in production it holds refresh-built titles
 * {order, title, type: null, caption: null}.
 */

const {
    parse_args,
    split_ext,
    dip_path_of,
    access_rule,
    listing_paths,
    plan_row,
    run,
} = require('../../../scripts/repair_compound_parts_from_dip');
const { enrich_parts } = require('../../../ingester/lib/repository_build');
const { mets_path } = require('../../../libs/dip_store');
const { build_payload } = require('../../../metadata/worker');

const PID = '4cc77734-8690-407d-8984-7699171d10ff';
const OTHER_PID = '42571ee3-d2b8-47ea-99de-fa9b0ee9245c';
const DIP_UUID = 'c3fb9f8c-49b9-4aaa-9c75-3961c4f4867a';
const DIP =
    'c3fb/9f8c/49b9/4aaa/9c75/3961/c4f4/867a/807c083f-a74b-4615-86d1-0d872132925b_' +
    'U219.03.0003.0001.00001_transfer-4cc77734-8690-407d-8984-7699171d10ff';
const U = [
    '388c24c5-8c42-40ef-bf60-f5f4c8f2d7b9',
    '01543f96-020c-4706-940f-cd543d06dc1e',
    'b62c1a35-8789-4be1-a08e-bebb7f39025f',
];
const URI_TXT = '5d0c8a8e-2f41-4c7b-9b8e-0c6a1d2e3f40';
const TITLE = 'Woodstock Chronology - University of Denver, 1970, 1970 August';
const name = (n) => `U219.03.0003.0001.00001_p00${n}`;

/*
 * parse_mets output for the DIP: a uri.txt sidecar, then the pages last
 * to first (METS order is not page order).
 */
function mets_files({ count = 3, mime = 'image/tiff' } = {}) {
    const file = (uuid, f, type, mime_type) => ({
        uuid,
        sip_uuid: PID,
        dip_path: DIP,
        file: f,
        file_id: split_ext(f).stem,
        mime_type,
        type,
    });
    const pages = Array.from({ length: count }, (_, i) =>
        file(U[i], `${name(i + 1)}.tif`, 'object', mime)
    );
    return [file(URI_TXT, 'uri.txt', 'txt', null), ...pages.reverse()];
}

// The same files as Archivematica's METS XML, for run() and the real parser.
function mets_xml(files = mets_files()) {
    const amd_secs = files
        .map(
            (f, i) => `
  <mets:amdSec ID="amdSec_${i + 1}">
    <mets:techMD><mets:mdWrap><mets:xmlData><premis:object><premis:objectCharacteristics>
      <premis:objectCharacteristicsExtension><rdf:RDF><rdf:Description>
        <File:MIMEType>${f.mime_type || ''}</File:MIMEType>
      </rdf:Description></rdf:RDF></premis:objectCharacteristicsExtension>
    </premis:objectCharacteristics></premis:object></mets:xmlData></mets:mdWrap></mets:techMD>
  </mets:amdSec>`
        )
        .join('');
    const entries = files
        .map(
            (f, i) => `
      <mets:file ID="file-${f.uuid}" ADMID="amdSec_${i + 1}">
        <mets:FLocat xlink:href="objects/${f.file}" />
      </mets:file>`
        )
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<mets:mets xmlns:mets="http://www.loc.gov/METS/" xmlns:premis="info:lc/xmlns/premis-v2"
           xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns:File="https://example.com/file-ns" xmlns:xlink="http://www.w3.org/1999/xlink">${amd_secs}
  <mets:fileSec><mets:fileGrp USE="original">${entries}
  </mets:fileGrp></mets:fileSec>
</mets:mets>`;
}

function titles(count = 3) {
    return Array.from({ length: count }, (_, i) => ({
        order: String(i + 1),
        title: `${name(i + 1)}.tif`,
        type: null,
        caption: null,
    }));
}

/*
 * The row as the local database has it: an empty parts list. `parts`
 * replaces display_record.parts, `envelope` patches the envelope, and the
 * rest patches the columns.
 */
function broken_row({ parts = [], envelope = {}, ...columns } = {}) {
    const display_record = {
        pid: PID,
        is_member_of_collection: '807c083f-a74b-4615-86d1-0d872132925b',
        handle: `https://hdl.handle.net/10176/${PID}`,
        thumbnail: `${DIP}/thumbnails/${U[0]}.jpg`,
        mime_type: 'image/tiff',
        object_type: 'object',
        is_published: 1,
        is_compound: 1,
        title: TITLE,
        type: 'text',
        display_record: {
            title: TITLE,
            uri: '/repositories/2/archival_objects/80168',
            is_compound: true,
            parts,
        },
        compound: [],
        object: `${DIP}/objects/${U[0]}-${name(1)}.tif`,
        ...envelope,
    };
    return {
        pid: PID,
        is_compound: 1,
        mime_type: 'image/tiff',
        file_name: `${DIP}/objects/${U[0]}-${name(1)}.jp2`,
        thumbnail: `${DIP}/thumbnails/${U[0]}.jpg`,
        display_record: JSON.stringify(display_record),
        compound_parts: null,
        is_updated: 0,
        ...columns,
    };
}

// A repaired page, shaped like the healthy 2019 siblings' parts.
const healed = (i) => ({
    order: String(i + 1),
    title: `${name(i + 1)}.tif`,
    type: 'image/tiff',
    caption: null,
    object: `${DIP}/objects/${U[i]}-${name(i + 1)}.jp2`,
    thumbnail: `${DIP}/thumbnails/${U[i]}.jpg`,
});
const HEALED = [0, 1, 2].map(healed);

function listing(count = 3) {
    const out = [`${DIP}/METS.${PID}.xml`];
    for (let i = 0; i < count; i++) {
        out.push(`${DIP}/objects/${U[i]}-${name(i + 1)}.jp2`, `${DIP}/thumbnails/${U[i]}.jpg`);
    }
    return out;
}

const plan_for = (row, opts = {}) => plan_row(row, { mets_files: mets_files(), ...opts });

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('scripts/repair_compound_parts_from_dip — helpers', () => {
    it('split_ext splits off a real extension only, keeping its case', () => {
        expect(split_ext(`${name(1)}.TIF`)).toEqual({ stem: name(1), ext: '.TIF' });
        expect(split_ext(name(1))).toEqual({ stem: name(1), ext: '' });
        expect(split_ext('B463.01.0016.00001')).toEqual({ stem: 'B463.01.0016.00001', ext: '' });
        expect(split_ext(null)).toEqual({ stem: '', ext: '' });
    });

    it('parse_args defaults to a dry run over every candidate', () => {
        expect(parse_args(['node', 's'])).toEqual({
            pids: null,
            listing: null,
            execute: false,
            backup_dir: null,
        });
    });

    it('parse_args takes --pids as lower-cased, de-duplicated UUIDs', () => {
        expect(parse_args(['node', 's', '--pids', `${PID.toUpperCase()}, ${PID}`]).pids).toEqual([
            PID,
        ]);
        expect(parse_args(['node', 's', '--pids', `${PID},${OTHER_PID}`]).pids).toEqual([
            PID,
            OTHER_PID,
        ]);
        expect(() => parse_args(['node', 's', '--pids', 'nope'])).toThrow(
            /--pids must be UUIDs: nope/
        );
        expect(() => parse_args(['node', 's', '--pids', ' , '])).toThrow(/--pids needs/);
    });

    it('parse_args: --listing is optional, --execute needs --backup-dir', () => {
        expect(parse_args(['node', 's', '--listing', 'k.txt']).listing).toBe('k.txt');
        expect(() => parse_args(['node', 's', '--listing'])).toThrow(/--listing needs <file>/);
        expect(() => parse_args(['node', 's', '--execute'])).toThrow(
            /--execute needs --backup-dir/
        );
        expect(parse_args(['node', 's', '--execute', '--backup-dir', '/b'])).toMatchObject({
            execute: true,
            backup_dir: '/b',
        });
        expect(() => parse_args(['node', 's', '--pid', PID])).toThrow(/unknown arg: --pid/);
    });

    it('dip_path_of reads the folder from the row and envelope paths', () => {
        const row = broken_row();
        expect(dip_path_of(row, JSON.parse(row.display_record))).toEqual({ dip_path: DIP });
        expect(
            dip_path_of({ file_name: 'x/objects/a.jp2', thumbnail: 'y/thumbnails/a.jpg' }, {})
        ).toEqual({ error: 'dip_path_conflict', values: ['x', 'y'] });
        expect(dip_path_of({}, {})).toEqual({ error: 'no_dip_path', values: [] });
    });

    it('listing_paths takes aws s3 ls output and bare key lists', () => {
        const text = [
            `2019-12-24 07:45:31   15946206 dip-store/${DIP}/objects/${U[0]}-${name(1)}.jp2`,
            `${DIP}/thumbnails/${U[0]}.jpg`,
            '2019-12-24 07:45:31   99 unrelated/key.jpg',
            '',
        ].join('\n');
        expect(listing_paths(text, DIP)).toEqual([
            `${DIP}/objects/${U[0]}-${name(1)}.jp2`,
            `${DIP}/thumbnails/${U[0]}.jpg`,
        ]);
    });

    it('access_rule learns the access-copy extension from file_name', () => {
        const dip_parts = enrich_parts(mets_files(), { dip_path: DIP });
        const rule = (file_name) => access_rule(file_name, DIP, dip_parts);
        expect(rule(`${DIP}/objects/${U[0]}-${name(1)}.jp2`)).toEqual({ from: '.tif', to: '.jp2' });
        expect(rule(`${DIP}/objects/${U[0]}-${name(1)}.tif`)).toEqual({ from: '.tif', to: '.tif' });
        expect(rule('')).toMatchObject({ error: 'file_name_not_an_access_copy' });
        expect(rule(`${DIP}/objects/${name(1)}.jp2`)).toMatchObject({
            error: 'file_name_not_an_access_copy',
        });
        expect(rule(`${DIP}/objects/${URI_TXT}-uri.jp2`)).toMatchObject({
            error: 'master_not_in_mets',
        });
        expect(rule(`${DIP}/objects/${U[0]}-${name(2)}.jp2`)).toEqual({
            error: 'master_name_mismatch',
            detail: { mets: `${name(1)}.tif`, file_name: `${name(2)}.jp2` },
        });
    });
});

describe('scripts/repair_compound_parts_from_dip — plan_row', () => {
    it('builds one part per METS file, in page order, when the parts list is empty', () => {
        const plan = plan_for(broken_row());
        expect(plan.action).toBe('update');
        expect(plan.parts).toEqual(HEALED);
        expect(JSON.parse(plan.updates.compound_parts)).toEqual(HEALED);
        expect(plan.updates.is_updated).toBe(1);
        expect(plan.notes).toEqual({
            title: TITLE,
            dip_path: DIP,
            parts: 3,
            source: 'mets',
            access: '.tif → .jp2',
            objects_checked: false,
        });
    });

    it('changes only the parts, leaving an empty top-level compound alone', () => {
        const row = broken_row();
        const before = JSON.parse(row.display_record);
        const after = JSON.parse(plan_for(row).updates.display_record);
        expect(after.display_record.parts).toEqual(HEALED);
        expect({ ...after, display_record: { ...after.display_record, parts: [] } }).toEqual(
            before
        );
    });

    it('fills paths and MIME into refresh-built titles, keeping their captions', () => {
        const parts = titles();
        parts[1].caption = 'Page two';
        const plan = plan_for(broken_row({ parts }));
        expect(plan.notes.source).toBe('titles');
        expect(plan.parts).toEqual([healed(0), { ...healed(1), caption: 'Page two' }, healed(2)]);
    });

    it('keeps a part MIME that is already set', () => {
        const parts = titles();
        parts[1].type = 'image/jp2';
        expect(plan_for(broken_row({ parts })).parts.map((p) => p.type)).toEqual([
            'image/tiff',
            'image/jp2',
            'image/tiff',
        ]);
    });

    it('takes the row MIME for pages the METS gives none', () => {
        const plan = plan_row(broken_row(), { mets_files: mets_files({ mime: null }) });
        expect(plan.parts).toEqual(HEALED);
    });

    it('rewrites a pathless top-level compound copy along with the parts', () => {
        const row = broken_row({ parts: titles(), envelope: { compound: titles() } });
        const after = JSON.parse(plan_for(row).updates.display_record);
        expect(after.compound).toEqual(HEALED);
        expect(after.display_record.parts).toEqual(HEALED);
    });

    it('is idempotent: a repaired row is skipped', () => {
        const plan = plan_for(broken_row());
        expect(plan_for(broken_row({ display_record: plan.updates.display_record }))).toEqual({
            action: 'skip',
            reason: 'already_repaired',
        });
    });

    it('survives a later metadata refresh, with or without ASpace parts', () => {
        for (const aspace_parts of [titles(), undefined]) {
            const plan = plan_for(broken_row());
            const repaired = broken_row({
                display_record: plan.updates.display_record,
                compound_parts: plan.updates.compound_parts,
            });
            const metadata = { title: TITLE, is_compound: true, parts: aspace_parts };
            const parts = JSON.parse(build_payload(repaired, metadata).display_record)
                .display_record.parts;
            expect(parts.map((p) => [p.title, p.object, p.thumbnail, p.type])).toEqual(
                HEALED.map((p) => [p.title, p.object, p.thumbnail, p.type])
            );
        }
    });

    it('accepts paths already present when they agree, and refuses ones that conflict', () => {
        const agree = titles();
        agree[0] = healed(0);
        expect(plan_for(broken_row({ parts: agree })).parts).toEqual(HEALED);

        const conflict = titles();
        conflict[1] = { ...conflict[1], object: `${DIP}/objects/${U[1]}-${name(2)}.tif` };
        expect(plan_for(broken_row({ parts: conflict }))).toEqual({
            action: 'refuse',
            reason: 'dip_mismatch',
            detail: {
                path_conflicts: [
                    `${name(2)}.tif object: ${DIP}/objects/${U[1]}-${name(2)}.tif → ${healed(1).object}`,
                ],
            },
        });
    });

    it('reports unmatched titles and unused METS files together', () => {
        const parts = [
            ...titles(2),
            { order: '3', title: 'missing_page.tif', type: null, caption: null },
        ];
        expect(plan_for(broken_row({ parts }))).toEqual({
            action: 'refuse',
            reason: 'dip_mismatch',
            detail: {
                unmatched_titles: ['missing_page.tif'],
                unused_mets_files: [`${name(3)}.tif`],
            },
        });
    });

    it('refuses an untitled part rather than pairing it by position', () => {
        const parts = titles();
        parts[2].title = '';
        expect(plan_for(broken_row({ parts })).detail).toEqual({ untitled_parts: ['order 3'] });
    });

    it('refuses two parts that name the same file', () => {
        const parts = titles();
        parts[1].title = `${name(1)}.TIF`;
        expect(plan_for(broken_row({ parts })).detail).toEqual({
            claimed_twice: [`${name(1)}.tif, ${name(1)}.TIF`],
            unused_mets_files: [`${name(2)}.tif`],
        });
    });

    it('refuses pages that are not still images', () => {
        const plan = plan_row(broken_row({ mime_type: 'video/mp4' }), {
            mets_files: mets_files({ mime: 'video/mp4' }),
        });
        expect(plan.detail).toEqual({
            not_still_image: [1, 2, 3].map((n) => `${name(n)}.tif (video/mp4)`),
        });
    });

    it('refuses METS files the access rule cannot name', () => {
        const files = mets_files();
        const extra = (uuid, file) => ({ ...files[1], uuid, file, file_id: split_ext(file).stem });
        files.push(
            extra('aaaaaaaa-0000-4000-8000-000000000001', 'notes.pdf'),
            extra('aaaaaaaa-0000-4000-8000-000000000002', `sub/${name(4)}.tif`),
            extra('aaaaaaaa-0000-4000-8000-000000000003', `${name(2)}.tif`)
        );
        expect(plan_row(broken_row(), { mets_files: files }).detail).toEqual({
            other_extensions: ['notes.pdf'],
            nested_files: [`sub/${name(4)}.tif`],
            duplicate_files: [`${name(2)}.tif`],
        });
    });

    it('checks the rebuilt master part against the row columns', () => {
        const cases = [
            [{ file_name: `${DIP}/objects/${U[1]}-${name(2)}.jp2` }, /^file_name /],
            [{ thumbnail: `${DIP}/thumbnails/${U[1]}.jpg` }, /^thumbnail /],
            [{ mime_type: 'image/jp2' }, /^mime_type /],
        ];
        for (const [columns, pattern] of cases) {
            const plan = plan_for(broken_row(columns));
            expect(plan.reason).toBe('dip_mismatch');
            expect(plan.detail.master_mismatch).toEqual([expect.stringMatching(pattern)]);
        }
        // A custom thumbnail (an absolute URL in the column) is not compared.
        const custom = plan_for(broken_row({ thumbnail: 'https://example.org/custom.jpg' }));
        expect(custom.action).toBe('update');
    });

    it('checks objects and thumbnails against a --listing when given', () => {
        expect(plan_for(broken_row(), { listing_paths: listing() }).notes.objects_checked).toBe(
            true
        );
        const short = listing().filter((p) => p !== `${DIP}/objects/${U[2]}-${name(3)}.jp2`);
        expect(plan_for(broken_row(), { listing_paths: short }).detail).toEqual({
            not_in_listing: [`objects/${U[2]}-${name(3)}.jp2`],
        });
    });

    it('refuses shapes it does not handle', () => {
        const cases = [
            [broken_row({ is_compound: 0 }), 'not_compound'],
            [broken_row({ display_record: '{oops' }), 'display_record_unparsable'],
            [broken_row({ envelope: { display_record: null } }), 'no_inner_record'],
            [
                broken_row({ envelope: { parts: [{ file: 'a.tif', object: 'x' }] } }),
                'top_level_parts_present',
            ],
            [broken_row({ envelope: { compound: [healed(0)] } }), 'top_level_compound_has_paths'],
            [
                broken_row({
                    file_name: '',
                    thumbnail: '',
                    envelope: { object: '', thumbnail: '' },
                }),
                'no_dip_path',
            ],
            [
                broken_row({ file_name: `${DIP}/objects/${name(1)}.jp2` }),
                'file_name_not_an_access_copy',
            ],
        ];
        for (const [row, reason] of cases) {
            const plan = plan_for(row);
            expect(plan.action, reason).toBe('refuse');
            expect(plan.reason).toBe(reason);
        }
        expect(plan_row(broken_row(), { mets_files: [] }).reason).toBe('mets_no_files');
    });
});

describe('scripts/repair_compound_parts_from_dip — run', () => {
    const tables = { objects: 'tbl_objects' };

    function fake_db(update_count = 1) {
        const applied = [];
        const db = () => (table) => ({
            where(criteria) {
                return {
                    andWhere(column, value) {
                        return {
                            update(updates) {
                                applied.push({ table, criteria, guard: [column, value], updates });
                                return Promise.resolve(update_count);
                            },
                        };
                    },
                };
            },
        });
        return { db, applied };
    }

    function fake_am(overrides = {}) {
        return {
            is_storage_configured: () => true,
            get_dip_path: vi.fn(async () => ({ status: 200, dip_path: DIP, dip_uuid: DIP_UUID })),
            get_dip_package: vi.fn(async () => ({
                status: 200,
                package_type: 'DIP',
                package_status: 'UPLOADED',
            })),
            ...overrides,
        };
    }

    function fake_store({ xml = mets_xml(), status = 200, head_status = () => 200 } = {}) {
        return {
            is_configured: () => true,
            mets_path,
            fetch_text: vi.fn(async () => ({ status, data: status === 200 ? xml : '' })),
            head: vi.fn(async (p) => ({ status: head_status(p) })),
        };
    }

    function setup(rows, { update_count, ...deps } = {}) {
        const db = fake_db(update_count);
        return {
            applied: db.applied,
            deps: {
                db_module: { db: db.db, destroy_all: async () => {} },
                tables,
                select_candidates: vi.fn(async () => rows),
                archivematica: fake_am(),
                dip_store: fake_store(),
                read_file: vi.fn(() => listing().join('\n')),
                write_file: vi.fn(),
                is_directory: () => true,
                ...deps,
            },
        };
    }
    const args = (o = {}) => ({
        pids: [PID],
        listing: null,
        execute: false,
        backup_dir: '/b',
        ...o,
    });

    it('dry run asks Archivematica, reads the METS, checks thumbnails and writes nothing', async () => {
        const { deps, applied } = setup([broken_row()]);
        const { results, counts } = await run(args(), deps);
        expect(counts).toEqual({ update: 1, skip: 0, refuse: 0 });
        expect(results[0].plan.parts).toEqual(HEALED);
        expect(results[0].plan.notes.dip_uuid).toBe(DIP_UUID);
        expect(deps.select_candidates).toHaveBeenCalledWith(expect.any(Function), tables, [PID]);
        expect(deps.archivematica.get_dip_path).toHaveBeenCalledWith(PID);
        expect(deps.archivematica.get_dip_package).toHaveBeenCalledWith(DIP_UUID);
        expect(deps.dip_store.fetch_text).toHaveBeenCalledWith(`${DIP}/METS.${PID}.xml`);
        expect(deps.dip_store.head.mock.calls.map(([p]) => p)).toEqual(
            HEALED.map((p) => p.thumbnail)
        );
        expect(applied).toEqual([]);
        expect(deps.write_file).not.toHaveBeenCalled();
    });

    it('--execute writes the before-image, then updates guarded on the value it read', async () => {
        const row = broken_row();
        const { deps, applied } = setup([row]);
        const { results } = await run(args({ execute: true }), deps);
        expect(deps.write_file).toHaveBeenCalledTimes(1);
        const [file, body] = deps.write_file.mock.calls[0];
        expect(file).toBe(results[0].backup);
        expect(file.startsWith(`/b/repair_compound_parts_${PID}_`)).toBe(true);
        expect(JSON.parse(body)).toMatchObject({
            pid: PID,
            display_record: row.display_record,
            compound_parts: null,
            is_updated: 0,
        });
        expect(applied).toEqual([
            {
                table: 'tbl_objects',
                criteria: { pid: PID, is_active: 1 },
                guard: ['display_record', row.display_record],
                updates: results[0].plan.updates,
            },
        ]);
    });

    it('fails before any database call when the setup is incomplete', async () => {
        const cases = [
            [{ is_directory: () => false }, { execute: true }, /not an existing directory/],
            [
                { archivematica: fake_am({ is_storage_configured: () => false }) },
                {},
                /Archivematica Storage Service is not configured/,
            ],
            [
                { dip_store: { ...fake_store(), is_configured: () => false } },
                {},
                /DIP store is not configured/,
            ],
            [
                {
                    read_file: () => {
                        throw new Error('ENOENT: keys.txt');
                    },
                },
                { listing: 'keys.txt' },
                /ENOENT/,
            ],
        ];
        for (const [deps_patch, args_patch, message] of cases) {
            const { deps } = setup([broken_row()], deps_patch);
            await expect(run(args(args_patch), deps)).rejects.toThrow(message);
            expect(deps.select_candidates).not.toHaveBeenCalled();
        }
    });

    it('--execute stops if the row changed since it was read', async () => {
        const { deps } = setup([broken_row()], { update_count: 0 });
        await expect(run(args({ execute: true }), deps)).rejects.toThrow(
            /changed since it was read/
        );
    });

    it('refuses requested pids with no active row, or several, without asking Archivematica', async () => {
        const twin = broken_row({ pid: OTHER_PID });
        const { deps } = setup([twin, twin]);
        const { results, counts } = await run(args({ pids: [PID, OTHER_PID] }), deps);
        expect(results.map((r) => [r.pid, r.plan.reason])).toEqual([
            [PID, 'not_found'],
            [OTHER_PID, 'multiple_active_rows'],
        ]);
        expect(counts).toEqual({ update: 0, skip: 0, refuse: 2 });
        expect(deps.archivematica.get_dip_path).not.toHaveBeenCalled();
    });

    it('without --pids, plans every selected row and asks Archivematica only past the row checks', async () => {
        const { deps } = setup([broken_row(), broken_row({ pid: OTHER_PID, is_compound: 0 })]);
        const { results } = await run(args({ pids: null }), deps);
        expect(results.map((r) => [r.pid, r.plan.action])).toEqual([
            [PID, 'update'],
            [OTHER_PID, 'refuse'],
        ]);
        expect(deps.select_candidates).toHaveBeenCalledWith(expect.any(Function), tables, null);
        expect(deps.archivematica.get_dip_path).toHaveBeenCalledTimes(1);
    });

    it('reads a --listing once and checks the objects against it', async () => {
        const { deps } = setup([broken_row()]);
        const { results } = await run(args({ listing: 'keys.txt' }), deps);
        expect(deps.read_file).toHaveBeenCalledTimes(1);
        expect(deps.read_file).toHaveBeenCalledWith('keys.txt');
        expect(results[0].plan.notes.objects_checked).toBe(true);
    });

    it('refuses when Archivematica disagrees, before reading the METS', async () => {
        const dip = (package_type, package_status) => async () => ({
            status: 200,
            package_type,
            package_status,
        });
        const cases = [
            [
                { get_dip_path: async () => ({ status: 404, dip_path: null }) },
                'am_aip_lookup_failed',
            ],
            [{ get_dip_path: async () => ({ status: 200, dip_path: null }) }, 'am_no_related_dip'],
            [
                {
                    get_dip_path: async () => ({
                        status: 200,
                        dip_path: `${DIP}-x`,
                        dip_uuid: DIP_UUID,
                    }),
                },
                'dip_path_mismatch',
            ],
            [{ get_dip_package: async () => ({ status: 404 }) }, 'am_dip_lookup_failed'],
            [{ get_dip_package: dip('AIP', 'UPLOADED') }, 'not_a_dip'],
            [{ get_dip_package: dip('DIP', 'DELETED') }, 'dip_not_uploaded'],
            [
                {
                    get_dip_path: async () => {
                        throw new Error('ECONNRESET');
                    },
                },
                'archivematica_error',
            ],
        ];
        for (const [am, reason] of cases) {
            const { deps } = setup([broken_row()], { archivematica: fake_am(am) });
            const { results } = await run(args(), deps);
            expect(results[0].plan.reason, reason).toBe(reason);
            expect(deps.dip_store.fetch_text).not.toHaveBeenCalled();
        }
    });

    it('refuses an unreadable METS or a failed thumbnail check, writing nothing', async () => {
        const cases = [
            [fake_store({ status: 404 }), 'mets_unavailable'],
            [fake_store({ xml: '<mets:mets' }), 'mets_error'],
            [fake_store({ head_status: () => 500 }), 'thumbnails_error'],
        ];
        for (const [store, reason] of cases) {
            const { deps, applied } = setup([broken_row()], { dip_store: store });
            const { results } = await run(args({ execute: true }), deps);
            expect(results[0].plan.reason, reason).toBe(reason);
            expect(applied).toEqual([]);
            expect(deps.write_file).not.toHaveBeenCalled();
        }
    });

    it('refuses a page whose thumbnail the DIP store lacks', async () => {
        const store = fake_store({ head_status: (p) => (p === healed(1).thumbnail ? 404 : 200) });
        const { deps, applied } = setup([broken_row()], { dip_store: store });
        const { results } = await run(args({ execute: true }), deps);
        expect(results[0].plan).toEqual({
            action: 'refuse',
            reason: 'dip_mismatch',
            detail: { missing_thumbnails: [`${name(2)}.tif`] },
        });
        expect(applied).toEqual([]);
    });
});
