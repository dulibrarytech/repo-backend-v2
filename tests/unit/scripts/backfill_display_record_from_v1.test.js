'use strict';

/*
 * Pure-helper tests for scripts/backfill_display_record_from_v1.js —
 * the merge rules that recover type/object/entry_id/parts (and whole
 * NULL envelopes) from v1 index docs without ever overwriting data
 * that already exists on the row.
 */

const {
    parse_args,
    v1_level2,
    has_usable_parts,
    merge_row,
} = require('../../../scripts/backfill_display_record_from_v1');

describe('scripts/backfill_display_record_from_v1', () => {
    describe('parse_args', () => {
        it('defaults to dry-run', () => {
            expect(parse_args(['node', 's'])).toEqual({ execute: false, pids: null });
        });
        it('parses --execute and --pids', () => {
            expect(parse_args(['node', 's', '--execute', '--pids', 'a,b'])).toEqual({
                execute: true,
                pids: ['a', 'b'],
            });
        });
        it('throws on unknown args', () => {
            expect(() => parse_args(['node', 's', '--nope'])).toThrow(/unknown arg/);
        });
    });

    describe('v1_level2', () => {
        it('returns the 3-level doc\'s display_record (L2)', () => {
            const src = { pid: 'p', display_record: { type: 'text', display_record: {} } };
            expect(v1_level2(src).type).toBe('text');
        });
        it('normalizes 2-level (prod repo_public) docs to the recoverable fields', () => {
            const src = {
                pid: 'p',
                type: 'text',
                object: 'dip/o.tif',
                display_record: { title: 'raw AS record', parts: [{ order: '1' }] },
            };
            const l2 = v1_level2(src);
            expect(l2.type).toBe('text');
            expect(l2.object).toBe('dip/o.tif');
            expect(l2.parts).toEqual([{ order: '1' }]);
        });
        it('does not mistake a raw AS record (which has parts) for an L2 envelope', () => {
            // 2-level doc whose display_record carries parts but no L2 markers:
            // the parts must surface via normalization, not via envelope passthrough.
            const src = { type: 'still image', display_record: { parts: [{ order: '1' }] } };
            const l2 = v1_level2(src);
            expect(l2.type).toBe('still image');
            expect(l2.parts).toEqual([{ order: '1' }]);
        });
        it('handles missing display_record', () => {
            expect(v1_level2({ pid: 'p' })).toEqual({});
            expect(v1_level2(null)).toEqual({});
        });
    });

    describe('has_usable_parts', () => {
        it('accepts non-empty parts or compound', () => {
            expect(has_usable_parts({ parts: [{}] })).toBe(true);
            expect(has_usable_parts({ compound: [{}] })).toBe(true);
        });
        it('rejects empty arrays and absence', () => {
            expect(has_usable_parts({ parts: [] })).toBe(false);
            expect(has_usable_parts({ compound: [] })).toBe(false);
            expect(has_usable_parts({})).toBe(false);
        });
        it('counts parts on the inner AS record (projection derives from there)', () => {
            expect(has_usable_parts({ display_record: { parts: [{}] } })).toBe(true);
            expect(has_usable_parts({ display_record: { parts: [] } })).toBe(false);
        });
    });

    describe('merge_row', () => {
        const l2 = {
            type: 'still image',
            object: 'dip/objects/x.tif',
            entry_id: '1_abc',
            parts: [{ order: '1', object: 'dip/objects/x.tif' }],
        };

        it('adopts the whole v1 envelope when the row column is NULL', () => {
            const { merged, changes } = merge_row(null, l2);
            expect(changes).toEqual(['envelope']);
            expect(merged).toBe(l2);
        });

        it('adds only the missing fields', () => {
            const row_dr = { type: 'text', display_record: {} };
            const { merged, changes } = merge_row(row_dr, l2);
            expect(changes.sort()).toEqual(['entry_id', 'object', 'parts']);
            expect(merged.type).toBe('text'); // existing value untouched
            expect(merged.object).toBe('dip/objects/x.tif');
            expect(merged.entry_id).toBe('1_abc');
            expect(merged.parts).toEqual(l2.parts);
        });

        it('treats an empty compound array as missing parts', () => {
            const row_dr = { type: 'text', object: 'o', entry_id: 'e', compound: [] };
            const { changes, merged } = merge_row(row_dr, l2);
            expect(changes).toEqual(['parts']);
            expect(merged.parts).toEqual(l2.parts);
        });

        it('does not fabricate parts when the row already has compound entries', () => {
            const row_dr = { type: 'text', object: 'o', entry_id: 'e', compound: [{ order: '1' }] };
            expect(merge_row(row_dr, l2).changes).toEqual([]);
        });

        it('reports no changes when v1 has nothing to offer', () => {
            expect(merge_row({ title: 'sparse' }, {}).changes).toEqual([]);
            expect(merge_row(null, {}).changes).toEqual([]);
        });
    });
});
