# Sub-collections — design

**Status:** approved 2026-06-21. Phase 1 in progress.
**Goal:** let staff create collections (top-level *and* nested sub-collections)
**outside** the ingest pipeline, each bound to an ArchivesSpace **resource**
(`/repositories/N/resources/M`) exactly like ingest-created collections, and
populate them with **existing** objects.

## Approved decisions
1. **Nesting is dashboard-only.** An object belongs to exactly one collection.
   A parent shows its sub-collections as a navigation tree but does **not**
   aggregate their objects. → No indexer / public-API / search changes.
2. **Single membership (move).** Adding an existing object to a (sub-)collection
   reassigns its `is_member_of_collection` (+ `is_updated=1` so the indexer
   re-syncs). No schema change.
3. **Bind to a full ASpace URI** — either a resource
   (`/repositories/N/resources/M`) or an archival_object
   (`/repositories/N/archival_objects/M`); staff use both as collections, same
   as ingest. (Updated 2026-06-21: the dashboard originally required a resource
   URI / bare ID and rejected archival_objects; it now requires the full URI of
   either kind — a bare ID can't disambiguate the two.)
4. **Both top-level and sub-collections** — one form; parent optional.

## Current state (review, 2026-06-21)
- A collection is a `tbl_objects` row, `object_type='collection'`, bound to its
  ASpace resource via the **`uri`** column. A **unique index** on live-collection
  `uri` (`_collection_uri_unique_v` / partial index, migration 20260524000001)
  means one live collection per resource.
- Objects belong via single `is_member_of_collection` = the collection **PID**.
- Collections are created **only during ingest**:
  `ingester/workspace.js _ensure_collection_exists` → `repository/model.js`
  `find_collection_by_uri` (reuse) | `aspace.get_record` → mint handle →
  `create_collection({uri, mods, pid, display_record, handle})` (which hardcodes
  `is_member_of_collection=''`).
- No standalone create; no membership editing. `is_member_of_collection` is
  written once at Stage 5 (`ingester/lib/repository_build.js:190`).
- Nesting is structurally allowed but downstream is flat: member **counts**
  exclude collections while the member **list** does not (an inconsistency to
  fix); the ES indexer / projection / public API / search pass
  `is_member_of_collection` through with no rollup.

## Design

### Data model
No schema change. A sub-collection is a `collection` row whose
`is_member_of_collection` = the **parent collection's PID** (instead of `''`).
The `uri` unique constraint still guarantees one live collection per resource.

### Shared provisioning helper (new) — `repository/collection_provision.js`
Extract the reusable "given a resource URI, find-or-create the local collection
mirror" core out of `_ensure_collection_exists`:

```
provision_collection({ uri, parent_collection_pid }, deps) ->
  { ok:true, collection_pid, uri, created, handle, collection } | { ok:false, error }
```

Steps: `find_collection_by_uri(uri)` (reuse → `created:false`) → check ASpace
configured → `get_session_token` → `get_record(uri)` (404 / non-200 handling) →
mint handle (best-effort) → `create_collection({…, parent_collection_pid})`.
`_mint_collection_handle` moves here. Deps (`aspace`, `repo_model`, `handles`)
stay injectable for tests.

- **Ingest** (`_ensure_collection_exists`) keeps its folder→URI parse
  (`_parse_resource_uri`, which still also accepts `archival_objects_N` for
  back-compat) and then delegates to `provision_collection({ uri }, deps)` — no
  behavior change, no parent.
- **Dashboard** calls `provision_collection({ uri, parent_collection_pid }, deps)`.

### `create_collection` change (`repository/model.js`)
Add optional `parent_collection_pid` → `is_member_of_collection = parent || ''`.
When set, validate the parent is an **active `collection`** row (else
`ValidationError`). Everything else (envelope build, unique-URI race recovery)
unchanged. With no parent, behavior is byte-identical to today (ingest path).

### Validation
- Dashboard requires a **full URI** of either kind before provisioning —
  `^/repositories/\d+/resources/\d+$` OR
  `^/repositories/\d+/archival_objects/\d+$` — and rejects anything else
  (including a bare numeric ID, which can't disambiguate resource vs
  archival_object) with a clear message. (Updated 2026-06-21; previously a bare
  ID or resource URI only.) provision_collection / get_record fetch the URI
  generically, so both kinds work the same downstream.
- Duplicate resource → the unique constraint + `find_collection_by_uri` surface
  the existing collection ("already exists", link to it) rather than erroring.

### RBAC
Reuse **`edit_object`** (staff + admin) for both create and (Phase 2) move — no
new permission. Gate the routes with `require_permission(EDIT_OBJECT)` and the
UI buttons with `res.locals.can('edit_object')`.

### Downstream
Untouched (the payoff of decision #1): indexer, `object_projection`, public API,
search. New collections set `is_updated=1`, so the indexer mirrors them to ES
like any collection.

## Phase 1 — create collection (top-level + sub)
Files:
- `repository/model.js` — `create_collection` gains `parent_collection_pid` +
  parent validation.
- `repository/collection_provision.js` (new) — `provision_collection` +
  `_mint_collection_handle` (moved).
- `ingester/workspace.js` — `_ensure_collection_exists` delegates to the helper;
  drop the moved handle-mint. (Return shape + deps unchanged → submit_to_ingest
  untouched.)
- `dashboard/controller.js` — `collection_new_page` (GET form, optional
  `?parent`) + `collection_create` (POST → provision → redirect to the new
  collection detail, or re-render the form with an error / "already exists").
- `dashboard/routes.js` — `GET /collections/new` + `POST /collections`, gated on
  `require_dashboard_auth` + `can_edit` (+ write_limiter on POST).
- `views/dashboard/collections_new.ejs` (new) — the form.
- `views/dashboard/collections.ejs` — "+ New collection" button (gated).
- `views/dashboard/collection_detail.ejs` — "+ Create sub-collection" button
  (gated) → `/collections/new?parent=<pid>`.

Tests: model (parent set + parent validation + dup URI); provision helper
(mocked aspace/handles); e2e (form renders + parent variant; POST creates
top-level and sub; archival_object URI accepted; bare ID rejected; RBAC 403 for
viewer); ingest workspace tests still green.

## Phase 2 — populate with existing objects + parent tree
- `repository/model.js` (or `collections/model.js`) — `move_objects_to_collection(pids[], collection_pid, actor)`: set `is_member_of_collection` + `is_updated=1` for active, non-collection pids; validate the target is an active collection. First post-ingest writer of the field.
- Endpoint + an object picker (search existing objects) on the collection detail; "Create sub-collection **with objects**" can chain create → move.
- Collection detail gets a distinct **"Sub-collections"** section (collections where `is_member_of_collection = this pid`), and the object member list excludes collections — fixing the count/list inconsistency.
- Tests for the move + the detail sections.

## Risks / notes
- **No cycles in scope:** we only create fresh collections and move *objects*
  (never re-parent an existing collection), so the hierarchy is a safe tree at
  any depth.
- **Refactor risk:** extracting the ingest creation core is the one change that
  touches a working path — mitigated by keeping the return shape + deps identical
  and re-running the ingest tests.
- **Open detail (build-time):** object-picker scope (search all vs within a
  collection) and whether the collections list page should visually indent
  sub-collections — both Phase 2, not blocking.
