'use strict';

// Unit tests for metadata/worker.js. The build_payload helper is pure
// and easy to test in isolation; the rest of the worker (network +
// DB) is exercised at the integration tier with a real sqlite + fake
// ArchivesSpace.

const { build_payload } = require('../../../metadata/worker');

describe('metadata/worker — build_payload', () => {
    it('overwrites the inner display_record with fresh ASpace JSON', () => {
        const existing = JSON.stringify({
            pid: 'p',
            display_record: { title: 'OLD', dates: ['1999'] },
        });
        const fresh = { title: 'NEW', dates: ['2024'] };
        const payload = build_payload(existing, fresh);
        const dr = JSON.parse(payload.display_record);
        expect(dr.display_record).toEqual({ title: 'NEW', dates: ['2024'] });
        // The outer wrapper fields the indexer denormalized stay intact.
        expect(dr.pid).toBe('p');
    });

    it('initializes an envelope when there is no prior display_record', () => {
        const payload = build_payload(null, { title: 'X' });
        const dr = JSON.parse(payload.display_record);
        expect(dr.display_record).toEqual({ title: 'X' });
    });

    it('recovers from a corrupt prior display_record', () => {
        const payload = build_payload('{not json', { title: 'X' });
        const dr = JSON.parse(payload.display_record);
        expect(dr.display_record).toEqual({ title: 'X' });
    });

    it('writes mods as the raw stringified ASpace JSON', () => {
        const fresh = { title: 'X', notes: [{ content: 'note' }] };
        const payload = build_payload(null, fresh);
        expect(JSON.parse(payload.mods)).toEqual(fresh);
    });

    it('sets compound_parts="[]" and is_compound=0 for simple objects', () => {
        const payload = build_payload(null, { title: 'X', is_compound: false });
        expect(payload.compound_parts).toBe('[]');
        expect(payload.is_compound).toBe(0);
    });

    it('preserves the existing parts list for compound objects', () => {
        const existing = JSON.stringify({
            display_record: {
                title: 'OLD',
                parts: [
                    { order: '1', title: 'one' },
                    { order: '2', title: 'two' },
                ],
            },
        });
        const fresh = { title: 'NEW', is_compound: true };
        const payload = build_payload(existing, fresh);
        expect(payload.is_compound).toBe(1);
        const parts = JSON.parse(payload.compound_parts);
        expect(parts).toHaveLength(2);
        expect(parts[0].title).toBe('one');
        // The inner display_record carries the merged parts too.
        const dr = JSON.parse(payload.display_record);
        expect(dr.display_record.parts).toHaveLength(2);
    });

    it('handles a compound object that previously had no parts list', () => {
        // Edge case: a previously-simple object reclassified as
        // compound. There's no existing parts list to splice in;
        // compound_parts becomes an empty array, not undefined.
        const payload = build_payload(JSON.stringify({ display_record: { title: 'OLD' } }), {
            title: 'NEW',
            is_compound: true,
        });
        expect(payload.compound_parts).toBe('[]');
        expect(payload.is_compound).toBe(1);
    });
});
