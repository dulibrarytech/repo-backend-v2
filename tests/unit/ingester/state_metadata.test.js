'use strict';

/*
 * Unit tests for the status → severity / suggested_action map and the
 * state → available-actions classifier. Pure functions, no DB; the
 * integration-tier model tests cover the model layer's *use* of these.
 */

const {
    STATUS_METADATA,
    get_status_metadata,
    available_actions,
    STATES_AT_PRE_AM_FAILURE,
    STATES_AT_AM_FAILURE,
    STATES_PRE_FOLDER_MOVE_FAILURE,
    CANCELLABLE_STATES,
    PRE_AM_PRIOR_STATES,
    PRE_UPLOAD_PRIOR_STATES,
    POST_UPLOAD_PRE_AM_PRIOR_STATES,
    AM_PRIOR_STATES,
} = require('../../../ingester/state_metadata');

describe('ingester/state_metadata — get_status_metadata', () => {
    it('returns the mapped entry for a known status', () => {
        const meta = get_status_metadata('FAILED');
        expect(meta.severity).toBe('ERROR');
        // "Roll back the AIP …" — two words in the human text.
        expect(meta.suggested_action).toMatch(/roll\s?back/i);
    });

    it('returns INFO/null for PENDING (canonical happy-path entry)', () => {
        const meta = get_status_metadata('PENDING');
        expect(meta).toEqual({ severity: 'INFO', suggested_action: null });
    });

    it('falls back to INFO/null for an unknown status', () => {
        const meta = get_status_metadata('SOMETHING_NEW');
        expect(meta).toEqual({ severity: 'INFO', suggested_action: null });
    });

    it('falls back to INFO/null when status is null or undefined', () => {
        expect(get_status_metadata(null)).toEqual({ severity: 'INFO', suggested_action: null });
        expect(get_status_metadata(undefined)).toEqual({
            severity: 'INFO',
            suggested_action: null,
        });
    });

    it('does not return the prototype `toString` etc. as a status', () => {
        /*
         * Defensive: the lookup uses hasOwnProperty so inherited keys
         * don't leak through as fake states.
         */
        const meta = get_status_metadata('toString');
        expect(meta).toEqual({ severity: 'INFO', suggested_action: null });
    });

    it('classifies WARN states correctly', () => {
        expect(get_status_metadata('UPLOAD_TIMEOUT').severity).toBe('WARN');
        expect(get_status_metadata('DURACLOUD_TIMEOUT').severity).toBe('WARN');
        expect(get_status_metadata('AM_DELETION_REQUESTED').severity).toBe('WARN');
    });

    it('classifies ERROR states correctly', () => {
        expect(get_status_metadata('FAILED').severity).toBe('ERROR');
        expect(get_status_metadata('INGEST_HALTED').severity).toBe('ERROR');
        expect(get_status_metadata('AS_METADATA_DRIFT').severity).toBe('ERROR');
        expect(get_status_metadata('AS_METADATA_INVALID').severity).toBe('ERROR');
        expect(get_status_metadata('COLLECTION_RECORD_NOT_INDEXED').severity).toBe('ERROR');
    });

    it('attaches a suggested_action to every WARN / ERROR state', () => {
        /*
         * The dashboard relies on this: any non-INFO row must surface
         * *some* guidance text, even if minimal.
         */
        const offenders = [];
        for (const [status, meta] of Object.entries(STATUS_METADATA)) {
            if (meta.severity === 'WARN' || meta.severity === 'ERROR') {
                if (!meta.suggested_action || typeof meta.suggested_action !== 'string') {
                    offenders.push(status);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('ingester/state_metadata — available_actions', () => {
    it('always includes "timeline"', () => {
        expect(available_actions('PENDING')).toContain('timeline');
        expect(available_actions('COMPLETE')).toContain('timeline');
        expect(available_actions('made_up_state')).toContain('timeline');
    });

    it('returns timeline-only for a terminal-success state', () => {
        /*
         * COMPLETE has nothing actionable: no rollback target, no
         * cancel target. The success path ends here.
         */
        expect(available_actions('COMPLETE')).toEqual(['timeline']);
    });

    it('offers "cancel" for in-flight cancellable states', () => {
        /*
         * PENDING is the entry state; staff can cancel before the
         * worker picks it up. UPLOADING / TRANSFER_IN_PROGRESS are
         * long-poll states — cancel signals the AbortController.
         */
        expect(available_actions('PENDING')).toEqual(['timeline', 'cancel']);
        expect(available_actions('UPLOADING')).toEqual(['timeline', 'cancel']);
        expect(available_actions('TRANSFER_IN_PROGRESS')).toEqual(['timeline', 'cancel']);
    });

    it('offers "rollback_pre_ingest" for PRE_AM_FAILURE states', () => {
        for (const state of STATES_AT_PRE_AM_FAILURE) {
            const actions = available_actions(state);
            expect(actions).toContain('timeline');
            expect(actions).toContain('rollback_pre_ingest');
            expect(actions).not.toContain('rollback_archivematica');
            expect(actions).not.toContain('reset');
        }
    });

    it('offers "rollback_archivematica" for AM_FAILURE states', () => {
        for (const state of STATES_AT_AM_FAILURE) {
            const actions = available_actions(state);
            expect(actions).toContain('rollback_archivematica');
            expect(actions).not.toContain('rollback_pre_ingest');
            expect(actions).not.toContain('reset');
        }
    });

    it('offers "reset" for PRE_FOLDER_MOVE_FAILURE states', () => {
        for (const state of STATES_PRE_FOLDER_MOVE_FAILURE) {
            const actions = available_actions(state);
            expect(actions).toContain('reset');
            expect(actions).not.toContain('rollback_pre_ingest');
            expect(actions).not.toContain('rollback_archivematica');
        }
    });

    it('the three rollback sets are mutually exclusive', () => {
        /*
         * Belt-and-braces — if anyone adds a state to two sets, the
         * available_actions if/else chain silently picks just one.
         */
        const pre = [...STATES_AT_PRE_AM_FAILURE];
        const am = [...STATES_AT_AM_FAILURE];
        const folder = [...STATES_PRE_FOLDER_MOVE_FAILURE];
        for (const s of pre) {
            expect(am).not.toContain(s);
            expect(folder).not.toContain(s);
        }
        for (const s of am) {
            expect(folder).not.toContain(s);
        }
    });

    it('returns rollback_to_packaging for CANCELLED_BY_USER with a pre-AM prior_state', () => {
        /*
         * Both halves of PRE_AM_PRIOR_STATES (pre-upload AND
         * post-upload-pre-AM) get the same action — the handler
         * decides whether to call QA based on which half.
         */
        for (const prev of PRE_AM_PRIOR_STATES) {
            const actions = available_actions('CANCELLED_BY_USER', prev);
            expect(actions).toContain('timeline');
            expect(actions).toContain('rollback_to_packaging');
            expect(actions).not.toContain('rollback_archivematica');
            expect(actions).not.toContain('rollback_pre_ingest');
        }
    });

    it('PRE_AM_PRIOR_STATES = PRE_UPLOAD ∪ POST_UPLOAD_PRE_AM (disjoint halves)', () => {
        const expected = new Set([...PRE_UPLOAD_PRIOR_STATES, ...POST_UPLOAD_PRE_AM_PRIOR_STATES]);
        expect([...PRE_AM_PRIOR_STATES].sort()).toEqual([...expected].sort());
        // No overlap — every state belongs to exactly one half.
        for (const s of PRE_UPLOAD_PRIOR_STATES) {
            expect(POST_UPLOAD_PRE_AM_PRIOR_STATES.has(s)).toBe(false);
        }
    });

    it('CANCELLED_BY_USER always returns the single rollback_to_packaging follow-up', () => {
        /*
         * Design decision: the kebab on a cancelled row shows ONE
         * follow-up regardless of prev_state. The controller branches
         * internally on prev_state to decide what cleanup runs (no
         * QA call for pre-upload, QA move for post-upload-pre-AM,
         * audit-only for AM-side). Keeps the staff UX predictable
         * and avoids the word "rollback" entirely in the cancel flow.
         */
        for (const prev of AM_PRIOR_STATES) {
            expect(available_actions('CANCELLED_BY_USER', prev)).toEqual([
                'timeline',
                'rollback_to_packaging',
            ]);
        }
        expect(available_actions('CANCELLED_BY_USER', null)).toEqual([
            'timeline',
            'rollback_to_packaging',
        ]);
        expect(available_actions('CANCELLED_BY_USER', 'SOMETHING_WEIRD')).toEqual([
            'timeline',
            'rollback_to_packaging',
        ]);
    });

    it('never offers rollback_archivematica or reset from CANCELLED_BY_USER', () => {
        /*
         * The cancel flow deliberately collapses all follow-ups into
         * Return to Packaging. AM-side cleanup is a separate manual
         * ops task (the audit trail flags it via needed_am_cleanup).
         */
        for (const prev of [
            ...PRE_UPLOAD_PRIOR_STATES,
            ...POST_UPLOAD_PRE_AM_PRIOR_STATES,
            ...AM_PRIOR_STATES,
            null,
            'WHATEVER',
        ]) {
            const actions = available_actions('CANCELLED_BY_USER', prev);
            expect(actions).not.toContain('rollback_archivematica');
            expect(actions).not.toContain('rollback_pre_ingest');
            expect(actions).not.toContain('reset');
        }
    });

    it('CANCELLABLE_STATES = PRE_AM_PRIOR_STATES ∪ AM_PRIOR_STATES', () => {
        const expected = new Set([...PRE_AM_PRIOR_STATES, ...AM_PRIOR_STATES]);
        expect([...CANCELLABLE_STATES].sort()).toEqual([...expected].sort());
    });

    it('does NOT offer cancel for halted / terminal states', () => {
        /*
         * The cancel kebab item should never appear on a row that
         * can't be cancelled — staff should see the rollback action
         * instead. Spot-check the boundaries.
         */
        expect(available_actions('COMPLETE')).not.toContain('cancel');
        expect(available_actions('INGEST_HALTED')).not.toContain('cancel');
        expect(available_actions('FAILED')).not.toContain('cancel');
        expect(available_actions('AS_METADATA_INVALID')).not.toContain('cancel');
        expect(available_actions('ROLLED_BACK_TO_READY')).not.toContain('cancel');
    });

    it('every classified state is also present in STATUS_METADATA', () => {
        /*
         * Catch typos: if you add 'INGSET_HALTED' to a rollback set,
         * the row would never render the right suggested_action.
         */
        const all = [
            ...STATES_AT_PRE_AM_FAILURE,
            ...STATES_AT_AM_FAILURE,
            ...STATES_PRE_FOLDER_MOVE_FAILURE,
        ];
        const missing = all.filter(
            (s) => !Object.prototype.hasOwnProperty.call(STATUS_METADATA, s)
        );
        expect(missing).toEqual([]);
    });
});
