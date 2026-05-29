# repo-backend-v2

> Digital DU Repository back-end — modernized rebuild of `digitaldu-backend`, with `digitaldu-backend-ingest-service` folded in.

This is the unified v2 codebase. It supersedes the two legacy services:

- `digitaldu-backend` — repository CRUD, search, indexer, dashboard, public API.
- `digitaldu-backend-ingest-service` — ingest pipeline, ASpace QA, Kaltura packaging, migration tools.

The merge and modernization plans live under [docs/](./docs/):

- [docs/MODERNIZATION_PLAN.md](./docs/MODERNIZATION_PLAN.md) — phased plan for security, stability, maintainability, async/await refactor, HTMX dashboard.
- [docs/MERGE_PLAN.md](./docs/MERGE_PLAN.md) — strategy for folding the ingest-service into this codebase.

## Status

| Phase                                              | Status                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Repo hygiene + scaffolding                     | ✅ Done                                                                                                                                      |
| 1 — Security hardening                             | ✅ Done (helmet, CORS, body limits, sanitize, JWT cookies, rate limit, request-id, error handler, graceful shutdown)                         |
| 2 — Dependency upgrade                             | ✅ Greenfield deps current                                                                                                                   |
| 3 — Async/await refactor (port code)               | ✅ All domains ported (auth, users, repository, collections, search, stats, indexer, api, uploads, dashboard)                                |
| 4 — Stability (DB pool sizing + drain on shutdown) | ✅ Pool sized, drained on SIGTERM, DB health checks live                                                                                     |
| 5 — Tests                                          | ✅ 1,478 tests across unit / integration / e2e tiers                                                                                         |
| 6 — HTMX dashboard                                 | ✅ Home, Stats, Collections, Objects, Users, AIPs, ingest workflow (MDO / ASpace QA / Packaging / Queue / History), admin tools              |
| 7 — Observability                                  | 🟢 Structured logs + request-id + per-row timelines; metrics still deferred                                                                  |
| 8 — Merge with ingest-service                      | ✅ Done — ingest worker, 5-stage pipeline, ASpace QA tooling, Kaltura packaging, migration utilities all live in this codebase               |
| 9 — Preservation tier (AIP store)                  | ✅ Stage 6 AIP→Wasabi copy, admin backfill, /dashboard/aips browse + download via presigned URLs                                             |
| 10 — System-refresh hardening                      | ✅ Concurrency cap, exponential backoff, serialized ticks, periodic ASpace session-token rotation, opt-in resume-from-cancel                 |

## Stack

- **Runtime:** Node.js 20+ (pinned via `.nvmrc`).
- **Framework:** Express 5 — native async error forwarding, no wrap-helper needed.
- **Modules:** CommonJS (for porting compatibility with the legacy projects).
- **Database:** MariaDB / MySQL 8 via knex 3 — two pools, one for `repo`, one for `repo_queue`.
- **Search:** Elasticsearch 8 (single public-facing index in v2; the legacy admin/back index was retired in favor of MariaDB-backed staff queries).
- **Templates:** EJS with HTMX-driven partials. Bootstrap 5 + DU theme tokens.
- **Tests:** vitest 3 — unit, integration, and e2e tiers under `tests/`.
- **Lint/format:** ESLint 9 (flat config) + Prettier 3.

### External services it speaks to

| Service                       | Role                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| **Archivematica + AM Storage Service** | Ingest pipeline target. Stage 3 starts transfers; Stage 4 polls ingest; AIP retrieved via Storage Service API for the preservation copy. |
| **ArchivesSpace**             | Source of truth for descriptive metadata. On-demand + system-wide refresh both fetch from here.   |
| **DuraCloud**                 | Active storage tier for AIPs (post-AM). Thumbnail proxy reads legacy thumbnails from here.        |
| **Wasabi S3** (`library-repository/aip-store/`) | Preservation tier. Stage 6 + backfill copy AIPs here via the curation API.            |
| **Curation API** (Python)     | Wasabi gatekeeper. Holds the boto3 credentials; v2 talks HTTP to it for both SFTP-staging and AIP copies. Also owns AM-folder QA. |
| **Handle service**            | Mints persistent identifiers per object.                                                          |
| **TN service**                | Generates fresh thumbnails from source files.                                                     |
| **Kaltura**                   | Streaming media for AV-bearing objects.                                                           |
| **DU SSO** (authproxy)        | Single sign-on (layered defense: IP allowlist + timestamp + HMAC).                                |

## Layout

```
repo-backend-v2/
├── repo-backend-v2.js               # entry point — wires Express, workers, graceful shutdown
├── config/                          # app, db, express, security configuration
├── auth/                            # JWT, login, SSO (sso/ subdir for the layered SSO machinery)
├── users/                           # user CRUD + JWT token claims
├── repository/                      # objects + collections CRUD
│   └── aip_store_model.js           # tbl_aip_store data layer
├── collections/                     # collection-scoped reads (members, detail)
├── search/                          # public + dashboard search
├── indexer/                         # ES indexer worker + reindex admin
├── stats/                           # stats endpoints (counts, storage usage)
├── api/                             # public REST API (v1 shape)
├── uploads/                         # thumbnail upload
├── metadata/                        # metadata refresh queue + worker + producer
│   └── admin_controller.js          # system-wide refresh admin surface
├── ingester/                        # 5-stage ingest pipeline (+ Stage 6 for AIPs)
│   ├── stages/                      # process_metadata → upload → transfer → ingest → repository → aip_store
│   ├── lib/                         # METS parser, repository builder
│   ├── libs/                        # external clients (qa_service, astools, aip_store_client)
│   ├── worker.js                    # state-machine worker with AM single-row gate
│   ├── aip_backfill.js              # admin-initiated AIP catch-up
│   └── workspace.js                 # pre-ingest workspace (MDO, ASpace QA, Packaging)
├── astools/                         # ArchivesSpace tooling endpoints
├── kaltura/                         # Kaltura packaging hooks
├── migration/                       # legacy → v2 data migration utilities
├── dashboard/                       # HTMX dashboard layer (controller + AIP/backfill sub-controllers)
├── libs/                            # shared clients + helpers
│   ├── archivematica.js             # AM main + Storage Service client
│   ├── archivesspace.js             # AS REST client with token rotation
│   ├── archivesspace_transform.js   # in-process transformer (replaces the DU AS plugin)
│   ├── duracloud.js                 # DC fetch (text + thumbnail)
│   ├── elasticsearch.js             # ES client wrapper + index lifecycle
│   ├── handles.js                   # Handle service client
│   ├── tn_service.js                # TN thumbnail derivative client
│   ├── jwt.js / sanitize.js / errors.js / log.js / health.js / request_id.js
│   └── object_projection.js         # display_record enrichment for table rows
├── knex/migrations/                 # repo + repo_queue schema (idempotent, prod-safe)
├── db/                              # programmatic schema bootstrap (used by tests)
├── public/                          # static assets (HTMX, Bootstrap, theme, dashboard.js)
├── views/                           # EJS
│   ├── dashboard/                   # page-level views (home, stats, objects, collections, aips, ingest, …)
│   │   ├── admin/                   # admin surfaces (indexer, metadata-refresh, services, aip-backfill)
│   │   └── partials/                # HTMX fragments (rows, modals, status panels)
├── tests/                           # 1,478 passing
│   ├── unit/                        # pure functions, no I/O
│   ├── integration/                 # real sqlite-in-memory via knex
│   ├── e2e/                         # full app via supertest
│   └── helpers/                     # shared test setup + seeders
├── docs/                            # plans, ADRs, ops notes
├── .github/workflows/               # CI
├── logs/                            # runtime logs (gitignored)
├── tmp/                             # scratch (gitignored)
└── uploads/                         # upload sink (gitignored)
```

## Dashboard

Staff log in via DU SSO (or a local dev shortcut) and land on `/dashboard/`. The HTMX-driven surface is the primary day-to-day affordance:

| Page                                      | Purpose                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/dashboard/`                             | At-a-glance home — recent ingests, top collections, quick links                                                          |
| `/dashboard/stats`                        | Aggregate counts, DuraCloud + AM storage usage, ingests-per-year chart                                                   |
| `/dashboard/collections`                  | Browse + detail; per-collection metadata refresh + members view                                                          |
| `/dashboard/objects`                      | Flat object browse + multi-select bulk actions (publish, suppress, soft-delete, refresh metadata)                        |
| `/dashboard/aips`                         | Preservation tier — browse, search, download AIPs via presigned Wasabi URLs; retry failed copies                         |
| `/dashboard/users`                        | User CRUD                                                                                                                |
| `/dashboard/ingest/*`                     | Pre-ingest workspace: Make Digital Objects, ASpace QA, Packaging & Ingesting, Queue, History                             |
| `/dashboard/admin/indexer`                | ES indexer status + reindex-all                                                                                          |
| `/dashboard/admin/metadata-refresh`       | System-wide ASpace metadata refresh — start, cancel, resume-from-last-cancel, live progress                              |
| `/dashboard/admin/aip-backfill`           | Catch-up Stage 6 against pre-flag AIPs (chunked, paced)                                                                  |
| `/dashboard/admin/services`               | Services Health — live probes for ES, AS, AM, DC, Handle, TN, Wasabi                                                     |

Every action that mutates state surfaces an HX-Trigger toast for confirmation; long-running operations (system refresh, AIP copy, AIP backfill) use polled status partials + cancel affordances.

## Ingest pipeline

A six-stage state machine. Each stage is idempotent on resume; the worker awaits external systems (AM, DC, curation) on bounded budgets and only advances state when the upstream confirms.

```
Stage 1 (process_metadata) → ASpace fetch + transformer → workspace metadata snapshot
Stage 2 (upload)           → SFTP push to Archivematica drop
Stage 3 (transfer)         → AM start_transfer + approval + transfer polling
Stage 4 (ingest)           → AM ingest poll + DuraCloud propagation wait
Stage 5 (repository)       → tbl_objects insert + handle mint + SFTP cleanup + move-to-ingested (Wasabi staging copy)
Stage 6 (aip_store)        → Curation /copy-to-wasabi → AIP lands in library-repository/aip-store/
```

Stage 6 is gated by `AIP_STORE_ENABLED`. With the flag off, Stage 5 finalizes ingest the same way it did pre-Stage-6. With the flag on, the worker hands off automatically. The single-row AM gate at Stages 3–4 prevents AM from being overwhelmed by parallel transfers.

## System-wide metadata refresh

Admin-initiated, queue-paced re-fetch of every active object's ASpace metadata. The hardening lever inventory (all configurable via env):

| Lever                                       | Default | Purpose                                                                                |
| ------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `ARCHIVESPACE_TIMEOUT_MS`                   | 30 s    | Per-request ceiling                                                                    |
| `METADATA_WORKER_CONCURRENCY`               | 1       | Parallel ASpace fetches                                                                |
| `METADATA_UPDATE_TIMER`                     | 12 s    | Tick cadence                                                                           |
| `METADATA_MAX_ATTEMPTS`                     | 3       | Retry budget per row                                                                   |
| `METADATA_RETRY_BASE_BACKOFF_MS` / `_MAX_`  | 30 s / 5 min | Exponential backoff between retries                                              |
| `ARCHIVESPACE_TOKEN_ROTATE_AFTER_REQUESTS`  | 500     | Rotate AS session token periodically to flatten per-session-cache buildup              |

The admin page exposes a **Resume from last cancelled batch** opt-in checkbox. With it checked, the new batch inherits the prior cancelled batch's cursor instead of restarting from `tbl_objects.id=0`.

## Preservation tier (AIP store)

AIPs produced by Archivematica land in DuraCloud as part of standard AM operation, then get a second copy in **Wasabi S3** (`library-repository/aip-store/`) for long-term preservation. v2 owns the second copy:

- **Live ingest:** Stage 6 fires automatically when `AIP_STORE_ENABLED=true`.
- **Backfill:** `/dashboard/admin/aip-backfill` chews through objects that pre-date the flag, in operator-controlled chunks (default 1,000 per click).
- **Catalog:** `tbl_aip_store` holds one row per AIP. ~20,800 legacy rows from the one-time DuraCloud → Wasabi migration plus ingest-time rows from Stage 6.
- **Orphans:** AIPs AM has no record of (mostly legacy artifacts whose AM packages were already deleted) are tagged `is_migrated=8` and excluded from retries.
- **Downloads:** Dashboard renders a presigned Wasabi URL via the curation API; bytes never transit v2.

## Curation API integration

The Python curation service (`digitaldu-backend-curation-service`) is the gatekeeper for everything that touches Wasabi + AM filesystem state. v2 talks to it over HTTP under two prefixes:

- `/api/v2/qa/*` — pre-ingest workspace + SFTP staging operations
- `/api/v2/aip/*` — AIP copy + presigned URLs (added by `curration-api-modified-4` / `-5`)

Wasabi credentials live in the curation service's env, not v2's. v2 carries the `CURATION_API` URL + `CURATION_API_KEY` (X-API-Key header).

## Getting started

```sh
# 1. Use the pinned Node version
nvm use

# 2. Configure secrets
cp .env-example .env
# Edit .env with your local DB/ES/auth values

# 3. Install
npm install

# 4. Run database migrations (idempotent — safe to re-run)
npm run migrate:all

# 5. Run tests
npm test

# 6. Start the app
npm start
```

For development with auto-reload:

```sh
npm run dev
```

`.env-example` documents every supported environment variable inline with the rationale and default; copy it to `.env` and edit the values that aren't already correct for your machine.

## Scripts

| Command                                       | What it does                                          |
| --------------------------------------------- | ----------------------------------------------------- |
| `npm start`                                   | Boot the app.                                         |
| `npm run dev`                                 | Boot with `--watch` (restart on file change).         |
| `npm test`                                    | Run every test tier (unit + integration + e2e).       |
| `npm run test:unit` / `:integration` / `:e2e` | Run a single tier.                                    |
| `npm run test:watch`                          | Vitest watch mode.                                    |
| `npm run test:coverage`                       | Coverage report under `coverage/`.                    |
| `npm run lint` / `npm run lint:fix`           | ESLint check / autofix.                               |
| `npm run format` / `npm run format:check`     | Prettier write / check.                               |
| `npm run migrate:repo`                        | Apply pending migrations to the `repo` DB.            |
| `npm run migrate:queue`                       | Apply pending migrations to the `repo_queue` DB.      |
| `npm run migrate:all`                         | Both of the above, in order.                          |
| `npm run migrate:status:repo` / `:queue`      | Show pending migrations without applying.             |
| `npm run migrate:rollback:repo` / `:queue`    | Roll back the last batch (use with care in prod).     |
| `npm run migrate:make:repo` / `:queue <name>` | Scaffold a new migration file.                        |

## Tests

```sh
npm test                          # full suite
npm run test:unit                 # pure-function tests, no I/O
npm run test:integration          # in-memory sqlite via knex
npm run test:e2e                  # full app via supertest
npm run test:coverage             # generates coverage/ report
```

Integration + e2e use an in-memory sqlite DB that's bootstrapped from the same migration files as production — so a schema change ships with its migration once and applies everywhere (test, dev, prod).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache 2.0](./LICENSE).
