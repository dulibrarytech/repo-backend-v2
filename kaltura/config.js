'use strict';

// Kaltura config helpers. The canonical app-wide config lives in
// config/app.js under the `kaltura` block; this module just exposes a
// `is_configured()` predicate so callers (controller, service, route
// guards) don't have to repeat the truthy-on-all-three check.
//
// Required env (all three or none):
//   KALTURA_PARTNER_ID   — numeric Kaltura partner id
//   KALTURA_USER_ID      — admin user id used for session minting
//   KALTURA_SECRET_KEY   — admin secret (NEVER log this; the service
//                          treats it like an OAuth client secret)
//
// Optional:
//   KALTURA_PUBLIC_VIDEO_METADATA_PROFILE_ID
//     — numeric profile id used by service.get_public_video_data to
//       look up the per-entry custom metadata (ReferenceID,
//       OriginalFileName). Only needed by the legacy export flow;
//       the package-queue flow does not touch it.
//
// We deliberately do NOT throw on missing config at module load —
// the rest of the app must boot even when Kaltura is unconfigured
// (dev environments, isolated test runs). Routes 503 instead.

const app_config = require('../config/app');

function get() {
    return app_config().kaltura;
}

function is_configured() {
    const cfg = get();
    return Boolean(
        cfg && cfg.partner_id && cfg.user_id && cfg.secret_key
    );
}

module.exports = {
    get,
    is_configured,
};
