'use strict';

/*
 * Admin-facing controllers for the indexer. Flows:
 * 
 *   GET  /dashboard/admin/indexer                       full admin page
 *   GET  /dashboard/admin/indexer/status                status partial (HTMX-polled)
 *   POST /dashboard/admin/indexer/reindex-all
 *   POST /dashboard/admin/indexer/reindex-collection/:pid
 *   POST /dashboard/admin/indexer/reindex/:pid
 *   POST /dashboard/admin/indexer/rebuild-index         drop & recreate index
 * 
 * The reindex actions just dirty rows (set is_updated=1). The running
 * worker picks them up at its own pace. We surface the count of newly-
 * dirtied rows as a toast so staff can see scope before walking away.
 * 
 * rebuild-index is the destructive sibling: drops the ES index entirely,
 * recreates it from current mappings, then dirties every eligible row.
 * Use when a mapping change is shipped that re-pushing alone can't
 * pick up (ES mappings are largely immutable post-create).
 */

const app_config = require('../config/app');
const validator = require('validator');

const model = require('./model');
const es = require('../libs/elasticsearch');
const { ValidationError } = require('../libs/errors');

function render_partial(req, res, view, locals = {}) {
    const cfg = app_config();
    res.render(view, {
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        ...locals,
    });
}

function render_page(req, res, view, locals = {}) {
    const cfg = app_config();
    const base_locals = {
        title: locals.title || 'Indexer — Repository @ DU',
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        app_version: cfg.version,
        asset_v: cfg.asset_v,
        page: locals.page || view,
        active: locals.active || '',
        user: locals.user || res.locals.user || null,
        ...locals,
    };
    res.render(view, base_locals, (err, body) => {
        if (err) return res.status(500).send(err.message);
        res.render('dashboard/layout', { ...base_locals, body });
    });
}

function trigger_toast(res, level, message) {
    res.set('HX-Trigger', JSON.stringify({ toast: { level, message } }));
}

async function indexer_page(req, res) {
    render_page(req, res, 'dashboard/admin/indexer', {
        page: 'indexer',
        active: 'admin',
        title: 'Indexer — Repository @ DU',
    });
}

/*
 * Status partial: counts from the DB + ES health probe. Used by both
 * the initial page render (via include) and the HTMX poll.
 */
async function status_partial(req, res) {
    const [counts, health, index_count] = await Promise.all([
        model.status_counts(),
        es.health(),
        es.count(),
    ]);
    render_partial(req, res, 'dashboard/partials/indexer_status', {
        counts,
        health,
        index_count: index_count.count,
        es_configured: es.is_configured(),
    });
}

async function reindex_all(req, res) {
    const result = await model.mark_dirty_all();
    trigger_toast(
        res,
        'success',
        `Dirtied ${result.affected} row${result.affected === 1 ? '' : 's'} ` +
            `for re-indexing. Watch the status panel for progress.`
    );
    /*
     * Return the freshly-rendered status partial so the page updates
     * without an extra round-trip.
     */
    return status_partial(req, res);
}

async function reindex_collection(req, res) {
    const result = await model.mark_dirty_collection(req.params.pid);
    trigger_toast(
        res,
        'success',
        `Dirtied ${result.affected} member${result.affected === 1 ? '' : 's'} ` + `for re-indexing.`
    );
    return status_partial(req, res);
}

/*
 * Drop the public ES index, recreate it from the current mappings,
 * then mark every eligible row dirty so the worker repopulates.
 * 
 * Ordering rationale (ES first, DB second):
 *   delete_index → ensure_index → reset_all_index_state
 * 
 * If we flipped the DB first, the worker could claim rows from the
 * already-dirty pool and push them to a doomed index — harmless
 * (those writes are simply overwritten when the index is recreated),
 * but noisy in logs and on the ES side. Doing ES first means any
 * in-flight worker tick either no-ops on the empty index or sees a
 * transient error that the existing requeue path absorbs.
 * 
 * If delete_index fails we surface the error and STOP. The DB hasn't
 * been touched, so staff can fix ES (commonly an auth or connectivity
 * issue) and retry without any orphaned state.
 */
async function rebuild_index(req, res) {
    try {
        await es.delete_index();
        await es.ensure_index();
    } catch (err) {
        trigger_toast(res, 'error', `Index rebuild failed: ${err.message}`);
        return status_partial(req, res);
    }
    const result = await model.reset_all_index_state();
    trigger_toast(
        res,
        'success',
        `Index dropped and recreated. ${result.affected} row${result.affected === 1 ? '' : 's'} ` +
            `queued for re-push. Watch the status panel as the worker drains the queue.`
    );
    return status_partial(req, res);
}

async function reindex_pid(req, res) {
    const pid = req.params.pid;
    if (!validator.isUUID(String(pid))) {
        throw new ValidationError('pid must be a UUID');
    }
    const result = await model.mark_dirty_pid(pid);
    /*
     * HTTP header values must be ASCII — use three dots, not the
     * Unicode ellipsis. Same gotcha that bit the publish toast.
     */
    trigger_toast(
        res,
        'success',
        result.affected === 1 ? `Object ${pid.slice(0, 8)}... re-queued.` : `No row found.`
    );
    return status_partial(req, res);
}

/*
 * Retry every dead-lettered row (those that exhausted the retry cap and
 * were parked with index_error set). Clears their error + attempt counter
 * and re-dirties them so the worker re-attempts on its next tick. Run this
 * after fixing the underlying cause (e.g. an ES mapping or bad metadata).
 */
async function retry_dead_lettered(req, res) {
    const result = await model.requeue_dead_lettered();
    trigger_toast(
        res,
        'success',
        result.affected === 0
            ? 'No dead-lettered rows to retry.'
            : `Re-queued ${result.affected} dead-lettered row${result.affected === 1 ? '' : 's'} ` +
                  `for indexing. Watch the status panel for progress.`
    );
    return status_partial(req, res);
}

module.exports = {
    indexer_page,
    status_partial,
    reindex_all,
    reindex_collection,
    reindex_pid,
    rebuild_index,
    retry_dead_lettered,
};
