'use strict';

// Dashboard controllers. All async. Each handler either:
//   - renders a full page (returns layout.ejs wrapping a body view), or
//   - renders a partial (just the inner HTML — HTMX swaps it in).
//
// The two-render pattern keeps the code tight: render the inner view
// to string with `app.render`, then render layout.ejs passing that
// string as `body`.

const validator = require('validator');

const app_config = require('../config/app');
const auth_model = require('../auth/model');
const user_model = require('../users/model');
const repo_model = require('../repository/model');
const search_model = require('../search/model');
const stats_model = require('../stats/model');
const collections_model = require('../collections/model');
const projection = require('../libs/object_projection');
const jwt = require('../libs/jwt');
const thumbnails = require('./thumbnails');
const duracloud = require('../libs/duracloud');
const tn_service = require('../libs/tn_service');
const path = require('node:path');
const fs = require('node:fs');
const { UnauthorizedError, ValidationError } = require('../libs/errors');

// Decode a `next=` value that the sanitize middleware has already
// HTML-entity-encoded (slashes → `&#x2F;` etc.), then verify it's a safe
// same-origin path — must start with `/` but NOT `//` (which would be a
// protocol-relative redirect to another host).
function safe_next(raw, fallback) {
    if (typeof raw !== 'string' || raw.length === 0) return fallback;
    const decoded = validator.unescape(raw.trim());
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return fallback;
    if (decoded.includes('\n') || decoded.includes('\r')) return fallback;
    return decoded;
}

// ----------------------------------------------------------------------------
// Internal: render a body view and wrap it in layout.ejs.
// ----------------------------------------------------------------------------
function render_page(req, res, view, locals = {}) {
    const cfg = app_config();
    const base_locals = {
        title: locals.title || 'Repository @ DU',
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

// Coerce a query-string value to a string. Express's qs parser
// produces a string for a single occurrence, an array of strings
// for repeated keys (?q=a&q=b → ['a','b']), and undefined when
// absent. We pick the last value on array (matches the common
// "last wins" convention) and fall back to '' on undefined/null.
// Mirrors dashboard/aip_controller.js:_str — kept identical so a
// future refactor can lift the pair to libs/.
function _last_string(v) {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return _last_string(v[v.length - 1]);
    return String(v);
}

// ----------------------------------------------------------------------------
// LOGIN
// ----------------------------------------------------------------------------
async function login_page(req, res) {
    const cfg = app_config();
    // Login uses its own standalone shell — no sidebar/header from
    // layout.ejs. Render directly.
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
    // When SSO_LOGOUT_URL is configured, redirect to the IdP's central
    // signout so the user is logged out everywhere, not just here.
    // Otherwise fall back to our local login page.
    const target = cfg.sso.logout_url || `${cfg.path}/dashboard/login`;
    return res.redirect(303, target);
}

// ----------------------------------------------------------------------------
// HOME
// ----------------------------------------------------------------------------
async function home_page(req, res) {
    const user = await auth_model.find_by_id(req.user.sub);
    if (!user || user.is_active !== 1) {
        // Token still valid but user was deactivated. Bounce.
        jwt.clear_cookie(res);
        throw new UnauthorizedError('User no longer active');
    }
    // Top-line counts. The richer breakdowns (top collections, recent
    // ingests) load via HTMX after the page paints — keeps initial
    // render snappy against a 23k-row DB.
    const [counts, active_users] = await Promise.all([
        stats_model.summary(),
        stats_model.active_users(),
    ]);
    render_page(req, res, 'dashboard/home', {
        page: 'home',
        active: 'home',
        title: 'Home — Repo Dashboard',
        user,
        stats: { ...counts, active_users },
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

// ----------------------------------------------------------------------------
// STATS — dedicated /dashboard/stats page (v1 dashboard parity).
//
// 12-card grid + ingests-per-year bar chart. The DB-derived cards
// and the chart render server-side at page load. The 3 DuraCloud
// usage cards lazy-load via HTMX after paint, because each one is
// a 1-3s round-trip to AM's storage API — gating the whole page
// on that would be bad UX.
// ----------------------------------------------------------------------------
const stats_duracloud = require('../stats/duracloud');
const { format_bytes, format_count } = require('../libs/format');

async function stats_page(req, res) {
    const [summary, per_year] = await Promise.all([
        stats_model.extended_summary(),
        stats_model.ingests_per_year({ min_year: 2020 }),
    ]);
    render_page(req, res, 'dashboard/stats', {
        page: 'stats',
        active: 'stats',
        title: 'Stats — Repository @ DU',
        summary,
        per_year,
        // Pass formatters as locals so the EJS templates don't need
        // to require modules themselves.
        fmt_count: format_count,
        fmt_bytes: format_bytes,
    });
}

async function stats_duracloud_partial(req, res) {
    const usage = await stats_duracloud.usage();
    render_partial(req, res, 'dashboard/partials/stats_duracloud', {
        usage,
        fmt_bytes: format_bytes,
    });
}

// ----------------------------------------------------------------------------
// COLLECTIONS — list + detail
// ----------------------------------------------------------------------------
async function collections_page(req, res) {
    render_page(req, res, 'dashboard/collections', {
        page: 'collections',
        active: 'collections',
        title: 'Collections — Repository @ DU',
        filters: {
            q: req.query.q || '',
            // Default the staff collections view to title A–Z (the initial
            // /collections/list load below carries no sort param, so the
            // partial defaults to 'title' too). The API/model default stays
            // 'count'; this is a dashboard-only default.
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
    render_page(req, res, 'dashboard/collection_detail', {
        page: 'collection_detail',
        active: 'collections',
        title: `${collection.title || collection.pid} — Repository @ DU`,
        collection,
        filters: {
            q: req.query.q || '',
            is_published: req.query.is_published || '',
        },
    });
}

// ----------------------------------------------------------------------------
// OBJECTS
// ----------------------------------------------------------------------------
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
    // Defensive coercion: Express parses repeated query keys as an
    // array (e.g. ?q=&q=foo → ['', 'foo']). The objects-table view
    // tries hard not to send duplicates (pagination URL strips
    // filters and lets hx-include carry them — see partials/objects_
    // table.ejs pagination comment), but a hand-crafted URL or a
    // misbehaving extension could still send one. Last-wins matches
    // what callers usually mean by a duplicated key. Same pattern
    // already in place in dashboard/aip_controller.js.
    const q_raw = _last_string(req.query.q);
    const is_published_raw = _last_string(req.query.is_published);
    const collection_raw = _last_string(req.query.collection);
    const is_active_raw = _last_string(req.query.is_active);
    const object_type_raw = _last_string(req.query.object_type);

    const q = q_raw.trim();
    // Default behavior: hide soft-deleted rows. Staff who need to
    // audit deleted objects can opt in explicitly via the URL param
    // (`?is_active=0`) — there's no UI filter for it since the
    // common workflow doesn't need one. This replaces an earlier
    // narrower fix that only hid soft-deleted rows under the
    // "Unpublished" filter; the universal default is the cleaner
    // behavior because conflating "not yet published" with
    // "removed" rarely makes sense in any view.
    //
    // is_active_raw='1' → show only active   (explicit)
    // is_active_raw='0' → show only deleted  (explicit opt-in for audit)
    // is_active_raw=''  → default to active  (was: undefined → show all)
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
        // is_active follows the is_published pattern. The collection
        // detail page passes ?is_active=1 to hide soft-deleted members.
        // The flat Objects page leaves it undefined ("show everything")
        // EXCEPT when the user picks "Unpublished" — see above.
        is_active: is_active_filter,
    };

    // When `q` is set, route through the search model (LIKE across
    // indexed columns). Otherwise the plain repository.list — cheap
    // index scan, no text match.
    const result = q ? await search_model.search({ ...common, q }) : await repo_model.list(common);

    // Enrich each row with title (parsed from display_record) and drop
    // the raw display_record blob from the projection. Keeps the table
    // rich without shipping ~3KB JSON per row to the browser.
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
    // delete_reason flows through from the confirmation modal's
    // textarea. Required — model throws ValidationError if missing.
    const delete_reason = req.body && req.body.delete_reason;
    // Audit actor: "First Last (du_id)" so the AM admin can identify who
    // initiated the delete by name, with the du_id as the unambiguous key.
    const actor = await user_model.actor_label(req.user);
    const result = await repo_model.soft_delete(req.params.pid, {
        delete_reason,
        actor,
    });
    // Combine three HTMX signals into one header:
    //   modal:close  — dashboard.js dismisses the confirmation modal
    //   toast        — surfaces success or AM-failure warning
    //   objects:refresh — table re-fetches so the deleted row drops
    //                     even if the modal swapped the wrong target
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
    // Return empty HTML so hx-target=#object-<pid> + hx-swap=outerHTML
    // removes the row visually if the page is listening to that target.
    res.set('Content-Type', 'text/html').send('');
}

// Confirmation modal for a single object delete. Renders the modal
// body with the object's title + a required reason textarea. The
// modal's form POSTs back to /objects/:pid (DELETE method via
// hx-delete) with the reason in the body.
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

// ----------------------------------------------------------------------------
// BULK ACTIONS
//
// All three multi-select endpoints share the same input contract:
//   - body.pids may be a comma-separated string (HTMX form submit) OR
//     a JSON array. Both forms get normalized to an array of strings
//     before the model call.
//   - body.target_url (optional) — when set, after the bulk action
//     completes we re-fetch THAT URL via HX-Trigger so the table refreshes
//     in place. We don't render a list partial here because the caller
//     could be on the Objects page OR the collection detail page, and the
//     query params (filters, page, page_size) live on the client.
// ----------------------------------------------------------------------------
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
    // Audit actor: "First Last (du_id)" — same label the single-delete and
    // API paths stamp, so the AM admin sees a consistent "Deleted by ...".
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
        // delete_reason required — model throws ValidationError if
        // missing. Same reason text applies to every pid in the batch.
        const delete_reason = req.body && req.body.delete_reason;
        result = await repo_model.bulk_soft_delete(pids, { delete_reason, actor });
        verb = 'deleted';
    } else {
        throw new ValidationError(`Unknown bulk action: ${kind}`);
    }

    // Compose the toast. If any per-row AM call failed during a
    // bulk delete, downgrade success → warning so staff knows to
    // chase AM in the Storage Service UI.
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

    // HX-Trigger combines: toast + a custom event the listing region
    // listens for (`objects:refresh`) to re-fetch the current view +
    // a `modal:close` so the confirmation modal dismisses after a
    // bulk submit. The Objects page wires
    // `hx-trigger="load, objects:refresh from:body"` on #objects-table;
    // the collection detail page does the same.
    //
    // modal:close is harmless when no modal is open (publish/suppress
    // come from row buttons, not a modal) — the dashboard.js handler
    // no-ops when it can't find an open modal instance.
    res.set(
        'HX-Trigger',
        JSON.stringify({
            'modal:close': {},
            toast: { level, message },
            'objects:refresh': { affected: result.affected, kind },
        })
    );
    // Return 204 — the toast + refresh trigger does the visible work.
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

// Delete confirmation modal — server renders the modal body listing
// the selected objects' titles so the user sees what they're about to
// nuke. The modal's submit button POSTs back to objects_bulk_delete.
async function objects_bulk_delete_confirm(req, res) {
    const pids = parse_pid_list(req.body && req.body.pids);
    if (pids.length === 0) {
        throw new ValidationError('Select at least one object');
    }
    // Fetch titles for the modal. Cheap — bounded at MAX_BULK_PIDS.
    // We deliberately tolerate misses (pid not found / soft-deleted
    // already) so the modal still renders if the list goes stale.
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

// Scope-based collection actions: publish or suppress every active
// non-collection member of a collection in one UPDATE. Triggered by
// header buttons on the collection-detail page.
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

// Metadata modal — renders the inner ASpace record from display_record.
//
// The `display_record` longtext column actually nests two layers: an
// outer envelope with denormalized lookup fields (pid, handle,
// thumbnail, is_member_of_collection, abstract, etc.) plus a key called
// `display_record` whose value is the real ASpace archival_object /
// resource record (title, uri, identifiers, dates, extents, subjects,
// notes, names, parts, etc.).
//
// Staff only care about the ASpace record. The wrapper fields are
// already visible elsewhere on the row, so we drill into the nested
// `display_record` and render its contents at the modal's top level.
// If the row doesn't have a nested record (legacy/incomplete data), we
// fall back to the outer envelope so the modal isn't empty.
async function object_metadata_modal(req, res) {
    const row = await repo_model.get(req.params.pid);
    const enriched = projection.enrich(row);
    const outer = projection.parse_display_record(row.display_record);
    const nested = outer && typeof outer.display_record === 'object' ? outer.display_record : null;
    const data = nested && Object.keys(nested).length > 0 ? nested : outer;
    render_partial(req, res, 'dashboard/partials/object_metadata_modal', {
        obj: enriched,
        display_record: data,
    });
}

// ----------------------------------------------------------------------------
// THUMBNAIL UPLOAD
//
// Two endpoints work together:
//
//   GET  /objects/:pid/thumbnail/form  → renders the upload modal
//        (lazy-loaded by the kebab menu so we don't ship the form HTML
//         on every row of the list)
//   POST /objects/:pid/thumbnail       → multer-backed upload + DB sync
//
// The POST handler is special-cased in routes.js because it needs
// multer middleware BEFORE the global sanitizer touches req.body (the
// sanitizer's a no-op on multipart since multer sets a fresh req.body
// of text fields only, but we want to avoid the dependency anyway).
// ----------------------------------------------------------------------------
async function object_thumbnail_form(req, res) {
    const row = await repo_model.get(req.params.pid);
    const enriched = projection.enrich(row);
    render_partial(req, res, 'dashboard/partials/thumbnail_upload_modal', {
        obj: enriched,
    });
}

// Invalidate the TN service's disk-cached thumbnail for a single
// object. The next request that flows through object_thumbnail_raw
// (either from the listing or an admin re-render) misses the cache
// and re-fetches from the TN service.
//
// We don't touch the browser's HTTP cache here — that's governed by
// the Cache-Control: private, max-age=3600 we set on proxy responses.
// Staff who need the new thumbnail immediately can hard-refresh.
// Within an hour, normal browser cache expiration will pick it up.
async function object_thumbnail_invalidate(req, res) {
    const pid = req.params.pid;
    // Ensure the row exists before we touch the filesystem — gives
    // a clean 404 for typos, and avoids logging cache events for
    // non-objects.
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

    // Pick the right partial to re-render based on object_type. The
    // collection_row expects member_count + published_count which we
    // lose going through repo_model — for the immediate post-upload
    // swap that's fine (the next reload of the collections page will
    // re-compute them); the row's `(0 pub)` fallback covers the gap.
    const is_collection = enriched.object_type === 'collection';
    const partial = is_collection
        ? 'dashboard/partials/collection_row'
        : 'dashboard/partials/object_row';

    // Two HX-Trigger events in one header: a toast for feedback AND a
    // close-modal event so dashboard.js can dismiss the upload form
    // once the row has swapped. Keeping them in a single header avoids
    // ordering surprises — both fire on the same htmx event tick.
    res.set(
        'HX-Trigger',
        JSON.stringify({
            toast: { level: 'success', message: 'Thumbnail updated.' },
            'modal:close': {},
        })
    );
    // The upload form posts with hx-target=#<row-id>, so htmx already
    // replaces the row outerHTML on its own. No HX-Retarget needed.
    render_partial(req, res, partial, { item: enriched });
}

// ----------------------------------------------------------------------------
// THUMBNAIL PROXY (DuraCloud-backed rows)
//
// Most pre-existing rows store their thumbnail as a dip-store-relative
// path under DuraCloud (the ingest service writes
// `<dip_path>/thumbnails/<uuid>.jpg`), NOT a fetchable URL. Browsers
// can't load those directly. This handler:
//
// Resolution order, top to bottom:
//
//   1. Uploaded thumbnail (absolute http(s) URL in tbl_objects.thumbnail
//      — written by the upload modal or a future CDN). 302-redirect to
//      it; the static file server handles caching from there.
//   2. TN service. If TN_SERVICE + TN_SERVICE_API_KEY are configured,
//      fetch by the row's PID. Disk-cached on success so repeated
//      requests don't re-hit the TN service. This is the preferred
//      path: TN service generates fresh thumbnails from source files,
//      giving more consistent quality than DuraCloud's archived ones.
//   3. DuraCloud fallback. If TN fails (or wasn't configured) and the
//      stored thumbnail value looks like a dip-store path, stream
//      through libs/duracloud. Kept around so legacy rows with DC
//      paths still work during migration.
//   4. Local SVG placeholder. Returned as 200 (not 404) so the row's
//      <img> tag never falls into the browser's broken-image state.
//
// Cache-Control: private, max-age=3600 — browser caches per session
// only. Don't make this `public`: backing content includes restricted items.
// ----------------------------------------------------------------------------
const THUMBNAIL_PLACEHOLDER = path.join(
    __dirname,
    '..',
    'public',
    'images',
    'thumbnail-missing.svg'
);

function send_thumbnail_placeholder(res) {
    // 200 + the placeholder so the <img> renders something; if we sent
    // 404 the browser would show its own broken-image icon, defeating
    // the whole point.
    res.status(200);
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'private, max-age=60');
    fs.createReadStream(THUMBNAIL_PLACEHOLDER).pipe(res);
}

async function object_thumbnail_raw(req, res) {
    const pid = req.params.pid;
    let row;
    try {
        row = await repo_model.get(pid);
    } catch {
        // Unknown pid → placeholder, not 404. The row may have been
        // soft-deleted while a list was on screen; we'd rather show
        // a blank tile than break the layout.
        return send_thumbnail_placeholder(res);
    }

    const enriched = projection.enrich(row);
    // IMPORTANT: read thumbnail_raw, NOT thumbnail. The `thumbnail`
    // field is the synthesized proxy URL (`/repo/dashboard/objects/
    // <pid>/thumbnail/raw`) for non-http stored values — useful for
    // EJS rendering, useless here (we ARE that proxy). The raw value
    // is what we need to decide between uploaded / TN / DC.
    const stored = enriched.thumbnail_raw;

    // Case 1: stored value is already an absolute URL (uploaded
    // thumbnail or CDN). Redirect rather than proxy.
    if (stored && /^https?:\/\//i.test(stored)) {
        res.set('Cache-Control', 'private, max-age=3600');
        return res.redirect(302, stored);
    }

    // Case 2: TN service. Always tried by PID (the stored value
    // doesn't matter — TN looks up by the object's identifier). If
    // it's not configured we fall through; if it IS configured but
    // this row's thumbnail isn't available there, the fetch throws
    // and we fall through to DC.
    if (tn_service.is_configured()) {
        try {
            const buffer = await tn_service.get_thumbnail(pid);
            res.status(200);
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'private, max-age=3600');
            return res.end(buffer);
        } catch {
            // TN service had nothing (404), errored, or timed out.
            // Continue to the DC fallback. Logging happens inside
            // libs/tn_service so we don't double up here.
        }
    }

    // Case 3: DuraCloud fallback. Only meaningful if the stored
    // value looks like a dip-store path (not empty, not an http URL).
    // The TN-first path above already absorbed the most common case
    // of "row has no usable thumbnail anywhere"; this branch is now
    // strictly for legacy DC-backed rows.
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

// ----------------------------------------------------------------------------
// USERS
// ----------------------------------------------------------------------------
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
        // Empty response body — the modal dismisses via the
        // modal:close trigger and the table re-fetches via
        // users:created. Same pattern as users_update.
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
    // Trigger a table refresh so the deactivated row updates its
    // status badge + kebab actions (or disappears if the toggle is
    // off). Simpler than swapping a single row partial back from
    // here, and uses the same `users:created` event the create flow
    // already wires up.
    const prev = res.get('HX-Trigger');
    res.set(
        'HX-Trigger',
        prev
            ? JSON.stringify({ ...JSON.parse(prev), 'users:created': { id: req.params.id } })
            : JSON.stringify({ 'users:created': { id: req.params.id } })
    );
    res.set('Content-Type', 'text/html').send('');
}

// Edit modal — renders the dashboard/partials/user_edit_modal partial
// targeting #modal-content. dashboard.js auto-opens the modal mount
// when content lands there.
async function users_edit_modal(req, res) {
    const user = await user_model.get(req.params.id);
    render_partial(req, res, 'dashboard/partials/user_edit_modal', {
        user,
        form: user, // initial form state is the current values
        error: null,
        details: [],
    });
}

// Update name + email. We deliberately do NOT let the dashboard
// route touch du_id (that's the user's stable identifier — changing
// it would orphan job-history rows, audit logs, etc.). The REST API
// at PUT /repo/users/:id still allows it for admin tooling.
async function users_update(req, res) {
    const body = req.body || {};
    const patch = {
        first_name: body.first_name,
        last_name: body.last_name,
        email: body.email,
        // RBAC role (validated against ROLE_NAMES in the model). Omitted
        // values fall through normalize() so an absent select keeps the
        // current role rather than nulling it.
        role: body.role,
    };
    try {
        const updated = await user_model.update(req.params.id, patch);
        res.set(
            'HX-Trigger',
            JSON.stringify({
                toast: { level: 'success', message: `User ${updated.du_id} updated.` },
                // Same event the create + delete flows fire so the
                // table refreshes itself.
                'users:created': { id: updated.id },
                // Close the open modal — dashboard.js section 5.
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
