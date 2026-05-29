'use strict';

// Dashboard-side controller for the metadata-refresh queue. Exposes
// five flows:
//
//   POST /dashboard/objects/:pid/metadata/refresh
//        Enqueue a single-row refresh, return the progress modal.
//   POST /dashboard/collections/:pid/metadata/refresh
//        Enqueue ONLY the collection/resource record (no members).
//        Triggered from the kabob on the collections list — the
//        detail-page button uses refresh-members for the full
//        expansion instead.
//   POST /dashboard/collections/:pid/metadata/refresh-members
//        Enqueue every active member of a collection (plus the
//        collection record itself), return the progress modal.
//   POST /dashboard/objects/metadata/refresh-bulk
//        Enqueue an explicit pid list from the multi-select toolbar.
//   GET  /dashboard/jobs/:batch_uuid/progress
//        Render the progress partial. Polled by the modal every 1s.
//   POST /dashboard/jobs/:batch_uuid/cancel
//        Mark all non-terminal rows as CANCELLED and refresh the
//        progress partial.

const validator = require('validator');

const app_config = require('../config/app');
const model = require('./model');
const aspace = require('../libs/archivesspace');

function render_partial(req, res, view, locals = {}) {
    const cfg = app_config();
    res.render(view, {
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        ...locals,
    });
}

// Merge a set of HX-Trigger events into the response's existing
// HX-Trigger header. The dashboard JS in public/assets/dashboard.js
// listens for these by name on document.body — see the show_toast
// handler for 'toast' specifically, and the per-event consumers for
// the others.
//
// Why merge vs. overwrite: the done-state of batch_progress_partial
// emits multiple events at once (objects:refresh, metadata:batch-done,
// toast) and a naive res.set() would clobber whichever was set first.
// Express's res.get / res.set round-trip header values as strings, so
// we parse-merge-serialize to preserve every event in one header.
function trigger_events(res, events) {
    const existing = res.get('HX-Trigger');
    let payload = {};
    if (existing) {
        try {
            payload = JSON.parse(existing);
        } catch {
            // Header was set to a non-JSON string somewhere upstream.
            // Replace rather than throw — losing one trigger is better
            // than 500ing the whole response.
            payload = {};
        }
    }
    res.set('HX-Trigger', JSON.stringify({ ...payload, ...events }));
}

// Show the user a toast confirmation that their click registered.
// Level maps to a Bootstrap alert variant; see show_toast in
// public/assets/dashboard.js.
function trigger_toast(res, level, message) {
    trigger_events(res, { toast: { level, message } });
}

function render_progress_modal(req, res, batch_uuid, count, source_label) {
    // Initiation toast — confirms the action took even if the modal
    // somehow fails to render or the user has already started reading
    // their next email. The progress bar still lives in the modal;
    // this is the "yes, the click registered" signal that persists
    // for ~5 seconds in the toast stack.
    trigger_toast(
        res,
        'info',
        `Metadata refresh queued (${count} record${count === 1 ? '' : 's'}).`
    );
    render_partial(req, res, 'dashboard/partials/metadata_progress_modal', {
        batch_uuid,
        count,
        source_label,
        aspace_configured: aspace.is_configured(),
    });
}

// Parse the comma-joined pid list from the bulk toolbar's hidden input.
// The sanitize middleware HTML-escapes the body; unescape before we
// hand to the model.
function parse_pid_list(raw) {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string' && raw.length > 0) {
        return raw
            .split(',')
            .map((s) => validator.unescape(s.trim()))
            .filter(Boolean);
    }
    return [];
}

async function refresh_object(req, res) {
    const result = await model.enqueue_single(req.params.pid);
    return render_progress_modal(
        req,
        res,
        result.batch_uuid,
        result.count,
        `object ${req.params.pid.slice(0, 8)}…`
    );
}

async function refresh_collection_members(req, res) {
    const result = await model.enqueue_collection(req.params.pid);
    return render_progress_modal(req, res, result.batch_uuid, result.count, 'collection members');
}

// Refresh ONLY the collection/resource record itself — does not
// fan out to members. The model layer enforces object_type=='collection'
// so a non-collection pid arriving here returns a ValidationError
// (the central handler turns that into a 400). The kabob action on
// the collections list page is the only caller; the collection
// detail page uses refresh_collection_members for the full expansion.
async function refresh_collection_record(req, res) {
    const result = await model.enqueue_collection_record(req.params.pid);
    return render_progress_modal(
        req,
        res,
        result.batch_uuid,
        result.count,
        'collection record'
    );
}

async function refresh_bulk(req, res) {
    const pids = parse_pid_list(req.body && req.body.pids);
    const result = await model.enqueue_pids(pids);
    return render_progress_modal(
        req,
        res,
        result.batch_uuid,
        result.count,
        `${result.count} selected object${result.count === 1 ? '' : 's'}`
    );
}

async function batch_progress_partial(req, res) {
    const progress = await model.get_batch_progress(req.params.batch_uuid);
    // When the batch completes, fire HX-Trigger so the open object
    // list (if any) reloads to show the new titles, and toast the
    // operator so they get a completion notification even if they've
    // closed the modal and moved on. Polling stops via the inner
    // partial's OOB swap once it sees status==='done', so the toast
    // fires exactly once per batch.
    if (progress.status === 'done') {
        const exceptions = progress.failed + progress.cancelled;
        const toast =
            exceptions > 0
                ? {
                      level: 'warn',
                      message:
                          `Metadata refresh finished with ${exceptions} ` +
                          `exception${exceptions === 1 ? '' : 's'}. ` +
                          `${progress.completed} record${
                              progress.completed === 1 ? '' : 's'
                          } updated.`,
                  }
                : {
                      level: 'success',
                      message:
                          `Metadata refresh complete (${progress.completed} ` +
                          `record${progress.completed === 1 ? '' : 's'} updated).`,
                  };
        trigger_events(res, {
            'objects:refresh': { batch_uuid: progress.batch_uuid },
            'metadata:batch-done': { batch_uuid: progress.batch_uuid },
            toast,
        });
    }
    render_partial(req, res, 'dashboard/partials/metadata_progress', { progress });
}

async function cancel_batch(req, res) {
    await model.cancel_batch(req.params.batch_uuid);
    // Re-render the progress partial so the user sees the cancellation
    // take effect immediately, without waiting for the next 1s poll.
    return batch_progress_partial(req, res);
}

module.exports = {
    refresh_object,
    refresh_collection_members,
    refresh_collection_record,
    refresh_bulk,
    batch_progress_partial,
    cancel_batch,
};
