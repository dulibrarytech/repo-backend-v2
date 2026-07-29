'use strict';

/*
 * Unit tests for the pure helpers of scripts/backfill_aip_sizes.js —
 * key resolution against a fetched inventory, no DB / HTTP.
 */

const {
    parse_args,
    basename,
    resolve_size,
} = require('../../../scripts/backfill_aip_sizes');

describe('scripts/backfill_aip_sizes', () => {
    describe('parse_args', () => {
        it('defaults to dry-run and accepts --execute', () => {
            expect(parse_args(['node', 's'])).toEqual({ execute: false });
            expect(parse_args(['node', 's', '--execute'])).toEqual({ execute: true });
        });
        it('throws on unknown args', () => {
            expect(() => parse_args(['node', 's', '--pids', 'a'])).toThrow(/unknown arg/);
        });
    });

    describe('basename', () => {
        it('returns the last path segment', () => {
            expect(basename('aip-store/a/b.7z')).toBe('b.7z');
            expect(basename('b.7z')).toBe('b.7z');
            expect(basename('')).toBeNull();
        });
    });

    describe('resolve_size', () => {
        const by_key = new Map([
            ['pkg-1.7z', 111],
            ['aip-store/pkg-2.7z', 222],
        ]);
        const by_basename = new Map([
            ['pkg-1.7z', 111],
            ['pkg-2.7z', 222],
            ['legacy-3.7z', 333],
        ]);

        it('matches the stored wasabi_key exactly', () => {
            expect(resolve_size({ wasabi_key: 'pkg-1.7z' }, by_key, by_basename)).toBe(111);
        });

        it('bridges the aip-store/ prefix in either direction', () => {
            // Row stores the prefixed shape; inventory has the bare key.
            expect(
                resolve_size({ wasabi_key: 'aip-store/pkg-1.7z' }, by_key, by_basename)
            ).toBe(111);
            // Row stores the bare shape; inventory has the prefixed key.
            expect(resolve_size({ wasabi_key: 'pkg-2.7z' }, by_key, by_basename)).toBe(222);
        });

        it('falls back to the aip column, then basename(aip_legacy)', () => {
            expect(resolve_size({ aip: 'pkg-1.7z' }, by_key, by_basename)).toBe(111);
            // Legacy path with _transfer stripped, matched via basename map.
            expect(
                resolve_size(
                    { aip_legacy: '/dura/path/legacy-3_transfer.7z' },
                    by_key,
                    by_basename
                )
            ).toBe(333);
        });

        it('returns null for unknown keys and keyless rows', () => {
            expect(resolve_size({ wasabi_key: 'nope.7z' }, by_key, by_basename)).toBeNull();
            expect(resolve_size({}, by_key, by_basename)).toBeNull();
        });
    });
});
