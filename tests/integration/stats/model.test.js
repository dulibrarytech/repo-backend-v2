'use strict';

const stats_model = require('../../../stats/model');
const db_helper = require('../../helpers/db');
const { ValidationError } = require('../../../libs/errors');

describe('stats/model — DB integration', () => {
    beforeAll(async () => {
        await db_helper.setup_schema();
    });
    beforeEach(async () => {
        await db_helper.reset_data();
        stats_model._reset();
    });
    afterAll(async () => {
        await db_helper.teardown();
    });

    describe('summary()', () => {
        it('returns zeros on an empty table', async () => {
            const s = await stats_model.summary();
            expect(s).toEqual({
                total: 0,
                published: 0,
                unpublished: 0,
                deleted: 0,
                collections: 0,
                compounds: 0,
            });
        });

        it('aggregates totals correctly', async () => {
            await db_helper.seed_object({ is_published: 1 });
            await db_helper.seed_object({ is_published: 1 });
            await db_helper.seed_object({ is_published: 0 });
            await db_helper.seed_object({ is_published: 0, is_active: 0 });
            await db_helper.seed_object({ object_type: 'collection' });
            await db_helper.seed_object({ object_type: 'compound' });

            const s = await stats_model.summary();
            expect(s.total).toBe(6);
            expect(s.published).toBe(2);
            expect(s.deleted).toBe(1);
            // unpublished = total - published - deleted
            expect(s.unpublished).toBe(3);
            expect(s.collections).toBe(1);
            expect(s.compounds).toBe(1);
        });

        it('caches its result within the TTL', async () => {
            await db_helper.seed_object();
            const a = await stats_model.summary();
            // Mutate the underlying table — without cache invalidation
            // the cached result should still be returned.
            await db_helper.seed_object();
            const b = await stats_model.summary();
            expect(b.total).toBe(a.total);
            // After explicit reset, fresh numbers
            stats_model._reset();
            const c = await stats_model.summary();
            expect(c.total).toBe(2);
        });
    });

    describe('by_collection()', () => {
        it('returns top-N grouped by collection, ordered by count desc', async () => {
            for (let i = 0; i < 3; i++) {
                await db_helper.seed_object({ is_member_of_collection: 'codu:A' });
            }
            for (let i = 0; i < 5; i++) {
                await db_helper.seed_object({
                    is_member_of_collection: 'codu:B',
                    is_published: 1,
                });
            }
            await db_helper.seed_object({ is_member_of_collection: 'codu:C' });

            const r = await stats_model.by_collection({ limit: 10 });
            expect(r).toHaveLength(3);
            expect(r[0].collection).toBe('codu:B');
            expect(r[0].count).toBe(5);
            expect(r[0].published).toBe(5);
            expect(r[1].collection).toBe('codu:A');
            expect(r[2].collection).toBe('codu:C');
        });

        it('honors the limit', async () => {
            for (const c of ['a', 'b', 'c', 'd']) {
                await db_helper.seed_object({ is_member_of_collection: 'codu:' + c });
            }
            const r = await stats_model.by_collection({ limit: 2 });
            expect(r).toHaveLength(2);
        });

        it('rejects out-of-range limits', async () => {
            await expect(stats_model.by_collection({ limit: 0 })).rejects.toBeInstanceOf(
                ValidationError
            );
            await expect(stats_model.by_collection({ limit: 100 })).rejects.toBeInstanceOf(
                ValidationError
            );
        });

        it('excludes soft-deleted rows', async () => {
            await db_helper.seed_object({ is_member_of_collection: 'codu:gone', is_active: 0 });
            const r = await stats_model.by_collection();
            expect(r).toEqual([]);
        });

        it('resolves the collection title from display_record', async () => {
            // Seed two child rows pointing at codu:Alpha + one
            // collection row for codu:Alpha carrying its title in
            // display_record.
            await db_helper.seed_object({ is_member_of_collection: 'codu:Alpha' });
            await db_helper.seed_object({ is_member_of_collection: 'codu:Alpha' });
            await db_helper.seed_object({
                pid: 'codu:Alpha',
                object_type: 'collection',
                display_record: JSON.stringify({ title: 'Alpha Papers' }),
            });
            const r = await stats_model.by_collection({ limit: 5 });
            const alpha = r.find((c) => c.collection === 'codu:Alpha');
            expect(alpha).toBeTruthy();
            expect(alpha.title).toBe('Alpha Papers');
            // Count still reflects only the children, not the
            // collection row itself (the GROUP BY filter is
            // on is_member_of_collection != '').
            expect(alpha.count).toBe(2);
        });

        it('falls back to null title when no collection row exists (orphan membership)', async () => {
            await db_helper.seed_object({ is_member_of_collection: 'codu:Orphan' });
            const r = await stats_model.by_collection({ limit: 5 });
            const orphan = r.find((c) => c.collection === 'codu:Orphan');
            expect(orphan).toBeTruthy();
            expect(orphan.title).toBeNull();
        });

        it('falls back to null title when display_record has no title key', async () => {
            await db_helper.seed_object({ is_member_of_collection: 'codu:NoTitle' });
            await db_helper.seed_object({
                pid: 'codu:NoTitle',
                object_type: 'collection',
                display_record: JSON.stringify({ abstract: 'no title here' }),
            });
            const r = await stats_model.by_collection({ limit: 5 });
            const row = r.find((c) => c.collection === 'codu:NoTitle');
            expect(row.title).toBeNull();
        });

        it('treats whitespace-only titles as missing (so partial falls back to PID)', async () => {
            await db_helper.seed_object({ is_member_of_collection: 'codu:Blank' });
            await db_helper.seed_object({
                pid: 'codu:Blank',
                object_type: 'collection',
                display_record: JSON.stringify({ title: '   ' }),
            });
            const r = await stats_model.by_collection({ limit: 5 });
            const row = r.find((c) => c.collection === 'codu:Blank');
            expect(row.title).toBeNull();
        });

        it('resolves titles even when the collection row is soft-deleted', async () => {
            // Counts include children regardless of the collection's
            // own active flag, so the title should also resolve. Lets
            // the panel stay readable mid-curation.
            await db_helper.seed_object({ is_member_of_collection: 'codu:Soft' });
            await db_helper.seed_object({
                pid: 'codu:Soft',
                object_type: 'collection',
                is_active: 0,
                display_record: JSON.stringify({ title: 'Withdrawn collection' }),
            });
            const r = await stats_model.by_collection({ limit: 5 });
            const row = r.find((c) => c.collection === 'codu:Soft');
            expect(row.title).toBe('Withdrawn collection');
        });

        it('ignores titles from non-collection rows that happen to share a pid', async () => {
            // Defense in depth: if a non-collection row was accidentally
            // assigned the same PID as a collection membership target,
            // its title MUST NOT be borrowed. The lookup is gated on
            // object_type='collection'.
            await db_helper.seed_object({ is_member_of_collection: 'codu:Mix' });
            await db_helper.seed_object({
                pid: 'codu:Mix',
                object_type: 'object',
                display_record: JSON.stringify({ title: 'Random object title' }),
            });
            const r = await stats_model.by_collection({ limit: 5 });
            const row = r.find((c) => c.collection === 'codu:Mix');
            expect(row.title).toBeNull();
        });
    });

    describe('recent_ingests()', () => {
        it('returns the latest N active objects, newest first', async () => {
            // sqlite created timestamp granularity may collide, so we
            // rely on id-order tie-breaking too.
            const seeded = [];
            for (let i = 0; i < 6; i++) {
                seeded.push(await db_helper.seed_object({ file_name: `f-${i}.dat` }));
            }
            const r = await stats_model.recent_ingests({ limit: 3 });
            expect(r).toHaveLength(3);
            // Last inserted should be first
            expect(r[0].file_name).toBe('f-5.dat');
        });

        it('skips soft-deleted rows', async () => {
            await db_helper.seed_object({ file_name: 'kept.dat' });
            await db_helper.seed_object({ file_name: 'gone.dat', is_active: 0 });
            const r = await stats_model.recent_ingests();
            expect(r.every((row) => row.file_name !== 'gone.dat')).toBe(true);
        });

        it('extracts title from display_record', async () => {
            await db_helper.seed_object({
                file_name: 'obj.tif',
                display_record: JSON.stringify({ title: 'Beautiful Photograph' }),
            });
            const r = await stats_model.recent_ingests({ limit: 1 });
            expect(r[0].title).toBe('Beautiful Photograph');
        });

        it('extracts call_number from display_record.identifiers (type=local)', async () => {
            await db_helper.seed_object({
                file_name: 'obj.tif',
                display_record: JSON.stringify({
                    title: 'Photo',
                    identifiers: [
                        { type: 'pid', identifier: 'codu:xyz' },
                        { type: 'local', identifier: 'B002.05.01.0387.0009.00003' },
                    ],
                }),
            });
            const r = await stats_model.recent_ingests({ limit: 1 });
            expect(r[0].call_number).toBe('B002.05.01.0387.0009.00003');
        });

        it('returns null title when display_record has no title key', async () => {
            await db_helper.seed_object({
                file_name: 'obj.tif',
                display_record: JSON.stringify({ abstract: 'no title' }),
            });
            const r = await stats_model.recent_ingests({ limit: 1 });
            expect(r[0].title).toBeNull();
        });

        it('returns null call_number when no local identifier is present', async () => {
            await db_helper.seed_object({
                file_name: 'obj.tif',
                display_record: JSON.stringify({
                    title: 'Photo',
                    identifiers: [{ type: 'pid', identifier: 'codu:xyz' }],
                }),
            });
            const r = await stats_model.recent_ingests({ limit: 1 });
            expect(r[0].call_number).toBeNull();
        });

        it('returns null title + call_number when display_record is absent', async () => {
            await db_helper.seed_object({ file_name: 'obj.tif' });
            const r = await stats_model.recent_ingests({ limit: 1 });
            expect(r[0].title).toBeNull();
            expect(r[0].call_number).toBeNull();
        });

        it('treats whitespace-only title as missing', async () => {
            await db_helper.seed_object({
                file_name: 'obj.tif',
                display_record: JSON.stringify({ title: '   ' }),
            });
            const r = await stats_model.recent_ingests({ limit: 1 });
            expect(r[0].title).toBeNull();
        });

        it('treats whitespace-only call_number as missing', async () => {
            await db_helper.seed_object({
                file_name: 'obj.tif',
                display_record: JSON.stringify({
                    identifiers: [{ type: 'local', identifier: '   ' }],
                }),
            });
            const r = await stats_model.recent_ingests({ limit: 1 });
            expect(r[0].call_number).toBeNull();
        });

        it('does not include the raw display_record blob in the response', async () => {
            // 3KB per row of unused payload is wasted bandwidth on the
            // home page poll. The partial only consumes the derived
            // fields, so the raw blob is stripped before returning.
            await db_helper.seed_object({
                file_name: 'obj.tif',
                display_record: JSON.stringify({ title: 'Photo', big_payload: 'x'.repeat(2000) }),
            });
            const r = await stats_model.recent_ingests({ limit: 1 });
            expect(r[0]).not.toHaveProperty('display_record');
        });

        it('handles malformed display_record JSON gracefully', async () => {
            await db_helper.seed_object({
                file_name: 'obj.tif',
                display_record: '{not valid json',
            });
            const r = await stats_model.recent_ingests({ limit: 1 });
            expect(r[0].title).toBeNull();
            expect(r[0].call_number).toBeNull();
        });
    });

    describe('active_users()', () => {
        it('counts only is_active=1 users', async () => {
            await db_helper.seed_user({ du_id: 'a' });
            await db_helper.seed_user({ du_id: 'b' });
            await db_helper.seed_user({ du_id: 'c', is_active: 0 });
            expect(await stats_model.active_users()).toBe(2);
        });
    });

    describe('extended_summary()', () => {
        // The v1-dashboard parity stats. Tests each field independently
        // so a regression on one bucket doesn't mask others.

        it('returns zeros on an empty table', async () => {
            const s = await stats_model.extended_summary();
            expect(s.total_collections).toBe(0);
            expect(s.published_collections).toBe(0);
            expect(s.total_objects).toBe(0);
            expect(s.published_objects).toBe(0);
            expect(s.images).toBe(0);
            expect(s.pdfs).toBe(0);
            expect(s.audio).toBe(0);
            expect(s.videos).toBe(0);
            expect(s.current_fy_ingests).toBe(0);
            expect(typeof s.current_fy_label).toBe('string');
        });

        it('partitions collections by published flag and ignores deleted rows', async () => {
            await db_helper.seed_object({ object_type: 'collection', is_published: 1 });
            await db_helper.seed_object({ object_type: 'collection', is_published: 1 });
            await db_helper.seed_object({ object_type: 'collection', is_published: 0 });
            await db_helper.seed_object({ object_type: 'collection', is_active: 0 });
            const s = await stats_model.extended_summary();
            expect(s.total_collections).toBe(3);
            expect(s.published_collections).toBe(2);
        });

        it('partitions objects by published flag and ignores deleted rows', async () => {
            await db_helper.seed_object({ object_type: 'object', is_published: 1 });
            await db_helper.seed_object({ object_type: 'object', is_published: 0 });
            await db_helper.seed_object({ object_type: 'object', is_active: 0, is_published: 1 });
            const s = await stats_model.extended_summary();
            expect(s.total_objects).toBe(2);
            expect(s.published_objects).toBe(1);
        });

        it('buckets media types using v1 mime-type lists', async () => {
            // Images: tiff + jpeg + png
            await db_helper.seed_object({ mime_type: 'image/tiff' });
            await db_helper.seed_object({ mime_type: 'image/jpeg' });
            await db_helper.seed_object({ mime_type: 'image/png' });
            // PDFs
            await db_helper.seed_object({ mime_type: 'application/pdf' });
            await db_helper.seed_object({ mime_type: 'application/pdf' });
            // Audio: wav + mp3
            await db_helper.seed_object({ mime_type: 'audio/x-wav' });
            await db_helper.seed_object({ mime_type: 'audio/mpeg' });
            // Videos: mp4 + quicktime + mpeg
            await db_helper.seed_object({ mime_type: 'video/mp4' });
            await db_helper.seed_object({ mime_type: 'video/quicktime' });
            // Unbucketed mime types must NOT count
            await db_helper.seed_object({ mime_type: 'text/plain' });
            // Deleted rows must NOT count even with a bucketed mime type
            await db_helper.seed_object({ mime_type: 'image/jpeg', is_active: 0 });

            const s = await stats_model.extended_summary();
            expect(s.images).toBe(3);
            expect(s.pdfs).toBe(2);
            expect(s.audio).toBe(2);
            expect(s.videos).toBe(2);
        });

        it('counts current-fiscal-year ingests (July 1 – June 30 window)', async () => {
            const { start, end } = stats_model._current_fiscal_year_bounds();
            // Three rows inside the FY window — should count.
            await db_helper.seed_object({ created: start });
            await db_helper.seed_object({ created: end });
            await db_helper.seed_object({
                created: start.slice(0, 4) + '-12-15 10:00:00',
            });
            // One row 1 day BEFORE the FY started — must NOT count.
            const start_year = Number(start.slice(0, 4));
            await db_helper.seed_object({
                created: `${start_year}-06-30 23:00:00`,
            });
            // One row AFTER the FY ends — must NOT count.
            const end_year = Number(end.slice(0, 4));
            await db_helper.seed_object({
                created: `${end_year}-07-01 01:00:00`,
            });
            // Soft-deleted row inside the window — must NOT count.
            await db_helper.seed_object({ created: start, is_active: 0 });

            const s = await stats_model.extended_summary();
            expect(s.current_fy_ingests).toBe(3);
            expect(s.current_fy_label).toMatch(/Jul 1, \d{4}/);
            expect(s.current_fy_label).toMatch(/Jun 30, \d{4}/);
        });
    });

    describe('ingests_per_year()', () => {
        it('returns padded contiguous year buckets starting at min_year', async () => {
            await db_helper.seed_object({ created: '2020-03-01 00:00:00' });
            await db_helper.seed_object({ created: '2020-08-15 00:00:00' });
            await db_helper.seed_object({ created: '2023-06-15 00:00:00' });
            const r = await stats_model.ingests_per_year({ min_year: 2020 });
            // Every year from 2020 → currentYear must be present.
            const years = r.map((x) => x.year);
            expect(years[0]).toBe(2020);
            const this_year = new Date().getFullYear();
            expect(years[years.length - 1]).toBe(this_year);
            // 2020 had 2, 2023 had 1.
            const by_year = Object.fromEntries(r.map((x) => [x.year, x.count]));
            expect(by_year[2020]).toBe(2);
            expect(by_year[2023]).toBe(1);
            // Years with no data MUST appear as zero rather than be
            // missing — the chart relies on contiguous x-axis.
            expect(by_year[2021]).toBe(0);
            expect(by_year[2022]).toBe(0);
        });

        it('counts every row regardless of object_type or is_active (matches v1)', async () => {
            // v1's chart shows throughput, not just published / leaf
            // objects. Pin that behavior — deleted + collection rows
            // count too.
            await db_helper.seed_object({
                created: '2025-01-01 00:00:00',
                object_type: 'collection',
            });
            await db_helper.seed_object({
                created: '2025-01-02 00:00:00',
                object_type: 'compound',
            });
            await db_helper.seed_object({
                created: '2025-01-03 00:00:00',
                is_active: 0,
            });
            const r = await stats_model.ingests_per_year({ min_year: 2020 });
            const by_year = Object.fromEntries(r.map((x) => [x.year, x.count]));
            expect(by_year[2025]).toBe(3);
        });

        it('rejects out-of-range min_year values', async () => {
            await expect(
                stats_model.ingests_per_year({ min_year: 1900 })
            ).rejects.toBeInstanceOf(ValidationError);
            await expect(
                stats_model.ingests_per_year({ min_year: 3000 })
            ).rejects.toBeInstanceOf(ValidationError);
        });
    });

    describe('_current_fiscal_year_bounds()', () => {
        // Pure function — exercise both halves of the year explicitly.

        it('Jan-Jun → FY is (prior_year-07-01, this_year-06-30)', () => {
            const bounds = stats_model._current_fiscal_year_bounds(new Date('2026-03-15'));
            expect(bounds.start.startsWith('2025-07-01')).toBe(true);
            expect(bounds.end.startsWith('2026-06-30')).toBe(true);
            expect(bounds.start_year).toBe(2025);
            expect(bounds.end_year).toBe(2026);
        });

        it('Jul-Dec → FY is (this_year-07-01, next_year-06-30)', () => {
            const bounds = stats_model._current_fiscal_year_bounds(new Date('2026-08-15'));
            expect(bounds.start.startsWith('2026-07-01')).toBe(true);
            expect(bounds.end.startsWith('2027-06-30')).toBe(true);
            expect(bounds.start_year).toBe(2026);
            expect(bounds.end_year).toBe(2027);
        });

        it('the cusp dates (July 1 + June 30) are handled correctly', () => {
            // June 30 = LAST day of the previous FY year boundary
            const jun30 = stats_model._current_fiscal_year_bounds(new Date('2026-06-30T12:00:00Z'));
            expect(jun30.start_year).toBe(2025);
            expect(jun30.end_year).toBe(2026);
            // July 1 = FIRST day of the new FY
            const jul1 = stats_model._current_fiscal_year_bounds(new Date('2026-07-01T12:00:00Z'));
            expect(jul1.start_year).toBe(2026);
            expect(jul1.end_year).toBe(2027);
        });
    });
});
