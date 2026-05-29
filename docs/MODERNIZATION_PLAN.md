# digitaldu-backend — Modernization Plan

> Status: proposal, not yet executed.
> Scope: `digitaldu-backend` only. A separate document, [MERGE_PLAN.md](./MERGE_PLAN.md), covers folding `digitaldu-backend-ingest-service` into this project once modernization is in flight.

This document is the result of an audit of the current code (entry point, Express wiring, dashboard, routes, controllers, services, DB layer, libs, dependencies) cross-referenced against the v2 dashboard in `digitaldu-backend-ingest-service` and against the `tbl_objects` / `tbl_users` / `tbl_*_queue` schemas in `/Users/fcr/Documents/repo/repo-db-schema.sql` and `/Users/fcr/Documents/repo/repo_queue-schema.sql`.

Items are grouped by theme and ordered so that early phases unblock later ones. Each item carries an effort estimate (S/M/L) and a risk tier (low / medium / high). Cite-able evidence is in the "evidence" lines.

---

## 1. Executive summary

`digitaldu-backend` is a stable but aging service. The biggest risks are not feature gaps — they are foundational:

1. **TLS verification is disabled globally** in [repo.js:24](repo.js:24): `process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0` runs unconditionally on boot, including in production. Every outbound HTTPS call from this process is unauthenticated.
2. **Secrets are checked into the repo.** `.env`, `.env_bkup`, `.env_2.0` are present in the working tree.
3. **The bootstrap will crash on any dependency upgrade.** [repo.js:21](repo.js:21) calls `require('dotenv').load()` — `.load()` was removed in dotenv v5 (current is 16). Same applies to `helmet@3`, `multer@1.4.2`, and `async@2`.
4. **No automated tests.** `test/` contains only config files; `npm test` runs against an empty suite.
5. **No graceful shutdown.** Unlike the sister service, `repo.js` never calls `DB.destroy()` on SIGTERM. Pool exhaustion under crash-loops is a real failure mode.
6. **The dashboard is full-page-reload EJS.** Every action navigates. There is a working HTMX pattern in the sister project that we can adopt verbatim.

None of these are large rewrites. They are small, mechanical fixes that compound. The plan below sequences them so the highest-impact, lowest-risk items land first.

---

## 2. Phased roadmap

| Phase | Theme | Outcome | Effort |
|-------|-------|---------|--------|
| 0 | Repo hygiene | Stop bleeding (gitignore secrets, prune dead files, add CI) | S |
| 1 | Security hardening | TLS, helmet, CORS, auth surface | M |
| 2 | Dependency upgrade | dotenv, helmet, multer, drop dead deps | M |
| 3 | Async/await refactor | Eliminate callback wrappers, mixed styles | M |
| 4 | Stability | Graceful shutdown, error boundaries, pool config | S |
| 5 | Tests | Smoke + integration coverage on critical paths | M |
| 6 | HTMX dashboard | Mirror v2 pattern from ingest-service | L |
| 7 | Observability | Structured logging, healthcheck endpoint | S |
| 8 | Merge prep | See [MERGE_PLAN.md](./MERGE_PLAN.md) | — |

Phases 0–4 can ship as small, independent PRs. Phase 6 is the largest and should land after the rest so the new dashboard sits on cleaned-up controllers.

---

## 3. Phase 0 — Repo hygiene

**0.1 Remove secrets from the working tree.** *(S / high)*
- Delete `.env`, `.env_bkup`, `.env_2.0` from the working tree. Add them to [.gitignore](.gitignore) if not already.
- Audit git history with `git log --all --full-history -- .env .env_bkup .env_2.0`. If they were ever committed, rotate every credential they contain (DB passwords, JWT secret, Archivematica/ArchivesSpace/DuraCloud tokens, mail relay creds) and use `git filter-repo` or BFG to scrub history.
- Keep `.env-example` as the template (it already exists).

**0.2 Delete dead artifacts.** *(S / low)*
- `Udenver_am_1.13.2_processing_backup.zip` — binary artifact in repo root.
- `coverage/` — checked-in, empty.
- Stale `.env_*` variants once 0.1 is done.

**0.3 Add a minimal CI workflow.** *(S / low)*
- `.github/workflows/ci.yml` runs `npm ci`, `npm test`, and (later) `npm audit --omit=dev`.
- Block merges on red CI once tests exist.

**0.4 Pin Node version.** *(S / low)*
- Add `"engines": { "node": ">=20" }` to [package.json](package.json) and an `.nvmrc`. Current code targets no version explicitly.

---

## 4. Phase 1 — Security hardening

**1.1 Remove the global TLS bypass.** *(S / high)*
- Delete `process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0` from [repo.js:24](repo.js:24).
- The same line is also present in [config/express.js:41](config/express.js:41), gated behind `NODE_ENV === 'development'`. That is the only place it should live, if anywhere. Prefer adding the offending dev hostnames to `NODE_EXTRA_CA_CERTS` instead.
- Audit calls in `libs/` for HTTPS clients that may have relied on this (Archivematica, ArchivesSpace, DuraCloud, Handle, Kaltura). Fix CA trust at the agent level.

**1.2 Tighten helmet.** *(S / medium)*
- Upgrade `helmet@3` → `^7`. Enable CSP with a starter policy (`default-src 'self'`, allow CDN origins for HTMX/Bootstrap in phase 6).
- Re-enable `crossOriginResourcePolicy`. Today both are explicitly disabled at [config/express.js:52-56](config/express.js:52).

**1.3 Restrict CORS.** *(S / medium)*
- The current CORS callback matches against `req.headers.host` (the *server's* host, not the *requester's* origin). That is the wrong header. See [config/express.js:65-77](config/express.js:65). Replace with `req.headers.origin` and a strict allowlist sourced from `APP_CONFIG.cors`.

**1.4 Reject prototype pollution and oversize bodies.** *(S / low)*
- Add `express.json({ limit: '1mb' })` and `express.urlencoded({ limit: '1mb', extended: false })`. `extended: true` enables the `qs` library; we don't need it.
- Body-parser is deprecated as a separate package since Express 4.16 — switch to the Express built-ins.

**1.5 Add per-route rate limiting.** *(S / medium)*
- `express-rate-limit` on `/auth/*` (login attempts) and any unauthenticated write endpoint.

**1.6 Replace JWT bearer with httpOnly cookies for the dashboard.** *(M / medium)*
- Tokens are currently passed in headers and visible to client JS. For the dashboard (browser context), switch to a SameSite=Lax, httpOnly, Secure cookie. Keep header-based JWT for the public API. Reduces XSS blast radius.

**1.7 Audit raw SQL.** *(M / medium)*
- `stats/` and `repository/` use `knex.raw()` in places. Confirm every call uses bindings (`knex.raw('SELECT ... WHERE id = ?', [id])`), never template interpolation. One unaudited concatenation is enough to be SQLi.

**1.8 File upload hardening.** *(S / medium)*
- `multer@1.4.2` has a stream of CVEs; upgrade to 2.x. Add `fileFilter` (mime allowlist) and `limits` (size, count). Move uploads off the web root.

---

## 5. Phase 2 — Dependency upgrade

**2.1 Replace dotenv `.load()`.** *(S / high)*
- `require('dotenv').load()` → `require('dotenv').config()`. Bump dotenv to `^16`. Without this, the app crashes on any reinstall against current registry tarballs.

**2.2 Remove duplicate UUID libraries.** *(S / low)*
- `node-uuid` is deprecated and shipped alongside modern `uuid@9`. Replace all `require('node-uuid')` with `require('uuid')` and remove `node-uuid`.

**2.3 Drop `async@2`.** *(M / low)*
- Inventory uses of the `async` library; almost all loops can be replaced with `for...of + await` or `Promise.all`. Then remove the dependency.

**2.4 Replace `request`.** *(S / low)*
- This dep is in ingest-service but not in backend's package.json — confirm nothing transitively pulls it in. If it does, replace with `axios` (already present).

**2.5 Replace `memory-cache` and `express-template-cache`.** *(M / low)*
- `memory-cache` is unmaintained; for process-local caches use `lru-cache@10`. For multi-instance, push to Redis.
- `express-template-cache@0.1.0` is unmaintained and rarely loaded. EJS already caches in production; just set `app.set('view cache', true)` in prod and delete the dep.

**2.6 Upgrade test stack.** *(S / low)*
- `mocha@9` → `mocha@10` or migrate to `vitest` (the sister project already uses it).

**2.7 Run `npm audit` and patch high/critical.** *(S / medium)*

---

## 6. Phase 3 — Async/await refactor

The code is in a half-converted state: services call `await` inside an IIFE wrapped by a callback. That's the worst of both — callbacks at the boundary, async/await inside, with no propagated error path.

**3.1 Convert service layer to plain `async` functions.** *(M / medium)*
- Pattern to eliminate: `function get_records(req, callback) { (async () => { ... callback(...) })(); }` in [repository/service.js:40](repository/service.js:40) and [search/service.js:29](search/service.js:29). Replace with `async function get_records(req)`.
- Callers should `await` and use Express's async-error middleware (see 3.3).

**3.2 Convert controllers.** *(M / medium)*
- Replace `function (req, res) { service.fn(req, (err, data) => res.json(...)) }` with `async (req, res, next) => { const data = await service.fn(req); res.json(data); }`.

**3.3 Add a single async error boundary.** *(S / medium)*
- Wrap every async handler with a `wrap(fn) => (req, res, next) => fn(req, res, next).catch(next)` helper, or upgrade to Express 5 (native async error forwarding). Then add a centralized error middleware at the end of `config/express.js` that maps known errors to HTTP responses and logs unknowns at error level.

**3.4 Indexer polling.** *(M / medium)*
- [indexer/model.js:47-72](indexer/model.js:47) uses `setTimeout` + `setInterval(async () => {...})` with no error handling. If a tick rejects, the interval keeps firing into a broken state. Replace with a `while (running) { await tick(); await sleep(N); }` loop guarded by try/catch and a cancellation flag, drained on shutdown.

**3.5 Remove the IIFE pattern from every "service" file.** *(M / low)*
- Grep: `\(async\s*\(\s*\)\s*=>` in `repository/`, `search/`, `import/`, `indexer/`. Each occurrence is the same anti-pattern.

---

## 7. Phase 4 — Stability

**4.1 Graceful shutdown.** *(S / high)*
- Port the SIGTERM/SIGINT handler from [`digitaldu-backend-ingest-service/repo-ingest.js:65-81`](../digitaldu-backend-ingest-service/repo-ingest.js:65). It awaits `DB.destroy()` on both knex pools before exiting. Add the same to `repo.js`. Without this, redeploys leave hanging connections that eventually saturate MySQL's `max_connections`.

**4.2 Explicit pool sizing.** *(S / low)*
- Set `pool: { min: 2, max: 10, acquireTimeoutMillis: 30000, idleTimeoutMillis: 30000 }` in [config/db_config.js](config/db_config.js) and `dbqueue_config.js`. Mirrors the sister service's [config/dbqueue_config.js](../digitaldu-backend-ingest-service/config/dbqueue_config.js).

**4.3 Healthcheck endpoint.** *(S / low)*
- `GET /repo/health` — returns 200 with `{ db: ok, dbqueue: ok, es: ok }` and 503 if any dependency fails a 1s ping. Wire into the load balancer.

**4.4 Process-level error handlers.** *(S / medium)*
- `process.on('unhandledRejection', ...)` and `process.on('uncaughtException', ...)` log + initiate graceful shutdown. Today nothing catches these and the process can drift in a broken state.

**4.5 Drop view cache toggle.** *(S / low)*
- [config/express.js:38-43](config/express.js:38) sets `view_cache = false` in development. Standard EJS already handles this with `NODE_ENV`. Remove the manual toggle and the unused `express-template-cache` (see 2.5).

---

## 8. Phase 5 — Tests

The repo claims `npm test` via mocha but `test/` is empty.

**5.1 Smoke tests first.** *(S / medium)*
- supertest against the running app: each route returns the expected status code. Aim for ~30 minutes of writing to cover all routes once.

**5.2 Integration tests for the queue + indexer pipeline.** *(M / medium)*
- Spin up a docker MySQL + Elasticsearch in CI (`services:` block in GH Actions). Test the happy path of ingest → index → publish → search.
- Do **not** mock the DB — the sister codebase already runs integration tests with real connections. The DB layer is where bugs hide.

**5.3 Unit tests for `libs/dom.js`.** *(S / medium)*
- Sanitizer correctness directly affects XSS surface; lock the behavior with explicit test vectors.

---

## 9. Phase 6 — HTMX dashboard

The sister project's v2 dashboard at [`digitaldu-backend-ingest-service/views/dashboard/`](../digitaldu-backend-ingest-service/views/dashboard/) is the reference. The user has already validated the pattern there.

### 9.1 What to copy verbatim

- **Layout shell**: [`views/dashboard/layout.ejs`](../digitaldu-backend-ingest-service/views/dashboard/layout.ejs) — HTMX 1.9.12 + Bootstrap 5.3.3 via CDN, sidebar, header, footer, modal mount point. Approx. 70 lines; copy and rename.
- **Custom confirm modal pattern** — replaces native `confirm()`; declarative via `hx-confirm` + `data-confirm-*` attributes. Already wired in `dashboard.js` there.
- **CSS theme tokens** in `public/app/v2/assets/styles.css` — DU crimson/gold palette, severity badges.
- **Auth via `X-API-Key` header + `sessionStorage`**, registered in `htmx:configRequest`. For digitaldu-backend we will replace this with the existing JWT (see 1.6).
- **Out-of-band swap convention** — `HX-Trigger: foo:refresh` from the server, listeners on `hx-trigger="foo:refresh from:body"`. Use for sidebar counters, table refreshes after writes.

### 9.2 Route mapping

The current full-page routes ([dashboard/routes.js](dashboard/routes.js)) split into a *shell* GET (returns layout + empty regions) and one or more *partial* endpoints (return fragments). Suggested mapping:

| Current full-page route | New shell | New partial(s) |
|---|---|---|
| `/dashboard/home` | `GET /dashboard/v2/` | `GET /dashboard/v2/stats` (counts), `GET /dashboard/v2/recent` (latest ingests) |
| `/dashboard/objects` | `GET /dashboard/v2/objects` | `GET /dashboard/v2/objects/list?q=&page=` (table fragment with live search) |
| `/dashboard/objects/unpublished` | (same shell, filter param) | `GET /dashboard/v2/objects/list?published=0` |
| `/dashboard/objects/search` | (folded into objects shell) | — |
| `/dashboard/object/thumbnail` (GET) + `/upload` | `GET /dashboard/v2/objects/:pid/thumbnail` | `POST /dashboard/v2/objects/:pid/thumbnail` returns updated card fragment |
| `/dashboard/object/delete` | modal triggered by row action | `POST /dashboard/v2/objects/:pid/delete` returns updated row |
| `/dashboard/users` (+ add/edit/delete) | `GET /dashboard/v2/users` | `GET /dashboard/v2/users/list`, `POST .../users`, `PATCH .../users/:id`, `DELETE .../users/:id` returning row fragments |
| `/dashboard/qa` | `GET /dashboard/v2/qa` | `GET /dashboard/v2/qa/list` polling every N seconds |
| `/dashboard/collections/add` | (folded into objects shell as modal) | `POST /dashboard/v2/collections` returns updated row |
| `/dashboard/transcript`, `/viewer` | unchanged — these are reader views | — |
| `/dashboard/ingest`, `/ingest/status`, `/import/complete` | **deleted** | once merged with ingest-service per [MERGE_PLAN.md](./MERGE_PLAN.md) |

### 9.3 UI/UX improvements to bake in

- **Live search instead of full-page submit** on objects browse. `hx-trigger="keyup changed delay:300ms"`, `hx-target="#objects-table"`.
- **Server-side pagination with infinite scroll or cursor pagination** — `tbl_objects` is ~23k rows today and will grow; offset pagination at scale is expensive against the `is_member_of_collection_index` lookup pattern.
- **Toast notifications** via `HX-Trigger: toast` events instead of full alert pages on success/failure.
- **Optimistic row updates** for publish/unpublish toggles using `hx-swap="outerHTML"` on the affected `<tr>`.
- **Bulk actions** on the objects list (checkboxes → action bar that appears on selection). Currently every action is single-record.
- **Object detail drawer** (`hx-target="#drawer"`) instead of separate pages for view/edit/thumbnail.
- **Accessibility**: real `<button>` for actions instead of `<a href="#">`, ARIA labels on icon-only buttons, focus management when modals open/close (Bootstrap 5 handles most of this if used correctly).
- **Empty states and error states** — the current EJS templates assume data exists; add fallbacks.
- **Dark mode**: cheap with Bootstrap 5 (`data-bs-theme="dark"` on `<body>`) once the palette tokens are in CSS variables.

### 9.4 Phasing the dashboard rewrite

Don't drop the old dashboard until the new one covers everything. Mount the new HTMX dashboard at `/dashboard/v2/*` parallel to the existing `/dashboard/*`. Migrate one screen at a time. When all are ported, retire the old routes and rename `v2` → primary.

---

## 10. Phase 7 — Observability

**7.1 Structured logging.** *(S / low)*
- log4js outputs are fine, but emit JSON in production (`type: 'json'` layout). Add a request ID middleware (`req.id = randomUUID()`) and include it in every log entry. Pipe to your log aggregator.

**7.2 Drop noisy `console.log`.** *(S / low)*
- [repo.js:29](repo.js:29) prints to stdout. Route through the logger so log levels and formats are consistent.

**7.3 Healthcheck.** *(S / low)*
- See 4.3.

**7.4 Metrics endpoint.** *(M / optional)*
- `prom-client` exposes `/metrics` for Prometheus. Useful if your platform scrapes; skip otherwise.

---

## 11. Quick wins (one-day items)

If you want to land visible improvements before committing to the full plan:

1. Delete `Udenver_am_1.13.2_processing_backup.zip`, `coverage/`, `.env_bkup`, `.env_2.0` (Phase 0.2).
2. Fix `dotenv.load()` → `.config()` and bump dotenv. App still runs (Phase 2.1).
3. Add graceful shutdown to `repo.js` (Phase 4.1). Copy from sister service.
4. Remove `NODE_TLS_REJECT_UNAUTHORIZED = 0` from [repo.js:24](repo.js:24); leave the dev-only one in `config/express.js` (Phase 1.1).
5. Add a healthcheck endpoint (Phase 4.3).

Each is < 1 hour, no behavior change for users, and removes real production risk.

---

## 12. Out of scope (consider later)

- **Rewrite EJS in a templating engine with auto-escaping by default** (Pug, Nunjucks, or React server components). The current XSS posture relies on `libs/dom.js` sanitizing inputs; output escaping with `<%- %>` is on the developer.
- **Move from Express 4 to Express 5** for native async error handling. Doable; deferred to keep this plan tractable.
- **TypeScript migration.** Would catch real bugs but is a multi-month investment. Revisit after merge.
- **Move long-running pipelines to a job queue** (BullMQ on Redis) instead of polling MySQL. This is what `tbl_ingest_queue` and `tbl_metadata_update_queue` simulate. Real queue infrastructure simplifies retries, dead-letter handling, and visibility. Belongs in MERGE_PLAN.

---

## 13. Acceptance criteria for "modernized"

- `npm ci && npm test` passes in CI.
- No `NODE_TLS_REJECT_UNAUTHORIZED = 0` in production code paths.
- No secrets in the repo; `.env` is gitignored; secrets rotated if ever committed.
- All controllers and services use `async`/`await`; no callback wrappers, no IIFEs around `await`.
- Graceful shutdown drains both knex pools.
- `helmet` v7, `dotenv` v16, `multer` v2, no `node-uuid`, no `async` v2.
- New `/dashboard/v2/*` covers all current `/dashboard/*` features with HTMX partials.
- Critical paths have integration tests against a real MySQL + ES.
- A healthcheck and structured logs exist.
- `npm audit` reports zero high/critical.

Once these are green, [MERGE_PLAN.md](./MERGE_PLAN.md) becomes the next workstream.
