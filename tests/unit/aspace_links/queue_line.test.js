'use strict';

const { queue_line } = require('../../../aspace_links/controller');
const app_config = require('../../../config/app');
const { PID, TWIN, AO, handle } = require('../../helpers/aspace_links');

const CHECKED = new Date('2026-11-17T15:04:00Z');

function queue_row(overrides = {}) {
    return { handle: handle(PID), batch: 'U358_LDT_Collection_1204', sip_uuid: PID, ...overrides };
}

function result(overrides = {}) {
    return {
        uri: AO,
        status: 'DONE',
        state: 'updated',
        pids: [PID],
        detail: {},
        error: null,
        checked_at: CHECKED,
        ...overrides,
    };
}

describe('aspace_links/controller queue_line', () => {
    beforeEach(() => {
        delete process.env.HANDLE_SKIP_BATCH_TOKENS;
        app_config._reset();
    });

    it.each(['updated', 'in_sync', 'orphan_link'])('says the link was added for %s', (state) => {
        expect(queue_line(queue_row(), result({ state }))).toEqual({
            text: 'ArchivesSpace link: added',
            css: '',
            uri: AO,
            state,
            label: expect.any(String),
            reason: null,
            checked_at: CHECKED,
        });
    });

    it('says when the link is there but not published in ArchivesSpace', () => {
        expect(queue_line(queue_row(), result({ state: 'unpublished_link' }))).toMatchObject({
            text: 'ArchivesSpace link: added, not published there',
            css: '',
            label: 'Link is not published',
        });
    });

    it('says when the link was removed in ArchivesSpace afterwards', () => {
        expect(queue_line(queue_row(), result({ state: 'link_removed' }))).toMatchObject({
            text: 'ArchivesSpace link: removed in ArchivesSpace',
            css: 'text-muted',
        });
    });

    it.each([
        ['queued and not checked yet', { status: 'PENDING', state: null, pids: [] }],
        ['being checked', { status: 'IN_PROGRESS', state: 'updated', pids: [TWIN] }],
        ['checked while writes are off', { state: 'pending' }],
    ])('says waiting when the record is %s', (_label, overrides) => {
        expect(queue_line(queue_row(), result(overrides))).toEqual({
            text: 'ArchivesSpace link: waiting',
            css: 'text-muted',
        });
    });

    it('says a record two objects share needs attention, for the older ingest as well', () => {
        for (const row of [queue_row(), queue_row({ sip_uuid: TWIN, handle: handle(TWIN) })]) {
            expect(
                queue_line(row, result({ state: 'contested', pids: [PID, TWIN] }))
            ).toMatchObject({
                text: 'ArchivesSpace link: needs attention — contact LDT',
                css: 'fw-semibold',
                label: 'More than one object shares this record',
            });
        }
    });

    it.each(['failed', 'needs_review', 'record_not_found', 'invalid_handle'])(
        'asks staff to contact LDT for %s, and gives admins the reason',
        (state) => {
            const line = queue_line(
                queue_row(),
                result({
                    state,
                    pids: [PID, TWIN],
                    detail: { note: 'A note.' },
                    error: 'An error.',
                })
            );
            expect(line).toMatchObject({
                text: 'ArchivesSpace link: not added — contact LDT',
                css: 'fw-semibold',
                uri: AO,
                state,
                reason: 'A note.',
            });
            expect(line.label).not.toBe(state);
        }
    );

    it('gives the error as the reason when there is no note', () => {
        const line = queue_line(queue_row(), result({ state: 'failed', error: 'HTTP 403' }));
        expect(line.reason).toBe('HTTP 403');
    });

    it('says nothing when the record was last checked for another object', () => {
        expect(queue_line(queue_row(), result({ pids: [TWIN] }))).toBeNull();
    });

    it('says nothing when the record has no result', () => {
        expect(queue_line(queue_row(), undefined)).toBeNull();
    });

    it('asks staff to contact LDT when no handle was made, whatever the record says', () => {
        expect(queue_line(queue_row({ handle: '' }), result())).toEqual({
            text: 'No handle — contact LDT',
            css: 'fw-semibold',
        });
        expect(queue_line(queue_row({ handle: null }), undefined)).toEqual({
            text: 'No handle — contact LDT',
            css: 'fw-semibold',
        });
    });

    it('says a test batch has no handle, without asking anyone to act', () => {
        const row = queue_row({ handle: '', batch: 'U358_LDT_TEST_Collection-resources_1204' });
        expect(queue_line(row, undefined)).toEqual({
            text: 'No handle (test batch)',
            css: 'text-muted',
        });
    });
});
