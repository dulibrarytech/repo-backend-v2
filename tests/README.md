# Tests

Three tiers. Each tier has its own discovery root under `tests/<tier>` and its own npm script.

| Tier            | Directory            | What goes here                                                                                           | When to run   |
| --------------- | -------------------- | -------------------------------------------------------------------------------------------------------- | ------------- |
| **unit**        | `tests/unit/`        | Pure functions, no I/O. Mocks are fine but rare — most "units" are pure.                                 | Every commit. |
| **integration** | `tests/integration/` | Talks to a real MySQL + Elasticsearch on `localhost`. Exercises modules that span the DB or ES boundary. | Every PR.     |
| **e2e**         | `tests/e2e/`         | Boots the full Express app via `supertest`. Asserts HTTP behavior end-to-end.                            | Every PR.     |

Shared helpers and fixtures live under `tests/helpers/` and `tests/fixtures/`.

## Running

```sh
npm test                  # all tiers
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:watch        # watch mode (vitest default)
npm run test:coverage     # writes coverage/ HTML + lcov
```

## Conventions

- File names: `*.test.js`. Vitest discovers only these.
- One `describe()` per module / route group.
- Don't mock the database in integration tests — spin up a real one. See [docs/MODERNIZATION_PLAN.md §5.2](../docs/MODERNIZATION_PLAN.md).
- E2E tests should boot the Express app _without_ listening on a port (use supertest's in-process invocation).
- Set `NODE_ENV=test` (vitest does this automatically) so app code can branch on it for test DBs, fixture loaders, etc.

## Local prerequisites for integration & e2e

The integration tier expects:

- MySQL 8 on `127.0.0.1:3306` with two empty schemas: `repo_test` and `repo_queue_test`.
- Elasticsearch 8 on `http://localhost:9200`.

A `docker-compose.test.yml` will land in a later phase; for now stand them up manually. Integration suites should auto-migrate schema and seed fixtures on `beforeAll`, then truncate on `afterEach`.

Until that infrastructure lands, integration and e2e suites contain only smoke tests that verify the harness is wired up.
