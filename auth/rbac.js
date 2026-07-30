'use strict';

/*
 * Role-based access control.
 * 
 * Design (see docs / the RBAC findings): repository objects come from the
 * ingest pipeline, not authored per-user, so repov2 uses PURE ROLE-BASED
 */
// global capabilities — no per-record ownership scoping (unlike exhibits).
/*
 * The role→permission map below is the code-defined source of truth
 * (versioned + testable); roles live on tbl_users.role.
 * 
 * Enforcement: require_permission(perm) runs AFTER the auth middleware
 * (require_auth / require_dashboard_auth set req.user). It resolves the
 * caller's role DB-fresh (so a role change or deactivation takes effect
 * immediately, regardless of the JWT's TTL) and 403s if the role lacks the
 * permission. Permission names mirror exhibits where they overlap
 * (e.g. manage_index) for cross-app consistency.
 * 
 * Phase 1 gates the ADMIN surfaces only (manage_users / manage_index /
 * manage_metadata_refresh / manage_convert); staff-curation permissions are
 * defined here but enforced at their routes in a later phase.
 */

const { ForbiddenError } = require('../libs/errors');

const ROLES = Object.freeze({ VIEWER: 'viewer', STAFF: 'staff', ADMIN: 'admin' });
const ROLE_NAMES = Object.freeze(Object.values(ROLES));
// Least-privilege default for newly-created users (admins pick explicitly).
const DEFAULT_ROLE = ROLES.STAFF;

const PERMISSIONS = Object.freeze({
    VIEW_REPOSITORY: 'view_repository', // list/get objects, search, collections, stats, queues
    PUBLISH_OBJECT: 'publish_object', // publish / suppress (public visibility)
    EDIT_OBJECT: 'edit_object', // metadata edits, thumbnails, per-object refresh/convert
    DELETE_OBJECT: 'delete_object', // soft-delete + bulk delete (→ AM deletion request)
    MANAGE_INGEST: 'manage_ingest', // enqueue/reset/cancel ingest, Kaltura, batch-backup browse
    MANAGE_INDEX: 'manage_index', // reindex, drop & rebuild, retry dead-lettered
    /*
     * AIP backfill start/cancel (bulk Stage-6 catch-up copies to
     * Wasabi). Deliberately NOT in the staff set (2026-07-29): it was
     * originally grouped under manage_ingest, but it drives a long
     * bulk preservation operation — admin-only, like the other
     * Admin Utils write surfaces. Admin holds it via ALL_PERMISSIONS.
     */
    MANAGE_AIP_STORE: 'manage_aip_store',
    MANAGE_METADATA_REFRESH: 'manage_metadata_refresh', // system-wide refresh start/cancel
    MANAGE_CONVERT: 'manage_convert', // TIFF→JPG batch convert queue
    MANAGE_USERS: 'manage_users', // user CRUD + role assignment
});
const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

const P = PERMISSIONS;
const ROLE_PERMISSIONS = Object.freeze({
    [ROLES.VIEWER]: Object.freeze([P.VIEW_REPOSITORY]),
    [ROLES.STAFF]: Object.freeze([
        P.VIEW_REPOSITORY,
        P.PUBLISH_OBJECT,
        P.EDIT_OBJECT,
        P.DELETE_OBJECT,
        P.MANAGE_INGEST,
    ]),
    // admin = every permission.
    [ROLES.ADMIN]: ALL_PERMISSIONS,
});

// Pure check: does `role` grant `permission`?
function has_permission(role, permission) {
    const perms = ROLE_PERMISSIONS[role];
    return Array.isArray(perms) && perms.includes(permission);
}

/*
 * 403 responder: HTMX (dashboard) gets a friendly toast + small body so the
 * UI doesn't render a raw error blob; pure API gets a ForbiddenError (JSON
 * 403) via the central error handler. ASCII-only header value.
 */
function deny(req, res, next, permission) {
    if (req.get && req.get('hx-request') === 'true') {
        res.set(
            'HX-Trigger',
            JSON.stringify({
                toast: {
                    level: 'error',
                    message: 'You do not have permission to perform this action.',
                },
            })
        );
        return res
            .status(403)
            .type('text/html')
            .send(
                '<div class="alert alert-danger mb-0" role="alert">Forbidden: your role lacks the required permission.</div>'
            );
    }
    return next(new ForbiddenError(`Missing required permission: ${permission}`));
}

/*
 * Express middleware factory. MUST be chained AFTER require_auth /
 * require_dashboard_auth (it reads req.user.du_id).
 */
function require_permission(permission) {
    return async function rbac_guard(req, res, next) {
        try {
            const principal = req.user || {};
            /*
             * Prefer a role already on the principal (e.g. a future JWT
             * claim); otherwise resolve it DB-fresh by du_id.
             */
            let role = principal.role;
            if (!role && principal.du_id) {
                /*
                 * Lazy require avoids a load-time cycle (users/model requires
                 * this module for ROLE_NAMES).
                 */
                const user_model = require('../users/model');
                const row = await user_model.get_by_du_id(principal.du_id);
                role = row && row.role;
            }
            if (role && has_permission(role, permission)) {
                req.user = { ...principal, role }; // memoize for downstream
                return next();
            }
            return deny(req, res, next, permission);
        } catch (err) {
            return next(err);
        }
    };
}

module.exports = {
    ROLES,
    ROLE_NAMES,
    DEFAULT_ROLE,
    PERMISSIONS,
    ALL_PERMISSIONS,
    ROLE_PERMISSIONS,
    has_permission,
    require_permission,
};
