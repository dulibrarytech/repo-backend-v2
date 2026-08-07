'use strict';

/*
 * AIPs dashboard controller — Stage 6 + legacy migration surface.
 * 
 * Five routes:
 * 
 *   GET  /dashboard/aips                — list page (filters + spinner)
 *   GET  /dashboard/aips/list           — table partial (HTMX swap)
 *   GET  /dashboard/aips/:id/download   — 302 to a presigned Wasabi URL,
 *                                          increment the downloaded counter
 *   POST /dashboard/aips/:id/retry      — clear backoff/attempts and
 *                                          flip the corresponding queue
 *                                          row back to AIP_STORE_PENDING
 *                                          so Stage 6 re-runs
 *   GET  /dashboard/aips/:id/row        — HTMX-targeted single-row
 *                                          re-render after retry (so the
 *                                          table updates in place)
 * 
 * Read pattern follows objects.ejs / collections.ejs: a page +
 * partial split where the page sets up filter inputs and the partial
 * is HTMX-swapped on filter changes. The partial joins
 * tbl_aip_store ← LEFT → tbl_objects on uuid=pid so the table can
 * show the human-readable object title alongside the AIP filename.
 */

const app_config = require('../config/app');
const log = require('../libs/log');
const aip_store_model = require('../repository/aip_store_model');
const repository_model = require('../repository/model');
const aip_store_client = require('../ingester/libs/aip_store_client');
const ingest_model = require('../ingester/model');
const { ValidationError } = require('../libs/errors');

function render_page(req, res, view, locals = {}) {
    const cfg = app_config();
    const base_locals = {
        title: locals.title || 'AIP Storage — Repo Dashboard',
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

function render_partial(req, res, view, locals = {}) {
    const cfg = app_config();
    res.render(view, {
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        ...locals,
    });
}

function trigger_events(res, events) {
    const existing = res.get('HX-Trigger');
    let payload = {};
    if (existing) {
        try {
            payload = JSON.parse(existing);
        } catch {
            payload = {};
        }
    }
    res.set('HX-Trigger', JSON.stringify({ ...payload, ...events }));
}

function trigger_toast(res, level, message) {
    trigger_events(res, { toast: { level, message } });
}

/*
 * Coerce a query-string value to a string. Express's qs parser will
 * produce a string for a single occurrence, an array of strings for
 * repeated keys (?q=a&q=b → ['a','b']), and undefined when absent.
 * We pick the last value on array (matches the common "last wins"
 * convention) and fall back to '' on undefined/null.
 */
function _str(v) {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return _str(v[v.length - 1]);
    return String(v);
}

/*
 * Format bytes for the dashboard column. Mirrors libs/format.js style
 * but kept inline because the rest of the AIP-store dashboard is
 * also display-formatting glue.
 */
function format_bytes(n) {
    if (n === null || n === undefined) return '—';
    const bytes = Number(n);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const v = bytes / Math.pow(1024, i);
    return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/*
 * Enrich list-page rows with the matching tbl_objects title, ASpace
 * identifier, and ASpace URI. We do this as a separate batch read
 * (one query for all rows on the page) rather than via a JOIN so the
 * existing aip_store_model.list stays scoped to its own table and
 * tests don't need to seed tbl_objects.
 */
async function _attach_titles(items) {
    const uuids = items.map((r) => r.uuid).filter(Boolean);
    if (uuids.length === 0) return items;
    const by_pid = {};
    try {
        const objs = await repository_model.list_by_pids(uuids);
        for (const o of objs) by_pid[o.pid] = o;
    } catch (err) {
        /*
         * Title is decoration — don't fail the page if the read
         * glitches. Loud log so an operator notices.
         */
        log.warn({ event: 'aip_dashboard_title_lookup_failed', err: err.message });
    }
    return items.map((r) => {
        const obj = by_pid[r.uuid];
        let title = null;
        let identifier = null;
        if (obj && obj.display_record) {
            try {
                const dr = JSON.parse(obj.display_record);
                title =
                    (dr && dr.display_record && dr.display_record.title) ||
                    dr.title ||
                    null;
                /*
                 * ASpace identifier — component_id for objects, joined
                 * id_0..id_3 for resources (see archivesspace_transform
                 * _build_identifiers). The exporter always emits the
                 * array but the identifier value itself can be null.
                 * Same envelope-or-flat fallback as the title above.
                 */
                const ids =
                    (dr && dr.display_record && dr.display_record.identifiers) ||
                    (dr && dr.identifiers) ||
                    null;
                const first = Array.isArray(ids) && ids.length > 0 ? ids[0] : null;
                identifier = (first && first.identifier) || null;
            } catch {
                // Corrupt display_record — no title/identifier.
            }
        }
        return {
            ...r,
            _object_title: title,
            _object_identifier: identifier,
            _object_uri: (obj && obj.uri) || null,
            _bytes_human: format_bytes(r.bytes),
        };
    });
}

// ---- Routes -----------------------------------------------------------

async function aips_page(req, res) {
    render_page(req, res, 'dashboard/aips', {
        page: 'aips',
        /*
         * 'admin' so the sidebar renders the Admin Utils focus mode
         * with the AIPs icon highlighted (page === 'aips'). The view
         * moved into the admin rail below Batch Backups (2026-08-07)
         * — the two are neighbors on the preservation tier: Batch
         * Backups browses the batch archive, AIPs browses the
         * per-object AIP copies.
         */
        active: 'admin',
        title: 'AIPs — Repo Dashboard',
        filters: {
            q: req.query.q || '',
            source: req.query.source || '',
            status: req.query.status || '',
            sort: req.query.sort || 'recent',
        },
        aip_store_enabled: Boolean(app_config().aip_store && app_config().aip_store.enabled),
    });
}

async function aips_table_partial(req, res) {
    /*
     * Defensive coercion: Express parses duplicated query keys as an
     * array (e.g. ?q=&q=foo → ['', 'foo']). The dashboard view tries
     * hard not to send duplicates (see aips_table.ejs pagination
     * comment), but a hand-crafted URL or a misbehaving extension
     * could still send one. Without this, `req.query.q.trim()` would
     * throw "trim is not a function" and we'd 500 on filter changes.
     * Last-wins matches what callers usually mean by a duplicated key.
     */
    const q = _str(req.query.q).trim();
    const source = _str(req.query.source);
    const status = _str(req.query.status);
    const sort = _str(req.query.sort);

    /*
     * Widen the text search to ASpace identifiers (e.g.
     * D009.22.0007.0041.00001): they live only inside tbl_objects'
     * display_record JSON, so resolve matching pids first and let the
     * model OR them into its own-table match. Best-effort — a glitch
     * reading tbl_objects degrades the search to AIP columns only
     * rather than failing the page.
     */
    let extra_uuids = [];
    if (q) {
        try {
            extra_uuids = await repository_model.list_pids_by_display_record_match(q);
        } catch (err) {
            log.warn({
                event: 'aip_dashboard_identifier_lookup_failed',
                err: err.message,
            });
        }
    }

    /*
     * Title sort needs a pid→title lookup (titles live in tbl_objects'
     * display_record; SQL-side extraction is prohibitively slow — see
     * repository_model.cached_title_map). Best-effort: if the map
     * can't be built, the model falls back to the default ordering
     * rather than failing the page.
     */
    let title_of;
    if (sort === 'title') {
        try {
            const title_map = await repository_model.cached_title_map();
            title_of = (uuid) => title_map.get(uuid) || null;
        } catch (err) {
            log.warn({
                event: 'aip_dashboard_title_map_failed',
                err: err.message,
            });
        }
    }

    const result = await aip_store_model.list({
        page: req.query.page,
        page_size: req.query.page_size || '25',
        q,
        extra_uuids,
        source: source || undefined,
        status: status || undefined,
        sort: sort || undefined,
        title_of,
    });

    const enriched = await _attach_titles(result.items);

    render_partial(req, res, 'dashboard/partials/aips_table', {
        items: enriched,
        page: result.page,
        page_size: result.page_size,
        total: result.total,
        filters: { q, source, status },
    });
}

/*
 * 302 to a presigned Wasabi URL. The browser pulls the AIP bytes
 * directly from Wasabi without transiting either v2 or the curation
 * service.
 * 
 * On the way out we also increment the downloaded counter so the
 * dashboard can show usage. Counter bump is best-effort — a failure
 * there shouldn't block the user's download.
 */
async function aip_download(req, res) {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await aip_store_model.get(id); // throws NotFoundError

    // Failed / never-copied rows have no key to download.
    if (!aip_store_model.is_terminal_success(row)) {
        throw new ValidationError(
            `AIP ${id} is not in a downloadable state ` +
                `(status=${aip_store_model.derive_display_status(row)})`
        );
    }

    /*
     * Resolve the Wasabi key, walking: wasabi_key → aip → basename(aip_legacy).
     * The third fallback exists because ~332 legacy rows have an empty
     * `aip` column but a populated `aip_legacy` — the original migration's
     * basename-extraction pass never ran for them, but the file IS in
     * Wasabi at the basename of aip_legacy. See
     * aip_store_model.derive_wasabi_key for the full rationale.
     */
    const key = aip_store_model.derive_wasabi_key(row);
    if (!key) {
        throw new ValidationError(
            `AIP ${id} has no usable key (wasabi_key, aip, and aip_legacy all empty)`
        );
    }

    if (!aip_store_client.is_configured()) {
        throw new ValidationError(
            'Curation API not configured — cannot mint presigned URLs'
        );
    }

    const presign = await aip_store_client.presigned_url(key);
    if (presign.status !== 200 || !presign.data || presign.data.ok !== true) {
        const reason =
            (presign.data && presign.data.error) ||
            `presigned-url returned HTTP ${presign.status}`;
        throw new ValidationError(`Could not mint download URL: ${reason}`);
    }

    // Counter bump — fire-and-forget; never block the redirect.
    aip_store_model.increment_downloaded(id).catch((err) => {
        log.warn({
            event: 'aip_download_counter_failed',
            id,
            err: err.message,
        });
    });

    res.redirect(302, presign.data.url);
}

/*
 * Manual retry for an AIP_STORE_FAILED row. Two-step:
 *   1. Reset tbl_aip_store row's attempts/next_attempt_at/error.
 *   2. Find the matching ingest_queue row (by repo PID) and flip
 *      pipeline_state back to AIP_STORE_PENDING so the worker
 *      picks it up next tick.
 * 
 * Step 2 is the load-bearing part — without it Stage 6 won't run
 * again no matter how clean the tbl_aip_store row is. If we can't
 * find a queue row (legacy migration rows that pre-date the v2
 * queue), we still reset tbl_aip_store but return a warning so
 * staff knows the retry won't auto-execute.
 */
async function aip_retry(req, res) {
    return _aip_retry_impl(req, res, { from_duracloud: false });
}

/*
 * "Retry from DuraCloud" — same reset + queue re-enqueue as aip_retry,
 * but stamps the store row with message=RETRY_FROM_DURACLOUD so Stage 6
 * copies from DuraCloud's aip-store replica instead of AM Storage.
 * Built for the 2026-07-31 incident class: AM's download path cannot
 * serve 66-75 GB AIPs (hangs, then 502s) while the DuraCloud replica
 * is intact, chunked, and MD5-verifiable.
 */
async function aip_retry_duracloud(req, res) {
    return _aip_retry_impl(req, res, { from_duracloud: true });
}

async function _aip_retry_impl(req, res, { from_duracloud }) {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    let reset = await aip_store_model.reset_for_retry(id);
    if (from_duracloud) {
        reset = await aip_store_model.update(id, {
            message: 'RETRY_FROM_DURACLOUD',
        });
    }

    let queue_retry_ok = false;
    try {
        /*
         * The ingest queue's natural link to a tbl_aip_store row is
         * the AM AIP UUID (which we stored on the v2 row at copy
         * time). For legacy rows where aip_uuid is NULL, there's no
         * way to find the queue row — return an informational
         * warning rather than fail the retry.
         */
        if (reset.aip_uuid) {
            const queue_rows = await ingest_model.list_queue(
                { sip_uuid: reset.aip_uuid },
                { limit: 1, offset: 0 }
            );
            if (queue_rows.length > 0) {
                await ingest_model.update_queue(
                    { id: queue_rows[0].id },
                    {
                        status: 'AIP_STORE_PENDING',
                        is_complete: 0,
                        error: null,
                    },
                    {
                        actor:
                            (req.user && req.user.du_id) ||
                            (req.user && req.user.sub) ||
                            'dashboard',
                        payload: {
                            stage: 'aip_store',
                            step: 'manual_retry',
                            aip_store_id: id,
                        },
                    }
                );
                queue_retry_ok = true;
            }
        }
    } catch (err) {
        log.warn({
            event: 'aip_retry_queue_update_failed',
            id,
            err: err.message,
        });
        /*
         * Fall through — tbl_aip_store was already reset, so the
         * toast can be honest about what happened.
         */
    }

    /*
     * ASCII-only toast text: HTTP headers can't carry a Unicode
     * em-dash, and trigger_toast round-trips through HX-Trigger.
     * Same gotcha documented in aip_backfill_controller.js and the
     * metadata admin controller — kept loud so future contributors
     * don't reintroduce the en-/em-dash here.
     */
    trigger_toast(
        res,
        queue_retry_ok ? 'success' : 'warn',
        queue_retry_ok
            ? from_duracloud
                ? `Retry queued - the AIP copy will re-run from DuraCloud on the next worker tick.`
                : `Retry queued - the AIP copy will re-run on the next worker tick.`
            : `AIP row reset, but no matching ingest queue row was found. ` +
                  `Legacy rows can be re-copied via a separate admin tool.`
    );

    // Return the updated row partial so the table updates in place.
    const enriched = await _attach_titles([reset]);
    render_partial(req, res, 'dashboard/partials/aip_row', { item: enriched[0] });
}

/*
 * HTMX target for the post-retry single-row refresh, in case the
 * table needs to pull a fresh row from outside the retry response
 * path (e.g. after an external state change). Same response shape
 * as the retry handler's body.
 */
async function aip_row_partial(req, res) {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError('id must be a positive integer');
    }
    const row = await aip_store_model.get(id);
    const enriched = await _attach_titles([row]);
    render_partial(req, res, 'dashboard/partials/aip_row', { item: enriched[0] });
}

module.exports = {
    aips_page,
    aips_table_partial,
    aip_download,
    aip_retry,
    aip_retry_duracloud,
    aip_row_partial,
    // Test helpers
    _format_bytes: format_bytes,
};
