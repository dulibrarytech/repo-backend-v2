'use strict';

// Minimal ArchivesSpace API client. Ports v1's libs/archivesspace.js with
// three notable changes:
//
//   1. Session token isn't embedded in the URL (v1 didn't either — kept
//      for consistency with the DuraCloud port).
//   2. Timeouts are bounded at 15s by default, NOT v1's 5 minutes. A
//      single hung ASpace request shouldn't be allowed to stall the
//      worker for that long; the next poll will pick the row back up.
//   3. The HTTP client is injectable via the factory so tests can
//      substitute a fake without monkey-patching axios.
//
// `is_configured()` lets callers cheaply short-circuit when ASpace env
// vars are absent — useful for dev / test envs that don't have an
// ASpace instance available.
//
// Phase B (May 2026): get_record can take one of TWO upstream paths,
// chosen by config.archivespace.use_transformer. See get_record's
// docstring for the trade-off and the rollout plan.

const http_default = require('axios');
const app_config = require('../config/app');
const log = require('./log');
const { UpstreamError, UnauthorizedError } = require('./errors');
const { transform } = require('./archivesspace_transform');

function is_configured() {
    const cfg = app_config().archivespace;
    return Boolean(cfg && cfg.host && cfg.user && cfg.password);
}

// Build a normalized base URL — strip any trailing slash so the joining
// logic below stays simple. The stored `uri` value from ASpace always
// starts with `/`, so we just concatenate.
function base_url() {
    const cfg = app_config().archivespace;
    return cfg.host.replace(/\/+$/, '');
}

// Resolve-references query the native AS endpoint needs in order to
// inline subjects + linked_agents + the digital_object tree under
// `_resolved` keys. Without these, the transformer would produce empty
// subjects/names/parts arrays because there's nothing to read.
//
// The same list works for archival_objects and resources. For resources
// the `digital_object::tree` resolve is a harmless no-op (resources
// typically don't have a representative DO with children), and we accept
// that small waste in exchange for a single uniform resolve list — the
// alternative was branching by record type which only the caller could
// do reliably.
const RESOLVE_PARAMS = [
    'subjects',
    'linked_agents',
    'instances::digital_object',
    'instances::digital_object::tree',
];

// Factory so tests can pass in an injected http client without touching
// the module-level axios import. Production callers get the default.
function create_client(http = http_default) {
    return {
        is_configured,

        // Authenticate against ASpace and return the session token. v1
        // calls this once per batch; v2 calls it once at worker startup
        // and refreshes on 401. The "expiring=false" query param mirrors
        // v1; ASpace honors it to issue a long-lived token.
        async get_session_token() {
            const cfg = app_config().archivespace;
            const url = `${base_url()}/users/${encodeURIComponent(cfg.user)}/login`;
            try {
                const res = await http.post(url, null, {
                    params: { password: cfg.password, expiring: false },
                    timeout: cfg.timeout_ms,
                    validateStatus: () => true,
                });
                if (res.status === 401 || res.status === 403) {
                    throw new UnauthorizedError(`ArchivesSpace login rejected: HTTP ${res.status}`);
                }
                if (res.status !== 200 || !res.data || !res.data.session) {
                    throw new UpstreamError(
                        `ArchivesSpace login returned unexpected response (HTTP ${res.status})`
                    );
                }
                return res.data.session;
            } catch (err) {
                if (err instanceof UpstreamError || err instanceof UnauthorizedError) throw err;
                log.warn({ event: 'aspace_login_failed', err: err.message });
                throw new UpstreamError(`ArchivesSpace login failed: ${err.message}`);
            }
        },

        // Fetch one record by its URI (the path tail v1 stores in the
        // queue table — e.g. `/repositories/2/resources/12345`).
        //
        // Returns: { status, data } on a successful round-trip. The
        // caller distinguishes 200 from 4xx/5xx and decides how to
        // handle. The shape mirrors axios's response so the caller has
        // status + data + headers without a second wrapper.
        //
        // Throws UpstreamError on a transport-level failure (timeout,
        // DNS, TLS) — the caller treats that as a retry candidate.
        //
        // ── Two upstream paths ──
        //
        // 1. Plugin path (default, use_transformer=false):
        //
        //    GET <base><uri>/repository
        //
        //    The `/repository` suffix is a DU custom AS plugin
        //    endpoint that returns the pre-transformed metadata shape
        //    every downstream consumer expects:
        //
        //      { title, uri, identifiers, dates, subjects, notes,
        //        parts, is_compound, ... }
        //
        //    The plugin is no longer maintained upstream — we replicate
        //    its behavior locally in path (2) below. Until that has
        //    soaked in dev + prod we leave this as the default.
        //
        // 2. Transformer path (use_transformer=true):
        //
        //    GET <base><uri>?resolve[]=subjects&resolve[]=linked_agents
        //                  &resolve[]=instances::digital_object
        //                  &resolve[]=instances::digital_object::tree
        //
        //    Hits the native AS endpoint with resolve-references
        //    enabled so subjects/agents/tree are inlined, then pipes
        //    the response through libs/archivesspace_transform.js to
        //    produce the SAME flat shape the plugin emitted. Tested
        //    for byte-for-byte parity (sans I18n relator translation
        //    and kaltura_id, both deferred) — see
        //    tests/e2e/aspace_transform_parity.test.js when live.
        //
        // The transformer also stamps a `_transformer_version` field
        // into the returned data so the system-wide refresh can detect
        // a transformer-rule change and re-stamp affected rows in a
        // differential refresh.
        async get_record(uri, token) {
            const cfg = app_config().archivespace;
            if (typeof uri !== 'string' || !uri.startsWith('/')) {
                throw new UpstreamError(`Invalid ArchivesSpace URI: ${uri}`);
            }

            const url = cfg.use_transformer
                ? `${base_url()}${uri}`
                : `${base_url()}${uri}/repository`;
            const params = cfg.use_transformer ? { 'resolve[]': RESOLVE_PARAMS } : undefined;

            try {
                const res = await http.get(url, {
                    timeout: cfg.timeout_ms,
                    headers: { 'X-ArchivesSpace-Session': token },
                    params,
                    validateStatus: () => true,
                });

                // 4xx/5xx pass through unchanged so the worker can pick
                // the right recovery (token refresh on 401/403, mark
                // failed on 404). Only transform on a successful 200.
                if (!cfg.use_transformer || res.status !== 200 || !res.data) {
                    return res;
                }

                // Transformer path: replace res.data with the flat
                // shape downstream consumers (worker, QA validator,
                // indexer projection) already understand. We mutate a
                // shallow copy of res so the caller still gets status +
                // headers; data is replaced wholesale.
                const transformed = transform(res.data);
                transformed._transformer_version = cfg.transformer_version;
                return { ...res, data: transformed };
            } catch (err) {
                log.warn({ event: 'aspace_fetch_failed', uri, err: err.message });
                throw new UpstreamError(`ArchivesSpace fetch failed: ${err.message}`);
            }
        },

        // Best-effort logout. Used at worker shutdown to release the
        // session. If it fails the worker doesn't care — ASpace will
        // expire the token on its own schedule.
        async destroy_session_token(token) {
            const cfg = app_config().archivespace;
            if (!token) return;
            const url = `${base_url()}/logout`;
            try {
                await http.post(url, null, {
                    timeout: cfg.timeout_ms,
                    headers: { 'X-ArchivesSpace-Session': token },
                    validateStatus: () => true,
                });
            } catch (err) {
                // Swallow — see comment above.
                log.warn({ event: 'aspace_logout_failed', err: err.message });
            }
        },

        // Lightweight reachability + auth probe for the Services Health
        // admin page. A login round-trip is the cheapest call that
        // proves BOTH that ASpace is reachable AND that our credentials
        // work — a 200 with a session is the only "healthy" outcome.
        //
        // Mirrors archivematica.ping_api()'s contract: returns a boolean
        // and NEVER throws (a down/misconfigured ASpace must render as a
        // red card, not a 500). We request an expiring session (no
        // `expiring:false`) and best-effort log it out immediately so
        // the 30s poll doesn't accumulate sessions on the ASpace side.
        async ping() {
            if (!is_configured()) return false;
            const cfg = app_config().archivespace;
            const login_url = `${base_url()}/users/${encodeURIComponent(cfg.user)}/login`;
            try {
                const res = await http.post(login_url, null, {
                    params: { password: cfg.password },
                    timeout: cfg.timeout_ms,
                    validateStatus: () => true,
                });
                const token = res.data && res.data.session;
                if (res.status === 200 && token) {
                    // Fire-and-forget logout so the probe leaves no
                    // lingering session. Don't await — the probe's
                    // result doesn't depend on the logout landing.
                    http.post(`${base_url()}/logout`, null, {
                        timeout: cfg.timeout_ms,
                        headers: { 'X-ArchivesSpace-Session': token },
                        validateStatus: () => true,
                    }).catch(() => {});
                    return true;
                }
                return false;
            } catch (err) {
                log.warn({ event: 'aspace_ping_failed', err: err.message });
                return false;
            }
        },
    };
}

// Default instance for production callers. Tests use `create_client(fake_http)`.
module.exports = create_client();
module.exports.create_client = create_client;
module.exports.is_configured = is_configured;
module.exports.RESOLVE_PARAMS = RESOLVE_PARAMS;
