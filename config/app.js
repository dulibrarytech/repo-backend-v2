'use strict';

/*
 * Central app configuration. Reads from process.env, surfaces typed
 * values, throws early on missing required vars so misconfiguration
 * fails at boot rather than at first request.
 */

const path = require('node:path');

const pkg = require('../package.json');

/*
 * Build the DuHandleTool classpath (libs/handle_writer.js) from the
 * in-checkout jar plus HANDLE_CLIENT_LIB. Returns '' when
 * HANDLE_CLIENT_LIB is unset. HANDLE_HELPER_CLASSPATH overrides.
 */
function handle_helper_classpath() {
    const override = process.env.HANDLE_HELPER_CLASSPATH;
    if (override) return override;

    const client_lib = process.env.HANDLE_CLIENT_LIB;
    if (!client_lib) return '';

    const jar = path.join(__dirname, '..', 'java', 'duhandletool.jar');
    return `${jar}${path.delimiter}${path.join(client_lib, '*')}`;
}

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
 * Process-startup timestamp, used as a cache-bust suffix on static asset
 * URLs (views/dashboard/layout.ejs). Stable for the life of the process.
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
        asset_v: ASSET_V,
        organization: optional('ORGANIZATION', ''),

        host: optional('APP_HOST', 'localhost'),
        port: integer('APP_PORT', 8000),
        path: optional('APP_PATH', '/repo'),
        api_url: optional('API_URL', ''),
        /*
         * Externally-visible base URL used when minting full URLs for
         * storage in the database (tbl_objects.thumbnail and the
         * parallel `thumbnail` key in display_record). Falls back to a
         * host+path string built from APP_HOST/APP_PORT when unset.
         */
        public_base_url: optional('PUBLIC_BASE_URL', ''),

        /*
         * Where uploaded thumbnails land on disk. Written as <pid>.jpg
         * and served back via /repo/static/tn/<pid>.jpg.
         */
        thumbnail_upload_path: optional('THUMBNAIL_UPLOAD_PATH', './public/thumbnails'),
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
         * SSO. Four independently-toggled layers; each may be enabled
         * without the others.
         */
        sso: {
            // Layer 0 (legacy compat): expected HTTP_HOST body field.
            expected_host: optional('SSO_HOST', ''),
            // Where to send the user to initiate SSO (the GET start handler).
            url: optional('SSO_URL', ''),
            /*
             * Where the upstream proxy POSTs the callback. Included in
             * the start redirect as `?app_url=...`.
             */
            response_url: optional('SSO_RESPONSE_URL', ''),
            /*
             * Central IdP logout URL. When set, dashboard logout
             * redirects here rather than only clearing the local cookie.
             */
            logout_url: optional('SSO_LOGOUT_URL', ''),
            // Where the user lands by default after a successful callback.
            default_redirect: optional(
                'SSO_DEFAULT_REDIRECT',
                optional('APP_PATH', '/repo') + '/dashboard/'
            ),

            /*
             * Layer 1: IP allowlist. Comma-separated IPs or CIDR ranges.
             * Empty = layer disabled (every source allowed).
             */
            trusted_ips: list('SSO_TRUSTED_IPS'),

            // Layer 2: timestamp + nonce freshness.
            require_freshness: boolean('SSO_REQUIRE_FRESHNESS', false),
            max_skew_seconds: integer('SSO_MAX_SKEW_SECONDS', 60),

            // Layer 3: HMAC signature.
            require_hmac: boolean('SSO_REQUIRE_HMAC', false),
            hmac_secret: optional('SSO_HMAC_SECRET', ''),
            // Rotation: the verifier accepts a signature matching either secret.
            hmac_secret_next: optional('SSO_HMAC_SECRET_NEXT', ''),
        },

        /*
         * Elasticsearch — the single public-facing index. The indexer
         * writes here; the dashboard does not read here. Anything
         * failing the eligibility filter (is_published=1 AND is_active=1)
         * is deleted from the index rather than indexed.
         */
        elasticsearch: {
            host: optional('ELASTICSEARCH_HOST', ''),
            index: optional('ELASTICSEARCH_FRONT_INDEX', 'repo_public'),
            shards: integer('ELASTICSEARCH_SHARDS', 3),
            replicas: integer('ELASTICSEARCH_REPLICAS', 2),
            timeout_ms: integer('ELASTICSEARCH_TIMEOUT_MS', 10000),
            /*
             * ca_cert_file — PEM of CA certs to trust in addition to
             *   Node's bundled roots.
             * reject_unauthorized — false disables cert verification for
             *   the ES connection entirely. Dev only; the ES client logs
             *   a warning at boot when it is off.
             */
            ca_cert_file: optional('ELASTICSEARCH_CA_CERT_FILE', ''),
            reject_unauthorized: boolean('ELASTICSEARCH_REJECT_UNAUTHORIZED', true),
        },
        /*
         * Indexer worker. Note `concurrency` here means max rows per ES
         * `_bulk` request, not parallel HTTP requests.
         */
        indexer: {
            enabled: boolean('INDEXER_ENABLED', true),
            concurrency: integer('INDEXER_CONCURRENCY', 50),
            poll_ms: integer('INDEXER_POLL_MS', 8000),
            /*
             * Consecutive per-row failures before the row is
             * dead-lettered (index_error recorded, no longer auto-
             * requeued). A whole-batch ES transport failure does not
             * count toward this cap.
             */
            max_attempts: integer('INDEXER_MAX_ATTEMPTS', 5),
        },

        /*
         * ArchivesSpace — source of truth for descriptive metadata. The
         * metadata-refresh worker fetches records here and writes them
         * into tbl_objects.mods + display_record.
         *
         * `host` is the base URL of an ASpace API endpoint; the worker
         * appends the stored `uri` path tail per record.
         */
        archivespace: {
            host: optional('ARCHIVESPACE_HOST', ''),
            user: optional('ARCHIVESPACE_USER', ''),
            password: optional('ARCHIVESPACE_PASSWORD', ''),
            repository_id: optional('ARCHIVESPACE_REPOSITORY_ID', ''),
            // Per-fetch timeout.
            timeout_ms: integer('ARCHIVESPACE_TIMEOUT_MS', 15000),
            /*
             * Minimum spacing between ingest-stage ASpace record fetches,
             * process-wide (libs/aspace_session.js). 0 disables pacing.
             * Does not affect the metadata worker or dashboard requests.
             */
            fetch_min_interval_ms: integer('ASPACE_FETCH_MIN_INTERVAL_MS', 10000),
            /*
             * Rotate the AS session token every N requests during a
             * long-running batch. Runs at end-of-tick. 0 disables
             * rotation (one token for the whole batch).
             */
            token_rotate_after_requests: integer(
                'ARCHIVESPACE_TOKEN_ROTATE_AFTER_REQUESTS',
                500
            ),
            /*
             * Metadata transformer source.
             *   false — fetch <uri>/repository, the DU custom AS plugin
             *           endpoint returning a pre-flattened shape.
             *   true  — fetch the native AS endpoint with ?resolve[]=
             *           params and flatten locally via
             *           libs/archivesspace_transform.js.
             */
            use_transformer: boolean('ASPACE_USE_TRANSFORMER', false),
            /*
             * Transformer schema version, stamped into the stored
             * display_record envelope so differential refresh can detect
             * a shape change even when AS mtime has not moved. Bump when
             * transform() rules change.
             */
            transformer_version: optional('ASPACE_TRANSFORMER_VERSION', '1'),
        },
        /*
         * Metadata-refresh worker. Caps ASpace requests in flight; staff
         * can re-enqueue any batch the worker has not started.
         */
        metadata_worker: {
            // Max concurrent ASpace fetches across all batches.
            concurrency: integer('METADATA_WORKER_CONCURRENCY', 3),
            // Poll interval for claiming new rows (legacy env name).
            poll_ms: integer('METADATA_UPDATE_TIMER', 8000),
            /*
             * Per-PID enqueue cap for the bulk action. The
             * collection-scoped variant has no cap.
             */
            max_batch_pids: integer('METADATA_MAX_BATCH_PIDS', 100),
            // Skip the worker entirely (tests, read-only dashboard).
            enabled: boolean('METADATA_WORKER_ENABLED', true),
            /*
             * Per-row retry budget. On failure the worker flips the row
             * back to PENDING and increments `attempts`; at this cap the
             * row transitions to DEAD_LETTERED (terminal). Applies to
             * all refresh kinds.
             */
            max_attempts: integer('METADATA_MAX_ATTEMPTS', 3),
            /*
             * Orphan sweep. Each tick, before claiming new rows, the
             * worker resets any row that has been IN_PROGRESS longer
             * than this.
             */
            orphan_reset_seconds: integer('METADATA_ORPHAN_RESET_SECONDS', 300),
            /*
             * Per-row retry backoff. mark_failed sets
             * next_attempt_at = now() + backoff, doubling on each
             * subsequent failure up to retry_max_backoff_ms. Set base to
             * 0 to disable (rows return to PENDING immediately).
             */
            retry_base_backoff_ms: integer('METADATA_RETRY_BASE_BACKOFF_MS', 30000),
            retry_max_backoff_ms: integer('METADATA_RETRY_MAX_BACKOFF_MS', 300000),
        },

        /*
         * System-wide metadata refresh — refreshes every active row in
         * tbl_objects via the metadata worker, with the producer pacing
         * enqueue so the queue table does not balloon.
         */
        metadata_system_refresh: {
            // Producer cadence + rows enqueued per tick.
            poll_ms: integer('METADATA_REFRESH_PRODUCER_POLL_MS', 5000),
            chunk_size: integer('METADATA_REFRESH_CHUNK_SIZE', 500),
            /*
             * Queue priority for system-refresh rows. On-demand rows are
             * 0, so the worker drains those first.
             */
            priority: integer('METADATA_REFRESH_PRIORITY', 5),
            // Opt-in; the cron expression is wired separately.
            cron_enabled: boolean('METADATA_REFRESH_CRON_ENABLED', false),
        },

        /*
         * TN service — generates thumbnails per object from source
         * files. Lookup is by the row's PID (passed as the path UUID);
         * auth is an API key in the query string. The disk cache is
         * write-once with no TTL, written atomically (temp + rename).
         */
        tn_service: {
            url: optional('TN_SERVICE', ''),
            api_key: optional('TN_SERVICE_API_KEY', ''),
            timeout_ms: integer('TN_SERVICE_TIMEOUT_MS', 30000),
            cache_path: optional('TN_CACHE_PATH', './public/tn_cache'),
        },

        /*
         * Convert service — DU's TIFF→JPG derivative generator. The
         * convert/ subsystem submits objects one at a time, paced
         * `delay_ms` apart. Auth is an api_key query param. When
         * url/api_key are empty the worker idles and the dashboard shows
         * a "not configured" notice.
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
            // Enqueue-time clamp on a single collection's fan-out.
            max_batch: integer('CONVERT_MAX_BATCH', 5000),
            // How many payloads the dry-run preview lists (count is exact).
            preview_sample: integer('CONVERT_PREVIEW_SAMPLE', 25),
            /*
             * Post-conversion verification. The convert service ACKs 202
             * before converting (fire-and-forget), so an OK queue row
             * proves nothing about the derivative — libspec02's full
             * disk produced 0-byte JPGs while every row read "OK"
             * (2026-08-04). When enabled, the worker probes the
             * service's GET /image endpoint on the tick AFTER each POST
             * and only then marks the row COMPLETE; empty or missing
             * derivatives mark FAILED (paced retry, then terminal).
             */
            verify_enabled: boolean('CONVERT_VERIFY_ENABLED', true),
            // Missing-file checks per row before failing (one per tick).
            verify_max_checks: integer('CONVERT_VERIFY_MAX_CHECKS', 3),
        },

        /*
         * Derivative-image gateway (images/): serves JPG derivatives to
         * the public frontend + Cantaloupe by streaming from the convert
         * service's GET /image endpoint (derived from CONVERT_SERVICE).
         * The key gates raw filename access — unpublished derivatives
         * must not be enumerable without it. Unset → gateway refuses 503.
         */
        images: {
            api_key: optional('IMAGES_API_KEY', ''),
        },

        /*
         * DuraCloud — streams thumbnails for legacy rows whose
         * `thumbnail` column holds a dip-store-relative path
         * (<dip_path>/thumbnails/<uuid>.jpg) rather than a URL. A
         * staff-only proxy route fetches them server-side. When `api` is
         * empty the proxy returns the local placeholder.
         */
        duracloud: {
            /*
             * Host + path prefix WITHOUT scheme, e.g.
             * "digitaldu.duracloud.org/durastore/". The lib prepends
             * `https://`.
             */
            api: optional('DURACLOUD_API', ''),
            user: optional('DURACLOUD_USER', ''),
            password: optional('DURACLOUD_PWD', ''),
            // Wall-clock timeout for a single thumbnail fetch.
            timeout_ms: integer('DURACLOUD_TIMEOUT_MS', 15000),
        },

        /*
         * Archivematica — preservation pipeline. Two APIs with separate
         * credentials:
         *   - dashboard API (transfer/ingest), auth via username +
         *     api_key in the query string. The worker's primary surface.
         *   - Storage Service API (file/space endpoints, AIP deletion),
         *     auth via `Authorization: ApiKey user:key`. Used by
         *     rollback flows.
         *
         * `timeout_ms` bounds a single HTTP call only; the worker layers
         * its own long-poll budgets on top.
         */
        archivematica: {
            // Dashboard API base URL; must include a trailing slash.
            api: optional('ARCHIVEMATICA_API', ''),
            username: optional('ARCHIVEMATICA_USERNAME', ''),
            api_key: optional('ARCHIVEMATICA_API_KEY', ''),
            // Storage Service API — separate creds + URL.
            storage_api: optional('ARCHIVEMATICA_STORAGE_API', ''),
            storage_username: optional('ARCHIVEMATICA_STORAGE_USERNAME', ''),
            storage_api_key: optional('ARCHIVEMATICA_STORAGE_API_KEY', ''),
            /*
             * Transfer-source UUID + path inside it. start_transfer
             * base64-encodes "<source>:<path>/<collection>/<package>".
             */
            transfer_source: optional('ARCHIVEMATICA_TRANSFER_SOURCE', ''),
            sftp_remote_path: optional('SFTP_REMOTE_PATH', ''),
            /*
             * Identifies the deletion requester to AM Storage Service;
             * stamped into AM's deletion-approval audit record.
             */
            pipeline: optional('ARCHIVEMATICA_PIPELINE', ''),
            user_id: optional('ARCHIVEMATICA_USERID', ''),
            user_email: optional('ARCHIVEMATICA_USER_EMAIL', ''),
            /*
             * Storage-space UUIDs for the optional
             * get_dip_storage_usage / get_aip_storage_usage helpers.
             * Unset → those helpers return null.
             */
            storage_dip_uuid: optional('ARCHIVEMATICA_DIP_UUID', ''),
            storage_aip_uuid: optional('ARCHIVEMATICA_AIP_UUID', ''),
            // Per-request timeout for all calls except start_transfer.
            timeout_ms: integer('ARCHIVEMATICA_TIMEOUT_MS', 60000),
            /*
             * start_transfer gets its own budget: AM filesystem-probes
             * every file in the staged package before responding, which
             * for multi-GB media can take minutes.
             */
            start_transfer_timeout_ms: integer(
                'ARCHIVEMATICA_START_TRANSFER_TIMEOUT_MS',
                10 * 60 * 1000
            ),
        },

        /*
         * Handle.net — persistent-identifier minting. Every ingested
         * object gets a handle URL in tbl_objects.handle; update
         * re-points an existing handle at the current target.
         *
         * Reads go over HTTP (libs/handles.js); writes go through the
         * DuHandleTool Java helper on the native protocol
         * (libs/handle_writer.js).
         *
         *   admin_url       handle server HTTP interface, resolution
         *                   only (origin only, no path)
         *   admin_id        prefix administrator, index and handle, in
         *                   the form "300:0.NA/10176"
         *   admin_key_path  Handle-format private key (admpriv.bin),
         *                   read directly by the Java helper
         *   admin_passphrase  decrypts admin_key_path
         *   client_lib      handle client's lib/ directory; the only
         *                   host-specific part of helper_classpath
         *   target          what handles resolve TO; affects future
         *                   mints and updates only, never existing
         *                   handles retroactively
         *   server+prefix   form the public handle URL stored in the DB,
         *                   independent of `target`
         */
        handles: {
            admin_url: optional('HANDLE_ADMIN_URL', ''),
            admin_id: optional('HANDLE_ADMIN_ID', ''),
            admin_key_path: optional('HANDLE_ADMIN_KEY_PATH', ''),
            admin_passphrase: optional('HANDLE_ADMIN_PASSPHRASE', ''),
            java_bin: optional('HANDLE_JAVA_BIN', 'java'),
            client_lib: optional('HANDLE_CLIENT_LIB', ''),
            helper_classpath: handle_helper_classpath(),
            target: optional('HANDLE_TARGET', ''),
            /*
             * Hosts a hand-minted handle may point at. Comma-separated;
             * a value matches if the target host equals it or is a
             * subdomain of it. Unset falls back to the host of
             * HANDLE_TARGET.
             */
            allowed_target_hosts: optional('HANDLE_ALLOWED_TARGET_HOSTS', ''),
            /*
             * Tokens marking a BATCH (collection folder) as a test run,
             * whose ingests must not mint a handle. Comma-separated,
             * case-insensitive, matched as whole delimiter-separated
             * tokens — not substrings, not prefixes. Not applied to the
             * package name.
             */
            skip_batch_tokens: optional('HANDLE_SKIP_BATCH_TOKENS', 'test'),
            prefix: optional('HANDLE_PREFIX', ''),
            server: optional('HANDLE_SERVER', ''),
            ttl: integer('HANDLE_TTL', 86400),
            timeout_ms: integer('HANDLE_TIMEOUT_MS', 30000),
        },

        /*
         * Kaltura — media platform. kaltura/* looks each file up by
         * EXACT_MATCH filename and persists entry IDs into
         * tbl_kaltura_ids; the repository build stage reads those back
         * when stamping `kaltura_id` onto per-part metadata.
         *
         * partner_id + user_id + secret_key are all required to boot the
         * SDK; routes 503 when any is unset.
         * public_video_metadata_profile_id is used only by the legacy
         * /export flow.
         */
        kaltura: {
            partner_id: optional('KALTURA_PARTNER_ID', ''),
            user_id: optional('KALTURA_USER_ID', ''),
            secret_key: optional('KALTURA_SECRET_KEY', ''),
            public_video_metadata_profile_id: integer(
                'KALTURA_PUBLIC_VIDEO_METADATA_PROFILE_ID',
                0
            ),
            session_expiry_s: integer('KALTURA_SESSION_EXPIRY_S', 24 * 60 * 60),
            /*
             * Per-call wall-clock timeouts raced against the SDK, which
             * surface UpstreamError on expiry.
             */
            session_timeout_ms: integer('KALTURA_SESSION_TIMEOUT_MS', 10_000),
            search_timeout_ms: integer('KALTURA_SEARCH_TIMEOUT_MS', 15_000),
        },

        /*
         * Curation service — one Python service hosting both workflow
         * surfaces, sharing a host and an X-API-Key:
         *   - /api/v2/qa/*      pre-ingest folder management, SFTP push,
         *                       upload status (ingester/libs/qa_service.js)
         *   - /api/v1/astools/* workspace inventory, make-digital-objects,
         *                       revert, uri.txt (ingester/libs/astools.js)
         *
         * CURATION_API / CURATION_API_KEY are canonical; the legacy
         * QA_SERVICE / ASTOOLS_SERVICE pairs are honored as fallbacks.
         *
         *   timeout_ms       default per-request budget
         *   move_timeout_ms  QA move-to-sftp / folder moves
         *   mdo_timeout_ms   AStools make-digital-objects
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
         * Ingest worker. Drives packages through the 5-stage pipeline
         * (process_metadata → upload → AM transfer/ingest → DuraCloud →
         * repository). The stage-specific timeouts bound the long polls
         * each stage performs against upstream services.
         */
        ingest_worker: {
            enabled: boolean('INGEST_WORKER_ENABLED', true),
            // Max rows in flight through stages 1-2.
            concurrency: integer('INGEST_WORKER_CONCURRENCY', 2),
            // How often the worker wakes to claim new PENDING rows.
            poll_ms: integer('INGEST_WORKER_POLL_MS', 5000),

            /*
             * AM-active gate. False (default) admits at most one row at
             * a time into the AM window (UPLOAD_COMPLETE through
             * INGEST_IN_PROGRESS). True allows parallel start_transfer
             * calls bounded only by `concurrency` — tests and small dev
             * batches only, not production.
             */
            am_parallel: boolean('INGEST_AM_PARALLEL', false),
            /*
             * Serial pipeline. One package at a time through stages 1-5;
             * the next starts only after the previous one's repository
             * record is created. Stage 6 runs in the background either
             * way. 0 restores interleaved (AM-only gating) behavior.
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
             * Stage 5 success hold. The row sits at COMPLETE with
             * is_complete=0 for this long before flipping to
             * is_complete=1 and dropping out of the "Open only" view.
             */
            complete_hold_ms: integer('INGEST_COMPLETE_HOLD_MS', 4000),
        },

        /*
         * AIP-store Stage 6 — preservation copy from Archivematica
         * Storage Service to Wasabi S3, fired after Stage 5 finalizes
         * the repository record. Node calls the curation API
         * (POST /api/v2/aip/copy-to-wasabi); Wasabi credentials live in
         * the Python service. State machine in
         * ingester/stages/aip_store.js, wire client in
         * ingester/libs/aip_store_client.js.
         */
        aip_store: {
            // Off skips Stage 6 entirely; Stage 5 finalizes as terminal.
            enabled: boolean('AIP_STORE_ENABLED', false),
            /*
             * One AIP copy at a time. Stage 6 sits outside the
             * serial-pipeline gate, so this is its own gate. 0 restores
             * parallel Stage 6.
             */
            serial: boolean('AIP_STORE_SERIAL', true),
            /*
             * Wall-clock budget for /copy-to-wasabi. On timeout the row
             * records AIP_STORE_FAILED and can be retried from the
             * dashboard.
             */
            copy_timeout_ms: integer('AIP_STORE_COPY_TIMEOUT_MS', 60 * 60 * 1000),
            /*
             * Cadence of the byte-progress side-poll that runs while
             * /copy-to-wasabi is in flight; each poll GETs
             * /aip/copy-progress/<uuid> and persists bytes to the queue
             * row. 0 disables the poller.
             */
            progress_poll_ms: integer('AIP_STORE_PROGRESS_POLL_MS', 60_000),
            // Presigned-URL TTL for dashboard downloads.
            presign_ttl_seconds: integer('AIP_STORE_PRESIGN_TTL_SECONDS', 900),
            // Retry backoff; same semantics as metadata_worker.retry_*.
            retry_base_backoff_ms: integer('AIP_STORE_RETRY_BASE_BACKOFF_MS', 60_000),
            retry_max_backoff_ms: integer('AIP_STORE_RETRY_MAX_BACKOFF_MS', 30 * 60 * 1000),
            /*
             * Auto-retry cap before the row sits at AIP_STORE_FAILED
             * awaiting the dashboard retry button, which resets attempts
             * and clears next_attempt_at.
             */
            max_attempts: integer('AIP_STORE_MAX_ATTEMPTS', 5),
            /*
             * Separate, more generous budget for "AIP not found in AM
             * Storage Service", which may mean a genuine orphan or an
             * AIP that AM has not finished registering. An orphan is
             * declared only once it is still not found at the end of
             * this budget.
             */
            not_found_max_attempts: integer('AIP_STORE_NOT_FOUND_MAX_ATTEMPTS', 8),
            /*
             * Synthetic queue rows enqueued per "Start backfill" click
             * (ingester/aip_backfill.js). Clamped server-side to
             * [1, 10000].
             */
            backfill_chunk_size: integer('AIP_STORE_BACKFILL_CHUNK_SIZE', 1000),
        },

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
