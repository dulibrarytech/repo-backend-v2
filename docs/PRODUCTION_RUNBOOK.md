# repo-backend-v2 — Production Runbook

Cutover procedure and pre-flight checklist for putting repo-backend-v2 into
production. Read top-to-bottom once before the cutover window; then work the
checklists in order.

**Scope.** This covers the app process, its two MySQL/MariaDB databases,
Elasticsearch, configuration/secrets, and the companion services it depends
on. It does **not** cover provisioning the host OS, the MariaDB/ES server
installs themselves, or the curation Python service's own deploy (it has its
own repo) — those are prerequisites assumed already in place.

**Companion reading (in this repo):**
- `docs/MIGRATIONS.md` — migration workflow + the two-DB layout.
- `.env-example` — the authoritative, commented list of every env var.
- `docs/MODERNIZATION_PLAN.md` — the SSO layered-defense design (Layers 1–3).

---

## 0. The one thing people get wrong

> **`migrate:latest` on one database is NOT enough, and order matters.**

Three corrections to the naive "import a dump + `migrate:latest`":

1. **There are two databases** — `repo` and `repo_queue` — each with its own
   migration tree and its own `knex_migrations` table. Use `npm run migrate:all`,
   not a single `migrate:latest`.

2. **Import the data FIRST, then migrate.** A SQL dump recreates tables from the
   *legacy* schema (it does `DROP TABLE` + `CREATE TABLE`). The migrations are
   written with `hasTable`/`hasColumn` guards precisely so they can run **on top
   of** an imported legacy DB and add only the deltas — including the
   `_collection_uri_unique_v` generated column + its unique index, and the
   `index_attempts`/`index_error` columns. If you migrate first and import
   second, the import **drops** those again and `migrate` won't re-add them (it
   has already recorded them as run). Import → then `migrate:all`.

3. **Never rename or re-timestamp a migration that's already been applied.**
   knex tracks applied migrations by exact filename in each DB's
   `knex_migrations` table; if the ledger records a name that isn't on disk it
   aborts the **whole** run with `The migration directory is corrupt, the
   following files are missing: <name>` — so one renamed file blocks every
   pending migration behind it. Keep migration filenames **byte-identical across
   every checkout** (edit copy, running checkout, dev VM). To change an applied
   migration's behaviour, add a NEW forward migration — never edit or
   re-timestamp the old one. (Recovery in B3.)

Everything below assumes a **fresh** production `repo`/`repo_queue` whose
`knex_migrations` tables are empty (i.e. you have not previously run
migrations against them). If you are migrating an *existing* repov1 database
in place, you simply skip the data-import step (B2) — the data is already
there — and run `migrate:all` to apply the deltas.

---

## 1. Pre-flight checklist (do these BEFORE the cutover window)

- [ ] **Code:** the running checkout contains the latest merged code, including
      every applied `output/repo/repov2-modified-*` deliverable. In particular
      the migration files must be present on disk:
      `knex/migrations/repo/` (4 files, incl. `…_indexer_dead_letter.js`) and
      `knex/migrations/repo_queue/` (10 files). Confirm with `git log`/`ls`.
- [ ] `npm ci` runs clean on the prod host (Node version matches dev).
- [ ] **Full test suite green** on the prod host or CI: `npx vitest run`.
- [ ] **A full DB dump** of the source data is ready — *all* tables, not just
      `tbl_objects` (see B2 for why).
- [ ] **Elasticsearch** cluster reachable from the prod host; you know the
      target index name (`ELASTICSEARCH_FRONT_INDEX`).
- [ ] **Companion services** reachable from the prod host: ArchivesSpace,
      Archivematica + AM Storage Service, the curation API (behind TLS), the
      Handle service, Kaltura.
- [ ] **Secrets generated/rotated** (see §3) — do NOT ship dev values.
- [ ] **SSO signing coordinated with DU IT** (see §3 — this is the security gate).
- [ ] Reverse proxy (nginx + TLS cert) for the app's public host is configured.
- [ ] A process manager (systemd/PM2) unit is prepared to run + auto-restart
      `node repo-backend-v2.js`.
- [ ] Decide a maintenance window — public search returns partial results until
      the Elasticsearch reindex (E) drains.

---

## 2. Cutover procedure

### A. Deploy the code to the running checkout

> Per the deploy-topology note: the app runs from its own checkout, and
> migrations only run from the migration files present **in that checkout**.

```bash
# on the prod host, in the running checkout
git fetch && git checkout <release-tag>        # or however releases land here
npm ci
npx vitest run                                  # optional but recommended gate
```

### B. Databases

**B1. Create the databases + a dedicated app user** (do NOT run the app as
`root`; the dev `.env` using `root` is a known weak spot to fix here):

```sql
CREATE DATABASE IF NOT EXISTS repo        CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE DATABASE IF NOT EXISTS repo_queue  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER 'repo_app'@'%' IDENTIFIED BY '<<STRONG_PASSWORD>>';
GRANT ALL PRIVILEGES ON repo.*       TO 'repo_app'@'%';
GRANT ALL PRIVILEGES ON repo_queue.* TO 'repo_app'@'%';
FLUSH PRIVILEGES;
```

**B2. Import the full data dump → `repo`** (and `repo_queue` if you have data
for it; normally `repo_queue` is operational/transient and only needs schema,
which migrate creates in B3):

```bash
# IMPORT FIRST, THEN MIGRATE (see §0). The dump has no USE/CREATE DATABASE,
# so name the target DB on the command line.
mariadb -h<DB_HOST> -P<DB_PORT> -u<DB_USER> -p repo < /path/to/full-repo-dump.sql
```

> ⚠️ **A `tbl_objects`-only dump is not a database.** Production also needs:
> - **`tbl_users`** — staff accounts. There are **no seed files**, so `migrate`
>   does not create any users. If they aren't in your dump, no one can log in;
>   provision them (insert rows, or import the users table) before go-live.
> - **`tbl_aip_store`** — the ~20.8k legacy DuraCloud→Wasabi AIP audit rows that
>   preservation features read.
> - Collections live inside `tbl_objects` (`object_type='collection'`) — covered.

**B3. Apply migrations to BOTH databases:**

```bash
npm run migrate:all          # = migrate:repo && migrate:queue
npm run migrate:status:repo  # confirm every repo migration is "Batch ... Up"
npm run migrate:status:queue # confirm every queue migration is up
```

> **Recovery — `Error: The migration directory is corrupt, the following files
> are missing: <name>`:** the DB's `knex_migrations` ledger records a migration
> filename that isn't in this checkout — the same migration was renamed /
> re-timestamped in another checkout (see §0.3). It aborts the entire run, so no
> pending migration applies until it's resolved. Fix by renaming the file **on
> disk to match the recorded name** — `git mv <name-on-disk> <recorded-name>` —
> NOT by editing the ledger (that just pushes the same error onto the other
> checkout). Diff the two with:
> ```bash
> mysql <db> -N -e "SELECT name FROM knex_migrations ORDER BY name;"
> ls knex/migrations/<repo|repo_queue>/
> ```
> Then re-run `migrate:all`.

**B4. Verify the schema landed (esp. the things a legacy dump lacks):**

```sql
USE repo;
-- generated column + unique-collection-URI index present?
SHOW CREATE TABLE tbl_objects\G   -- expect _collection_uri_unique_v + idx_tbl_objects_unique_collection_uri
-- dead-letter columns present?
SELECT COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA='repo' AND TABLE_NAME='tbl_objects'
   AND COLUMN_NAME IN ('index_attempts','index_error');   -- expect 2
-- row sanity
SELECT COUNT(*) total,
       SUM(object_type='collection') collections,
       SUM(is_published=1) published FROM tbl_objects;
```

If `SHOW CREATE TABLE` is missing the generated column, you imported *after*
migrating (or into an already-migrated DB). Recovery: see **Appendix A**.

### C. Environment & secrets

**C1.** Build the production `.env` from `.env-example` (which documents every
key). At minimum, set for real (not dev defaults):

- **App:** `NODE_ENV=production`, `APP_PORT` (default 8000), `APP_PATH`
  (default `/repo`), `APP_NAME`, `CORS_ALLOWED_ORIGINS`, `LOG_LEVEL`.
- **Databases:** `DB_HOST/PORT/USER/PASSWORD/NAME` and
  `DB_QUEUE_HOST/PORT/USER/PASSWORD/NAME` — pointing at the `repo_app` user.
- **Auth/JWT:** `TOKEN_SECRET` (strong, unique), `TOKEN_ALGO`, `TOKEN_ISSUER`,
  `TOKEN_EXPIRES`.
- **Elasticsearch:** `ELASTICSEARCH_HOST`, `ELASTICSEARCH_FRONT_INDEX`,
  `ELASTICSEARCH_SHARDS`, `ELASTICSEARCH_REPLICAS`,
  `ELASTICSEARCH_REJECT_UNAUTHORIZED=true` (for TLS clusters).
- **SSO:** see §3 — this is the gate.
- **Services:** `ARCHIVESPACE_*`, `ARCHIVEMATICA_*` (+ `ARCHIVEMATICA_STORAGE_*`),
  `CURATION_API*` (HTTPS URL), `HANDLE_*`, `CONVERT_SERVICE*`, `TN_SERVICE*`,
  Kaltura.
- **Workers:** `INGEST_WORKER_ENABLED`, `AIP_STORE_ENABLED`, `INDEXER_ENABLED`
  (default true), `INDEXER_MAX_ATTEMPTS` (default 5), poll/concurrency timers.

**C2. Rotate every secret that shipped with a dev value.** Known offenders from
the code review — do not carry these to prod: `DB_PASSWORD` (was `root`),
`ARCHIVESPACE_PASSWORD` (was `freyes0`), the reused Handle/curation key, plus
`CURATION_API_KEY`, `ARCHIVEMATICA_*_KEY`, `CONVERT_SERVICE_API_KEY`,
`TN_SERVICE_API_KEY`, `DURACLOUD_PWD`, `TOKEN_SECRET`.

### D. Bring up / verify companion services

Confirm each is reachable from the prod host before starting the app — the
workers will log errors and back off if they aren't:

- [ ] Elasticsearch (`curl $ELASTICSEARCH_HOST/_cluster/health`)
- [ ] ArchivesSpace (metadata source for the metadata-refresh worker)
- [ ] Archivematica + AM Storage Service (ingest + AIP delete)
- [ ] Curation API **over TLS** (it has no TLS of its own — must sit behind the
      nginx reverse proxy; never expose it plaintext)
- [ ] Handle service, Kaltura, TN/thumbnail service

### E. Elasticsearch — create + populate (the dump does NOT touch ES)

The MySQL import does nothing to Elasticsearch. The public index must be
created with the current mappings and then filled.

1. **Start the app once** (next step F) — on first tick the indexer worker
   calls `ensure_index` and creates the index (empty) with the correct
   mappings from `libs/es_mappings.json` (incl. the lenient date mappings).
2. **Populate it.** Imported rows carry the *source* cluster's
   `is_indexed`/`is_updated` flags, so they will claim to be indexed when your
   new cluster is empty. Force a reconcile from the admin UI:
   - **Drop & rebuild index** (recommended for a fresh cluster): drops, recreates
     from mappings, and re-queues every eligible row.
     `…/dashboard/admin/indexer` → *Drop & rebuild index*.
   - or **Reindex all active rows** if the index is already correct and you just
     need to re-push.
3. **Watch it drain** on the same admin page (Dirty → 0, ES doc count → ≈
   eligible count). Public search is partial until it does.

### F. Start the app behind the reverse proxy

```bash
# via your process manager; raw form:
node repo-backend-v2.js          # listens on APP_PORT, mounts under APP_PATH
```

On boot it starts four long-running workers (metadata-refresh, indexer, ingest,
convert), each gated by its `*_ENABLED`/config flags. Front it with nginx + TLS
terminating to `http://127.0.0.1:$APP_PORT`.

### G. Smoke tests (post-start)

```bash
# 1. process alive (public, does not probe ES)
curl -fsS https://<host>$APP_PATH/api/v1/health        # {"status":"ok",...}
# 2. public search returns results (after E drains)
curl -fsS "https://<host>$APP_PATH/api/v1/search?q=*&page_size=1"
```

Then in a browser, with a provisioned staff account:
- [ ] **SSO sign-in** succeeds (and a forged `employeeID` is rejected — see §3).
- [ ] Dashboard **search/list** shows objects.
- [ ] **Publish** an object → appears in public `/api/v1/search` within ~8s.
- [ ] **Suppress**, then **delete** an unpublished object → the AM deletion
      request reason reads `Deleted by First Last (du_id) on … . Reason: …`.
- [ ] **Indexer admin** page: Dirty count drains, no drift, 0 dead-lettered.
- [ ] A small **ingest** end-to-end (upload → transfer → ingest) if AM is live.

---

## 3. 🔴 Security gate — MUST pass before public traffic

**SSO authentication bypass.** `POST {APP_PATH}/auth/sso` trusts the
browser-POSTed `employeeID` unless the layered defenses are enabled. The
remediation is fully coded but ships **off**. Turn it on:

- `SSO_TRUSTED_IPS=<comma-separated SSO gateway IPs>`   — Layer 1 (IP allowlist)
- `SSO_REQUIRE_FRESHNESS=true`, `SSO_MAX_SKEW_SECONDS=60` — Layer 2 (timestamp+nonce)
- `SSO_REQUIRE_HMAC=true`, `SSO_HMAC_SECRET=<shared secret>` — Layer 3 (HMAC)
  - `SSO_HMAC_SECRET_NEXT` supports zero-downtime secret rotation.

The HMAC/freshness signature must be produced by the DU IT SSO side — **this
requires coordination with DU IT and cannot be flipped on unilaterally** (the
app will reject all logins if it expects a signature the IdP isn't sending).
Verify on a staging host that a real login passes and a hand-forged
`employeeID` POST is rejected before opening public traffic.

- [ ] SSO Layers 1–3 enabled and verified against DU IT's signing.
- [ ] All dev secrets rotated (§C2).
- [ ] Curation API only reachable via TLS reverse proxy (§D).

---

## 4. Rollback

- **App:** stop the new process, restart the previous release (process manager).
- **Schema:** migrations are reversible — `npm run migrate:rollback:repo` /
  `:queue` step back one batch each. Prefer this only if a migration itself
  failed; for data problems, restore from the pre-cutover DB backup.
- **Database:** take a snapshot/dump **before** B2 so you can restore. (For a
  fresh DB there's nothing to lose; for an in-place repov1 upgrade, back up
  first — non-negotiable.)
- **Elasticsearch:** the index is rebuildable at will from MySQL via the admin
  *Drop & rebuild* — never the rollback bottleneck.

---

## 5. Post-cutover monitoring (first 24–48h)

- **Indexer admin page** — Dirty drains to ~0; **dead-lettered stays 0** (a
  non-zero count means rows ES keeps rejecting — check the log for
  `indexer_row_dead_lettered`, fix the data/mapping, hit *Retry failed*).
- **Logs** — watch for `*_failed` / backoff events from the workers
  (`indexer_*`, metadata refresh, ingest, AIP store) indicating a flaky
  companion service.
- **Queues** (`repo_queue`) — ingest/metadata queues draining, not piling up.
- **/api/v1/health** under your uptime monitor.

---

## Appendix A — Recurring data refresh (re-importing `tbl_objects`)

This is the workflow for refreshing data from a **`tbl_objects`-only** dump into
a DB that has **already been migrated** (e.g. a dev/staging box, or prod after
the first cutover). Because the dump's `DROP TABLE`+`CREATE TABLE` uses the
legacy schema and `migrate` already recorded the relevant migrations as run,
you must **manually re-add** the generated column + unique index afterward —
`migrate` will not.

```bash
# 1. import (replaces tbl_objects)
mariadb -h<HOST> -P<PORT> -u<USER> -p repo < repo-tbl_objects-MM-DD-YYYY.sql

# 2. check for duplicate live-collection URIs (would block the unique index)
mariadb ... repo -e "SELECT uri,COUNT(*) c FROM tbl_objects
  WHERE object_type='collection' AND uri<>'' GROUP BY uri HAVING c>1;"
#    (empty result = safe to proceed)
```
```sql
-- 3. re-add the generated column + unique index (exact current definition)
ALTER TABLE `tbl_objects` ADD COLUMN `_collection_uri_unique_v` varchar(255)
  GENERATED ALWAYS AS (case when `object_type`='collection' and `uri`<>'' then `uri` else NULL end) VIRTUAL;
ALTER TABLE `tbl_objects` ADD UNIQUE KEY `idx_tbl_objects_unique_collection_uri` (`_collection_uri_unique_v`);

-- 4. if modified-34 was deployed here, also re-add the dead-letter columns
--    (skip if `migrate` was never run here / columns already absent by design):
ALTER TABLE `tbl_objects` ADD COLUMN `index_attempts` int NOT NULL DEFAULT 0;
ALTER TABLE `tbl_objects` ADD COLUMN `index_error` text NULL;
```
```bash
# 5. reconcile Elasticsearch (imported is_indexed/is_updated reflect the SOURCE)
#    → admin: …/dashboard/admin/indexer → Drop & rebuild (or Reindex all)
```

> Avoid this dance entirely on a **fresh** DB: import the dump *before* the first
> `migrate:all`, and the migrations add all of the above for you (see §0).

---

## Appendix B — Quick reference

| Item | Value |
| --- | --- |
| Start command | `node repo-backend-v2.js` |
| Default port / mount | `APP_PORT=8000` / `APP_PATH=/repo` |
| Databases | `repo`, `repo_queue` (separate `knex_migrations` each) |
| Migrate (both) | `npm run migrate:all` |
| Migrate status | `npm run migrate:status:repo` / `:queue` |
| Rollback (1 batch) | `npm run migrate:rollback:repo` / `:queue` |
| Health (public) | `GET {APP_PATH}/api/v1/health` |
| Public search | `GET {APP_PATH}/api/v1/search?q=` |
| Indexer admin | `{APP_PATH}/dashboard/admin/indexer` |
| Env template | `.env-example` |
| Migration docs | `docs/MIGRATIONS.md` |
| Workers (start with app) | metadata-refresh, indexer, ingest, convert |
