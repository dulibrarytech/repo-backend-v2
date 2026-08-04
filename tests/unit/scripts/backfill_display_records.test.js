'use strict';

/*
 * Unit tests for scripts/backfill_display_records.js — the prod repair
 * for thin 2026-07/08 envelopes. plan_row is pure; run() is exercised
 * with injected deps (no DB env needed).
 */

const { parse_args, plan_row, run } = require('../../../scripts/backfill_display_records');

/* A thin-envelope prod row, modeled on the affected oral histories. */
function thin_row(overrides = {}) {
    const metadata = {
        title: 'Nancy McElroy Oral History, 2024',
        identifiers: [{ type: 'local', identifier: 'D009.1' }],
        parts: [
            {
                order: '1',
                title: 'D009.mov',
                kaltura_id: '1_abc',
                type: 'video/quicktime',
                caption: null,
            },
        ],
        is_compound: false,
    };
    return {
        pid: 'pid-1',
        is_member_of_collection: 'col-1',
        handle: 'https://hdl.example/pid-1',
        thumbnail: 'dip/thumbnails/u-mov.jpg',
        mime_type: null, // the METS swap nulled it
        file_name: 'D009.mov',
        object_type: 'object',
        is_published: 0,
        is_compound: 0,
        mods: JSON.stringify(metadata),
        display_record: JSON.stringify({
            title: metadata.title,
            abstract: '',
            handle: 'https://hdl.example/pid-1',
            display_record: metadata,
            parts: [
                {
                    uuid: 'u-txt',
                    file_id: 'uri',
                    file: 'uri.txt',
                    mime_type: 'video/quicktime',
                    type: 'txt',
                    object: 'dip/objects/uri.txt',
                    thumbnail: 'dip/thumbnails/u-txt.jpg',
                },
                {
                    uuid: 'u-mov',
                    file_id: 'D009',
                    file: 'D009.mov',
                    mime_type: null,
                    type: 'object',
                    object: 'dip/objects/D009.mov',
                    thumbnail: 'dip/thumbnails/u-mov.jpg',
                },
            ],
        }),
        ...overrides,
    };
}

describe('scripts/backfill_display_records — parse_args', () => {
    it('defaults to dry-run', () => {
        expect(parse_args(['node', 's'])).toEqual({ execute: false, pids: null });
    });
    it('parses --execute and --pids', () => {
        expect(parse_args(['node', 's', '--execute', '--pids', 'a, b'])).toEqual({
            execute: true,
            pids: ['a', 'b'],
        });
    });
    it('throws on unknown args', () => {
        expect(() => parse_args(['node', 's', '--nope'])).toThrow(/unknown arg/);
    });
});

describe('scripts/backfill_display_records — plan_row', () => {
    it('rebuilds a thin envelope to the fat contract with merged parts', () => {
        const plan = plan_row(thin_row());
        expect(plan.action).toBe('update');
        const envelope = JSON.parse(plan.updates.display_record);
        expect(envelope.pid).toBe('pid-1');
        expect(envelope.title).toBe('Nancy McElroy Oral History, 2024');
        expect(envelope.entry_id).toBe('1_abc');
        expect(envelope.mime_type).toBe('video/quicktime');
        expect(envelope.object).toBe('dip/objects/D009.mov');
        expect(envelope.parts).toBeUndefined();
        expect(envelope.display_record.parts).toHaveLength(1);
        expect(envelope.display_record.parts[0]).toMatchObject({
            kaltura_id: '1_abc',
            type: 'video/quicktime',
            object: 'dip/objects/D009.mov',
        });
        expect(plan.updates.is_updated).toBe(1);
    });

    it('repairs a nulled mime_type column but never nulls one out', () => {
        const plan = plan_row(thin_row());
        expect(plan.updates.mime_type).toBe('video/quicktime');

        /* Master resolvable but mime unknown everywhere → no mime update. */
        const metadata = { title: 'T', parts: [{ order: '1', title: 'a.bin', caption: null }] };
        const no_mime = plan_row(
            thin_row({
                mime_type: 'application/octet-stream',
                mods: JSON.stringify(metadata),
                display_record: JSON.stringify({
                    title: 'T',
                    display_record: metadata,
                    parts: [
                        { uuid: 'u', file: 'a.bin', mime_type: null, type: 'object', object: 'o' },
                    ],
                }),
            })
        );
        expect(no_mime.action).toBe('update');
        expect(no_mime.updates.mime_type).toBeUndefined();
    });

    it('fills an empty thumbnail column but never overwrites one', () => {
        const filled = plan_row(thin_row({ thumbnail: null }));
        expect(filled.updates.thumbnail).toBe('dip/thumbnails/u-mov.jpg');

        const kept = plan_row(thin_row({ thumbnail: 'custom/path.jpg' }));
        expect(kept.updates.thumbnail).toBeUndefined();
    });

    it('keeps a custom absolute-URL thumbnail authoritative in the envelope', () => {
        const plan = plan_row(thin_row({ thumbnail: 'https://repo.example/static/tn/p.jpg' }));
        const envelope = JSON.parse(plan.updates.display_record);
        expect(envelope.thumbnail).toBe('https://repo.example/static/tn/p.jpg');
    });

    it('populates compound_parts for compound rows', () => {
        const plan = plan_row(thin_row({ is_compound: 1, object_type: 'compound' }));
        expect(plan.action).toBe('update');
        expect(JSON.parse(plan.updates.compound_parts)).toHaveLength(1);
        expect(JSON.parse(plan.updates.display_record).is_compound).toBe(1);
    });

    it('is idempotent: skips rows whose envelope is already fat', () => {
        const first = plan_row(thin_row());
        const again = plan_row(thin_row({ display_record: first.updates.display_record }));
        expect(again).toEqual({ action: 'skip', reason: 'already_fat' });
    });

    it('skips collections, unparsable envelopes, and rows without metadata', () => {
        expect(plan_row(thin_row({ object_type: 'collection' })).reason).toBe('collection');
        expect(plan_row(thin_row({ display_record: '{nope' })).reason).toBe(
            'display_record_unparsable'
        );
        expect(
            plan_row(thin_row({ mods: null, display_record: JSON.stringify({ parts: [] }) }))
                .reason
        ).toBe('no_metadata');
    });

    it('falls back to the envelope inner record when mods is empty', () => {
        const plan = plan_row(thin_row({ mods: null }));
        expect(plan.action).toBe('update');
        expect(JSON.parse(plan.updates.display_record).title).toBe(
            'Nancy McElroy Oral History, 2024'
        );
    });
});

describe('scripts/backfill_display_records — run', () => {
    function fake_db(rows) {
        const applied = [];
        /* Minimal knex-shaped stub: db()(table).where().update() */
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

    it('dry-run plans but writes nothing', async () => {
        const fake = fake_db([thin_row()]);
        const { counts } = await run(
            { execute: false, pids: null },
            {
                db_module: { db: fake.db, destroy_all: async () => {} },
                tables,
                select_candidates: async () => fake.rows,
            }
        );
        expect(counts).toEqual({ update: 1, skip: 0 });
        expect(fake.applied).toEqual([]);
    });

    it('--execute applies the planned updates per pid', async () => {
        const fake = fake_db([thin_row(), thin_row({ pid: 'pid-2' })]);
        const { counts } = await run(
            { execute: true, pids: null },
            {
                db_module: { db: fake.db, destroy_all: async () => {} },
                tables,
                select_candidates: async () => fake.rows,
            }
        );
        expect(counts).toEqual({ update: 2, skip: 0 });
        expect(fake.applied).toHaveLength(2);
        expect(fake.applied[0].criteria).toEqual({ pid: 'pid-1' });
        expect(fake.applied[0].updates.is_updated).toBe(1);
        expect(fake.applied[1].criteria).toEqual({ pid: 'pid-2' });
    });

    it('counts skips without writing', async () => {
        const fake = fake_db([thin_row({ object_type: 'collection' })]);
        const { counts } = await run(
            { execute: true, pids: null },
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
