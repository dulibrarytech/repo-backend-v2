# Merging `digitaldu-backend-ingest-service` into `digitaldu-backend`

> Status: proposal, depends on [MODERNIZATION_PLAN.md](./MODERNIZATION_PLAN.md).
> Goal: one cohesive application that owns repository CRUD, search, indexing, dashboard, **and** ingest pipeline — eliminating duplicate Express scaffolding, duplicate DB pools, duplicate `libs/dom.js`, duplicate views.

This document is paired with [MODERNIZATION_PLAN.md](./MODERNIZATION_PLAN.md). Run that plan first (or in parallel) so the merge lands on a cleaned-up base instead of inheriting both projects' tech debt.

---

## 1. Why merge

The two services share more than they don't:

- **Same databases.** Both connect to `repo` (containing `tbl_objects`, `tbl_users`) and `repo_queue` (containing `tbl_ingest_queue`, `tbl_jobs`, `tbl_kaltura_ids`, `tbl_kaltura_package_queue`, `tbl_metadata_update_queue`). See [repo-db-schema.sql](../repo-db-schema.sql) and [repo_queue-schema.sql](../repo_queue-schema.sql).
- **Same libraries duplicated by copy-paste.** `libs/dom.js`, `libs/log4.js`, knex configs, helmet/express setup. Every fix has to land twice.
- **No clear API boundary between them.** The "ingest service" calls the "backend" indexer, the backend embeds an iframe-redirect to the ingest-service dashboard ([dashboard-import.ejs](views/dashboard-import.ejs)). They are conceptually one application split for accidental reasons.
- **Operationally fragile.** Two processes, two .env files, two log streams, two systemd units (or two PM2 entries), and one shared queue table they coordinate through.

What the merger buys:
- One deployment, one config, one log stream, one healthcheck.
- One auth surface — the API key the ingest dashboard uses can be retired in favor of the existing JWT.
- The HTMX v2 dashboard from ingest-service becomes the dashboard for the whole app (per [MODERNIZATION_PLAN.md §9](./MODERNIZATION_PLAN.md)).
- Single source of truth for shared `libs/`.

What it does **not** buy:
- It does not change the database layout. `repo` and `repo_queue` stay as separate schemas (and likely separate physical DBs). They are accessed via two knex instances today and will continue to be.
- It does not eliminate the need for the ingest *pipeline workers* — Archivematica polling, ASpace QA, Kaltura packaging — those keep running. They just run in the same Node process.

---

## 2. Pre-merge checklist

Before you start, the digitaldu-backend side must have completed (from [MODERNIZATION_PLAN.md](./MODERNIZATION_PLAN.md)):

- [ ] Phase 0 — secrets removed, `.env*` cleaned up.
- [ ] Phase 1.1 — TLS bypass removed.
- [ ] Phase 2.1 — `dotenv.config()` migration.
- [ ] Phase 4.1 — graceful shutdown handler.

The ingest-service side already has most of the modern patterns we want — async/await throughout, graceful shutdown, explicit pool sizing, the v2 dashboard. The merger is therefore *one-directional*: pull ingest-service into backend, not vice versa.

---

## 3. Target directory layout

The merged repo lives at `digitaldu-backend/`. Suggested top-level structure after merge:

```
digitaldu-backend/
├── repo.js                          # single entry point
├── package.json                     # unified deps (see §5)
├── config/
│   ├── express.js                   # mounts all route groups
│   ├── app_config.js
│   ├── db_config.js                 # repo DB (knex)
│   ├── dbqueue_config.js            # repo_queue DB (knex)
│   ├── db_tables_config.js
│   ├── elasticsearch_config.js
│   ├── token_config.js
│   ├── webservices_config.js
│   ├── archivematica_config.js
│   ├── archivesspace_config.js
│   ├── duracloud_config.js
│   ├── handle_config.js             # from ingest-service
│   ├── kaltura_config.js            # from ingest-service
│   └── index_records_validator_config.js   # from ingest-service
├── libs/                            # de-duplicated
│   ├── dom.js
│   ├── log4.js
│   ├── cache.js
│   ├── directories.js
│   └── ...
├── auth/                            # unchanged
├── users/                           # unchanged
├── repository/                      # unchanged
├── search/                          # unchanged
├── indexer/                         # unchanged
├── stats/                           # unchanged
├── api/                             # unchanged
├── uploads/                         # unchanged
├── dashboard/                       # rebuilt — see §6
│   ├── routes.js
│   ├── controller.js
│   ├── tasks.js
│   └── views/
│       ├── layout.ejs
│       ├── partials/
│       └── ...
├── ingester/                        # from ingest-service
│   ├── routes.js
│   ├── controller.js
│   ├── ingest_service.js
│   ├── dashboard_routes.js          # to be folded into dashboard/
│   ├── dashboard_controller.js      # to be folded into dashboard/
│   ├── dashboard_tasks.js
│   └── ...
├── migration/                       # from ingest-service
├── astools/                         # from ingest-service (ASpace tooling)
├── kaltura/                         # from ingest-service
├── import/                          # current backend import flow — likely deleted (see §7)
├── test/
└── views/
```

The `import/` directory in the current backend is mostly a redirect shim into ingest-service ([views/dashboard-import.ejs](views/dashboard-import.ejs) and [views/dashboard-import-status.ejs](views/dashboard-import-status.ejs)). After merge it disappears entirely — the new dashboard talks directly to `ingester/` routes.

---

## 4. Route namespace plan

Both services already namespace under `APP_CONFIG.app_path` (typically `/repo`). The ingest-service additionally uses `/repo/ingester/*`. After merge:

| Surface | Path prefix | Source |
|---|---|---|
| Public read API | `/repo/api/v1/*` | backend |
| Repository CRUD | `/repo/repository/*` | backend |
| Search | `/repo/search/*` | backend |
| Indexer | `/repo/indexer/*` | backend |
| Auth | `/repo/auth/*` | backend |
| Users | `/repo/users/*` | backend |
| Stats | `/repo/stats/*` | backend |
| Uploads | `/repo/uploads/*` | backend |
| Ingester API | `/repo/ingester/*` | ingest-service |
| Migration tools | `/repo/migration/*` | ingest-service |
| ASpace tools | `/repo/astools/*` | ingest-service |
| Kaltura | `/repo/kaltura/*` | ingest-service |
| Dashboard (HTMX v2) | `/repo/dashboard/*` | merged |
| Health | `/repo/health` | new |

No collisions. The biggest decision is the dashboard: today both projects have one. The merged dashboard adopts the **ingest-service v2 layout shell** and folds in the backend dashboard's screens (objects, users, QA, etc.) as new tabs — as called out in [MODERNIZATION_PLAN.md §9](./MODERNIZATION_PLAN.md).

---

## 5. Dependency reconciliation

Merging two `package.json` files; conflicts and resolutions:

| Package | backend | ingest-service | Resolution |
|---|---|---|---|
| `@elastic/elasticsearch` | ^8.12.2 | ^7.17.0 | **8.x.** Ingest-service must be tested against ES 8 client (mostly drop-in; the indexer in backend already uses 8). |
| `knex` | ^3.1.0 | ^2.4.2 | **3.x.** API differences are minor; ingest-service's queries should port cleanly. |
| `helmet` | ^3.23.3 | ^3.23.3 | Both upgrade to `^7` per [MODERNIZATION_PLAN.md §1.2](./MODERNIZATION_PLAN.md). |
| `dotenv` | ^4.0.0 | ^4.0.0 | Both upgrade to `^16` per [MODERNIZATION_PLAN.md §2.1](./MODERNIZATION_PLAN.md). |
| `uuid` | ^9.0.0 | ^8.3.2 | **9.x.** |
| `node-uuid` | ^1.4.8 | — | Drop entirely. |
| `jsonwebtoken` | ^9.0.2 | ^9.0.0 | 9.x. |
| `axios` | ^1.6.8 | ^1.7.9 | Pin to latest 1.x. |
| `request` | — | ^2.88.2 | **Remove.** Deprecated; replace usages with `axios`. |
| `async` | ^2.6.3 | ^2.6.3 | **Remove.** Use native async/await. |
| `kaltura-client` | — | ^21.13.0 | Keep (ingest-only). |
| `xml2js` | — | ^0.6.2 | Keep (ingest-only). |
| `xmldoc` | ^1.1.2 | ^1.1.2 | Dedupe. |
| `memory-cache` | ^0.2.0 | — | Replace with `lru-cache` per [MODERNIZATION_PLAN.md §2.5](./MODERNIZATION_PLAN.md). |
| `express-template-cache` | ^0.1.0 | — | **Remove.** |
| `nodemailer` | ^6.4.18 | — | Keep. |
| `multer` | ^1.4.2 | — | Upgrade to 2.x per [MODERNIZATION_PLAN.md §1.8](./MODERNIZATION_PLAN.md). |
| `log4js` | ^6.4.1 | ^6.4.1 | Dedupe. |
| Test stack | mocha 9 + chai + supertest | vitest 3 + mocha 11 + chai + supertest | **Standardize on vitest 3.** Migrate any existing mocha tests; ingest-service already runs vitest. |

---

## 6. Dashboard consolidation

This is the largest deliverable of the merge. Detail in [MODERNIZATION_PLAN.md §9](./MODERNIZATION_PLAN.md); here is the merge-specific piece.

**Today:**
- Backend dashboard: full-page EJS at `/repo/dashboard/*`, ~20 views.
- Ingest dashboard: HTMX at `/repo/ingester/dashboard/v2/*`, queue + workspace flow.

**After merge:**
- Single dashboard at `/repo/dashboard/*` using the ingest-service layout shell.
- Sidebar gets a new section for repository administration (objects, users, QA, stats) sitting alongside the existing ingest sections (queue, make-digital-objects, aspace-qa, packaging).
- The "ingest" tab on the old backend dashboard, which redirected to the ingest-service URL, becomes a real in-app nav item — no redirect.

Suggested sidebar (final state):

```
Repository
  ├── Home (stats overview)
  ├── Objects
  ├── Collections
  ├── Users
  └── QA

Ingest
  ├── Queue
  ├── Make Digital Objects
  ├── ASpace QA
  └── Packaging & Ingest

Tools
  ├── Migration
  ├── ASpace tools
  └── Kaltura

Admin
  ├── Stats
  └── Logs
```

Auth: the ingest dashboard uses `X-API-Key`. Replace with the backend's JWT — issued as an httpOnly cookie for browser, header for API. One mechanism, both halves of the app.

---

## 7. Migration sequence

The merge should be done as a series of small, individually-shippable PRs against `digitaldu-backend`. Each PR can be reviewed and rolled back independently.

### Step 1 — Land the modernization base
- Phases 0–4 from [MODERNIZATION_PLAN.md](./MODERNIZATION_PLAN.md). Async/await refactor is the heaviest prereq.

### Step 2 — Copy ingest-service libs and reconcile
- Copy `libs/` from ingest-service, diff against backend's `libs/`, dedupe. Pick the newer/cleaner implementation per file.
- Copy the configs unique to ingest-service: `handle_config.js`, `kaltura_config.js`, `index_records_validator_config.js`.
- Verify both `db_config.js` files target the same connections. They should — both point at `repo` and `repo_queue` via env vars. Drop the duplicate; keep one knex instance per DB at process scope.

### Step 3 — Port routes by domain
For each, copy `routes.js` + `controller.js` + `model.js`/`tasks.js`, register in [config/express.js](config/express.js), and smoke-test. Order:
1. `migration/` — least entangled; copy first to validate the pattern.
2. `astools/` — ASpace tooling; depends on `archivesspace_config.js` which both projects already have.
3. `kaltura/` — depends on `kaltura_config.js` and `kaltura-client` dep.
4. `ingester/` — the meat. Includes the queue tables, pipeline workers, restart-resumer (see [`repo-ingest.js:45-63`](../digitaldu-backend-ingest-service/repo-ingest.js:45) — port this into `repo.js`).

### Step 4 — Port the v2 dashboard scaffolding
- Copy `views/dashboard/` + partials from ingest-service.
- Copy `public/app/v2/` (HTMX-aware static assets).
- Register dashboard routes under the new namespace.
- Verify the existing ingest dashboard screens (queue, workspace) work end-to-end against the merged DB pools.

### Step 5 — Port backend dashboard screens to HTMX partials
- Per [MODERNIZATION_PLAN.md §9.2](./MODERNIZATION_PLAN.md): objects browse, users CRUD, QA, collections, transcript/viewer.
- Each existing EJS view becomes a shell + one or more partials.
- Old `/dashboard/*` routes stay alive in parallel until the new ones cover every feature; then delete.

### Step 6 — Delete the now-redundant redirect-import flow
- Delete `import/`, [views/dashboard-import.ejs](views/dashboard-import.ejs), [views/dashboard-import-status.ejs](views/dashboard-import-status.ejs), [views/dashboard-import-complete.ejs](views/dashboard-import-complete.ejs).
- These exist only to bridge to ingest-service. Once ingest-service *is* this app, they go.

### Step 7 — Retire ingest-service
- Update DNS / load balancer to send all `digitaldu-backend-ingest-service.example/*` traffic to the merged backend.
- Archive the ingest-service repo (do not delete; keep for historical reference and git history).
- Decommission the old ingest-service process / systemd unit / PM2 entry.

### Step 8 — Post-merge cleanup
- Single `.env-example` covering all knobs.
- Single README documenting the merged app.
- Single CI workflow.
- A short "operations" doc covering the restart-resumer behavior, queue draining, and how to disable the ingester (e.g., `INGEST_DISABLE_RESUME=1`) for incident response.

---

## 8. Risks and how we mitigate

| Risk | Mitigation |
|---|---|
| **Knex 2 → 3 query surface differences break ingest queries** | Run vitest suite from ingest-service against the merged code before flipping production traffic. The sister project already has integration tests; port them first. |
| **ES 7 → 8 client breaks ingester indexing logic** | Run a full reindex in staging before cutover. The mapping format is largely compatible; the breaking changes are in `body` argument shape. |
| **Restart-resumer double-fires on rolling deploys** | The existing [`INGEST_DISABLE_RESUME=1`](../digitaldu-backend-ingest-service/repo-ingest.js:46) flag and the in-process `shutting_down` guard already cover this; we keep both. Add a single-instance lock (DB row or file lock) before resumer runs. |
| **Two processes have shared queue ownership today; one process changes consistency assumptions** | Audit queue handling for the assumption "another process can update this row underneath me." Once it's the same process, internal locking (knex transactions) is sufficient and arguably *simpler*. |
| **Larger blast radius if the merged app crashes** | Phase 4 of [MODERNIZATION_PLAN.md](./MODERNIZATION_PLAN.md) adds graceful shutdown + healthcheck + process error handlers before the merge lands. Run behind a load balancer with 2+ instances so a crash doesn't take ingest down. |
| **Long-running ingest work blocks HTTP** | Today they're in separate processes; after merge they're not. Make sure pipeline workers are `setImmediate`/`setTimeout`-scheduled (the existing code already does this) and **never** block on synchronous work. Consider moving heavy work to `worker_threads` or to a real queue (BullMQ/Redis) — see [MODERNIZATION_PLAN.md §12](./MODERNIZATION_PLAN.md). |
| **One bigger codebase is harder to reason about** | Counterweighted by removing all the copy-pasted scaffolding. The `routes.js`/`controller.js`/`tasks.js` per-domain pattern keeps modules independent — they just live in the same process. |

---

## 9. Rollback plan

Each step in §7 lands as a PR with a feature flag where possible:
- `INGEST_DISABLE_RESUME=1` already exists for the restart-resumer.
- New routes can be gated by `MERGE_ENABLE_INGESTER=1` until verified.
- Old ingest-service stays deployed in parallel until §7 step 7. Cutover is a load-balancer switch, reversible in seconds.

Don't delete the ingest-service repo or its DNS until the merged app has been in production for at least one full ingest cycle without incident.

---

## 10. Acceptance criteria for "merged"

- Single repo, single deployment, single process per node.
- All ingest-service tests pass against the merged codebase.
- All backend integration tests (added per [MODERNIZATION_PLAN.md §5.2](./MODERNIZATION_PLAN.md)) pass.
- Dashboard at `/repo/dashboard/*` covers every screen from both old dashboards using HTMX partials.
- One auth mechanism (JWT) for both the public API and the dashboard.
- One healthcheck endpoint reporting on both `repo` and `repo_queue` DBs plus ES.
- Restart-resumer behavior preserved; can still be disabled with `INGEST_DISABLE_RESUME=1`.
- Ingest-service repo archived; no production traffic to its old DNS.
- One `.env-example`, one README, one CI workflow.

---

## 11. Estimate

Assuming [MODERNIZATION_PLAN.md](./MODERNIZATION_PLAN.md) phases 0–4 are done first:

| Step | Estimate |
|---|---|
| Step 2 — libs + configs | 1–2 days |
| Step 3 — port routes (migration, astools, kaltura, ingester) | 1 week |
| Step 4 — v2 dashboard scaffolding | 2 days |
| Step 5 — port backend dashboard screens to HTMX | 1–2 weeks |
| Step 6 — delete import redirect flow | 0.5 day |
| Step 7 — retire ingest-service | 0.5 day |
| Step 8 — post-merge cleanup | 1 day |

Total: roughly 3–4 weeks of focused work, sequenced behind the modernization phases.
