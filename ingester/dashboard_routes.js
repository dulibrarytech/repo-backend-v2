'use strict';

// Mount the ingest dashboard pages + action endpoints.
//
// Page layout mirrors the production v2 ingest-service:
//
//   /dashboard/ingest                              ← Queue (live monitor)
//   /dashboard/ingest/workspace                    ← Make Digital Objects
//   /dashboard/ingest/aspace-qa                    ← ASpace Description QA
//   /dashboard/ingest/packaging                    ← Packaging and Ingesting
//
//   POST /dashboard/ingest/workspace/:folder/make-digital-objects
//   POST /dashboard/ingest/workspace/:folder/check-metadata
//   POST /dashboard/ingest/workspace/:folder/submit-ingest
//   POST /dashboard/ingest/workspace/:folder/revert-to-mdo
//
// Route order matters: literal segments (`/list`, `/workspace`,
// `/aspace-qa`, `/packaging`) MUST be registered before any
// `/:id`-shaped catch-all so Express doesn't mis-resolve them as ids.

const app_config = require('../config/app');
const { require_dashboard_auth } = require('../dashboard/middleware');
const { require_permission, PERMISSIONS } = require('../auth/rbac');
const { write_limiter } = require('../auth/rate_limit');
const controller = require('./dashboard');

module.exports = function mount(app) {
    const cfg = app_config();
    const base = `${cfg.path}/dashboard/ingest`;
    // The ingest workflow actions (MDO / QA / submit / rollback / reset /
    // cancel) are all writes → manage_ingest. The pages + status partials
    // are reads, open to any authenticated user.
    const can_ingest = require_permission(PERMISSIONS.MANAGE_INGEST);

    // Queue page + partials.
    app.get(base, require_dashboard_auth, controller.ingest_page);
    app.get(`${base}/list`, require_dashboard_auth, controller.ingest_list_partial);

    // Workspace pages + partials.
    app.get(`${base}/workspace`, require_dashboard_auth, controller.workspace_page);
    app.get(`${base}/workspace/list`, require_dashboard_auth, controller.workspace_list_partial);
    app.get(`${base}/aspace-qa`, require_dashboard_auth, controller.aspace_qa_page);
    app.get(`${base}/aspace-qa/list`, require_dashboard_auth, controller.aspace_qa_list_partial);
    app.get(`${base}/packaging`, require_dashboard_auth, controller.packaging_page);
    app.get(`${base}/packaging/list`, require_dashboard_auth, controller.packaging_list_partial);
    app.get(`${base}/recent`, require_dashboard_auth, controller.recent_ingests_page);

    // Workspace actions — folder name is URL-encoded by the row's
    // HTMX template.
    app.post(
        `${base}/workspace/:folder/make-digital-objects`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        controller.make_digital_objects_action
    );
    app.post(
        `${base}/workspace/:folder/check-metadata`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        controller.aspace_qa_check_action
    );
    app.post(
        `${base}/workspace/:folder/submit-ingest`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        controller.submit_ingest_action
    );
    app.post(
        `${base}/workspace/:folder/revert-to-mdo`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        controller.revert_to_mdo_action
    );

    // Job History — retrospective view of MDO / QA / Submit actions.
    app.get(`${base}/history`, require_dashboard_auth, controller.history_page);
    app.get(`${base}/history/list`, require_dashboard_auth, controller.history_list_partial);

    // Services Health (admin) — surfaces the curation-API's Wasabi
    // probe so staff can confirm S3 reachability without SSHing
    // anywhere. Today it's just Wasabi; the same page is the natural
    // home for future service-health cards (Archivematica, ASpace).
    const admin_base = `${cfg.path}/dashboard/admin/services`;
    app.get(`${admin_base}`, require_dashboard_auth, controller.services_page);
    // Combined upstream-services panel: curation-API, Archivematica,
    // DuraCloud, ArchivesSpace — each a single reachability/auth probe.
    app.get(`${admin_base}/health`, require_dashboard_auth, controller.services_health_partial);
    app.get(`${admin_base}/wasabi`, require_dashboard_auth, controller.services_wasabi_partial);

    // Post-sign-in degraded-services banner. Lazy-loaded by the home page
    // after paint (hx-trigger="load"); any signed-in staff, and deliberately
    // NOT under /admin/ so it's part of the normal landing experience, not
    // an admin-only view. Renders nothing when all services are reachable.
    // NOTE: path is `${cfg.path}/dashboard/_services/banner` — NOT under
    // `base` (which is `${cfg.path}/dashboard/ingest`). It must match the
    // home page's mount, which uses dashboard_base (`${cfg.path}/dashboard`).
    app.get(
        `${cfg.path}/dashboard/_services/banner`,
        require_dashboard_auth,
        controller.services_banner_partial
    );

    // Queue timeline modal — registered last so the more-specific
    // routes above (e.g. `/list`, `/workspace`, `/history`) match first.
    app.get(`${base}/:id/timeline`, require_dashboard_auth, controller.ingest_timeline_partial);

    // Staff-initiated cancel of an in-flight row. Returns the
    // rendered row partial so HTMX can swap it in place; 409 if
    // the row reached a terminal state between page render and click.
    app.post(
        `${base}/:id/cancel`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        controller.cancel_row_action
    );
    // Per-row rollback / reset / return-to-packaging — dashboard
    // wrappers around the matching REST endpoints. They run the same
    // mutation logic but return the rendered row partial so HTMX can
    // swap it cleanly in place (the bare REST endpoints return JSON,
    // which previously caused raw JSON to appear inside the row when
    // the kebab items pointed at /api/ingest/... directly).
    app.post(
        `${base}/:id/rollback-pre`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        controller.rollback_pre_ingest_action
    );
    app.post(
        `${base}/:id/rollback-am`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        controller.rollback_archivematica_action
    );
    app.post(
        `${base}/:id/reset`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        controller.reset_row_action
    );
    app.post(
        `${base}/:id/return-to-packaging`,
        require_dashboard_auth,
        can_ingest,
        write_limiter(),
        controller.return_to_packaging_action
    );
};
