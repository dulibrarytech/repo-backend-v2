# Tests

Three tiers. Each tier has its own discovery root under `tests/<tier>` and its own npm script.

| Tier            | Directory            | What goes here                                                                                              | When to run   |
| --------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- | ------------- |
| **unit**        | `tests/unit/`        | Pure functions, no I/O. Mocks are fine but rare — most "units" are pure.                                    | Every commit. |
| **integration** | `tests/integration/` | Exercises modules that span the DB boundary against the in-memory test database (see below).                | Every PR.     |
| **e2e**         | `tests/e2e/`         | Boots the full Express app in-process via `supertest` (`tests/helpers/app.js`). Asserts HTTP end-to-end.    | Every PR.     |

Shared helpers live under `tests/helpers/`; shared fixtures go in `tests/fixtures/`.

## Running

```sh
npm test                  # all tiers
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:watch        # watch mode (vitest default)
npm run test:coverage     # writes coverage/ HTML + lcov
```

The whole suite is hermetic and deterministic — no external services, no
network, no `.env` required. `tests/helpers/setup.js` seeds the minimum env
vars; live smokes are opt-in (see below).

## Test database

Integration and e2e tiers run against a **sqlite-in-memory** knex pool —
`config/db.js` branches on `NODE_ENV=test` automatically. There is no MySQL
or Elasticsearch prerequisite. `tests/helpers/db.js` provides:

- `setup_schema()` — materialize the repo + queue schemas (`db/schema.js`)
- `reset_data()` — truncate everything, keep schema (call in `beforeEach`)
- `teardown()` — destroy the pools (call in `afterAll`)
- `seed_user()` / `seed_object()` — row factories

Caveat: sqlite is a stand-in, not MariaDB. Behavior that depends on
MySQL-specific SQL (collations, `ON DUPLICATE KEY`, generated columns)
belongs in a live smoke or manual verification, not this tier.

## Live smokes (skipped by default)

Two e2e files talk to real dev services and are gated behind env vars so
`npm test` and CI stay hermetic:

- `tests/e2e/ingest_live.test.js` — QA/curation service, Archivematica,
  and Handle reachability. Run with `INGEST_LIVE_E2E=1`. The full
  package-through-the-pipeline smoke additionally needs
  `INGEST_LIVE_E2E_FULL=1` plus `INGEST_LIVE_E2E_BATCH/PACKAGE/COLLECTION/URI`
  (it moves a real package on the QA SFTP — see the file header).
- `tests/e2e/aspace_transform_parity.test.js` — compares
  `libs/archivesspace_transform.js` output against the legacy DU
  `/repository` plugin for live records. Run with `INGEST_LIVE_E2E=1` plus
  `ARCHIVESPACE_*` creds and `ASPACE_PARITY_URIS`. This is the gate before
  flipping `ASPACE_USE_TRANSFORMER=1`.

```sh
INGEST_LIVE_E2E=1 npx vitest run tests/e2e/ingest_live.test.js
```

## Conventions

- File names: `*.test.js`. Vitest discovers only these.
- One `describe()` per module / route group.
- E2E tests boot the Express app _without_ listening on a port — use
  `make_app()` from `tests/helpers/app.js` with supertest.
- `NODE_ENV=test` is set by `tests/helpers/setup.js` so app code can branch
  on it for the test DB, fixture loaders, etc.
- Keep the default suite deterministic: anything that needs a live service,
  the network, or real credentials gets an env-var gate and a passing
  placeholder test, following the `ingest_live.test.js` pattern.
