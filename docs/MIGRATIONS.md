# Database migrations

repo-backend-v2 uses [knex migrations](https://knexjs.org/guide/migrations.html)
as the source of truth for schema evolution. Two separate migration
trees, one per database:

```
knex/
  migrations/
    repo/          → migrations against the `repo` DB (tbl_objects, tbl_users)
    repo_queue/    → migrations against the `repo_queue` DB
                       (tbl_ingest_queue, tbl_metadata_update_queue)
```

Each DB has its own `knex_migrations` table tracking which files have
been applied.

## Day-to-day workflow

### Check status

```bash
npm run migrate:status:repo
npm run migrate:status:queue
```

Lists applied + pending migrations for each DB.

### Apply pending migrations

```bash
npm run migrate:repo
npm run migrate:queue
# or both at once:
npm run migrate:all
```

Idempotent: running on an up-to-date DB is a no-op.

### Create a new migration

```bash
npm run migrate:make:repo  add_foo_column_to_objects
npm run migrate:make:queue add_index_to_metadata_queue
```

Knex generates `knex/migrations/<db>/<timestamp>_<name>.js` with
empty `up`/`down` stubs. Edit them, commit, then `npm run migrate:*`
to apply.

### Roll back the last batch

```bash
npm run migrate:rollback:repo
npm run migrate:rollback:queue
```

Reverses the most recently applied batch. Useful in dev. Production
rollbacks should usually be done with a forward migration that
explicitly undoes the change, not by rolling back — that way the
rollback is itself tracked and audited.

## Production cutover

The initial migration is `hasTable`-guarded, so applying it to a DB
that already has the legacy schema is a no-op — knex just records
the baseline. To bring an existing production DB under migration
control for the first time:

1. Make sure `.env` has the correct `DB_*` and `DB_QUEUE_*` connection settings
2. Run `npm run migrate:all`
3. Verify with `npm run migrate:status:repo` / `:status:queue`

After this, all schema changes flow through new migration files.

## Writing migrations

### Conventions

- One logical change per migration file (one column, one index, one table — not "everything for sprint 12").
- Always write a working `down()` that reverses `up()`. If a change is genuinely irreversible (data destruction, lossy type narrow), make it explicit in the down (e.g., `throw new Error('this migration is one-way')`) so it's a deliberate operator choice, not a silent gap.
- Use `knex.schema.alterTable(...)`, `hasColumn`, etc. rather than `knex.raw('ALTER TABLE ...')` where you can — the schema builder is portable across MySQL + SQLite, and the test SQLite runs the same files.
- For multi-step DDL where transactional safety matters (rare on MySQL since it auto-commits DDL anyway), the migration's default transaction wrapper still helps SQLite and PostgreSQL.

### Idempotency for the initial migration

The initial migration is the only one that needs to be safe against an existing schema. Going forward, migrations are linear: knex tracks each one in `knex_migrations`, so a second `migrate:latest` skips already-applied files. You don't need `hasTable` guards in follow-up migrations.

### When to use `knex.raw`

Knex's schema builder doesn't cover every operation. Examples that need `knex.raw`:

- Adding an index with non-trivial options (partial index, expression, type)
- `ALTER COLUMN` operations on MySQL (knex's `alter()` works but with caveats)
- Database-specific features (MySQL fulltext indexes, JSON path indexes, etc.)

When you do use raw SQL, comment WHY the schema builder wasn't enough — future-you will thank you when porting between DB engines.

## Tests

Tests don't use the knex CLI. Instead, `db/schema.js` runs
`knex.migrate.latest({ directory: ... })` programmatically against
the in-memory SQLite pool that the test harness creates. Same
migration files, same up/down logic — just a different driver.

This means:

- **Tests pick up new migrations automatically** — drop a file in `knex/migrations/<db>/` and the next `npm test` builds the schema with it.
- **A migration that breaks on SQLite will fail tests** — useful early warning before it lands in MySQL prod. Watch out for type quirks (SQLite has no native boolean — knex maps to integer; date precision differs; etc.).
- **No manual schema-update step for the test path** — db/schema.js IS the migrations.

## Relationship to `/repo-db-schema.sql` and `/repo_queue-schema.sql`

Those two SQL files at the project root are the legacy v1 schema artifacts that bootstrapped the production DB before v2. They are NOT consumed by v2 — the v2 migrations are the source of truth from this point forward. The .sql files are kept as historical reference + a recovery option if migrations ever need to be reseeded from scratch.

If a migration's intent ever diverges from those .sql files, the migrations win. We don't try to keep the .sql files in sync.
