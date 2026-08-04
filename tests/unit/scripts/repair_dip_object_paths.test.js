'use strict';

/*
 * Unit tests for scripts/repair_dip_object_paths.js — the prod repair
 * that uuid-prefixes DIP object paths on v2-ingested rows (the uuid is
 * recovered from each part's thumbnail derivative name). plan_row is
 * pure; run() is exercised with injected deps.
 */

const {
    parse_args,
    plan_row,
    run,
    uuid_from_thumbnail,
} = require('../../../scripts/repair_dip_object_paths');

const U1 = '52aafea5-fbaf-4394-a2f6-67c3c0dd6ecb';
const U2 = '072ef0f0-047d-4316-9fa5-b8618baee5a3';

/* A fat (post-backfill) row with un-prefixed object paths, per prod. */
function broken_row(overrides = {}) {
    const parts = [
        {
            order: '1',
            title: 'B463.00001.tif',
            type: 'image/tiff',
            caption: null,
            object: 'dip/objects/B463.00001.tif',
            thumbnail: `dip/thumbnails/${U1}.jpg`,
        },
        {
            order: '2',
            title: 'B463.00002.tif',
            type: 'image/tiff',
            caption: null,
            object: 'dip/objects/B463.00002.tif',
            thumbnail: `dip/thumbnails/${U2}.jpg`,
        },
    ];
    return {
        pid: 'pid-1',
        object_type: 'compound',
        is_compound: 1,
        file_name: 'B463.00001.tif',
        display_record: JSON.stringify({
            pid: 'pid-1',
            title: 'Albuquerque, NM,',
            object: 'dip/objects/B463.00001.tif',
            mime_type: 'image/tiff',
            display_record: { title: 'Albuquerque, NM,', parts },
        }),
        ...overrides,
    };
}

describe('scripts/repair_dip_object_paths — uuid_from_thumbnail', () => {
    it('extracts the uuid from a thumbnail derivative path', () => {
        expect(uuid_from_thumbnail(`dip/thumbnails/${U1}.jpg`)).toBe(U1);
    });
    it('rejects non-uuid stems and empties', () => {
        expect(uuid_from_thumbnail('dip/thumbnails/not-a-uuid.jpg')).toBeNull();
        expect(uuid_from_thumbnail('')).toBeNull();
        expect(uuid_from_thumbnail(null)).toBeNull();
    });
});

describe('scripts/repair_dip_object_paths — plan_row', () => {
    it('uuid-prefixes every part object path and the master-derived fields', () => {
        const plan = plan_row(broken_row());
        expect(plan.action).toBe('update');
        const envelope = JSON.parse(plan.updates.display_record);
        const parts = envelope.display_record.parts;
        expect(parts[0].object).toBe(`dip/objects/${U1}-B463.00001.tif`);
        expect(parts[1].object).toBe(`dip/objects/${U2}-B463.00002.tif`);
        // Master (stable-sorted by title) drives the top level + column.
        expect(envelope.object).toBe(`dip/objects/${U1}-B463.00001.tif`);
        expect(plan.updates.file_name).toBe(`dip/objects/${U1}-B463.00001.tif`);
        expect(JSON.parse(plan.updates.compound_parts)).toHaveLength(2);
        expect(plan.updates.is_updated).toBe(1);
        // Untouched fields ride along unchanged.
        expect(envelope.title).toBe('Albuquerque, NM,');
        expect(envelope.mime_type).toBe('image/tiff');
    });

    it('skips compound_parts for simple objects', () => {
        const row = broken_row({ object_type: 'object', is_compound: 0 });
        const plan = plan_row(row);
        expect(plan.action).toBe('update');
        expect(plan.updates.compound_parts).toBeUndefined();
    });

    it('is idempotent: skips rows whose paths already carry the prefix', () => {
        const first = plan_row(broken_row());
        const again = plan_row(broken_row({ display_record: first.updates.display_record }));
        expect(again.action).toBe('skip');
        expect(again.reason).toBe('already_correct');
    });

    it('leaves parts without a derivable uuid untouched, repairs the rest', () => {
        const row = broken_row();
        const envelope = JSON.parse(row.display_record);
        envelope.display_record.parts[1].thumbnail = 'dip/thumbnails/whoops.png';
        row.display_record = JSON.stringify(envelope);
        const plan = plan_row(row);
        expect(plan.action).toBe('update');
        const parts = JSON.parse(plan.updates.display_record).display_record.parts;
        expect(parts[0].object).toBe(`dip/objects/${U1}-B463.00001.tif`);
        expect(parts[1].object).toBe('dip/objects/B463.00002.tif');
        expect(plan.notes.no_uuid).toBe(1);
    });

    it('skips thin envelopes (backfill_display_records owns those)', () => {
        const row = broken_row({
            display_record: JSON.stringify({ title: 'T', display_record: {}, parts: [] }),
        });
        expect(plan_row(row).reason).toBe('thin_run_backfill_first');
    });

    it('skips collections, unparsable envelopes, and part-less rows', () => {
        expect(plan_row(broken_row({ object_type: 'collection' })).reason).toBe('collection');
        expect(plan_row(broken_row({ display_record: '{nope' })).reason).toBe(
            'display_record_unparsable'
        );
        const no_parts = broken_row({
            display_record: JSON.stringify({ pid: 'pid-1', display_record: { parts: [] } }),
        });
        expect(plan_row(no_parts).reason).toBe('no_parts');
    });
});

describe('scripts/repair_dip_object_paths — parse_args / run', () => {
    it('defaults to dry-run with the v2-era created floor', () => {
        expect(parse_args(['node', 's'])).toEqual({
            execute: false,
            pids: null,
            since: '2026-07-01',
        });
    });
    it('validates --since', () => {
        expect(() => parse_args(['node', 's', '--since', 'nope'])).toThrow(/YYYY-MM-DD/);
    });

    function fake_db(rows) {
        const applied = [];
        const db = () => (table) => ({
            where(criteria) {
                return {
                    update(updates) {
                        applied.push({ table, criteria, updates });
                        return Promise.resolve(1);
                    },
                };
            },
        });
        return { db, applied, rows };
    }
    const tables = { objects: 'tbl_objects' };

    it('dry-run writes nothing; --execute applies per pid', async () => {
        const fake = fake_db([broken_row(), broken_row({ pid: 'pid-2' })]);
        const deps = {
            db_module: { db: fake.db, destroy_all: async () => {} },
            tables,
            select_candidates: async () => fake.rows,
        };
        const dry = await run({ execute: false, pids: null, since: '2026-07-01' }, deps);
        expect(dry.counts).toEqual({ update: 2, skip: 0 });
        expect(fake.applied).toEqual([]);

        const real = await run({ execute: true, pids: null, since: '2026-07-01' }, deps);
        expect(real.counts).toEqual({ update: 2, skip: 0 });
        expect(fake.applied).toHaveLength(2);
        expect(fake.applied[0].criteria).toEqual({ pid: 'pid-1' });
    });

    it('legacy-correct rows count as skips and are not written', async () => {
        const first = plan_row(broken_row());
        const fixed = broken_row({ display_record: first.updates.display_record });
        const fake = fake_db([fixed]);
        const { counts } = await run(
            { execute: true, pids: null, since: '2026-07-01' },
            {
                db_module: { db: fake.db, destroy_all: async () => {} },
                tables,
                select_candidates: async () => fake.rows,
            }
        );
        expect(counts).toEqual({ update: 0, skip: 1 });
        expect(fake.applied).toEqual([]);
    });
});
