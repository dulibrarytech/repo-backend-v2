'use strict';

/*
 * Dashboard controllers. All async. Each handler either:
 *   - renders a full page (layout.ejs wrapping a body view), or
 *   - renders a partial (just the inner HTML — HTMX swaps it in).
 */

const validator = require('validator');

const app_config = require('../config/app');
const auth_model = require('../auth/model');
const user_model = require('../users/model');
const repo_model = require('../repository/model');
const search_model = require('../search/model');
const stats_model = require('../stats/model');
const collections_model = require('../collections/model');
const collection_provision = require('../repository/collection_provision');
const projection = require('../libs/object_projection');
const jwt = require('../libs/jwt');
const thumbnails = require('./thumbnails');
const duracloud = require('../libs/duracloud');
const tn_service = require('../libs/tn_service');
const path = require('node:path');
const fs = require('node:fs');
const { UnauthorizedError, ValidationError } = require('../libs/errors');

/*
 * Decode a `next=` value that the sanitize middleware has HTML-entity-encoded
 * (slashes → `&#x2F;` etc.) and return it only if it is a safe same-origin
 * path: starts with `/`, not `//` (protocol-relative), no CR/LF. Otherwise
 * returns `fallback`.
 */
function safe_next(raw, fallback) {
    if (typeof raw !== 'string' || raw.length === 0) return fallback;
    const decoded = validator.unescape(raw.trim());
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return fallback;
    if (decoded.includes('\n') || decoded.includes('\r')) return fallback;
    return decoded;
}

/*
 * ----------------------------------------------------------------------------
 * Internal: render a body view and wrap it in layout.ejs.
 * ----------------------------------------------------------------------------
 */
function render_page(req, res, view, locals = {}) {
    const cfg = app_config();
    const base_locals = {
        title: locals.title || 'Digital Archives Manager @ DU',
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

function trigger_toast(res, level, message) {
    res.set('HX-Trigger', JSON.stringify({ toast: { level, message } }));
}

/*
 * Coerce a query-string value to a string: last value of an array
 * (?q=a&q=b → 'b'), '' for undefined/null, String(v) otherwise.
 * Mirrors dashboard/aip_controller.js:_str.
 */
function _last_string(v) {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return _last_string(v[v.length - 1]);
    return String(v);
}

/*
 * ----------------------------------------------------------------------------
 * LOGIN
 * ----------------------------------------------------------------------------
 */
async function login_page(req, res) {
    const cfg = app_config();
    // Standalone shell — no sidebar/header from layout.ejs.
    res.render('dashboard/login_shell', {
        title: 'Sign in — Repo Dashboard',
        app_path: cfg.path,
        dashboard_base: `${cfg.path}/dashboard`,
        static_base: `${cfg.path}/static`,
        asset_v: cfg.asset_v,
        next: req.query.next || '',
        error: null,
        sso_enabled: Boolean(cfg.sso && cfg.sso.url),
    });
}

async function login_submit(req, res) {
    const cfg = app_config();
    const sso_enabled = Boolean(cfg.sso && cfg.sso.url);
    const du_id = String((req.body && req.body.du_id) || '').trim();
    const next = String((req.body && req.body.next) || '').trim();
    if (!du_id) {
        return render_partial(req, res, 'dashboard/partials/login_form', {
            next,
            error: 'Please enter your DU ID.',
            sso_enabled,
        });
    }

    const user = await auth_model.find_active_user(du_id);
    if (!user) {
        return render_partial(req, res, 'dashboard/partials/login_form', {
            next,
            error: 'Invalid credentials.',
            sso_enabled,
        });
    }

    await auth_model.rotate_refresh_token(user.id);
    jwt.issue_cookie(res, { sub: String(user.id), du_id: user.du_id, email: user.email });

    const home = `${app_config().path}/dashboard/`;
    const target = safe_next(next, home);

    // HTMX path: tell the client to do a soft redirect.
    if (req.get('hx-request') === 'true') {
        res.set('HX-Redirect', target);
        return res.status(204).end();
    }

    // Non-HTMX (e.g. JS-off): traditional 303.
    return res.redirect(303, target);
}

async function logout(req, res) {
    const cfg = app_config();
    if (req.user && req.user.sub) {
        try {
            await auth_model.clear_refresh_token(req.user.sub);
        } catch {
            // Best-effort — even if DB is unreachable, clear the cookie.
        }
    }
    jwt.clear_cookie(res);
    // SSO_LOGOUT_URL when configured (central IdP signout), else the local login page.
    const target = cfg.sso.logout_url || `${cfg.path}/dashboard/login`;
    return res.redirect(303, target);
}

/*
 * ----------------------------------------------------------------------------
 * HOME
 * ----------------------------------------------------------------------------
 */
/*
 * Renders the STATS view, not dashboard/home. TEMPORARY — see
 * repo/notes/REPOV2_CODE_NOTES.md for the restore steps. Throws
 * UnauthorizedError and clears the cookie if the token's user is deactivated.
 */
async function home_page(req, res) {
    const user = await auth_model.find_by_id(req.user.sub);
    if (!user || user.is_active !== 1) {
        // Token still valid but user was deactivated. Bounce.
        jwt.clear_cookie(res);
        throw new UnauthorizedError('User no longer active');
    }
    const [summary, per_year] = await Promise.all([
        stats_model.extended_summary(),
        stats_model.ingests_per_year({ min_year: 2020 }),
    ]);
    render_page(req, res, 'dashboard/stats', {
        page: 'stats',
        active: 'home',
        title: 'Home — Digital Archives Manager @ DU',
        user,
        summary,
        per_year,
        fmt_count: format_count,
        fmt_bytes: format_bytes,
        // Degraded-services banner: staff's passive signal that a backing service is down.
        show_services_banner: true,
    });
}

async function home_top_collections_partial(req, res) {
    const items = await stats_model.by_collection({ limit: 5 });
    render_partial(req, res, 'dashboard/partials/home_top_collections', { items });
}

async function home_recent_ingests_partial(req, res) {
    const items = await stats_model.recent_ingests({ limit: 5 });
    render_partial(req, res, 'dashboard/partials/home_recent_ingests', { items });
}

/*
 * ----------------------------------------------------------------------------
 * STATS
 * ----------------------------------------------------------------------------
 */
const stats_duracloud = require('../stats/duracloud');
const { format_bytes, format_count } = require('../libs/format');

/*
 * Redirects /dashboard/stats to /dashboard/, which renders the stats view.
 * TEMPORARY — see repo/notes/REPOV2_CODE_NOTES.md.
 */
async function stats_page(req, res) {
    const cfg = app_config();
    return res.redirect(302, `${cfg.path}/dashboard/`);
}

async function stats_duracloud_partial(req, res) {
    const usage = await stats_duracloud.usage();
    render_partial(req, res, 'dashboard/partials/stats_duracloud', {
        usage,
        fmt_bytes: format_bytes,
    });
}

/*
 * ----------------------------------------------------------------------------
 * COLLECTIONS — list + detail
 * ----------------------------------------------------------------------------
 */
async function collections_page(req, res) {
    render_page(req, res, 'dashboard/collections', {
        page: 'collections',
        active: 'collections',
        title: 'Manage Collections — Digital Archives Manager @ DU',
        filters: {
            q: req.query.q || '',
            // Dashboard default is title A–Z; the model/API default stays 'count'.
            sort: req.query.sort || 'title',
        },
    });
}

async function collections_list_partial(req, res) {
    const result = await collections_model.list_collections({
        q: req.query.q,
        sort: req.query.sort || 'title',
        page: req.query.page,
        page_size: req.query.page_size,
    });
    render_partial(req, res, 'dashboard/partials/collections_table', {
        items: result.items,
        page: result.page,
        page_size: result.page_size,
        total: result.total,
        filters: { q: result.q, sort: result.sort },
    });
}

async function collection_detail_page(req, res) {
    const collection = await collections_model.get_collection(req.params.pid);
    // Rendered in their own section, separate from the member-object list.
    const sub_collections = await collections_model.sub_collections(req.params.pid);
    render_page(req, res, 'dashboard/collection_detail', {
        page: 'collection_detail',
        active: 'collections',
        title: `${collection.title || collection.pid} — Digital Archives Manager @ DU`,
        collection,
        sub_collections,
        filters: {
            q: req.query.q || '',
            is_published: req.query.is_published || '',
        },
    });
}

/*
 * "Add objects" page for a collection — shell only. Search results and
 * pagination load into #add-objects-results via collection_add_objects_list;
 * selected pids POST to /collections/:pid/members.
 */
async function collection_add_objects_page(req, res) {
    const collection = await collections_model.get_collection(req.params.pid);
    const q = (_last_string(req.query.q) || '').trim();
    render_page(req, res, 'dashboard/collections_add_objects', {
        page: 'collections_add_objects',
        active: 'collections',
        title: `Add objects — ${collection.title || collection.pid}`,
        collection,
        q,
    });
}

/*
 * Results partial for the Add-objects picker. Excludes collections and objects
 * already in this collection at the SQL layer, so the total and page math stay
 * accurate. 25 per page.
 */
async function collection_add_objects_list(req, res) {
    const collection = await collections_model.get_collection(req.params.pid);
    const q = (_last_string(req.query.q) || '').trim();
    const result = await search_model.search({
        q: q || undefined,
        is_active: true,
        exclude_collections: true,
        not_member_of_collection: collection.pid,
        page: _last_string(req.query.page),
        page_size: 25,
    });
    const candidates = projection.enrich_all(result.items);
    /*
     * is_member_of_collection holds a PID, not a name — resolve the candidates'
     * current collections to titles in one batch query for display.
     */
    const current_titles = await collections_model.titles_by_pids(
        candidates.map((o) => o.is_member_of_collection)
    );
    candidates.forEach((o) => {
        o.current_collection_title = current_titles.get(o.is_member_of_collection) || null;
    });
    render_partial(req, res, 'dashboard/partials/add_objects_results', {
        collection,
        q,
        candidates,
        page: result.page,
        page_size: result.page_size,
        total: result.total,
    });
}

// Move the selected objects into the collection, then return to its detail.
async function collection_add_members(req, res) {
    const dashboard_base = `${app_config().path}/dashboard`;
    const pid = req.params.pid;
    let pids = req.body.pids;
    if (typeof pids === 'string') pids = [pids];
    if (!Array.isArray(pids)) pids = [];
    if (pids.length === 0) {
        // Nothing selected — back to the picker.
        return res.redirect(303, `${dashboard_base}/collections/${pid}/add-objects`);
    }
    await collections_model.add_members(pid, pids);
    return res.redirect(303, `${dashboard_base}/collections/${pid}`);
}

/*
 * Soft-delete an EMPTY (sub-)collection. The model refuses (409) if it still
 * has any active children. Removes the row from the Sub-collections section
 * (hx-target=#collection-<pid>, hx-swap=outerHTML on an empty body) + toasts.
 */
async function collection_delete(req, res) {
    const actor = await user_model.actor_label(req.user);
    await collections_model.delete_collection(req.params.pid, { actor });
    res.set(
        'HX-Trigger',
        JSON.stringify({
            toast: { level: 'success', message: 'Sub-collection deleted.' },
        })
    );
    // Empty body so the targeted row is removed cleanly.
    res.set('Content-Type', 'text/html').send('');
}

/*
 * Modal to move/re-parent a collection. Lists the collections it may be moved
 * under (excludes itself and its descendants) plus a "top level" option.
 * Loaded into #modal-content via HTMX.
 */
async function collection_move_form(req, res) {
    const collection = await collections_model.get_collection(req.params.pid);
    const parents = await collections_model.eligible_parents(req.params.pid);
    /*
     * A real parent is a UUID pid; legacy top-level markers ('codu:root', '',
     * null) collapse to '' so the modal pre-selects "Top level".
     */
    const raw_parent = collection.is_member_of_collection || '';
    const current_parent = validator.isUUID(raw_parent) ? raw_parent : '';
    render_partial(req, res, 'dashboard/partials/collection_move_modal', {
        collection,
        parents,
        current_parent,
    });
}

/*
 * Apply a collection move. new_parent_pid='' → top-level. The model enforces the
 * active-collection + cycle guards (400/404 on violation). Toasts + refreshes.
 */
async function collection_move(req, res) {
    const new_parent_pid = _last_string(req.body.new_parent_pid) || '';
    const result = await collections_model.move_collection(req.params.pid, new_parent_pid);
    const message = result.parent_pid
        ? 'Collection moved.'
        : 'Collection moved to the top level.';
    res.set(
        'HX-Trigger',
        JSON.stringify({
            'modal:close': {},
            toast: { level: 'success', message },
            'collections:refresh': {},
        })
    );
    res.set('Content-Type', 'text/html').send('');
}

/*
 * Render the "New collection" / "Create sub-collection" form. `?parent=<pid>`
 * pre-binds a parent so the new collection becomes a sub-collection of it.
 */
async function collection_new_page(req, res) {
    const parent_pid = _last_string(req.query.parent);
    // Best-effort parent lookup for display ("under X"); null if absent/invalid.
    const parent = parent_pid
        ? await collections_model.get_collection(parent_pid).catch(() => null)
        : null;
    render_page(req, res, 'dashboard/collections_new', {
        page: 'collections_new',
        active: 'collections',
        title: parent ? 'Create Sub-collection — Digital Archives Manager @ DU' : 'New Collection — Digital Archives Manager @ DU',
        parent,
        form: { uri: '' },
        error: null,
    });
}

/*
 * Create a collection (top-level or sub) bound to an ArchivesSpace URI, via the
 * same provisioning the ingest gate uses. On success redirects to the new
 * collection's detail; on error or already-exists re-renders the form with the
 * message.
 */
async function collection_create(req, res) {
    const dashboard_base = `${app_config().path}/dashboard`;
    // The body sanitizer HTML-escapes '/', so a pasted URI needs unescaping first.
    const raw = validator.unescape((_last_string(req.body.uri) || '').trim());
    const parent_pid = _last_string(req.body.parent_collection_pid) || '';
    const parent = parent_pid
        ? await collections_model.get_collection(parent_pid).catch(() => null)
        : null;

    function reject(message) {
        return render_page(req, res, 'dashboard/collections_new', {
            page: 'collections_new',
            active: 'collections',
            title: parent
                ? 'Create Sub-collection — Digital Archives Manager @ DU'
                : 'New Collection — Digital Archives Manager @ DU',
            parent,
            form: { uri: raw },
            error: message,
        });
    }

    if (parent_pid && !parent) {
        return reject('The parent collection could not be found.');
    }
    /*
     * Accepts a full ArchivesSpace URI only, of either form:
     *   /repositories/<n>/resources/<n>
     *   /repositories/<n>/archival_objects/<n>
     * A bare numeric ID is rejected.
     */
    let uri;
    if (
        /^\/repositories\/\d+\/resources\/\d+$/.test(raw) ||
        /^\/repositories\/\d+\/archival_objects\/\d+$/.test(raw)
    ) {
        uri = raw;
    } else {
        return reject(
            'Enter the full ArchivesSpace URI, e.g. /repositories/2/resources/1204 ' +
                'or /repositories/2/archival_objects/426.'
        );
    }

    const result = await collection_provision.provision_collection({
        uri,
        parent_collection_pid: parent_pid || undefined,
    });
    if (!result.ok) {
        return reject(result.error);
    }
    if (!result.created) {
        // One live collection per URI (unique index).
        return reject(
            `A collection bound to ${uri} already exists — open it from the Collections list.`
        );
    }
    return res.redirect(303, `${dashboard_base}/collections/${result.collection_pid}`);
}

/*
 * ----------------------------------------------------------------------------
 * OBJECTS
 * ----------------------------------------------------------------------------
 */
async function objects_page(req, res) {
    render_page(req, res, 'dashboard/objects', {
        page: 'objects',
        active: 'objects',
        title: 'Objects — Repo Dashboard',
        filters: {
            q: req.query.q || '',
            is_published: req.query.is_published || '',
            collection: req.query.collection || '',
        },
    });
}

async function objects_table_partial(req, res) {
    // Repeated query keys arrive as arrays; _last_string collapses them last-wins.
    const q_raw = _last_string(req.query.q);
    const is_published_raw = _last_string(req.query.is_published);
    const collection_raw = _last_string(req.query.collection);
    const is_active_raw = _last_string(req.query.is_active);
    const object_type_raw = _last_string(req.query.object_type);

    const q = q_raw.trim();
    /*
     * is_active_raw='1' → show only active   (explicit)
     * is_active_raw='0' → show only deleted  (audit opt-in, URL param only)
     * is_active_raw=''  → show only active   (default)
     */
    const is_active_filter =
        is_active_raw === '1'
            ? true
            : is_active_raw === '0'
              ? false
              : true; // default: hide deleted
    const common = {
        page: _last_string(req.query.page),
        page_size: _last_string(req.query.page_size) || '25',
        collection: collection_raw || undefined,
        object_type: object_type_raw || undefined,
        is_published:
            is_published_raw === '1'
                ? true
                : is_published_raw === '0'
                  ? false
                  : undefined,
        // Always a boolean — never undefined. See is_active_filter above.
        is_active: is_active_filter,
    };

    /*
     * ?recent_days=N limits to objects created in the last N days, capped at
     * 365. The cutoff is formatted as the 'YYYY-MM-DD HH:MM:SS' UTC string the
     * `created` TIMESTAMP stores (see repository/model.list).
     */
    const recent_days = Number.parseInt(_last_string(req.query.recent_days), 10);
    if (Number.isFinite(recent_days) && recent_days > 0) {
        common.created_since = new Date(Date.now() - Math.min(recent_days, 365) * 86400000)
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ');
    }
    // Collection-detail member list sets this to keep sub-collections out of the rows.
    if (_last_string(req.query.exclude_collections) === '1') {
        common.exclude_collections = true;
    }

    // With `q`: search model (LIKE across indexed columns). Without: plain index scan.
    const result = q ? await search_model.search({ ...common, q }) : await repo_model.list(common);

    // Adds title (parsed from display_record) and drops the raw display_record blob.
    const items = projection.enrich_all(result.items);

    render_partial(req, res, 'dashboard/partials/objects_table', {
        items,
        page: result.page,
        page_size: result.page_size,
        total: result.total,
        filters: {
            q,
            is_published: is_published_raw,
            collection: collection_raw,
            is_active: is_active_raw,
        },
    });
}

async function objects_row_action(req, res, action) {
    let updated;
    if (action === 'publish') updated = await repo_model.publish(req.params.pid);
    else if (action === 'suppress') updated = await repo_model.suppress(req.params.pid);
    else throw new ValidationError(`Unknown action: ${action}`);
    // HTTP headers must be ASCII — no Unicode ellipsis in toast messages.
    trigger_toast(res, 'success', `Object ${updated.pid.slice(0, 8)}... ${action}ed.`);
    render_partial(req, res, 'dashboard/partials/object_row', { item: updated });
}

async function objects_publish(req, res) {
    return objects_row_action(req, res, 'publish');
}
async function objects_suppress(req, res) {
    return objects_row_action(req, res, 'suppress');
}

async function objects_delete(req, res) {
    // From the confirmation modal's textarea. Required — model throws if missing.
    const delete_reason = req.body && req.body.delete_reason;
    // Audit actor, "First Last (du_id)".
    const actor = await user_model.actor_label(req.user);
    const result = await repo_model.soft_delete(req.params.pid, {
        delete_reason,
        actor,
    });
    /*
     * Three HTMX signals in one header:
     *   modal:close     — dashboard.js dismisses the confirmation modal
     *   toast           — success, or a warning when the AM call failed
     *   objects:refresh — table re-fetches so the deleted row drops
     */
    const am_failed = result.am && !result.am.ok;
    const toast = am_failed
        ? {
              level: 'warning',
              message: `Object soft-deleted, but AM AIP deletion request failed: ${
                  result.am.error || `HTTP ${result.am.status}`
              }`,
          }
        : { level: 'success', message: 'Object deleted.' };
    res.set(
        'HX-Trigger',
        JSON.stringify({
            'modal:close': {},
            toast,
            'objects:refresh': { affected: 1, kind: 'delete' },
        })
    );
    // Empty body so hx-target=#object-<pid> + hx-swap=outerHTML removes the row.
    res.set('Content-Type', 'text/html').send('');
}

/*
 * Confirmation modal for a single object delete: the object's title plus a
 * required reason textarea. The form hx-deletes back to /objects/:pid with the
 * reason in the body. Falls back to a placeholder title if the row is gone.
 */
async function objects_delete_confirm(req, res) {
    const pid = req.params.pid;
    let item;
    try {
        item = projection.enrich(await repo_model.get(pid));
    } catch {
        item = { pid, title: '(unknown / already gone)', is_published: 0 };
    }
    render_partial(req, res, 'dashboard/partials/object_delete_modal', { item });
}

/*
 * ----------------------------------------------------------------------------
 * BULK ACTIONS
 *
 * All three multi-select endpoints share one input contract:
 *   - body.pids: a comma-separated string (HTMX form submit) or a JSON array.
 *     Both are normalized to an array of strings before the model call.
 *   - body.target_url (optional): re-fetched via HX-Trigger once the action
 *     completes, so the caller's table refreshes in place. No list partial is
 *     rendered here — the caller may be on the Objects page or a collection
 *     detail page, and its filters/page/page_size live on the client.
 * ----------------------------------------------------------------------------
 */
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

async function objects_bulk_action(req, res, kind) {
    const pids = parse_pid_list(req.body && req.body.pids);
    if (pids.length === 0) {
        throw new ValidationError('Select at least one object');
    }
    // Audit actor, "First Last (du_id)" — same label the single-delete path stamps.
    const actor = await user_model.actor_label(req.user);

    let result;
    let verb;
    if (kind === 'publish') {
        result = await repo_model.bulk_publish(pids);
        verb = 'published';
    } else if (kind === 'suppress') {
        result = await repo_model.bulk_suppress(pids);
        verb = 'suppressed';
    } else if (kind === 'delete') {
        // Required; the same reason text applies to every pid in the batch.
        const delete_reason = req.body && req.body.delete_reason;
        result = await repo_model.bulk_soft_delete(pids, { delete_reason, actor });
        verb = 'deleted';
    } else {
        throw new ValidationError(`Unknown bulk action: ${kind}`);
    }

    // A bulk delete with any failed per-row AM call downgrades success → warning.
    let level = 'success';
    let message = `${result.affected} object${result.affected === 1 ? '' : 's'} ${verb}.`;
    if (kind === 'delete' && result.am_failed > 0) {
        level = 'warning';
        message =
            `${result.affected} object${result.affected === 1 ? '' : 's'} soft-deleted; ` +
            `${result.am_failed} AM AIP deletion request${
                result.am_failed === 1 ? '' : 's'
            } failed — see logs.`;
    }

    /*
     * modal:close + toast + objects:refresh. Both the Objects page and the
     * collection detail page wire `hx-trigger="load, objects:refresh from:body"`
     * on their table. modal:close is a no-op when no modal is open.
     */
    res.set(
        'HX-Trigger',
        JSON.stringify({
            'modal:close': {},
            toast: { level, message },
            'objects:refresh': { affected: result.affected, kind },
        })
    );
    // 204 — the toast + refresh trigger does the visible work.
    res.status(204).end();
}

async function objects_bulk_publish(req, res) {
    return objects_bulk_action(req, res, 'publish');
}
async function objects_bulk_suppress(req, res) {
    return objects_bulk_action(req, res, 'suppress');
}
async function objects_bulk_delete(req, res) {
    return objects_bulk_action(req, res, 'delete');
}

/*
 * Bulk-delete confirmation modal — lists the selected objects' titles. Its
 * submit button POSTs back to objects_bulk_delete.
 */
async function objects_bulk_delete_confirm(req, res) {
    const pids = parse_pid_list(req.body && req.body.pids);
    if (pids.length === 0) {
        throw new ValidationError('Select at least one object');
    }
    /*
     * Bounded at MAX_BULK_PIDS. Misses (pid not found, already soft-deleted)
     * become a placeholder row so the modal still renders on a stale list.
     */
    const items = [];
    for (const pid of pids.slice(0, repo_model.MAX_BULK_PIDS)) {
        try {
            const row = await repo_model.get(pid);
            items.push(projection.enrich(row));
        } catch {
            items.push({ pid, title: '(unknown / already gone)' });
        }
    }
    render_partial(req, res, 'dashboard/partials/bulk_delete_modal', {
        items,
        pids,
    });
}

/*
 * Publish or suppress every active non-collection member of a collection in one
 * UPDATE. Triggered by header buttons on the collection-detail page.
 */
async function collection_bulk_publish(req, res) {
    const result = await collections_model.publish_members(req.params.pid);
    res.set(
        'HX-Trigger',
        JSON.stringify({
            toast: {
                level: 'success',
                message: `Published ${result.affected} member object${result.affected === 1 ? '' : 's'}.`,
            },
            'objects:refresh': { affected: result.affected, kind: 'publish' },
        })
    );
    res.status(204).end();
}

async function collection_bulk_suppress(req, res) {
    const result = await collections_model.suppress_members(req.params.pid);
    res.set(
        'HX-Trigger',
        JSON.stringify({
            toast: {
                level: 'success',
                message: `Suppressed ${result.affected} member object${result.affected === 1 ? '' : 's'}.`,
            },
            'objects:refresh': { affected: result.affected, kind: 'suppress' },
        })
    );
    res.status(204).end();
}

/*
 * Metadata modal — renders the inner ASpace record from display_record.
 *
 * The `display_record` longtext column nests two layers: an outer envelope of
 * denormalized lookup fields (pid, handle, thumbnail, is_member_of_collection,
 * abstract, …) containing a `display_record` key whose value is the ASpace
 * archival_object / resource record (title, uri, identifiers, dates, extents,
 * subjects, notes, names, parts, …).
 *
 * Renders the nested record at the modal's top level, falling back to the outer
 * envelope when the row has no nested record (legacy/incomplete data).
 */
async function object_metadata_modal(req, res) {
    const row = await repo_model.get(req.params.pid);
    const enriched = projection.enrich(row);
    const outer = projection.parse_display_record(row.display_record);
    const nested = outer && typeof outer.display_record === 'object' ? outer.display_record : null;
    const data = nested && Object.keys(nested).length > 0 ? nested : outer;
    /*
     * Only keys with a non-empty value; blank strings and empty/all-empty
     * arrays and objects are dropped. Kaltura entry ids are rendered per-part
     * by metadata_field.ejs straight off parts[].kaltura_id.
     */
    const fields = Object.keys(data || {}).filter((k) => !projection.is_empty_value(data[k]));
    render_partial(req, res, 'dashboard/partials/object_metadata_modal', {
        obj: enriched,
        display_record: data,
        fields,
    });
}

/*
 * ----------------------------------------------------------------------------
 * THUMBNAIL UPLOAD
 *
 * Two endpoints:
 *   GET  /objects/:pid/thumbnail/form  → the upload modal, lazy-loaded by the
 *                                        kebab menu
 *   POST /objects/:pid/thumbnail       → multer-backed upload + DB sync
 *
 * The POST is special-cased in routes.js so multer middleware runs before the
 * global sanitizer reaches req.body.
 * ----------------------------------------------------------------------------
 */
async function object_thumbnail_form(req, res) {
    const row = await repo_model.get(req.params.pid);
    const enriched = projection.enrich(row);
    render_partial(req, res, 'dashboard/partials/thumbnail_upload_modal', {
        obj: enriched,
    });
}

/*
 * Invalidate the TN service's disk-cached thumbnail for one object; the next
 * request through object_thumbnail_raw re-fetches from the TN service. Does not
 * affect the browser's HTTP cache.
 */
async function object_thumbnail_invalidate(req, res) {
    const pid = req.params.pid;
    // 404 on an unknown pid before touching the filesystem.
    await repo_model.get(pid);
    const result = await tn_service.invalidate_cache(pid);
    trigger_toast(
        res,
        'success',
        result.invalidated
            ? 'Thumbnail cache cleared. The next fetch will pull a fresh thumbnail.'
            : 'No cached thumbnail to clear (nothing to do).'
    );
    res.status(204).end();
}

async function object_thumbnail_upload(req, res) {
    const buffer = thumbnails.validate_uploaded_buffer(req.file);
    await thumbnails.write_thumbnail_atomically(req.params.pid, buffer);
    const url = thumbnails.build_thumbnail_url(req, req.params.pid);
    const updated = await repo_model.set_thumbnail(req.params.pid, url);
    const enriched = projection.enrich(updated);

    /*
     * Partial is chosen by object_type. collection_row's member_count and
     * published_count don't survive repo_model, so the row falls back to
     * `(0 pub)` until the collections page is reloaded.
     */
    const is_collection = enriched.object_type === 'collection';
    const partial = is_collection
        ? 'dashboard/partials/collection_row'
        : 'dashboard/partials/object_row';

    // toast + modal:close in one header, so both fire on the same htmx event tick.
    res.set(
        'HX-Trigger',
        JSON.stringify({
            toast: { level: 'success', message: 'Thumbnail updated.' },
            'modal:close': {},
        })
    );
    // The form posts with hx-target=#<row-id>, so htmx swaps the row itself.
    render_partial(req, res, partial, { item: enriched });
}

/*
 * ----------------------------------------------------------------------------
 * THUMBNAIL PROXY
 * ----------------------------------------------------------------------------
 */
const THUMBNAIL_PLACEHOLDER = path.join(
    __dirname,
    '..',
    'public',
    'images',
    'thumbnail-missing.svg'
);

// 200, not 404 — a 404 would put the row's <img> into the broken-image state.
function send_thumbnail_placeholder(res) {
    res.status(200);
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'private, max-age=60');
    fs.createReadStream(THUMBNAIL_PLACEHOLDER).pipe(res);
}

/*
 * Serve an object's thumbnail. Resolution order, first match wins:
 *
 *   1. Absolute http(s) URL in tbl_objects.thumbnail (uploaded or CDN) →
 *      302 redirect.
 *   2. TN service, by PID, when TN_SERVICE + TN_SERVICE_API_KEY are set.
 *      Disk-cached on success.
 *   3. DuraCloud, when the stored value is a dip-store path.
 *   4. Local SVG placeholder, as 200.
 *
 * Responses carry `Cache-Control: private, max-age=3600` — private because the
 * backing content includes restricted items.
 */
async function object_thumbnail_raw(req, res) {
    const pid = req.params.pid;
    let row;
    try {
        row = await repo_model.get(pid);
    } catch {
        // Unknown pid (e.g. soft-deleted while a list was on screen) → placeholder.
        return send_thumbnail_placeholder(res);
    }

    const enriched = projection.enrich(row);
    /*
     * thumbnail_raw, not thumbnail: `thumbnail` is the synthesized proxy URL
     * pointing back at this handler. The raw value is what selects the case
     * below.
     */
    const stored = enriched.thumbnail_raw;

    // Case 1: absolute URL — redirect rather than proxy.
    if (stored && /^https?:\/\//i.test(stored)) {
        res.set('Cache-Control', 'private, max-age=3600');
        return res.redirect(302, stored);
    }

    /*
     * Case 2: TN service, looked up by PID regardless of the stored value.
     * Unconfigured, or a throwing fetch, falls through to case 3.
     */
    if (tn_service.is_configured()) {
        try {
            const buffer = await tn_service.get_thumbnail(pid);
            res.status(200);
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'private, max-age=3600');
            return res.end(buffer);
        } catch {
            // 404, error, or timeout — fall through. libs/tn_service does the logging.
        }
    }

    // Case 3: DuraCloud, for legacy rows whose stored value is a dip-store path.
    if (stored && duracloud.is_configured()) {
        let upstream;
        try {
            upstream = await duracloud.get_thumbnail_stream(stored);
        } catch {
            return send_thumbnail_placeholder(res);
        }
        if (upstream.status === 200 && upstream.data) {
            res.status(200);
            res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
            res.set('Cache-Control', 'private, max-age=3600');
            upstream.data.pipe(res);
            upstream.data.on('error', () => {
                if (!res.headersSent) send_thumbnail_placeholder(res);
                else res.end();
            });
            return;
        }
    }

    // Case 4: nothing usable. Placeholder.
    return send_thumbnail_placeholder(res);
}

/*
 * ----------------------------------------------------------------------------
 * USERS
 * ----------------------------------------------------------------------------
 */
async function users_page(req, res) {
    render_page(req, res, 'dashboard/users', {
        page: 'users',
        active: 'users',
        title: 'Users — Repo Dashboard',
    });
}

async function users_table_partial(req, res) {
    const items = await user_model.list({
        include_inactive: req.query.include_inactive === '1',
    });
    render_partial(req, res, 'dashboard/partials/users_table', {
        items,
        include_inactive: req.query.include_inactive === '1',
    });
}

// Create modal — empty form rendered into #modal-content.
async function users_create_modal(req, res) {
    render_partial(req, res, 'dashboard/partials/user_create_modal', {
        form: {},
        error: null,
        details: [],
    });
}

async function users_create(req, res) {
    try {
        const created = await user_model.create(req.body || {});
        // Empty body: modal:close dismisses the modal, users:created refetches the table.
        res.set(
            'HX-Trigger',
            JSON.stringify({
                toast: { level: 'success', message: `User ${created.du_id} created.` },
                'users:created': { id: created.id },
                'modal:close': {},
            })
        );
        res.set('Content-Type', 'text/html').send('');
    } catch (err) {
        if (err.code === 'VALIDATION_ERROR' || err.code === 'CONFLICT') {
            res.status(err.status || 400);
            return render_partial(req, res, 'dashboard/partials/user_create_modal', {
                error: err.message,
                details: err.details || [],
                form: req.body || {},
            });
        }
        throw err;
    }
}

async function users_delete(req, res) {
    await user_model.soft_delete(req.params.id);
    trigger_toast(res, 'success', 'User deactivated.');
    /*
     * Append users:created to whatever trigger_toast already set, so the table
     * refetches and the deactivated row updates its badge and kebab actions (or
     * disappears when the include-inactive toggle is off).
     */
    const prev = res.get('HX-Trigger');
    res.set(
        'HX-Trigger',
        prev
            ? JSON.stringify({ ...JSON.parse(prev), 'users:created': { id: req.params.id } })
            : JSON.stringify({ 'users:created': { id: req.params.id } })
    );
    res.set('Content-Type', 'text/html').send('');
}

/*
 * Edit modal — renders into #modal-content. dashboard.js auto-opens the modal
 * mount when content lands there.
 */
async function users_edit_modal(req, res) {
    const user = await user_model.get(req.params.id);
    render_partial(req, res, 'dashboard/partials/user_edit_modal', {
        user,
        form: user, // initial form state is the current values
        error: null,
        details: [],
    });
}

/*
 * Update name, email, and role. du_id is not updatable here; PUT
 * /repo/users/:id still allows it for admin tooling.
 */
async function users_update(req, res) {
    const body = req.body || {};
    const patch = {
        first_name: body.first_name,
        last_name: body.last_name,
        email: body.email,
        // Validated against ROLE_NAMES; undefined keeps the current role.
        role: body.role,
    };
    try {
        const updated = await user_model.update(req.params.id, patch);
        res.set(
            'HX-Trigger',
            JSON.stringify({
                toast: { level: 'success', message: `User ${updated.du_id} updated.` },
                'users:created': { id: updated.id },
                'modal:close': {},
            })
        );
        res.set('Content-Type', 'text/html').send('');
    } catch (err) {
        if (err.code === 'VALIDATION_ERROR' || err.code === 'NOT_FOUND') {
            res.status(err.status || 400);
            return render_partial(req, res, 'dashboard/partials/user_edit_modal', {
                user: { id: req.params.id, ...body },
                form: body,
                error: err.message,
                details: err.details || [],
            });
        }
        throw err;
    }
}

// Reactivate a previously soft-deleted user. Inverse of users_delete.
async function users_activate(req, res) {
    const updated = await user_model.activate(req.params.id);
    res.set(
        'HX-Trigger',
        JSON.stringify({
            toast: { level: 'success', message: `User ${updated.du_id} activated.` },
            'users:created': { id: updated.id },
        })
    );
    res.set('Content-Type', 'text/html').send('');
}

module.exports = {
    login_page,
    login_submit,
    logout,
    home_page,
    home_top_collections_partial,
    home_recent_ingests_partial,
    stats_page,
    stats_duracloud_partial,
    collections_page,
    collections_list_partial,
    collection_detail_page,
    collection_new_page,
    collection_create,
    collection_add_objects_page,
    collection_add_objects_list,
    collection_add_members,
    collection_delete,
    collection_move_form,
    collection_move,
    objects_page,
    objects_table_partial,
    objects_publish,
    objects_suppress,
    objects_delete,
    objects_delete_confirm,
    objects_bulk_publish,
    objects_bulk_suppress,
    objects_bulk_delete,
    objects_bulk_delete_confirm,
    collection_bulk_publish,
    collection_bulk_suppress,
    object_metadata_modal,
    object_thumbnail_form,
    object_thumbnail_upload,
    object_thumbnail_invalidate,
    object_thumbnail_raw,
    users_page,
    users_table_partial,
    users_create,
    users_create_modal,
    users_delete,
    users_edit_modal,
    users_update,
    users_activate,
};
