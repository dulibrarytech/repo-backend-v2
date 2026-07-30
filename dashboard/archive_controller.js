'use strict';

/*
 * Admin: Batch Backups (Wasabi) browser — read-only browse + per-file
 * download over the Wasabi batch archive (the retired 003-ingested
 * folders' replacement; design in repo/WASABI_ARCHIVE_BROWSER_PLAN.md).
 *
 * Routes mounted at /dashboard/admin/archive/* (see dashboard/routes.js;
 * all gated on manage_ingest):
 *
 *   GET /dashboard/admin/archive            full page (collections level)
 *   GET /dashboard/admin/archive/list       HTMX partial — one level:
 *         (no params)                       → collections
 *         ?collection=<c>                   → packages in <c>
 *         ?collection=<c>&package=<p>       → files in <c>/<p>
 *         &token=<t>                        → next page ("Load more")
 *         &q=<text>                         → server-side name filter of
 *                                             the fetched page
 *   GET /dashboard/admin/archive/download?key=<c>/<p>/<file>
 *         302 → presigned Wasabi URL (bytes go browser←Wasabi direct;
 *         no JWT ever appears in a URL — the redirect target is
 *         Wasabi-signed and time-boxed)
 *
 * Shape mirrors aip_controller (list + presigned 302) and the
 * aip_backfill admin surface (page shell under active:'admin' so the
 * sidebar enters Admin Utils focus mode). Every handler is a thin
 * shell over ingester/libs/archive_client; ValidationError bubbles to
 * the central handler.
 *
 * READ-ONLY: no handler here (nor any endpoint it calls) can mutate
 * the archive.
 */

const app_config = require('../config/app');
const archive_client_default = require('../ingester/libs/archive_client');
const { ValidationError } = require('../libs/errors');

function render_page(req, res, view, locals = {}) {
    const cfg = app_config();
    const base_locals = {
        title: locals.title || 'Batch Backups — Repo Dashboard',
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

/*
 * Level params arrive as user input; they become URL path segments in
 * the curation call and (for download) S3 key segments. The curation
 * service enforces its own validation — this is the belt half of
 * belt-and-braces, and it produces friendlier 400s.
 */
function _clean_segment(value, field) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 255) {
        throw new ValidationError(`invalid ${field}`);
    }
    if (
        value === '.' ||
        value === '..' ||
        value.includes('/') ||
        value.includes('\\') ||
        [...value].some((c) => c.charCodeAt(0) < 0x20)
    ) {
        throw new ValidationError(`invalid ${field}`);
    }
    return value;
}

async function archive_page(req, res) {
    render_page(req, res, 'dashboard/admin/archive', {
        page: 'archive',
        active: 'admin',
        title: 'Batch Backups — Repo Dashboard',
    });
}

/*
 * One drill-down level as an HTMX partial. The same partial template
 * renders all three levels — folder rows (collections/packages) link
 * deeper via hx-get; file rows get a download link.
 */
async function archive_list_partial(req, res, deps = {}) {
    const client = deps.archive_client || archive_client_default;
    const collection = _clean_segment(req.query.collection, 'collection');
    const pkg = _clean_segment(req.query.package, 'package');
    const token = typeof req.query.token === 'string' && req.query.token ? req.query.token : null;
    const q = (req.query.q || '').trim().toLowerCase();

    const level = pkg ? 'files' : collection ? 'packages' : 'collections';
    const locals = {
        level,
        collection,
        package_name: pkg,
        folders: [],
        files: [],
        next_token: null,
        q: req.query.q || '',
        error: null,
    };

    if (pkg && !collection) {
        throw new ValidationError('package requires collection');
    }
    if (!client.is_configured()) {
        locals.error = 'Curation API is not configured';
        return render_partial(req, res, 'dashboard/partials/archive_table', locals);
    }

    try {
        if (level === 'collections') {
            const r = await client.list_collections();
            if (r.status !== 200 || !r.data || !r.data.result) {
                locals.error = _upstream_error(r);
            } else {
                locals.folders = r.data.result.collections || [];
            }
        } else if (level === 'packages') {
            /*
             * Package level searches SERVER-SIDE (2026-07-30): q goes
             * to the curation API as an S3 prefix match (case
             * SENSITIVE — send the raw text, not the lowercased local
             * filter form), so a package pages deep in a
             * thousands-of-packages migrated collection is findable
             * by typing the start of its id.
             */
            const q_raw = (req.query.q || '').trim();
            const r = await client.list_packages(collection, {
                token,
                q: q_raw || undefined,
            });
            if (r.status !== 200 || !r.data || !r.data.result) {
                locals.error = _upstream_error(r);
            } else {
                locals.folders = r.data.result.packages || [];
                locals.next_token = r.data.result.next_token || null;
            }
        } else {
            const r = await client.list_files(collection, pkg, { token });
            if (r.status !== 200 || !r.data || !r.data.result) {
                locals.error = _upstream_error(r);
            } else {
                locals.files = r.data.result.files || [];
                locals.folders = (r.data.result.folders || []).map((name) => `${name}/`);
                locals.next_token = r.data.result.next_token || null;
            }
        }
    } catch (err) {
        locals.error = err.message;
    }

    /*
     * Name filter of the fetched page — collections and files levels
     * only. The packages level already searched server-side above
     * (S3 prefix match); re-filtering it locally would be a no-op at
     * best and a case-sensitivity fight at worst.
     */
    if (q && level !== 'packages') {
        locals.folders = locals.folders.filter((n) => n.toLowerCase().includes(q));
        locals.files = locals.files.filter((f) => (f.name || '').toLowerCase().includes(q));
    }

    render_partial(req, res, 'dashboard/partials/archive_table', locals);
}

function _upstream_error(r) {
    const detail =
        r.data && Array.isArray(r.data.errors) && r.data.errors.length > 0
            ? r.data.errors[0]
            : `HTTP ${r.status}`;
    return `Could not list the archive: ${detail}`;
}

/*
 * 302 to a presigned Wasabi URL for one file. Mirrors aip_download —
 * the bytes never transit this app.
 *
 * The key arrives as a WILDCARD PATH (`/download/*key`), not a query
 * param: the global query sanitizer (libs/sanitize.js) HTML-entity-
 * encodes `/` in query values, which would mangle any object key.
 * Express 5's named wildcard hands us the decoded segments as an
 * array; joining restores the S3 key.
 */
async function archive_download(req, res, deps = {}) {
    const client = deps.archive_client || archive_client_default;
    const raw = req.params.key;
    const key = Array.isArray(raw) ? raw.join('/') : raw;
    if (!key || typeof key !== 'string' || key.length > 1024) {
        throw new ValidationError('key is required');
    }
    /*
     * Sanity checks only (curation enforces the full per-segment
     * rules): relative multi-segment path, no traversal.
     */
    if (
        key.startsWith('/') ||
        key.endsWith('/') ||
        key.includes('\\') ||
        key.split('/').length < 2 ||
        key.split('/').some((s) => s === '' || s === '.' || s === '..')
    ) {
        throw new ValidationError('invalid key');
    }

    if (!client.is_configured()) {
        throw new ValidationError('Curation API not configured — cannot mint download URLs');
    }

    const presign = await client.download_url(key);
    if (presign.status !== 200 || !presign.data || presign.data.ok !== true) {
        const reason =
            (presign.data && presign.data.error) ||
            `download-url returned HTTP ${presign.status}`;
        throw new ValidationError(`Could not mint download URL: ${reason}`);
    }

    res.redirect(302, presign.data.url);
}

module.exports = {
    archive_page,
    archive_list_partial,
    archive_download,
};
