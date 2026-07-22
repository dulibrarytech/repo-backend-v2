'use strict';

const { format_bytes, format_count } = require('../../../libs/format');

describe('libs/format', () => {
    describe('format_bytes', () => {
        it('handles null + undefined + negative as em-dash', () => {
            expect(format_bytes(null)).toBe('—');
            expect(format_bytes(undefined)).toBe('—');
            expect(format_bytes(-1)).toBe('—');
            expect(format_bytes(NaN)).toBe('—');
        });

        it('renders bytes as integer below 1 KiB', () => {
            expect(format_bytes(0)).toBe('0 B');
            expect(format_bytes(123)).toBe('123 B');
            expect(format_bytes(1023)).toBe('1023 B');
        });

        it('scales up to KB / MB / GB / TB at 1024 boundaries', () => {
            expect(format_bytes(1024)).toBe('1.00 KB');
            expect(format_bytes(1024 * 1024)).toBe('1.00 MB');
            expect(format_bytes(1024 * 1024 * 1024)).toBe('1.00 GB');
            expect(format_bytes(1024 * 1024 * 1024 * 1024)).toBe('1.00 TB');
        });

        it('matches v1 dashboard format for the screenshot value', () => {
            /*
             * 8.29 TB == ~9.11e12 bytes (1024^4 = 1.0995e12; 8.29 * that
             * = 9.115e12). Picking exactly that yields '8.29 TB'.
             */
            expect(format_bytes(8.29 * 1024 ** 4)).toBe('8.29 TB');
        });

        it('honors precision override', () => {
            expect(format_bytes(1536, { precision: 0 })).toBe('2 KB');
            expect(format_bytes(1536, { precision: 1 })).toBe('1.5 KB');
            expect(format_bytes(1536, { precision: 3 })).toBe('1.500 KB');
        });
    });

    describe('format_count', () => {
        it('groups thousands with locale separators', () => {
            expect(format_count(0)).toBe('0');
            expect(format_count(123)).toBe('123');
            expect(format_count(1234)).toBe('1,234');
            expect(format_count(21442)).toBe('21,442');
            expect(format_count(1234567)).toBe('1,234,567');
        });

        it('coerces null / undefined / non-numeric to 0', () => {
            expect(format_count(null)).toBe('0');
            expect(format_count(undefined)).toBe('0');
            expect(format_count('not a number')).toBe('0');
        });

        it('preserves numeric strings', () => {
            expect(format_count('12345')).toBe('12,345');
        });
    });
});
