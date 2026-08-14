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

        it('rewrites http hdl.handle.net handles to https at render time', () => {
            /*
             * All legacy handles were minted http:// — short-term
             * render-time rewrite until the data backfill. Precise
             * host match: junk handle values (stored v1 error
             * strings, bare pids) must pass through untouched.
             */
            const out = projection.enrich({
                pid: 'p-h1',
                handle: 'http://hdl.handle.net/10176/p-h1',
            });
            expect(out.handle).toBe('https://hdl.handle.net/10176/p-h1');
            // Already-https and non-handle values untouched.
            expect(
                projection.enrich({ pid: 'p-h2', handle: 'https://hdl.handle.net/10176/p-h2' }).handle
            ).toBe('https://hdl.handle.net/10176/p-h2');
            expect(
                projection.enrich({ pid: 'p-h3', handle: 'Error: [/libs/handles lib] mint failed' }).handle
            ).toBe('Error: [/libs/handles lib] mint failed');
            expect(projection.enrich({ pid: 'p-h4', handle: null }).handle).toBeNull();
            // display_record's copy wins and is rewritten too.
            expect(
                projection.enrich({
                    pid: 'p-h5',
                    handle: null,
                    display_record: JSON.stringify({ handle: 'http://hdl.handle.net/10176/p-h5' }),
                }).handle
            ).toBe('https://hdl.handle.net/10176/p-h5');
        });

        it('exposes the ASpace identifier from the nested transform record', () => {
            /*
             * Real display_record shape: an index-doc envelope whose
             * nested `display_record` carries the ASpace transform —
             * identifiers live ONLY there, not at the top level.
             */
            const out = projection.enrich({
                pid: 'p-id1',
                display_record: JSON.stringify({
                    title: 'Enveloped',
                    display_record: {
                        title: 'Enveloped',
                        identifiers: [
                            { type: 'local', identifier: 'B002.01.0098.0035.00008' },
                        ],
                    },
                }),
            });
            expect(out.identifier).toBe('B002.01.0098.0035.00008');
        });

        it('falls back to flat identifiers and nulls a null identifier value', () => {
            // Flat-shape fallback (parity with the AIP dashboard lookup).
            const flat = projection.enrich({
                pid: 'p-id2',
                display_record: JSON.stringify({
                    identifiers: [{ type: 'local', identifier: 'M123.01' }],
                }),
            });
            expect(flat.identifier).toBe('M123.01');
            // Exporter emits {type:'local', identifier:null} when AS has none.
            const none = projection.enrich({
                pid: 'p-id3',
                display_record: JSON.stringify({
                    display_record: {
                        identifiers: [{ type: 'local', identifier: null }],
                    },
                }),
            });
            expect(none.identifier).toBeNull();
            // No display_record at all.
            expect(projection.enrich({ pid: 'p-id4' }).identifier).toBeNull();
        });

        it('derives the identifier from a raw ASpace record when no identifiers array exists', () => {
            /*
             * Most collection rows store the UNtransformed ASpace JSON
             * under display_record.display_record (no identifiers array).
             * The call number must still surface: id_0..id_3 joined for
             * resources, component_id for archival objects.
             */
            const resource = projection.enrich({
                pid: 'p-id5',
                display_record: JSON.stringify({
                    title: 'Raw resource',
                    display_record: {
                        jsonmodel_type: 'resource',
                        id_0: 'D009',
                    },
                }),
            });
            expect(resource.identifier).toBe('D009');
            const multi = projection.enrich({
                pid: 'p-id6',
                display_record: JSON.stringify({
                    display_record: {
                        jsonmodel_type: 'resource',
                        id_0: 'B002',
                        id_1: '01',
                    },
                }),
            });
            expect(multi.identifier).toBe('B002.01');
            const archival = projection.enrich({
                pid: 'p-id7',
                display_record: JSON.stringify({
                    display_record: {
                        jsonmodel_type: 'archival_object',
                        component_id: 'U212.02',
                    },
                }),
            });
            expect(archival.identifier).toBe('U212.02');
            // Raw record with no ids at all still nulls out cleanly.
            const bare = projection.enrich({
                pid: 'p-id8',
                display_record: JSON.stringify({
                    display_record: { jsonmodel_type: 'resource' },
                }),
            });
            expect(bare.identifier).toBeNull();
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
