'use strict';

/*
 * Unit tests for libs/object_projection — the row-enrichment helper
 * the dashboard runs on every list row. Covers display_record parsing
 * edge cases (the long tail of malformed JSON we've actually seen in
 * the v1 corpus) and the thumbnail-URL synthesis that decides whether
 * the row's <img src> points at the proxy or at a stored URL.
 */

const projection = require('../../../libs/object_projection');
const app_config = require('../../../config/app');

describe('libs/object_projection', () => {
    let original_env;
    beforeEach(() => {
        original_env = { ...process.env };
        process.env.APP_PATH = '/repo';
        app_config._reset();
    });
    afterEach(() => {
        process.env = original_env;
        app_config._reset();
    });

    describe('parse_display_record', () => {
        it('returns {} for null/undefined/empty inputs', () => {
            expect(projection.parse_display_record(null)).toEqual({});
            expect(projection.parse_display_record(undefined)).toEqual({});
            expect(projection.parse_display_record('')).toEqual({});
        });

        it('returns the object when passed a parsed object', () => {
            expect(projection.parse_display_record({ a: 1 })).toEqual({ a: 1 });
        });

        it('parses valid JSON strings', () => {
            expect(projection.parse_display_record('{"a":1}')).toEqual({ a: 1 });
        });

        it('returns {} for malformed JSON instead of throwing', () => {
            expect(projection.parse_display_record('{not json')).toEqual({});
        });

        it('returns {} when JSON parses to a non-object (e.g. a bare string)', () => {
            expect(projection.parse_display_record('"hello"')).toEqual({});
            expect(projection.parse_display_record('42')).toEqual({});
        });
    });

    describe('thumbnail_src', () => {
        it('returns null for empty/missing values', () => {
            expect(projection.thumbnail_src(null, 'pid')).toBeNull();
            expect(projection.thumbnail_src('', 'pid')).toBeNull();
            expect(projection.thumbnail_src(undefined, 'pid')).toBeNull();
        });

        it('passes through absolute http(s) URLs unchanged', () => {
            expect(projection.thumbnail_src('https://cdn.example/x.jpg', 'p')).toBe(
                'https://cdn.example/x.jpg'
            );
            expect(projection.thumbnail_src('http://localhost/y.jpg', 'p')).toBe(
                'http://localhost/y.jpg'
            );
        });

        it('rewrites a dip-store-relative path to the proxy URL', () => {
            const out = projection.thumbnail_src(
                'archivematica-dip-2024/thumbnails/abc.jpg',
                'abc-123'
            );
            expect(out).toBe('/repo/dashboard/objects/abc-123/thumbnail/raw');
        });

        it('returns null when the value is a path but pid is missing', () => {
            /*
             * Without a pid we can't build a proxy URL, so the caller
             * should render a placeholder rather than a broken link.
             */
            expect(projection.thumbnail_src('foo/thumbnails/x.jpg', null)).toBeNull();
        });

        it('honors APP_PATH when not /repo', () => {
            process.env.APP_PATH = '/something-else';
            app_config._reset();
            expect(projection.thumbnail_src('foo.jpg', 'pid-1')).toBe(
                '/something-else/dashboard/objects/pid-1/thumbnail/raw'
            );
        });
    });

    describe('media_category', () => {
        it('maps mime types to coarse categories', () => {
            expect(projection.media_category('audio/mpeg')).toBe('audio');
            expect(projection.media_category('video/mp4')).toBe('video');
            expect(projection.media_category('application/pdf')).toBe('pdf');
            expect(projection.media_category('image/tiff')).toBe('image');
            expect(projection.media_category('IMAGE/JPEG')).toBe('image'); // case-insensitive
        });
        it('falls back to "file" for unknown or empty mime', () => {
            expect(projection.media_category('application/zip')).toBe('file');
            expect(projection.media_category('')).toBe('file');
            expect(projection.media_category(null)).toBe('file');
            expect(projection.media_category(undefined)).toBe('file');
        });
    });

    describe('enrich', () => {
        it('drops display_record and exposes the parsed fields', () => {
            const out = projection.enrich({
                pid: 'p1',
                handle: 'https://hdl/p1',
                display_record: JSON.stringify({
                    title: 'A title',
                    abstract: ['First abstract', 'Second'],
                    f_subjects: ['One', 'Two'],
                }),
            });
            expect(out.display_record).toBeUndefined();
            expect(out.title).toBe('A title');
            expect(out.abstract).toBe('First abstract');
            expect(out.subjects).toEqual(['One', 'Two']);
        });

        it('exposes media_category derived from the row mime_type', () => {
            expect(projection.enrich({ pid: 'a', mime_type: 'audio/mpeg' }).media_category).toBe('audio');
            expect(projection.enrich({ pid: 'b', mime_type: 'application/pdf' }).media_category).toBe('pdf');
            expect(projection.enrich({ pid: 'c' }).media_category).toBe('file'); // no mime_type
        });

        it('synthesizes a proxy URL for legacy dip-store thumbnails', () => {
            const out = projection.enrich({
                pid: 'p2',
                thumbnail: 'archivematica-dip/thumbnails/p2.jpg',
                display_record: null,
            });
            expect(out.thumbnail).toBe('/repo/dashboard/objects/p2/thumbnail/raw');
            /*
             * Raw value preserved so the upload modal can still
             * display what's stored.
             */
            expect(out.thumbnail_raw).toBe('archivematica-dip/thumbnails/p2.jpg');
        });

        it('keeps an absolute http URL as-is', () => {
            const out = projection.enrich({
                pid: 'p3',
                thumbnail: 'https://repo.du.edu/repo/static/tn/p3.jpg',
            });
            expect(out.thumbnail).toBe('https://repo.du.edu/repo/static/tn/p3.jpg');
            expect(out.thumbnail_raw).toBe('https://repo.du.edu/repo/static/tn/p3.jpg');
        });

        it('prefers display_record.thumbnail over the column value', () => {
            /*
             * When the indexer wrote a newer URL into display_record
             * we trust that copy over the lagging column. Matches the
             * legacy behavior the comment in enrich() promises.
             */
            const out = projection.enrich({
                pid: 'p4',
                thumbnail: 'stale-col.jpg',
                display_record: JSON.stringify({
                    thumbnail: 'fresh-dr/thumbnails/p4.jpg',
                }),
            });
            expect(out.thumbnail_raw).toBe('fresh-dr/thumbnails/p4.jpg');
            expect(out.thumbnail).toBe('/repo/dashboard/objects/p4/thumbnail/raw');
        });

        it('returns null thumbnail when both sources are empty', () => {
            const out = projection.enrich({ pid: 'p5', thumbnail: null });
            expect(out.thumbnail).toBeNull();
            expect(out.thumbnail_raw).toBeNull();
        });
    });

    describe('is_empty_value', () => {
        it('treats nullish + blank strings + empty/all-empty arrays & objects as empty', () => {
            expect(projection.is_empty_value(null)).toBe(true);
            expect(projection.is_empty_value(undefined)).toBe(true);
            expect(projection.is_empty_value('')).toBe(true);
            expect(projection.is_empty_value('   ')).toBe(true);
            expect(projection.is_empty_value([])).toBe(true);
            expect(projection.is_empty_value([null, '', '  '])).toBe(true);
            expect(projection.is_empty_value({})).toBe(true);
            expect(projection.is_empty_value({ a: '', b: null })).toBe(true);
        });

        it('treats real values (incl. 0 and false) as non-empty', () => {
            expect(projection.is_empty_value('x')).toBe(false);
            expect(projection.is_empty_value(0)).toBe(false);
            expect(projection.is_empty_value(false)).toBe(false);
            expect(projection.is_empty_value(['a'])).toBe(false);
            expect(projection.is_empty_value({ a: 'b' })).toBe(false);
            expect(projection.is_empty_value([{ k: 'v' }])).toBe(false);
        });
    });

});
