'use strict';

// Pipeline status → severity / suggested-action map.
//
// This is the canonical reference for every state the ingest queue
// can be in. Two consumers read from here:
//
//   1. The model layer (ingester/model.js) auto-populates the
//      `severity` and `suggested_action` columns whenever a row's
//      pipeline_state changes — unless the caller passed explicit
//      overrides. Staff never see free-text status strings without
//      context.
//
//   2. The dashboard (ingester/dashboard/*) reads `severity` for
//      color-coding and `suggested_action` for the recommended next
//      step. Per-row kebab actions are derived from `available_actions`
//      below.
//
// Severity scale:
//   INFO   — normal progress; no staff attention needed
//   WARN   — likely transient or self-recoverable; staff can retry
//   ERROR  — staff intervention required; details in `error` column
//   FATAL  — IT escalation (reserved for later phases)
//
// Adding a new state is a single-line addition here. No other code
// path needs to change for severity/action to surface in the UI.

const STATUS_METADATA = {
    // --- Routine progress (INFO) ------------------------------------------
    PENDING: { severity: 'INFO', suggested_action: null },
    STARTING: { severity: 'INFO', suggested_action: null },
    // Stage 1 exit — AS metadata validated; ready to move folder to
    // 002-ingest and start the SFTP upload.
    QA_COMPLETE: { severity: 'INFO', suggested_action: null },
    // Stage 1 mid-state — fetching + validating the AS record.
    PROCESSING_METADATA: { severity: 'INFO', suggested_action: null },
    UPLOADING: {
        severity: 'INFO',
        suggested_action: 'Wait — packages uploading to Archivematica SFTP.',
    },
    UPLOAD_COMPLETE: { severity: 'INFO', suggested_action: null },
    REPLICATING_PACKAGE: { severity: 'INFO', suggested_action: null },
    TRANSFER_STARTED: {
        severity: 'INFO',
        suggested_action:
            'Wait — initializing Archivematica transfer. The pipeline reconciles with Archivematica on restart if this stalls.',
    },
    TRANSFER_IN_PROGRESS: {
        severity: 'INFO',
        suggested_action: 'Wait — Archivematica is processing the transfer.',
    },
    TRANSFER_APPROVED: { severity: 'INFO', suggested_action: null },
    TRANSFER_COMPLETE: { severity: 'INFO', suggested_action: null },
    INGEST_IN_PROGRESS: {
        severity: 'INFO',
        suggested_action: 'Wait — Archivematica is ingesting.',
    },
    INGEST_COMPLETE: { severity: 'INFO', suggested_action: null },
    CONSTRUCTED_OBJECT_PATHS: { severity: 'INFO', suggested_action: null },
    MASTER_OBJECT_DATA_SAVED: { severity: 'INFO', suggested_action: null },
    // Stage 4 exit / Stage 5 entry — AM has produced the AIP, the
    // post-AM AS validation passed, and the METS file is reachable
    // in DuraCloud. The repository-build stage takes it from here.
    METADATA_PROCESSED: { severity: 'INFO', suggested_action: null },
    METADATA_RECORD_PARTS_UPDATED: { severity: 'INFO', suggested_action: null },
    CREATING_REPOSITORY_RECORD: { severity: 'INFO', suggested_action: null },
    REPOSITORY_RECORD_CREATED: { severity: 'INFO', suggested_action: null },
    REPOSITORY_RECORD_INDEXED: { severity: 'INFO', suggested_action: null },
    REPOSITORY_COLLECTION_RECORD_CREATED_AND_INDEXED: {
        severity: 'INFO',
        suggested_action: null,
    },
    COMPLETE: { severity: 'INFO', suggested_action: 'Ingest Complete' },

    // --- Stage 6: AIP preservation copy to Wasabi -------------------------
    // Entry via Stage 5 when AIP_STORE_ENABLED is on. PENDING is the
    // wait state between Stage 5 completing and the next worker tick
    // picking up Stage 6; IN_PROGRESS is the curation /copy-to-wasabi
    // call in flight. COMPLETE is terminal success (is_complete=1).
    AIP_STORE_PENDING: {
        severity: 'INFO',
        suggested_action: 'Wait — preparing preservation copy to Wasabi S3.',
    },
    AIP_STORE_IN_PROGRESS: {
        severity: 'INFO',
        suggested_action: 'Wait — copying AIP to Wasabi S3.',
    },
    AIP_STORE_COMPLETE: {
        severity: 'INFO',
        suggested_action: 'Ingest Complete — AIP preserved in Wasabi.',
    },
    AIP_STORE_FAILED: {
        severity: 'WARN',
        suggested_action:
            'Preservation copy to Wasabi did not complete after its retry budget. Open the AIPs dashboard: if the row shows "Failed", retry once Wasabi/curation is reachable; if it shows "Orphan" (AIP not found in Archivematica), the AIP may have registered late — use "Re-check AM & retry".',
    },

    // --- Wait states (INFO, but explanatory) ------------------------------
    WAITING_FOR_DURACLOUD: {
        severity: 'INFO',
        suggested_action:
            'Wait — Archivematica completed; waiting for AIP to propagate to DuraCloud.',
    },

    // --- Polling timeouts — likely transient / staff-recoverable (WARN) ---
    UPLOAD_TIMEOUT: {
        severity: 'WARN',
        suggested_action:
            'SFTP upload exceeded 4 hours. Retry the batch; contact IT if it persists.',
    },
    APPROVE_TIMEOUT: {
        severity: 'WARN',
        suggested_action:
            'Archivematica did not present the transfer for approval within 10 minutes. Verify the transfer arrived in Archivematica and retry.',
    },
    TRANSFER_STATUS_TIMEOUT: {
        severity: 'WARN',
        suggested_action:
            'Transfer status polling exceeded 6 hours. Check Archivematica dashboard for the actual state.',
    },
    INGEST_STATUS_TIMEOUT: {
        severity: 'WARN',
        suggested_action:
            'Ingest status polling exceeded 6 hours. Check Archivematica dashboard for the actual state.',
    },
    DURACLOUD_TIMEOUT: {
        severity: 'WARN',
        suggested_action:
            'DuraCloud propagation exceeded 1 hour after Archivematica completed. Retry the package; contact IT if it persists.',
    },

    // --- Hard failures requiring staff action (ERROR) ---------------------
    FAILED: {
        severity: 'ERROR',
        suggested_action:
            'Archivematica reported a failure. Roll back the AIP in Archivematica admin, then retry the batch.',
    },
    INGEST_HALTED: {
        severity: 'ERROR',
        suggested_action: 'See the Timeline for details. Fix the underlying issue and retry.',
    },
    COLLECTION_RECORD_NOT_INDEXED: {
        severity: 'ERROR',
        suggested_action:
            'Collection record was created but not indexed in Elasticsearch. Retry indexing or contact IT.',
    },
    AS_METADATA_DRIFT: {
        severity: 'ERROR',
        suggested_action:
            'ArchivesSpace metadata failed validation post-ingest (record may have changed since pre-ingest validation). Review the AS record, fix any issues, then retry.',
    },
    AS_METADATA_INVALID: {
        severity: 'ERROR',
        suggested_action:
            'ArchivesSpace metadata failed pre-ingest validation. No Archivematica activity occurred — no rollback needed. Fix the AS record and re-run the ingest.',
    },

    // --- Rollback / retry terminal states (Phase 3 staff actions) ---------
    //
    // Note on naming: the underlying state name is preserved
    // (ROLLED_BACK_TO_READY) for backward-compat with v1 / existing
    // audit records, but the user-facing message references "Packaging
    // and Ingesting" — that's the view the folder reappears in after
    // the move, because uri.txt is preserved by the curation-API and
    // /processed lists folders with uri.txt regardless of physical
    // 001-ready vs 002-ingest location.
    ROLLED_BACK_TO_READY: {
        severity: 'INFO',
        suggested_action:
            'Folder returned to the Packaging and Ingesting view. Safe to re-submit once the underlying issue is fixed.',
    },
    // Terminal post-cancel state. Folder lives in 001-ready/ with
    // uri.txt intact, which means the curation-API lists it under
    // /processed — so it surfaces in BOTH the ASpace QA AND the
    // Packaging and Ingesting views, ready for re-submit once the
    // original issue is addressed.
    RETURNED_TO_PACKAGING: {
        severity: 'INFO',
        suggested_action:
            'Folder is back in the Packaging and Ingesting view. Safe to re-submit once the underlying issue is fixed.',
    },
    AM_DELETION_REQUESTED: {
        severity: 'WARN',
        suggested_action:
            'AIP deletion request submitted to Archivematica. An Archivematica admin must approve in the Storage Service UI before the AIP is fully removed. Once confirmed, retry the ingest.',
    },

    // Staff-initiated cancel of an in-flight row. Lands here from
    // the dashboard's per-row Cancel button (task #120). The state
    // is NOT terminal in the "no more work needed" sense — it's a
    // halt with explicit follow-up: staff is expected to click the
    // kebab action that available_actions() exposes for this state.
    //
    // The static message below is the fallback for raw API consumers
    // (and edge cases where the dashboard couldn't resolve prev_state).
    // The dashboard's decorate path overrides this with a state-aware
    // message that names the exact kebab item — see
    // ingester/dashboard.js `_cancel_followup_text`.
    CANCELLED_BY_USER: {
        severity: 'WARN',
        suggested_action:
            'Cancelled by staff. Use Return to Packaging in the kebab menu to' +
            ' move the folder back to the Packaging and Ingesting view before' +
            ' re-running.',
    },
};

const DEFAULT_METADATA = { severity: 'INFO', suggested_action: null };

// Look up severity + suggested_action for a given pipeline status.
// Unknown statuses fall back to INFO/null — so adding a new state
// without mapping it here is a silent no-op in the UI, not a
// production-breaking error. The caller can override either field.
function get_status_metadata(status) {
    if (status && Object.prototype.hasOwnProperty.call(STATUS_METADATA, status)) {
        return STATUS_METADATA[status];
    }
    return DEFAULT_METADATA;
}

// ---------------------------------------------------------------------
// State → staff actions
//
// Used by the dashboard row template to decide which kebab items to
// render. The buckets correspond to the rollback strategy needed:
//
//   - PRE_AM_FAILURE: package folder may be in `002-ingest` but no
//       Archivematica AIP exists. Rollback = move folder back to
//       `001-ready` + clear the queue row. No AM cleanup needed.
//
//   - AM_FAILURE: AM has produced (or is producing) the AIP. Rollback
//       = submit `delete_aip_request` to AM (async, requires admin
//       approval in the Storage Service UI) + halt the package.
//
//   - PRE_FOLDER_MOVE_FAILURE: halted before move_to_ingest ever ran.
//       Folder stays in 001-ready. Rollback = clear queue row only.
// ---------------------------------------------------------------------

const STATES_AT_PRE_AM_FAILURE = new Set([
    'INGEST_HALTED',
    'UPLOAD_TIMEOUT',
    'APPROVE_TIMEOUT',
    'TRANSFER_STATUS_TIMEOUT',
]);

const STATES_AT_AM_FAILURE = new Set([
    'INGEST_STATUS_TIMEOUT',
    'FAILED',
    'AS_METADATA_DRIFT',
    'DURACLOUD_TIMEOUT',
]);

const STATES_PRE_FOLDER_MOVE_FAILURE = new Set(['AS_METADATA_INVALID']);

// States that, taken alone, would imply pre-AM rollback. Used to
// decide what to surface on a CANCELLED_BY_USER row — the cancel
// itself doesn't carry rollback semantics; we infer them from
// where the pipeline was when the cancel fired (stored in the row's
// `prev_state` field — see model.cancel).
//
// The set splits into two by where the folder physically is:
//
//   PRE_UPLOAD_PRIOR_STATES: folder is still in 001-ready/ (Stage 2's
//     move_to_ingest hasn't fired yet). Return-to-Packaging needs no
//     curation-API call — clearing the queue row is enough; the folder
//     already shows in /processed.
//
//   POST_UPLOAD_PRE_AM_PRIOR_STATES: folder has been moved to
//     002-ingest/ by Stage 2, but AM hasn't started ingesting yet.
//     Return-to-Packaging calls move_from_ingest_to_ready to put
//     the folder back in 001-ready/ (uri.txt preserved → visible
//     in /processed).
const PRE_UPLOAD_PRIOR_STATES = new Set([
    'PENDING',
    'STARTING',
    'PROCESSING_METADATA',
    'QA_COMPLETE',
]);

const POST_UPLOAD_PRE_AM_PRIOR_STATES = new Set([
    'UPLOADING',
    'UPLOAD_COMPLETE',
    'TRANSFER_STARTED',
    'TRANSFER_IN_PROGRESS',
    'TRANSFER_APPROVED',
    'TRANSFER_COMPLETE',
]);

const PRE_AM_PRIOR_STATES = new Set([
    ...PRE_UPLOAD_PRIOR_STATES,
    ...POST_UPLOAD_PRE_AM_PRIOR_STATES,
]);

// States that imply AM has started ingesting — rollback target is
// the AIP deletion request.
const AM_PRIOR_STATES = new Set([
    'INGEST_IN_PROGRESS',
    'INGEST_COMPLETE',
    'CONSTRUCTED_OBJECT_PATHS',
    'MASTER_OBJECT_DATA_SAVED',
    'WAITING_FOR_DURACLOUD',
    'METADATA_PROCESSED',
    'METADATA_RECORD_PARTS_UPDATED',
    'CREATING_REPOSITORY_RECORD',
    'REPOSITORY_RECORD_CREATED',
    'REPOSITORY_RECORD_INDEXED',
]);

// Returns the subset of:
//   ['timeline', 'rollback_pre_ingest', 'rollback_archivematica',
//    'reset', 'cancel']
// that's appropriate from the given state. `timeline` is always
// available (every row has events). The others depend on where in
// the pipeline the package halted.
//
// `prev_state` is consulted only for CANCELLED_BY_USER rows — the
// cancel itself doesn't have a single canonical rollback target, so
// we infer one from where the pipeline was when the cancel fired.
// The model stamps the prior state into the cancel event's payload,
// and the dashboard read-path pulls it out for action lookup.
//
// `pipeline_state` (the active state, NOT terminal) gets the cancel
// action so staff can interrupt without waiting for the per-stage
// timeout (default 4–6 h).
function available_actions(state, prev_state) {
    const actions = ['timeline'];
    if (state === 'CANCELLED_BY_USER') {
        // Single follow-up: Return to Packaging. The handler
        // (controller.return_to_packaging) branches internally on
        // prev_state to decide what cleanup runs:
        //   - PRE_UPLOAD_PRIOR_STATES: folder is still in 001-ready,
        //     just mark the row terminal.
        //   - POST_UPLOAD_PRE_AM_PRIOR_STATES: call qa.move_from_ingest_to_ready
        //     and clean up SFTP. Folder reappears in /processed.
        //   - AM_PRIOR_STATES: AM has its own copy of the SIP, but
        //     the staff-visible folder is still in 002-ingest (the
        //     pipeline never moves it out). Same QA move-back as the
        //     post-upload case. The audit payload also flags
        //     needed_am_cleanup so staff knows to delete the AIP in
        //     the AM Storage Service UI manually.
        // `prev_state` is consulted by the handler, not here — keeping
        // the kebab a single, predictable item simplifies the staff UX.
        void prev_state;
        actions.push('rollback_to_packaging');
        return actions;
    }
    if (STATES_AT_PRE_AM_FAILURE.has(state)) {
        actions.push('rollback_pre_ingest');
    } else if (STATES_AT_AM_FAILURE.has(state)) {
        actions.push('rollback_archivematica');
    } else if (STATES_PRE_FOLDER_MOVE_FAILURE.has(state)) {
        actions.push('reset');
    } else if (CANCELLABLE_STATES.has(state)) {
        // In-flight row — staff can interrupt without waiting for
        // the per-stage timeout. The cancel itself is the only new
        // action; the rollback follow-up appears post-cancel.
        actions.push('cancel');
    }
    return actions;
}

// All states a row can be in while it has live work upstream
// (curation-API SFTP move, AM transfer, AM ingest, DuraCloud wait,
// Stage 5 record build). These are the rows where the Cancel kebab
// item appears. Terminal states (COMPLETE / halt states / already-
// cancelled) are deliberately excluded.
const CANCELLABLE_STATES = new Set([...PRE_AM_PRIOR_STATES, ...AM_PRIOR_STATES]);

module.exports = {
    STATUS_METADATA,
    get_status_metadata,
    available_actions,
    CANCELLABLE_STATES,
    PRE_AM_PRIOR_STATES,
    PRE_UPLOAD_PRIOR_STATES,
    POST_UPLOAD_PRE_AM_PRIOR_STATES,
    AM_PRIOR_STATES,
    STATES_AT_PRE_AM_FAILURE,
    STATES_AT_AM_FAILURE,
    STATES_PRE_FOLDER_MOVE_FAILURE,
};
