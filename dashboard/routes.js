'use strict';

const app_config = require('../config/app');
const { require_dashboard_auth, redirect_if_authenticated } = require('./middleware');
const { require_permission, PERMISSIONS } = require('../auth/rbac');
const { login_limiter, write_limiter } = require('../auth/rate_limit');
const controller = require('./controller');
const aip_controller = require('./aip_controller');
const aip_backfill_controller = require('./aip_backfill_controller');
const handles_controller = require('./handles_controller');
const archive_controller = require('./archive_controller');
const thumbnails = require('./thumbnails');
const errors = require('../libs/errors');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/dashboard`;

    /*
     * RBAC capability gates for the staff dashboard. Reads (object/collection
     * pages + thumbnail proxy) stay open to any authenticated user
     * (view_repository); these gate the curation WRITES + their modals.
     */
    const can_publish = require_permission(PERMISSIONS.PUBLISH_OBJECT);
    const can_edit = require_permission(PERMISSIONS.EDIT_OBJECT);
    const can_delete = require_permission(PERMISSIONS.DELETE_OBJECT);
    const can_ingest = require_permission(PERMISSIONS.MANAGE_INGEST);

    // Public: login.
    app.get(`${base}/login`, redirect_if_authenticated, controller.login_page);
    app.post(`${base}/login`, login_limiter(), controller.login_submit);

    /*
     * Logout is best-effort and always clears the cookie, regardless of
     * current auth state. require_dashboard_auth-with-fallback would be
     * overkill — we just attempt to read the user if a cookie exists.
     */
    app.post(`${base}/logout`, require_dashboard_auth, controller.logout);

    // Protected pages.
    app.get(`${base}/`, require_dashboard_auth, controller.home_page);
    app.get(base, require_dashboard_auth, controller.home_page);
    app.get(
        `${base}/_home/top-collections`,
        require_dashboard_auth,
        controller.home_top_collections_partial
    );
    app.get(
        `${base}/_home/recent-ingests`,
        require_dashboard_auth,
        controller.home_recent_ingests_partial
    );

    /*
     * Stats — dedicated v1-style dashboard. 12-card grid + chart on
     * page load; DuraCloud usage cards lazy-load via HTMX after paint
     * because each one is a slow round-trip to AM's storage API.
     */
    app.get(`${base}/stats`, require_dashboard_auth, controller.stats_page);
    app.get(
        `${base}/_stats/duracloud`,
        require_dashboard_auth,
        controller.stats_duracloud_partial
    );

    /*
     * Collections — order matters: /collections/list and /collections/new
     * must be registered BEFORE the :pid wildcard so Express matches the
     * literal paths first.
     */
    app.get(`${base}/collections`, require_dashboard_auth, controller.collections_page);
    app.get(
        `${base}/collections/list`,
        require_dashboard_auth,
        controller.collections_list_partial
    );
    /*
     * Create a collection (top-level or sub) bound to an ASpace resource URI.
     * Gated on edit_object (staff + admin). The form GET is gated too so a
     * viewer can't load it.
     */
    app.get(`${base}/collections/new`, require_dashboard_auth, can_edit, controller.collection_new_page);
    app.post(
        `${base}/collections`,
        require_dashboard_auth,
        can_edit,
        write_limiter(),
        controller.collection_create
    );
    app.get(`${base}/collections/:pid`, require_dashboard_auth, controller.collection_detail_page);
    /*
     * Move existing objects into a collection (single-membership reassign).
     * The picker page + the POST are both gated on edit_object. 3-segment
     * paths, so they don't collide with the :pid detail route above.
     */
    app.get(
        `${base}/collections/:pid/add-objects`,
        require_dashboard_auth,
        can_edit,
        controller.collection_add_objects_page
    );
    // Live-search results partial for the picker (HTMX-loaded, paginated).
    app.get(
        `${base}/collections/:pid/add-objects/list`,
        require_dashboard_auth,
        can_edit,
        controller.collection_add_objects_list
    );
    app.post(
        `${base}/collections/:pid/members`,
        require_dashboard_auth,
        can_edit,
        write_limiter(),
        controller.collection_add_members
    );
    /*
     * Soft-delete an EMPTY sub-collection. Gated on delete_object (staff +
     * admin); the model returns 409 if the collection still has children.
     */
    app.post(
        `${base}/collections/:pid/delete`,
        require_dashboard_auth,
        can_delete,
        write_limiter(),
        controller.collection_delete
    );
    /*
     * Re-parent a collection (nest under another collection or move to top level).
     * Gated on edit_object; the model enforces the cycle guard.
     */
    app.get(
        `${base}/collections/:pid/move/form`,
        require_dashboard_auth,
        can_edit,
        controller.collection_move_form
    );
    app.post(
        `${base}/collections/:pid/move`,
        require_dashboard_auth,
        can_edit,
        write_limiter(),
        controller.collection_move
    );

    app.get(`${base}/objects`, require_dashboard_auth, controller.objects_page);
    app.get(`${base}/objects/list`, require_dashboard_auth, controller.objects_table_partial);

    /*
     * Bulk multi-select actions — REGISTERED BEFORE the `:pid` routes
     * so Express's path matcher doesn't mistake `/objects/bulk/publish`
     * for `/objects/:pid/publish` with pid="bulk". (Same hazard the
     * `/collections/list` ordering comment above guards against.) All
     * capped at 100 pids per request by the model. /confirm renders
     * the destructive-confirmation modal; the actual delete only fires
     * from /delete after the user confirms.
     */
    app.post(
        `${base}/objects/bulk/publish`,
        require_dashboard_auth,
        can_publish,
        write_limiter(),
        controller.objects_bulk_publish
    );
    app.post(
        `${base}/objects/bulk/suppress`,
        require_dashboard_auth,
        can_publish,
        write_limiter(),
        controller.objects_bulk_suppress
    );
    app.post(
        `${base}/objects/bulk/delete/confirm`,
        require_dashboard_auth,
        can_delete,
        controller.objects_bulk_delete_confirm
    );
    app.post(
        `${base}/objects/bulk/delete`,
        require_dashboard_auth,
        can_delete,
        write_limiter(),
        controller.objects_bulk_delete
    );

    app.get(
        `${base}/objects/:pid/metadata`,
        require_dashboard_auth,
        can_edit,
        controller.object_metadata_modal
    );
    /*
     * Thumbnail form (renders modal body) + upload (multer-backed).
     * The upload route is the only one in the app that needs multer, so
     * we create the middleware lazily here rather than wiring it into
     * the global Express factory — keeps the dependency narrowly scoped.
     */
    app.get(
        `${base}/objects/:pid/thumbnail/form`,
        require_dashboard_auth,
        can_edit,
        controller.object_thumbnail_form
    );
    /*
     * DuraCloud-backed thumbnail proxy. Auth-gated like the rest of
     * the dashboard — staff only — because DC content includes
     * restricted/unpublished items. Returns the bytes (or a local
     * placeholder SVG on any failure) so the row's <img> never breaks.
     */
    app.get(
        `${base}/objects/:pid/thumbnail/raw`,
        require_dashboard_auth,
        controller.object_thumbnail_raw
    );
    app.post(
        `${base}/objects/:pid/thumbnail`,
        require_dashboard_auth,
        can_edit,
        write_limiter(),
        /*
         * Multer error handler: translates its MulterError codes into
         * our HTTP error shape so the global error handler renders the
         * right status. Without this the raw multer error would surface
         * as a 500.
         */
        (req, res, next) => {
            thumbnails.make_upload_middleware()(req, res, (err) => {
                if (!err) return next();
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return next(
                        new errors.PayloadTooLargeError('Thumbnail exceeds the 500 KB size limit')
                    );
                }
                return next(new errors.ValidationError(err.message || 'Upload failed'));
            });
        },
        controller.object_thumbnail_upload
    );
    /*
     * Clear the server-side TN cache entry for this object so the
     * next request fetches fresh from the TN service. Browser HTTP
     * cache is not touched — Cache-Control: max-age=3600 covers that
     * on its own schedule.
     */
    app.post(
        `${base}/objects/:pid/thumbnail/invalidate`,
        require_dashboard_auth,
        can_edit,
        write_limiter(),
        controller.object_thumbnail_invalidate
    );
    app.post(
        `${base}/objects/:pid/publish`,
        require_dashboard_auth,
        can_publish,
        write_limiter(),
        controller.objects_publish
    );
    app.post(
        `${base}/objects/:pid/suppress`,
        require_dashboard_auth,
        can_publish,
        write_limiter(),
        controller.objects_suppress
    );
    /*
     * Delete confirmation modal — fetched before the DELETE so we
     * can collect the required delete_reason in a textarea. The
     * model refuses the delete with a 409 if the object is still
     * published; we surface that as a toast via dashboard.js's
     * htmx:responseError handler.
     */
    app.get(
        `${base}/objects/:pid/delete/confirm`,
        require_dashboard_auth,
        can_delete,
        controller.objects_delete_confirm
    );
    app.delete(
        `${base}/objects/:pid`,
        require_dashboard_auth,
        can_delete,
        write_limiter(),
        controller.objects_delete
    );

    /*
     * Collection-scoped bulk: header buttons on the collection-detail
     * page that flip every active member's publish state in one UPDATE.
     * Registered AFTER /collections/:pid because the /:pid/bulk/* form
     * is unambiguous against the literal /:pid route (different HTTP
     * method + extra path segments).
     */
    app.post(
        `${base}/collections/:pid/bulk/publish`,
        require_dashboard_auth,
        can_publish,
        write_limiter(),
        controller.collection_bulk_publish
    );
    app.post(
        `${base}/collections/:pid/bulk/suppress`,
        require_dashboard_auth,
        can_publish,
        write_limiter(),
        controller.collection_bulk_suppress
    );

    /*
     * User management — admin-only end-to-end (manage_users). Gating the
     * GET page/list too so non-admins can't view the staff roster.
     */
    const can_manage_users = require_permission(PERMISSIONS.MANAGE_USERS);
    app.get(`${base}/users`, require_dashboard_auth, can_manage_users, controller.users_page);
    app.get(`${base}/users/list`, require_dashboard_auth, can_manage_users, controller.users_table_partial);
    /*
     * Add-user modal — empty form. Registered BEFORE /users/:id/edit
     * and /users/:id so Express matches the literal /users/new path
     * first (without ordering this, Express tries /users/:id with
     * id="new" and the controller fails at validation/parsing).
     */
    app.get(`${base}/users/new`, require_dashboard_auth, can_manage_users, controller.users_create_modal);
    app.post(`${base}/users`, require_dashboard_auth, can_manage_users, write_limiter(), controller.users_create);
    /*
     * Edit modal — GET returns the partial that targets #modal-content
     * (which the layout shell auto-opens via dashboard.js section 4).
     */
    app.get(`${base}/users/:id/edit`, require_dashboard_auth, can_manage_users, controller.users_edit_modal);
    /*
     * Patch name / email. Dashboard intentionally doesn't expose du_id
     * changes — that route exists on the REST API (PUT /repo/users/:id)
     * for admin tooling, but for the staff UI we treat du_id as
     * immutable to avoid orphaning audit / job-history records.
     */
    app.post(`${base}/users/:id`, require_dashboard_auth, can_manage_users, write_limiter(), controller.users_update);
    /*
     * Reactivate. Inverse of DELETE — visible only on rows where
     * is_active=0 (i.e. when "Include deactivated" is toggled on).
     */
    app.post(
        `${base}/users/:id/activate`,
        require_dashboard_auth,
        can_manage_users,
        write_limiter(),
        controller.users_activate
    );
    app.delete(
        `${base}/users/:id`,
        require_dashboard_auth,
        can_manage_users,
        write_limiter(),
        controller.users_delete
    );

    /*
     * AIPs (Stage 6 + legacy migration surface). Order matters:
     * `/aips/list` is registered BEFORE the `:id` routes so Express's
     * path matcher doesn't try to match `list` as a numeric id. Same
     * hazard the `/collections/list` ordering above guards against.
     */
    app.get(`${base}/aips`, require_dashboard_auth, aip_controller.aips_page);
    app.get(`${base}/aips/list`, require_dashboard_auth, aip_controller.aips_table_partial);
    app.get(
        `${base}/aips/:id/download`,
        require_dashboard_auth,
        aip_controller.aip_download
    );
    app.get(
        `${base}/aips/:id/row`,
        require_dashboard_auth,
        aip_controller.aip_row_partial
    );
    app.post(
        `${base}/aips/:id/retry`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        aip_controller.aip_retry
    );

    /*
     * AIP backfill — admin-initiated catch-up for AIPs that ingested
     * under v2 BEFORE Stage 6 existed. Admin-only via manage_aip_store
     * (2026-07-29; was manage_ingest, which staff hold — a bulk
     * preservation operation belongs with the other Admin Utils write
     * surfaces). See ingester/aip_backfill.js for the model + the
     * dashboard/aip_backfill_controller.js docstring for the surface.
     */
    const can_manage_aip = require_permission(PERMISSIONS.MANAGE_AIP_STORE);
    app.get(
        `${base}/admin/aip-backfill`,
        require_dashboard_auth,
        can_manage_aip,
        aip_backfill_controller.backfill_page
    );
    app.get(
        `${base}/admin/aip-backfill/status`,
        require_dashboard_auth,
        can_manage_aip,
        aip_backfill_controller.backfill_status_partial
    );
    app.post(
        `${base}/admin/aip-backfill/start`,
        require_dashboard_auth,
        can_manage_aip,
        write_limiter(),
        aip_backfill_controller.backfill_start
    );
    app.post(
        `${base}/admin/aip-backfill/cancel`,
        require_dashboard_auth,
        can_manage_aip,
        write_limiter(),
        aip_backfill_controller.backfill_cancel
    );

    /*
     * Handles — mint a small number of persistent identifiers by hand and
     * remove ones minted by mistake. Admin-only via manage_handles: these
     * writes run under the 10176 prefix administrator credential, the
     * highest-privilege action the app can take, and a delete removes a
     * persistent identifier.
     *
     * The GETs are gated too, not just the writes: the list is the only
     * record of hand-minted handles anywhere (the prefix cannot be
     * enumerated), so it is not a read a non-admin should have either.
     * See dashboard/handles_controller.js and handles/model.js.
     */
    const can_manage_handles = require_permission(PERMISSIONS.MANAGE_HANDLES);
    app.get(
        `${base}/admin/handles`,
        require_dashboard_auth,
        can_manage_handles,
        handles_controller.handles_page
    );
    app.get(
        `${base}/admin/handles/list`,
        require_dashboard_auth,
        can_manage_handles,
        handles_controller.handles_list_partial
    );
    app.post(
        `${base}/admin/handles/mint`,
        require_dashboard_auth,
        can_manage_handles,
        write_limiter(),
        handles_controller.handles_mint
    );
    app.post(
        `${base}/admin/handles/:id/delete`,
        require_dashboard_auth,
        can_manage_handles,
        write_limiter(),
        handles_controller.handles_delete
    );

    /*
     * Batch Backups (Wasabi) browser — read-only browse + per-file
     * download over the Wasabi batch archive (the retired 003-ingested
     * folders' replacement). Gated on manage_ingest like the other
     * ingest-infrastructure admin tools. All GETs; the surface has no
     * mutating operations by design. Nav entry lives in the Admin
     * Utils focus mode (currently nav-hidden), so these URLs are the
     * only way in until nav_show.admin_utils is re-enabled.
     */
    app.get(
        `${base}/admin/archive`,
        require_dashboard_auth,
        can_ingest,
        archive_controller.archive_page
    );
    app.get(
        `${base}/admin/archive/list`,
        require_dashboard_auth,
        can_ingest,
        archive_controller.archive_list_partial
    );
    /*
     * Wildcard path (not ?key=) because the query sanitizer entity-
     * encodes `/` — see archive_controller.archive_download.
     */
    app.get(
        `${base}/admin/archive/download/*key`,
        require_dashboard_auth,
        can_ingest,
        archive_controller.archive_download
    );
};
