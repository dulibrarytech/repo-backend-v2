# Digital Preservation Jobs — Help / Workflow Guide (design)

**Status:** design for review (2026-06-21). Implementation pending sign-off.
**Goal:** an in-dashboard Help view documenting the overall ingest process and each
step (Make Digital Objects, ASpace Description QA, Packaging & Ingesting, Ingest
Queue), reachable from the Digital Preservation Jobs (DPJ) section.

This doc captures the **structure + the factual claims per step** so the workflow
descriptions can be verified before the prose is written into the view. (Final prose
is authored directly in the EJS view at build time — not duplicated here.)

---

## Confirmed decisions

- **Presentation:** one **Workflow Guide** page in the DPJ workflow sidebar, **plus** a
  small contextual "Help" link on each step page that deep-links into the matching
  section (anchor).
- **Authoring:** **EJS**, hand-authored (no markdown dependency; CSP-safe; matches every
  other view). The EJS view is the user-facing source of truth for help.
- **Depth:** all of — staff how-to · glossary · troubleshooting/recovery ·
  technical / cross-app detail.

## Placement & architecture

- **Route:** `GET /dashboard/ingest/help` in `ingester/dashboard_routes.js`
  (`require_dashboard_auth`; it's part of the DPJ area, and the nav link is gated on
  `can('manage_ingest')`, same as the rest of DPJ — staff + admin).
- **Handler:** `help_page()` in `ingester/dashboard.js` → `render_page(req, res,
  'dashboard/ingest_help', { page: 'ingest-help', active: 'help', title: 'Digital
  Preservation Jobs — Help' })`. Pure static render (no model calls).
- **Sidebar:** add `'help'` to the `workflow_actives` array in
  `views/dashboard/partials/sidebar.ejs` (so the sidebar stays in DPJ "workflow focus"
  mode on this page) + a **"Help"** item at the bottom of the workflow-focus list
  (question-mark / book icon).
- **Per-step links:** a small "Help" link in the `page-subtitle` of each step view
  (`ingest_workspace.ejs`, `ingest_aspace_qa.ejs`, `ingest_packaging.ejs`,
  `ingest.ejs`) → `/dashboard/ingest/help#<anchor>`.
- **View:** `views/dashboard/ingest_help.ejs` — a table of contents (in-page anchor
  links) + one `content-card` per section. CSP-safe: anchors are native; no inline JS.
  A flow diagram rendered as inline SVG or styled HTML (no script).
- **RBAC:** `manage_ingest` (read-only page; nav hidden from viewers, same as DPJ).

## Maintenance note

The EJS view is the **user-facing** source of truth; the dev/operator `README.md`s and
`docs/*.md` stay separate. When the workflow changes, update the view. (We deliberately
avoid a markdown-render pipeline: no dependency, no HTML-sanitization burden under the
strict CSP, and the doc set is small + stable.)

---

## Page structure + per-step factual claims (PLEASE VERIFY)

### A. At a glance (overview + diagram)
The DPJ workflow takes archival packages staged on disk, registers them in
ArchivesSpace, quality-checks the description, then runs them through Archivematica
into the repository and the preservation tier. Actors: **you** (staff), **ArchivesSpace**
(description), **Archivematica** (preservation processing), **DuraCloud** + **Wasabi S3**
(storage), and the **repository** (the object record + search).

Flow diagram (left→right):
`Make Digital Objects → ASpace Description QA → Packaging & Ingesting → Ingest Queue
(6 stages) → published object in the repository + AIP preserved`

### B. The folder lifecycle (orientation)
A batch moves through on-disk stages owned by the curation service:
`workspace → 001-ready → 002-ingest → 003-ingested`.
A package carries a **`uri.txt`** sidecar once it has an ArchivesSpace digital-object
URI (written by Make Digital Objects). "Processed" = has `uri.txt`; "unprocessed" =
doesn't.

### C. Steps

Each step section: **What you do · What the system does · Inputs & outputs · Behind the
scenes (cross-app) · If something goes wrong.**

**1. Make Digital Objects** — `#make-digital-objects` (`/dashboard/ingest/workspace`)
- *You:* pick a batch folder that's still "unprocessed" (no `uri.txt`) and run Make
  Digital Objects.
- *System:* the curation service runs the `make_digital_object.py` CLI (ArchivesSnake):
  logs into ArchivesSpace, creates a **digital-object record** for each package, and
  writes a `uri.txt` sidecar per package. The batch flips to "processed" once every
  package has a `uri.txt`.
- *In/out:* batch of source files in → `uri.txt` (AS digital-object URI) per package.
- *Behind the scenes:* repo → Flask `POST /api/v1/astools/make-digital-objects`.
- *Trouble:* a package missing `uri.txt` stays unprocessed; re-run. AS login / record
  failures surface in the run result + Job History.

**2. ASpace Description QA** — `#aspace-qa` (`/dashboard/ingest/aspace-qa`)
- *You:* select a processed batch and run the metadata check; review before packaging.
- *System:* validates each package's `uri.txt` / ArchivesSpace record against the
  ingest spec (URI resolves, required fields present); marks the folder QA-passed.
- *In/out:* packages with `uri.txt` in → QA status (recorded in `tbl_ingest_jobs`).
- *Behind the scenes:* repo → Flask `/api/v1/astools/check-uri-txt` (+ workspace/uri
  helpers).
- *Trouble:* fix the description in ArchivesSpace, then re-check. Don't package a batch
  that hasn't passed QA.

**3. Packaging and Ingesting** — `#packaging-and-ingesting` (`/dashboard/ingest/packaging`)
- *You:* submit a QA-passed batch to the pipeline.
- *System:* finds-or-creates the collection (handle mint), moves each package
  `001-ready → 002-ingest`, queues one row per package, then the worker pushes the
  staged tree to Archivematica over SFTP and watches the upload complete.
- *In/out:* ready folders in → queue rows + files staged on AM's SFTP drop.
- *Behind the scenes:* Flask `/move-to-ingest` → `/move-to-sftp` → `/upload-status`
  (polled). One queue row per package.
- *Trouble:* a stuck submit can be returned to packaging from the Queue; large media
  uploads depend on the "LARGE KALTURA MEDIA" `.env` overrides being present (a known
  config-drift gotcha).

**4. Ingest Queue** — `#queue` (`/dashboard/ingest`)
- *You:* monitor packages flowing through the pipeline; open a row's **Timeline**,
  **Cancel** an in-flight package, or **roll back / retry** a halted one.
- *System:* the 6-stage state machine (idempotent on resume; awaits external systems on
  bounded budgets):
  1. **process_metadata** — ASpace fetch + transformer → workspace metadata snapshot
  2. **upload** — SFTP push to the Archivematica drop
  3. **transfer** — AM start-transfer + approval + transfer polling (single-row AM gate)
  4. **ingest** — AM ingest poll + DuraCloud propagation wait
  5. **repository** — `tbl_objects` insert + Handle mint + SFTP cleanup + move-to-ingested
     (Wasabi staging copy)
  6. **aip_store** — curation `/copy-to-wasabi` → AIP lands in the preservation tier
     (gated by `AIP_STORE_ENABLED`)
- *Recovery actions (row ⋮ menu):* Timeline, Cancel, Rollback (pre-upload), Rollback
  (Archivematica), Reset, Return to packaging, "Re-check AM & retry" (for an AIP-store
  not-found that resolved later).
- *Trouble:* common halts + what to do — transfer timeout on large media (config drift),
  "AIP not found in AM Storage Service" (retries over a budget, then re-check & retry),
  poison/dirty-date index failures (dead-letter + retry). Only one package occupies the
  AM stages at a time by design.

**5. Job History** — `#history` (`/dashboard/ingest/history`)
- Read-only log of completed Make Digital Objects / Description QA / Packaging runs,
  newest first (actor + timestamp + outcome).

**6. Recent Ingests** — `#recent-ingests` (`/dashboard/ingest/recent`)
- Objects that reached the repository in the last 30 days; review metadata, publish, or
  suppress from each row (reuses the objects table).

### D. Glossary — `#glossary`
ArchivesSpace (AS) · Archivematica (AM) · SIP · AIP (Archival Information Package) ·
DuraCloud · Wasabi (S3 preservation tier) · Handle / PID (persistent identifier) ·
`uri.txt` (sidecar linking a package to its AS digital-object URI) · MODS ·
Elasticsearch (search index) · Kaltura (A/V streaming) · collection (a `tbl_objects`
row bound to an AS resource).

---

## Implementation plan (after sign-off)

1. `ingester/dashboard.js` — `help_page()` handler (static render) + export.
2. `ingester/dashboard_routes.js` — `GET /dashboard/ingest/help` (`require_dashboard_auth`).
3. `views/dashboard/partials/sidebar.ejs` — add `'help'` to `workflow_actives` + a
   "Help" item in the workflow-focus list (gated `manage_ingest`).
4. `views/dashboard/ingest_help.ejs` (new) — the guide (TOC + sections + SVG diagram +
   glossary).
5. Per-step subtitle "Help" deep-links in `ingest_workspace.ejs`,
   `ingest_aspace_qa.ejs`, `ingest_packaging.ejs`, `ingest.ejs`.
6. Tests (`tests/e2e/dashboard.test.js` or `ingest_*`): help page renders (200) with the
   step anchors + glossary; nav shows the Help item; viewer (no `manage_ingest`) is
   gated; each step page links to `/ingest/help#…`.
7. Deliverable `output/repo/repov2-modified-N/` + this design doc.
