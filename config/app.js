'use strict';

/*
 * Central app configuration. Reads from process.env, surfaces typed
 * values, throws early on missing required vars so misconfiguration
 * fails at boot rather than at first request.
 */

const pkg = require('../package.json');

function required(name) {
    const v = process.env[name];
    if (v === undefined || v === null || v === '') {
        throw new Error(`Missing required env var: ${name}`);
    }
    return v;
}

function optional(name, fallback = '') {
    const v = process.env[name];
    return v === undefined || v === '' ? fallback : v;
}

function integer(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer (got "${v}")`);
    return n;
}

function boolean(name, fallback = false) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return v === '1' || v.toLowerCase() === 'true';
}

function list(name, fallback = []) {
    const v = process.env[name];
    if (!v) return fallback;
    return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/*
 * Process-startup timestamp, used as a cache-bust suffix on static
 * asset URLs (see views/dashboard/layout.ejs). Bumps on every restart
 * in dev — so a tweaked dashboard.js shows up on a hard refresh
 * instead of being stuck behind the browser cache; stable for the
 * lifetime of the process in prod.
 */
const ASSET_V = Date.now().toString(36);

let cached = null;

function build() {
    const env = optional('NODE_ENV', 'development');
    const is_prod = env === 'production';
    const is_test = env === 'test';
    const is_dev = !is_prod && !is_test;

    return {
        env,
        is_prod,
        is_test,
        is_dev,

        name: optional('APP_NAME', pkg.name),
        version: optional('APP_VERSION', pkg.version),
        /*
         * Static-asset cache buster — bound at module load. See ASSET_V
         * comment above.
         */
        asset_v: ASSET_V,
        organization: optional('ORGANIZATION', ''),

        host: optional('APP_HOST', 'localhost'),
        port: integer('APP_PORT', 8000),
        path: optional('APP_PATH', '/repo'),
        api_url: optional('API_URL', ''),
        /*
         * Externally-visible base URL used when we need to mint a full
         * URL for storage in the database (thumbnail URLs in tbl_objects
         * and the parallel `thumbnail` key in display_record). Falls
         * back to a host+path string built from APP_HOST/APP_PORT only
         * when unset — production should always set this so the stored
         * URL survives moving behind a different proxy.
         */
        public_base_url: optional('PUBLIC_BASE_URL', ''),

        /*
         * Where uploaded thumbnails land on disk. Files are written as
         * <pid>.jpg under this directory and served back via
         * /repo/static/tn/<pid>.jpg. Matches the legacy v1 layout so an
         * operator can NFS-mount the same volume during a rolling
         * cutover. Defaults to ./public/thumbnails for dev.
         */
        thumbnail_upload_path: optional('THUMBNAIL_UPLOAD_PATH', './public/thumbnails'),
        // 500 KiB cap — same as v1, plenty for a 200×200 JPEG.
        thumbnail_max_bytes: integer('THUMBNAIL_MAX_BYTES', 500 * 1024),

        cors_allowed_origins: list('CORS_ALLOWED_ORIGINS'),
        log_level: optional('LOG_LEVEL', is_prod ? 'info' : 'debug'),

        jwt: {
            secret: required('TOKEN_SECRET'),
            algorithm: optional('TOKEN_ALGO', 'HS512'),
            expires_in: optional('TOKEN_EXPIRES', '12h'),
            issuer: optional('TOKEN_ISSUER', 'repo-backend-v2'),
        },

        /*
         * SSO — layered defense. See docs/MODERNIZATION_PLAN.md and the
         * SSO_* env vars in .env-example. Each layer toggles
         * independently so we can stage rollout: ship Layer 1 today,
         * turn on Layer 2 once the upstream proxy sends timestamps,
         * turn on Layer 3 once it computes HMAC. Until then the
         * legacy HTTP_HOST string match keeps production working —
         * but only as defense-in-depth, never as the sole trust signal.
         */
        sso: {
            /*
             * Layer 0 (legacy compat): expected HTTP_HOST body field.
             * The upstream proxy sends its hostname in the body; we
             * compare against this. Spoof-able on its own, kept as
             * belt-and-braces only.
             */
            expected_host: optional('SSO_HOST', ''),
            // Where to send the user to initiate SSO (the GET start handler).
            url: optional('SSO_URL', ''),
            /*
             * Where the upstream proxy POSTs the callback. v2 includes
             * this in the start redirect as `?app_url=...` — matching
             * the legacy convention so authproxy.du.edu can use the
             * same query-parameter wiring it already understands.
             */
            response_url: optional('SSO_RESPONSE_URL', ''),
            /*
             * Central IdP logout URL. When set, the dashboard logout
             * redirects here so the user is signed out of DU central
             * and not just our local session cookie.
             */
            logout_url: optional('SSO_LOGOUT_URL', ''),
            // Where the user lands by default after a successful callback.
            default_redirect: optional(
                'SSO_DEFAULT_REDIRECT',
                optional('APP_PATH', '/repo') + '/dashboard/'
            ),

            /*
             * Layer 1: IP allowlist. Comma-separated list of IPs or
             * CIDR ranges. Empty = layer disabled (every source allowed).
             */
            trusted_ips: list('SSO_TRUSTED_IPS'),

            // Layer 2: timestamp + nonce freshness.
            require_freshness: boolean('SSO_REQUIRE_FRESHNESS', false),
            max_skew_seconds: integer('SSO_MAX_SKEW_SECONDS', 60),

            // Layer 3: HMAC signature.
            require_hmac: boolean('SSO_REQUIRE_HMAC', false),
            hmac_secret: optional('SSO_HMAC_SECRET', ''),
            /*
             * For zero-downtime key rotation: the verifier accepts a
             * signature matching either secret.
             */
            hmac_secret_next: optional('SSO_HMAC_SECRET_NEXT', ''),
        },

        /*
         * Elasticsearch — single public-facing index in v2. The legacy
         * admin/back index was retired with the move to a DB-backed
         * dashboard search; staff queries hit MariaDB directly via
         * search/model.js, and only public-facing content lives in ES.
         * 
         * The indexer writes here; the dashboard does NOT read here.
         * Anything failing the eligibility filter (is_published=1 AND
         * is_active=1) gets deleted from this index rather than indexed.
         */
        elasticsearch: {
            host: optional('ELASTICSEARCH_HOST', ''),
            index: optional('ELASTICSEARCH_FRONT_INDEX', 'repo_public'),
            shards: integer('ELASTICSEARCH_SHARDS', 3),
            replicas: integer('ELASTICSEARCH_REPLICAS', 2),
            timeout_ms: integer('ELASTICSEARCH_TIMEOUT_MS', 10000),
            /*
             * TLS:
             *   ca_cert_file — path to a PEM file with one or more CA
             *     certs to trust IN ADDITION to Node's bundled roots.
             *     Use this when ES is behind an internal CA (DU is on
             *     InCommon) OR when the ES server is misconfigured and
             *     fails to send its intermediate chain (we just patch
             *     the missing intermediate locally).
             *   reject_unauthorized — defaults to TRUE. Setting it to
             *     false disables cert verification entirely for the
             *     ES connection. NEVER do this in production; the
             *     ca_cert_file path is the right answer there. The
             *     opt-out exists for dev convenience only, and the
             *     ES client logs a loud warning at boot when it's off.
             */
            ca_cert_file: optional('ELASTICSEARCH_CA_CERT_FILE', ''),
            reject_unauthorized: boolean('ELASTICSEARCH_REJECT_UNAUTHORIZED', true),
        },
        /*
         * Indexer worker tunables. Mirrors metadata_worker shape so
         * operators only have to learn one pattern, but the semantics
         * diverge: the indexer issues ONE ES `_bulk` call per tick, so
         * `concurrency` here means "max rows per bulk batch", not
         * "max parallel HTTP requests" the way it does in the metadata
         * worker. Env var name kept stable for deployment compat.
         */
        indexer: {
            enabled: boolean('INDEXER_ENABLED', true),
            /*
             * Default 50: ES `_bulk` happily handles thousands of ops
             * per request, but we cap at a value that keeps each
             * request well under the default 100MB http.max_content_length
             * and keeps the worker's memory footprint bounded. Bump
             * higher in production if rebuilds need to drain faster.
             */
            concurrency: integer('INDEXER_CONCURRENCY', 50),
            /*
             * Poll cadence for claiming dirty rows. 8s mirrors the
             * metadata worker; staff actions that flip is_updated=1
             * become visible in public search within ~8s.
             */
            poll_ms: integer('INDEXER_POLL_MS', 8000),
            /*
             * Bounded retry for the (is_updated,is_indexed) queue. After
             * a row fails to index this many consecutive times it's
             * DEAD-LETTERED (index_error recorded, no longer auto-
             * requeued) instead of re-failing every poll forever. The
             * admin "Retry failed" button or any explicit reindex clears
             * it. A whole-batch ES transport failure does NOT count
             * toward this cap — an outage mustn't dead-letter every row.
             */
            max_attempts: integer('INDEXER_MAX_ATTEMPTS', 5),
        },

        /*
         * ArchivesSpace — the source of truth for descriptive metadata.
         * The metadata-refresh worker fetches records here and writes
         * them back into tbl_objects.mods + display_record.
         * 
         * `host` is the base URL of an ASpace API endpoint (e.g.
         * https://aspace.du.edu/api). The worker appends the stored
         * `uri` path tail per record — see libs/archivesspace.js.
         * 
         * Worker tunables: `concurrency` is the max number of parallel
         * ASpace fetches in flight at any time across ALL active
         * batches. `poll_ms` is how often the worker wakes to claim
         * more rows. Together they cap upstream load: at most
         * `concurrency` requests every `poll_ms`.
         */
        archivespace: {
            host: optional('ARCHIVESPACE_HOST', ''),
            user: optional('ARCHIVESPACE_USER', ''),
            password: optional('ARCHIVESPACE_PASSWORD', ''),
            repository_id: optional('ARCHIVESPACE_REPOSITORY_ID', ''),
            /*
             * 15s timeout per fetch. v1 used 5 minutes which made a
             * single hung ASpace request stall the worker. ASpace
             * reportedly serves a record in ~10s on a bad day, so 15s
             * is a generous ceiling that still bounds failure cases.
             */
            timeout_ms: integer('ARCHIVESPACE_TIMEOUT_MS', 15000),
            /*
             * Minimum spacing between ingest-stage ArchivesSpace record
             * fetches, process-wide (libs/aspace_session.js). ASpace
             * can't take more than a few concurrent requests — a big
             * batch's back-to-back per-package fetches read like an
             * attack (2026-07-29 burst incident). One fetch per 10s
             * mirrors the metadata-refresh worker's gentle cadence.
             * 0 disables pacing. Does NOT affect the metadata worker
             * (it has its own METADATA_UPDATE_TIMER cadence) or
             * dashboard request paths.
             */
            fetch_min_interval_ms: integer('ASPACE_FETCH_MIN_INTERVAL_MS', 10000),
            /*
             * Rotate the AS session token every N requests during a
             * long-running batch (e.g. the system-wide metadata
             * refresh). Mitigates AS-side per-session cache buildup
             * which is the dominant cause of "AS gets slower the
             * longer the refresh runs" — over thousands of requests
             * on one session, AS accumulates schema-resolution
             * caches, repository scopes, and permission lookups
             * that grow heap pressure and lengthen GC pauses.
             * 
             * The rotation runs at end-of-tick (not mid-tick) so no
             * in-flight request gets caught with a stale token.
             * Failure to mint a fresh token doesn't crash the worker
             * — the next tick's bootstrap re-tries.
             * 
             * Default 500: at our concurrency=1 + ~8s/request, that's
             * a rotation roughly every 65 minutes. Set to 0 to
             * disable (single token for the whole batch — pre-fix
             * behavior).
             */
            token_rotate_after_requests: integer(
                'ARCHIVESPACE_TOKEN_ROTATE_AFTER_REQUESTS',
                500
            ),
            /*
             * Feature flag for the in-process metadata transformer.
             * 
             *   false (default) — fetch <uri>/repository, the DU custom
             *                     AS plugin endpoint that returns the
             *                     pre-flattened shape. Battle-tested,
             *                     but depends on the plugin being
             *                     installed in the AS instance.
             *   true            — fetch the native AS endpoint with
             *                     ?resolve[]= params and pipe through
             *                     libs/archivesspace_transform.js to
             *                     produce the same flat shape locally.
             *                     Lets us decommission the plugin and
             *                     enables differential refresh (because
             *                     transform() is pure).
             * 
             * Roll out: leave default false until the parity test
             * (tests/e2e/aspace_transform_parity.test.js, gated by
             * INGEST_LIVE_E2E=1) confirms row-by-row equivalence.
             * Flip in dev, soak, then prod, then default true.
             */
            use_transformer: boolean('ASPACE_USE_TRANSFORMER', false),
            /*
             * Transformer schema version. Stamped into the stored
             * display_record envelope on every refresh so the system-
             * wide refresh's differential mode can detect "transformer
             * output shape changed; re-stamp this row" even when AS
             * mtime hasn't moved. Bump when transform() rules change.
             */
            transformer_version: optional('ASPACE_TRANSFORMER_VERSION', '1'),
        },
        /*
         * Metadata-refresh worker. Cap requests-in-flight so ASpace
         * doesn't get hammered; staff can re-enqueue any batch the
         * worker hasn't started yet.
         */
        metadata_worker: {
            // Max concurrent ASpace fetches across all batches.
            concurrency: integer('METADATA_WORKER_CONCURRENCY', 3),
            /*
             * Poll interval for claiming new rows. Honors the legacy
             * METADATA_UPDATE_TIMER env name; default 8s matches the
             * value v1 had in .env-example (it hardcoded 10s instead).
             */
            poll_ms: integer('METADATA_UPDATE_TIMER', 8000),
            /*
             * Per-PID enqueue cap. Matches the bulk-action limit so a
             * staff member can't queue 23k records in one click. The
             * collection-scoped variant has no cap (one collection at
             * a time is the implicit limit there).
             */
            max_batch_pids: integer('METADATA_MAX_BATCH_PIDS', 100),
            /*
             * Skip the worker entirely (useful for tests + the rare
             * case where you want to run the dashboard read-only).
             */
            enabled: boolean('METADATA_WORKER_ENABLED', true),
            /*
             * Per-row retry budget. On a fetch/DB failure the worker
             * flips the row back to PENDING and increments `attempts`;
             * once attempts >= this cap the row transitions to
             * DEAD_LETTERED (terminal). 3 covers transient ASpace
             * hiccups (most outages clear inside the 8s × 3 = ~24s
             * budget) without retrying genuinely-broken records
             * forever.
             * 
             * Applies to ALL refreshes (on-demand single, collection,
             * bulk, and system-wide). Previously failures were
             * single-shot terminal; bumping to 3 is a UX improvement
             * across the board.
             */
            max_attempts: integer('METADATA_MAX_ATTEMPTS', 3),
            /*
             * Orphan-sweep threshold. Each tick, before claiming new
             * rows, the worker resets any row that's been
             * status=IN_PROGRESS longer than this. Legitimate per-row
             * processing is ~30s worst case (ASpace timeout + token
             * refresh + retry), so 300s (5 min) is a safe ceiling
             * that catches genuinely-stuck claims without false-
             * positiving on slow-but-healthy fetches.
             * 
             * Without this, a process crash mid-claim or a hung
             * socket leaves rows in IN_PROGRESS until the next
             * worker boot (reset_orphaned only runs at start()).
             * With it, recovery is automatic and bounded.
             */
            orphan_reset_seconds: integer('METADATA_ORPHAN_RESET_SECONDS', 300),
            /*
             * Per-row retry backoff. After a row fails, mark_failed
             * sets next_attempt_at = now() + backoff so claim_pending
             * skips the row until that time passes. Doubles on each
             * subsequent failure, capped at retry_max_backoff_ms.
             * 
             * Why a backoff: previously a failed row went straight
             * back to PENDING and could be re-claimed within a single
             * tick — under sustained ArchivesSpace pressure this
             * amplified the load while AS was already struggling.
             * With backoff, a transient upstream wobble gets ~30s of
             * breathing room before the next attempt; a longer outage
             * spreads retries over minutes rather than seconds.
             * 
             * Set retry_base_backoff_ms=0 to disable (rows return to
             * PENDING immediately, matching the pre-backoff behavior).
             * Tests that exercise mark_failed -> claim_pending in
             * immediate succession use this opt-out.
             */
            retry_base_backoff_ms: integer('METADATA_RETRY_BASE_BACKOFF_MS', 30000),
            retry_max_backoff_ms: integer('METADATA_RETRY_MAX_BACKOFF_MS', 300000),
        },

        /*
         * System-wide metadata refresh — long-running refreshes that
         * touch every active row in tbl_objects. Uses the same
         * ASpace-bound metadata worker; the producer paces enqueue
         * so the queue table doesn't balloon.
         */
        metadata_system_refresh: {
            /*
             * Producer cadence + chunk size. Defaults give ~6k rows /
             * minute of enqueue capacity at steady state — well above
             * the worker's ~12-row/min drain, so the queue table
             * bounded mostly by the worker, not the producer.
             */
            poll_ms: integer('METADATA_REFRESH_PRODUCER_POLL_MS', 5000),
            chunk_size: integer('METADATA_REFRESH_CHUNK_SIZE', 500),
            /*
             * Priority used for system-refresh queue rows. On-demand
             * rows default to 0; system rows enqueue at 5 so the
             * worker drains on-demand work first whenever it co-exists.
             * Don't tune this without a reason.
             */
            priority: integer('METADATA_REFRESH_PRIORITY', 5),
            /*
             * Off by default. Operator opts in by setting this + a
             * cron expression (a follow-up wires the cron).
             */
            cron_enabled: boolean('METADATA_REFRESH_CRON_ENABLED', false),
        },

        /*
         * TN service — generates fresh thumbnails per object from
         * source files. Preferred over DuraCloud where available
         * because the source-image quality is more consistent than
         * whatever DuraCloud archived at ingest time.
         * 
         * Lookup is by the row's PID (passed as the path UUID).
         * Auth is an API key in the query string — matches v1's wire
         * format so we can reuse the existing TN service deployment.
         * 
         * Disk cache: write-once, no TTL. v1 ran with ~1,790 cached
         * entries at steady state. Same atomic-write pattern as the
         * thumbnail upload (temp file + rename), so a half-written
         * cache file can never be served.
         */
        tn_service: {
            url: optional('TN_SERVICE', ''),
            api_key: optional('TN_SERVICE_API_KEY', ''),
            timeout_ms: integer('TN_SERVICE_TIMEOUT_MS', 30000),
            cache_path: optional('TN_CACHE_PATH', './public/tn_cache'),
        },

        /*
         * Convert service — DU's TIFF→JPG derivative generator
         * (libspec02). The convert/ subsystem submits repo objects to
         * this remote API one at a time, paced `delay_ms` apart, because
         * the service is fragile under load (the legacy
         * post_tiff_convert.py used the same 20s pacing). Auth is an
         * api_key query param, matching the deployed service's wire
         * format. When url/api_key are empty the worker stays idle and
         * the dashboard shows a "not configured" notice.
         */
        convert_service: {
            enabled: boolean('CONVERT_WORKER_ENABLED', true),
            url: optional('CONVERT_SERVICE', ''),
            api_key: optional('CONVERT_SERVICE_API_KEY', ''),
            timeout_ms: integer('CONVERT_SERVICE_TIMEOUT_MS', 30000),
            // Cooldown BETWEEN requests (end of one → start of next).
            delay_ms: integer('CONVERT_SERVICE_DELAY_MS', 20000),
            // Poll cadence while the queue is empty.
            idle_poll_ms: integer('CONVERT_SERVICE_IDLE_POLL_MS', 5000),
            // Per-row retry ceiling before a row is marked FAILED.
            max_attempts: integer('CONVERT_SERVICE_MAX_ATTEMPTS', 3),
            /*
             * Guard against a fat-fingered collection fanning out to tens
             * of thousands of POSTs. Clamped at enqueue time.
             */
            max_batch: integer('CONVERT_MAX_BATCH', 5000),
            // How many payloads the dry-run preview lists (count is exact).
            preview_sample: integer('CONVERT_PREVIEW_SAMPLE', 25),
        },

        /*
         * DuraCloud — used to stream thumbnails for legacy rows whose
         * `thumbnail` column stores a dip-store-relative path (the
         * shape the ingest service writes: <dip_path>/thumbnails/<uuid>.jpg).
         * The browser can't fetch those directly: they aren't valid
         * URLs and DuraCloud requires Basic auth. A staff-only proxy
         * route in dashboard/ fetches them server-side and pipes the
         * bytes through.
         * 
         * When `api` is empty the proxy gracefully returns the local
         * placeholder so dev/test environments without DC creds boot
         * cleanly — see dashboard/thumbnail_proxy.js.
         */
        duracloud: {
            /*
             * Host + path prefix WITHOUT scheme — matches the v1 env
             * layout. Example: "digitaldu.duracloud.org/durastore/".
             * The lib prepends `https://` itself.
             */
            api: optional('DURACLOUD_API', ''),
            user: optional('DURACLOUD_USER', ''),
            password: optional('DURACLOUD_PWD', ''),
            /*
             * Wall-clock timeout for a single thumbnail fetch. DC can
             * be slow under load; 15s is generous but still well under
             * the upstream proxy's default.
             */
            timeout_ms: integer('DURACLOUD_TIMEOUT_MS', 15000),
        },

        /*
         * Archivematica — preservation pipeline. v2's ingest worker
         * pushes packages through Archivematica's transfer + ingest
         * stages and polls each until terminal. Two APIs are involved:
         * 
         *   - The main "dashboard" API (transfer / ingest endpoints).
         *     Auth via username + api_key in the query string. This is
         *     the worker's primary surface.
         *   - The Storage Service API (file / space endpoints, AIP
         *     deletion requests). Auth via `Authorization: ApiKey
         *     user:key` header. Used by rollback flows.
         * 
         * Both APIs ship with separate creds in legacy production. We
         * preserve the split so a v1 .env can be dropped in unchanged.
         * 
         * `transfer_timeout_ms` is the per-request axios timeout. The
         * worker has its own long-poll budgets layered on top (e.g.
         * 6h ingest-status polling) — this only bounds a SINGLE HTTP
         * call so a stuck connection can't hang the worker.
         */
        archivematica: {
            /*
             * Main dashboard API base URL — must include trailing slash
             * to match the v1 URL builder (e.g. "https://am.example.com/api/").
             */
            api: optional('ARCHIVEMATICA_API', ''),
            username: optional('ARCHIVEMATICA_USERNAME', ''),
            api_key: optional('ARCHIVEMATICA_API_KEY', ''),
            // Storage Service API — separate creds + URL.
            storage_api: optional('ARCHIVEMATICA_STORAGE_API', ''),
            storage_username: optional('ARCHIVEMATICA_STORAGE_USERNAME', ''),
            storage_api_key: optional('ARCHIVEMATICA_STORAGE_API_KEY', ''),
            /*
             * Transfer-source UUID + path inside it. start_transfer
             * base64-encodes "<source>:<path>/<collection>/<package>"
             * so AM can resolve the SFTP-deposited files.
             */
            transfer_source: optional('ARCHIVEMATICA_TRANSFER_SOURCE', ''),
            sftp_remote_path: optional('SFTP_REMOTE_PATH', ''),
            /*
             * Identifies the deletion requester to AM Storage Service.
             * The pipeline UUID + user ID are stamped into the audit
             * record AM creates for the deletion approval workflow.
             */
            pipeline: optional('ARCHIVEMATICA_PIPELINE', ''),
            user_id: optional('ARCHIVEMATICA_USERID', ''),
            user_email: optional('ARCHIVEMATICA_USER_EMAIL', ''),
            /*
             * Storage-space UUIDs used by the optional get_dip_storage_usage /
             * get_aip_storage_usage health helpers. Not required for the
             * main ingest pipeline; if unset, those helpers return null.
             */
            storage_dip_uuid: optional('ARCHIVEMATICA_DIP_UUID', ''),
            storage_aip_uuid: optional('ARCHIVEMATICA_AIP_UUID', ''),
            /*
             * Per-request timeout. 60s is roomy enough that even a slow
             * ingest-status query finishes; the worker layers its own
             * total-budget timeout for the multi-poll flows.
             */
            timeout_ms: integer('ARCHIVEMATICA_TIMEOUT_MS', 60000),
            /*
             * start_transfer is a SPECIAL CASE — AM does a filesystem
             * probe (stat + sample read) on every file in the SFTP-
             * staged package before responding 200. For typical
             * image/document packages that's well under 60s, but for
             * large media (multi-GB .mov / .mp4) AM can take 5-10
             * minutes just to ACK the start call. Give it its own
             * generous budget so we don't fail the row before AM
             * has even said "ok, queued".
             * 
             * 10 minutes by default — the legacy v1 ingest service
             * ran without a meaningful timeout on this call. Adjust
             * up for environments with very large media (250 GB+);
             * 20-30 min is reasonable for those.
             * 
             * The other AM calls (status polls, approves, deletes)
             * stay at the shorter timeout_ms — those have small,
             * predictable response sizes regardless of media size.
             */
            start_transfer_timeout_ms: integer(
                'ARCHIVEMATICA_START_TRANSFER_TIMEOUT_MS',
                10 * 60 * 1000
            ),
        },

        /*
         * Handle service — DU's persistent-identifier minting. Every
         * successfully ingested object gets a handle URL stored in
         * tbl_objects.handle. Update is a refresh (re-points the handle
         * at the current target URL).
         * 
         * `service` is the POST/PUT endpoint (e.g. "https://handle.example.com/handles").
         * `server` + `prefix` together form the public URL the handle
         * resolves to (e.g. "https://hdl.example.com/" + "20.500.12345"
         * → "https://hdl.example.com/20.500.12345/<uuid>"). The split
         * preserves v1's env shape so a legacy .env imports cleanly.
         */
        handles: {
            service: optional('HANDLE_SERVICE', ''),
            prefix: optional('HANDLE_PREFIX', ''),
            server: optional('HANDLE_SERVER', ''),
            api_key: optional('HANDLE_API_KEY', ''),
            timeout_ms: integer('HANDLE_TIMEOUT_MS', 30000),
        },

        /*
         * Kaltura — media platform. The kaltura subsystem (kaltura/*)
         * takes archival packages from staff, looks each file up in
         * Kaltura by EXACT_MATCH filename, and persists the resulting
         * entry IDs into tbl_kaltura_ids. The repository build stage
         * reads those IDs back when stamping `kaltura_id` onto the
         * per-part metadata of media objects.
         * 
         * All three credentials are required for the subsystem to
         * boot the SDK; the routes 503 when partner_id / user_id /
         * secret_key is unset (kaltura/config.is_configured()). This
         * is a back-compat path for dev environments that don't have
         * Kaltura access — nothing else in the app depends on Kaltura
         * being live.
         * 
         * public_video_metadata_profile_id is optional — only the
         * legacy /export flow needs it (custom-metadata XML lookup).
         * The /metadata flow ignores it.
         */
        kaltura: {
            partner_id: optional('KALTURA_PARTNER_ID', ''),
            user_id: optional('KALTURA_USER_ID', ''),
            secret_key: optional('KALTURA_SECRET_KEY', ''),
            public_video_metadata_profile_id: integer(
                'KALTURA_PUBLIC_VIDEO_METADATA_PROFILE_ID',
                0
            ),
            /*
             * Sessions last 24h by default — same as the legacy code's
             * hard-coded expiry. Exposed as an env so an operator can
             * shorten in a hardened deployment without touching code.
             */
            session_expiry_s: integer('KALTURA_SESSION_EXPIRY_S', 24 * 60 * 60),
            /*
             * Per-call wall-clock timeouts. The SDK's own timeout is
             * configurable but messy; we race against these and surface
             * UpstreamError. session.start is fast (~1s); metadata
             * lookups can be slow under load.
             */
            session_timeout_ms: integer('KALTURA_SESSION_TIMEOUT_MS', 10_000),
            search_timeout_ms: integer('KALTURA_SEARCH_TIMEOUT_MS', 15_000),
        },

        /*
         * Curation service — single Python service that hosts BOTH
         * workflow surfaces:
         * 
         *   - /api/v2/qa/*     (pre-ingest folder management, SFTP push,
         *                       upload status) — see ingester/libs/qa_service.js
         *   - /api/v1/astools/* (workspace inventory, make-digital-objects,
         *                       revert, uri.txt reads) — see
         *                       ingester/libs/astools.js
         * 
         * Earlier v2 iterations carried two config blocks (qa_service +
         * astools) plus duplicated env vars. Both pointed at the same
         * host with the same API key in every deployment. We collapsed
         * them here into a single block that the two clients share.
         * 
         * Auth: X-API-Key header (shared by both surfaces).
         * 
         * Three timeout knobs:
         *   - timeout_ms        — default per-request budget (~30s)
         *   - move_timeout_ms   — QA move-to-sftp / folder moves; can
         *                          legitimately take ~30 minutes for
         *                          large batches
         *   - mdo_timeout_ms    — AStools make-digital-objects; ~1 hour
         *                          for big batches.
         * 
         * Back-compat: CURATION_API / CURATION_API_KEY are the
         * canonical names. We fall through to the legacy QA_SERVICE /
         * ASTOOLS_SERVICE pairs so older .env files still boot —
         * production should migrate to the canonical names.
         */
        curation_api: {
            url: optional('CURATION_API', optional('QA_SERVICE', optional('ASTOOLS_SERVICE', ''))),
            api_key: optional(
                'CURATION_API_KEY',
                optional('QA_SERVICE_API_KEY', optional('ASTOOLS_API_KEY', ''))
            ),
            timeout_ms: integer(
                'CURATION_API_TIMEOUT_MS',
                integer('QA_SERVICE_TIMEOUT_MS', integer('ASTOOLS_TIMEOUT_MS', 30000))
            ),
            move_timeout_ms: integer(
                'CURATION_API_MOVE_TIMEOUT_MS',
                integer('QA_SERVICE_MOVE_TIMEOUT_MS', 30 * 60 * 1000)
            ),
            mdo_timeout_ms: integer(
                'CURATION_API_MDO_TIMEOUT_MS',
                integer('ASTOOLS_MDO_TIMEOUT_MS', 60 * 60 * 1000)
            ),
        },

        /*
         * Ingest worker tunables. Drives packages through the 5-stage
         * pipeline (process_metadata → upload → AM transfer/ingest →
         * DuraCloud → repository). Concurrency caps work in flight;
         * poll_ms controls how often the worker wakes to claim new
         * PENDING rows; the stage-specific timeouts bound the long
         * polls each stage performs against upstream services.
         * 
         * The polling cadences are deliberately conservative — these
         * are external systems that don't tolerate hammering. Stage-
         * specific timeouts are exposed so an operator can tune for
         * a slower-than-usual AM instance without changing code.
         */
        ingest_worker: {
            enabled: boolean('INGEST_WORKER_ENABLED', true),
            /*
             * Stages 1 + 2 do most of their work in DB writes + a
             * handful of QA calls; we can run a few in parallel
             * safely. Stage 3+ throttles itself further via per-row
             * sequential polling.
             */
            concurrency: integer('INGEST_WORKER_CONCURRENCY', 2),
            // How often the worker wakes to claim new PENDING rows.
            poll_ms: integer('INGEST_WORKER_POLL_MS', 5000),

            /*
             * AM-active gate. When OFF (the default), the worker
             * admits at most one row at a time into the AM window
             * (UPLOAD_COMPLETE through INGEST_IN_PROGRESS). AM chokes
             * on parallel transfers in big batches (~hundreds of
             * packages); the gate is the production-safe setting.
             * 
             * Setting this to true reverts to the pre-gate behavior
             * — multiple parallel start_transfer calls bounded only
             * by `concurrency`. Useful for tests that exercise the
             * pre-gate codepath and for small-batch dev environments
             * where AM is not under load. DO NOT enable in production.
             */
            am_parallel: boolean('INGEST_AM_PARALLEL', false),
            /*
             * Serial pipeline (2026-07-30, default ON): one package at
             * a time through stages 1–5 — the next package starts only
             * after the previous one's repository record is created.
             * Stage 6 (AIP→Wasabi copy) runs in the background either
             * way. Set INGEST_PIPELINE_SERIAL=0 to restore the old
             * interleaved behavior (AM-only gating).
             */
            pipeline_serial: boolean('INGEST_PIPELINE_SERIAL', true),

            // Stage 2 (upload) — poll cadence + total budget.
            upload_poll_ms: integer('INGEST_UPLOAD_POLL_MS', 60000),
            upload_timeout_ms: integer('INGEST_UPLOAD_TIMEOUT_MS', 4 * 60 * 60 * 1000),

            // Stage 3 (AM transfer) — two-phase polling.
            approve_poll_ms: integer('INGEST_APPROVE_POLL_MS', 5000),
            approve_timeout_ms: integer('INGEST_APPROVE_TIMEOUT_MS', 10 * 60 * 1000),
            transfer_poll_ms: integer('INGEST_TRANSFER_POLL_MS', 5000),
            transfer_timeout_ms: integer('INGEST_TRANSFER_TIMEOUT_MS', 6 * 60 * 60 * 1000),

            // Stage 4 (AM ingest + DC wait).
            ingest_poll_ms: integer('INGEST_INGEST_POLL_MS', 5000),
            ingest_timeout_ms: integer('INGEST_INGEST_TIMEOUT_MS', 6 * 60 * 60 * 1000),
            duracloud_poll_ms: integer('INGEST_DURACLOUD_POLL_MS', 60000),
            duracloud_timeout_ms: integer('INGEST_DURACLOUD_TIMEOUT_MS', 60 * 60 * 1000),

            /*
             * Stage 5 success hold. After all repository writes succeed,
             * the row flips to COMPLETE with is_complete=0 (still visible
             * in the queue) and the suggested_action shows "Ingest
             * Complete". After this many ms we flip is_complete=1 so the
             * row drops out of the default "Open only" view. Tests
             * override to 0 to keep the suite fast.
             */
            complete_hold_ms: integer('INGEST_COMPLETE_HOLD_MS', 4000),
        },

        /*
         * AIP-store Stage 6 — preservation copy from Archivematica
         * Storage Service to Wasabi S3. Fires AFTER Stage 5 finalizes
         * the repository record, so a Wasabi outage doesn't roll back
         * an otherwise successful ingest.
         * 
         * The Node side just calls the curation API
         * (POST /api/v2/aip/copy-to-wasabi) — Wasabi credentials live
         * in the Python service, mirroring how move_to_ingested
         * already delegates S3 work. See ingester/stages/aip_store.js
         * for the state machine and ingester/libs/aip_store_client.js
         * for the wire client.
         */
        aip_store: {
            /*
             * Feature flag for rollout. With this OFF, Stage 5
             * finalizes ingest as today (COMPLETE + is_complete=1)
             * and Stage 6 is skipped entirely. Flip in dev, soak,
             * then prod.
             */
            enabled: boolean('AIP_STORE_ENABLED', false),
            /*
             * Wall-clock budget for the curation /copy-to-wasabi call.
             * Multi-GB AIPs take many minutes; default 60 min is
             * generous. Stage 6 records AIP_STORE_FAILED on timeout
             * and the row can be retried via the dashboard.
             */
            copy_timeout_ms: integer('AIP_STORE_COPY_TIMEOUT_MS', 60 * 60 * 1000),
            /*
             * Presigned-URL TTL for dashboard downloads. Short by
             * default so a leaked URL has a small blast radius. 15
             * minutes is comfortable for a staff member kicking off
             * a download in the browser.
             */
            presign_ttl_seconds: integer('AIP_STORE_PRESIGN_TTL_SECONDS', 900),
            /*
             * Retry backoff on Stage 6 failure. Identical semantics
             * to metadata_worker.retry_*; we re-state the values here
             * so an operator can tune AIP retries independently
             * (Wasabi outages have different recovery shapes than
             * ArchivesSpace timeouts).
             */
            retry_base_backoff_ms: integer('AIP_STORE_RETRY_BASE_BACKOFF_MS', 60_000),
            retry_max_backoff_ms: integer('AIP_STORE_RETRY_MAX_BACKOFF_MS', 30 * 60 * 1000),
            /*
             * Hard cap on auto-retries before the row sits at
             * AIP_STORE_FAILED awaiting operator intervention via
             * the dashboard retry button. The dashboard retry resets
             * attempts to 0 and clears next_attempt_at, so staff
             * can always re-fire.
             */
            max_attempts: integer('AIP_STORE_MAX_ATTEMPTS', 5),
            /*
             * Separate, more generous attempt budget for the
             * "AIP not found in AM Storage Service" failure. This is
             * AMBIGUOUS: a genuine orphan, OR a large/slow AIP that
             * Archivematica hasn't finished registering in the Storage
             * Service yet when Stage 6 first queries. We retry it across
             * this budget (spaced by the backoff above) and only declare
             * an orphan once it's still not found at the end — so a slow
             * big AIP gets time to land instead of being stranded on the
             * first 404. With base 60s / cap 30min, 8 attempts ≈ 90 min
             * of grace. Genuine orphans still dead-letter, just later.
             */
            not_found_max_attempts: integer('AIP_STORE_NOT_FOUND_MAX_ATTEMPTS', 8),
            /*
             * Chunk size for the admin backfill action (see
             * ingester/aip_backfill.js). Each "Start backfill" click
             * enqueues at most this many synthetic queue rows; the
             * operator clicks again to chew through more. Bounded so
             * a misconfigured value can't enqueue millions in one
             * click. Clamped server-side to [1, 10000].
             */
            backfill_chunk_size: integer('AIP_STORE_BACKFILL_CHUNK_SIZE', 1000),
        },

        /*
         * (Legacy qa_service + astools config blocks were collapsed
         * into curation_api above — they both pointed at the same
         * host with the same API key, so duplicating them was an
         * operational footgun. Both clients now read from
         * app_config().curation_api.)
         */

        // Operational flags
        flags: {
            ingest_disable_resume: boolean('INGEST_DISABLE_RESUME', false),
        },
    };
}

/*
 * Exported as a factory so tests can reset env between cases by passing
 * `{ reload: true }`.
 */
module.exports = function app_config({ reload = false } = {}) {
    if (cached && !reload) return cached;
    cached = build();
    return cached;
};

// Test-only — never call from app code.
module.exports._reset = function _reset() {
    cached = null;
};
