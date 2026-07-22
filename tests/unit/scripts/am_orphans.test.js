'use strict';

/*
 * Unit tests for the pure helpers in scripts/am_orphans.js. The I/O parts
 * (AM pagination, DB reads, table/CSV writes, deletion POSTs) are exercised
 * against the live env; here we lock down arg parsing, the actionable/skip
 * rules, A/B/C bucketing, year extraction, the deletion selection gates,
 * and CSV escaping.
 */

const {
    parse_args,
    is_actionable,
    classify,
    to_csv,
    to_size,
    year_from_value,
    extract_year,
    parse_ingest_year,
    select_deletions,
} = require('../../../scripts/am_orphans');

describe('scripts/am_orphans — pure helpers', () => {
    describe('parse_args', () => {
        it('defaults (delete mode off, dry-run, no year)', () => {
            expect(parse_args([])).toEqual({
                probe: false,
                csv: null,
                page_size: 250,
                package_type: 'AIP',
                write_table: true,
                year_report: false,
                delete: false,
                year: null,
                reason: null,
                execute: false,
                date_field: null,
                allow_path_year: false,
                no_pointer: false,
                pace_ms: 150,
                limit: null,
            });
        });

        it('parses year-report flags', () => {
            const o = parse_args(['--year-report', '--pace-ms', '50', '--limit', '200']);
            expect(o).toMatchObject({ year_report: true, pace_ms: 50, limit: 200 });
        });

        it('parses --no-pointer', () => {
            expect(parse_args(['--delete', '--no-pointer']).no_pointer).toBe(true);
        });

        it('parses report flags', () => {
            const o = parse_args([
                '--probe',
                '--no-table',
                '--csv',
                '/tmp/x.csv',
                '--page-size',
                '50',
                '--package-type',
                'DIP',
            ]);
            expect(o).toMatchObject({
                probe: true,
                csv: '/tmp/x.csv',
                page_size: 50,
                package_type: 'DIP',
                write_table: false,
            });
        });

        it('parses delete-mode flags', () => {
            const o = parse_args([
                '--delete',
                '--year',
                '2019',
                '--reason',
                'orphan cleanup',
                '--execute',
                '--date-field',
                'stored_date',
                '--allow-path-year',
                '--limit',
                '10',
            ]);
            expect(o).toMatchObject({
                delete: true,
                year: 2019,
                reason: 'orphan cleanup',
                execute: true,
                date_field: 'stored_date',
                allow_path_year: true,
                limit: 10,
            });
        });

        it('delete defaults are safe: dry-run, no year', () => {
            const o = parse_args(['--delete']);
            expect(o.delete).toBe(true);
            expect(o.execute).toBe(false);
            expect(o.year).toBeNull();
        });

        it('falls back to the default page-size on junk input', () => {
            expect(parse_args(['--page-size', 'nope']).page_size).toBe(250);
        });
    });

    describe('is_actionable', () => {
        it('accepts a matching, non-deleted package_type', () => {
            expect(is_actionable({ uuid: 'u', package_type: 'AIP', status: 'UPLOADED' }, 'AIP')).toBe(true);
        });
        it('rejects a different package_type', () => {
            expect(is_actionable({ uuid: 'u', package_type: 'DIP', status: 'UPLOADED' }, 'AIP')).toBe(false);
        });
        it('rejects DELETED / DEL_REQ statuses (case-insensitive)', () => {
            expect(is_actionable({ uuid: 'u', package_type: 'AIP', status: 'DELETED' }, 'AIP')).toBe(false);
            expect(is_actionable({ uuid: 'u', package_type: 'AIP', status: 'del_req' }, 'AIP')).toBe(false);
        });
        it('rejects a package with no uuid', () => {
            expect(is_actionable({ package_type: 'AIP', status: 'UPLOADED' }, 'AIP')).toBe(false);
        });
    });

    describe('year_from_value', () => {
        it('parses ISO dates, embedded years; null on junk', () => {
            expect(year_from_value('2019-05-01T00:00:00Z')).toBe(2019);
            expect(year_from_value('2019-05-01')).toBe(2019);
            expect(year_from_value('AIP stored 2015 batch')).toBe(2015);
            expect(year_from_value('')).toBeNull();
            expect(year_from_value(null)).toBeNull();
            expect(year_from_value('no year here')).toBeNull();
        });
    });

    describe('extract_year', () => {
        it('uses an explicit date_field (authoritative, no path fallback)', () => {
            expect(extract_year({ mydate: '2018-03-02', current_path: '/x/2016/y' }, 'mydate')).toEqual({
                year: 2018,
                source: 'mydate',
            });
            // explicit field missing → null, does NOT fall back to the path year
            expect(extract_year({ current_path: '/x/2016/y' }, 'nope')).toEqual({ year: null, source: null });
        });
        it('auto-detects a known candidate field', () => {
            expect(extract_year({ stored_date: '2017-01-01T00:00:00Z' })).toEqual({
                year: 2017,
                source: 'stored_date',
            });
        });
        it('falls back to a 4-digit year in current_path', () => {
            expect(extract_year({ current_path: '/store/aips/2016/pkg-x' })).toEqual({
                year: 2016,
                source: 'current_path',
            });
        });
        it('returns nulls when no year is found', () => {
            expect(extract_year({ current_path: '/store/aips/pkg' })).toEqual({ year: null, source: null });
        });
    });

    describe('parse_ingest_year (pointer-file XML)', () => {
        it('prefers the METS CREATEDATE', () => {
            const xml =
                '<mets:mets><mets:metsHdr CREATEDATE="2019-11-29T23:59:26"></mets:metsHdr>' +
                '<premis:eventDateTime>2021-01-01T00:00:00</premis:eventDateTime></mets:mets>';
            expect(parse_ingest_year(xml)).toBe(2019);
        });
        it('falls back to the earliest premis:eventDateTime (namespace-tolerant)', () => {
            const xml =
                '<x><premis:eventDateTime>2020-06-01T00:00:00+00:00</premis:eventDateTime>' +
                '<premisv3:eventDateTime>2018-03-02T10:00:00</premisv3:eventDateTime></x>';
            expect(parse_ingest_year(xml)).toBe(2018); // earliest
        });
        it('returns null on empty / dateless XML', () => {
            expect(parse_ingest_year('')).toBeNull();
            expect(parse_ingest_year('<mets:mets></mets:mets>')).toBeNull();
            expect(parse_ingest_year(null)).toBeNull();
        });
    });

    describe('classify', () => {
        const pkgs = [
            { uuid: 'live-1', package_type: 'AIP', status: 'UPLOADED', size: 10, current_path: '/p/1', current_location: 'loc' },
            { uuid: 'orphan-A', package_type: 'AIP', status: 'UPLOADED', size: '20', current_path: '/p/2', stored_date: '2019-05-01T00:00:00Z' },
            { uuid: 'orphan-B', package_type: 'AIP', status: 'UPLOADED', current_path: '/store/2021/pkg' },
            { uuid: 'deleted-am', package_type: 'AIP', status: 'DELETED' }, // skipped (status)
            { uuid: 'a-dip', package_type: 'DIP', status: 'UPLOADED' }, // skipped (type)
        ];
        const live = new Set(['live-1']);
        const deleted = new Set(['orphan-B']);

        it('buckets A (no row) vs B (deleted-only), keeps live, skips deleted/other-type', () => {
            const { orphans, kept, skipped } = classify(pkgs, live, deleted, { package_type: 'AIP' });
            expect(kept).toBe(1); // live-1
            expect(skipped).toBe(2); // deleted-am + a-dip
            const by = Object.fromEntries(orphans.map((o) => [o.sip_uuid, o]));
            expect(Object.keys(by).sort()).toEqual(['orphan-A', 'orphan-B']);
            expect(by['orphan-A'].bucket).toBe('A');
            expect(by['orphan-B'].bucket).toBe('B');
        });

        it('annotates created_year + year_source (date field vs path)', () => {
            const { orphans } = classify(pkgs, live, deleted, { package_type: 'AIP' });
            const by = Object.fromEntries(orphans.map((o) => [o.sip_uuid, o]));
            expect(by['orphan-A'].created_year).toBe(2019);
            expect(by['orphan-A'].year_source).toBe('stored_date');
            expect(by['orphan-B'].created_year).toBe(2021);
            expect(by['orphan-B'].year_source).toBe('current_path');
        });

        it('honors an explicit date_field', () => {
            const pkg = [{ uuid: 'o', package_type: 'AIP', status: 'UPLOADED', ingest_date: '2014-07-07' }];
            const { orphans } = classify(pkg, new Set(), new Set(), { package_type: 'AIP', date_field: 'ingest_date' });
            expect(orphans[0].created_year).toBe(2014);
            expect(orphans[0].year_source).toBe('ingest_date');
        });

        it('coerces size to a number or null and carries AM fields', () => {
            const { orphans } = classify(pkgs, live, deleted, { package_type: 'AIP' });
            const a = orphans.find((o) => o.sip_uuid === 'orphan-A');
            expect(a.size_bytes).toBe(20); // '20' -> 20
            expect(a.current_path).toBe('/p/2');
            const b = orphans.find((o) => o.sip_uuid === 'orphan-B');
            expect(b.size_bytes).toBeNull(); // missing -> null
            expect(b.title).toBeNull(); // filled later from the DB
        });
    });

    describe('select_deletions', () => {
        const orphans = [
            { sip_uuid: 'a2019', bucket: 'A', created_year: 2019, year_source: 'stored_date' },
            { sip_uuid: 'a2019path', bucket: 'A', created_year: 2019, year_source: 'current_path' },
            { sip_uuid: 'a2020', bucket: 'A', created_year: 2020, year_source: 'stored_date' },
            { sip_uuid: 'a-undated', bucket: 'A', created_year: null, year_source: null },
            { sip_uuid: 'b2019', bucket: 'B', created_year: 2019, year_source: 'stored_date' },
        ];

        it('selects only bucket A, target year, trusted date source', () => {
            const { deletions, excluded_undated } = select_deletions(orphans, { year: 2019 });
            expect(deletions.map((d) => d.sip_uuid)).toEqual(['a2019']);
            /*
             * a2019path (path untrusted) + a-undated (no year) are undated;
             * a2020 is dated-but-wrong-year (not counted); b2019 is bucket B.
             */
            expect(excluded_undated).toBe(2);
        });

        it('includes current_path years only with allow_path_year', () => {
            const { deletions } = select_deletions(orphans, { year: 2019, allow_path_year: true });
            expect(deletions.map((d) => d.sip_uuid).sort()).toEqual(['a2019', 'a2019path']);
        });

        it('never selects bucket B even on a year match', () => {
            const { deletions } = select_deletions(orphans, { year: 2019, allow_path_year: true });
            expect(deletions.some((d) => d.sip_uuid === 'b2019')).toBe(false);
        });

        it('applies --limit but reports total_matched', () => {
            const { deletions, total_matched } = select_deletions(orphans, {
                year: 2019,
                allow_path_year: true,
                limit: 1,
            });
            expect(deletions).toHaveLength(1);
            expect(total_matched).toBe(2);
        });
    });

    describe('to_size', () => {
        it('handles numbers, numeric strings, blanks, and junk', () => {
            expect(to_size(5)).toBe(5);
            expect(to_size('42')).toBe(42);
            expect(to_size('')).toBeNull();
            expect(to_size(null)).toBeNull();
            expect(to_size('abc')).toBeNull();
        });
    });

    describe('to_csv', () => {
        it('emits the report header and escapes commas/quotes', () => {
            const rows = [
                {
                    sip_uuid: 'u1',
                    bucket: 'A',
                    created_year: 2019,
                    year_source: 'stored_date',
                    am_status: 'UPLOADED',
                    package_type: 'AIP',
                    size_bytes: 10,
                    current_location: 'loc',
                    current_path: '/a,b',
                    title: 'He said "hi"',
                },
            ];
            const lines = to_csv(rows).trim().split('\n');
            expect(lines[0]).toBe(
                'sip_uuid,bucket,created_year,year_source,am_status,package_type,size_bytes,current_location,current_path,title'
            );
            expect(lines[1]).toContain('"/a,b"');
            expect(lines[1]).toContain('"He said ""hi"""');
        });

        it('accepts a custom column set (used by the deletion CSVs)', () => {
            const csv = to_csv([{ sip_uuid: 'u', http_status: 202, ok: true }], [
                'sip_uuid',
                'http_status',
                'ok',
            ]);
            const lines = csv.trim().split('\n');
            expect(lines[0]).toBe('sip_uuid,http_status,ok');
            expect(lines[1]).toBe('u,202,true');
        });

        it('renders missing fields as empty cells', () => {
            const cells = to_csv([{ sip_uuid: 'u', bucket: 'A' }]).trim().split('\n')[1].split(',');
            expect(cells[0]).toBe('u');
            expect(cells[2]).toBe(''); // created_year missing
        });
    });
});
