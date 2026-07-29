'use strict';

/*
 * Unit tests for the pure helpers of scripts/backfill_https_handles.js
 * — the rewrite decision logic, exercised without a DB.
 */

const {
    parse_args,
    is_junk_handle,
    rewrite_row,
} = require('../../../scripts/backfill_https_handles');

describe('scripts/backfill_https_handles', () => {
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

    describe('is_junk_handle', () => {
        it('flags non-URL values, passes URLs and empties', () => {
            expect(is_junk_handle('Error: [/libs/handles lib] mint failed')).toBe(true);
            expect(is_junk_handle('142b65b1-53d1-47cd-ab65-a272b102812b')).toBe(true);
            expect(is_junk_handle('test-handle')).toBe(true);
            expect(is_junk_handle('http://hdl.handle.net/10176/x')).toBe(false);
            expect(is_junk_handle('https://hdl.handle.net/10176/x')).toBe(false);
            expect(is_junk_handle('')).toBe(false);
            expect(is_junk_handle(null)).toBe(false);
        });
    });

    describe('rewrite_row', () => {
        it('rewrites the column and the display_record projection copy', () => {
            const { new_handle, new_display_record, changes } = rewrite_row(
                'http://hdl.handle.net/10176/p1',
                JSON.stringify({
                    handle: 'http://hdl.handle.net/10176/p1',
                    title: 'T',
                })
            );
            expect(new_handle).toBe('https://hdl.handle.net/10176/p1');
            expect(JSON.parse(new_display_record).handle).toBe(
                'https://hdl.handle.net/10176/p1'
            );
            expect(JSON.parse(new_display_record).title).toBe('T');
            expect(changes).toEqual(['handle_column', 'display_record']);
        });

        it('rewrites a nested display_record.handle copy when present', () => {
            const { new_display_record, changes } = rewrite_row(null, {
                display_record: { handle: 'http://hdl.handle.net/10176/p2' },
            });
            expect(JSON.parse(new_display_record).display_record.handle).toBe(
                'https://hdl.handle.net/10176/p2'
            );
            expect(changes).toEqual(['display_record']);
        });

        it('is a no-op on already-https rows (idempotency)', () => {
            const { changes } = rewrite_row(
                'https://hdl.handle.net/10176/p3',
                JSON.stringify({ handle: 'https://hdl.handle.net/10176/p3' })
            );
            expect(changes).toEqual([]);
        });

        it('leaves junk values and other-host URLs untouched', () => {
            expect(rewrite_row('Error: mint failed', null).changes).toEqual([]);
            expect(rewrite_row('test-handle', null).changes).toEqual([]);
            expect(rewrite_row('http://example.org/10176/x', null).changes).toEqual([]);
        });

        it('survives corrupt display_record JSON (column-only rewrite)', () => {
            const { new_handle, new_display_record, changes } = rewrite_row(
                'http://hdl.handle.net/10176/p4',
                '{not json'
            );
            expect(new_handle).toBe('https://hdl.handle.net/10176/p4');
            expect(new_display_record).toBeNull();
            expect(changes).toEqual(['handle_column']);
        });

        it('handles null/empty inputs', () => {
            expect(rewrite_row(null, null).changes).toEqual([]);
            expect(rewrite_row('', '').changes).toEqual([]);
        });
    });
});
