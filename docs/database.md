# Database

emdashcms.org uses [Cloudflare D1](https://developers.cloudflare.com/d1/) (a serverless SQLite at the edge) for all persistent state. Schema is managed through [Wrangler's D1 migration tooling](https://developers.cloudflare.com/d1/reference/migrations/) — there is no ORM and no schema-as-code generator. Migrations are plain SQL files, applied in numbered order, tracked in a `d1_migrations` table that wrangler maintains automatically.

The same database name (`emdashcms-org`) is used for both local development and production, distinguished by the `--local` and `--remote` flags. The local database lives in `.wrangler/state/v3/d1/`. The remote database lives in your Cloudflare account.

## Schema source of truth

The migrations under [`migrations/`](../migrations) are the source of truth. There is no separate schema file. To understand the current schema:

- Read the migrations in numbered order
- Or query the live schema with: `wrangler d1 execute emdashcms-org --local --command="SELECT sql FROM sqlite_master WHERE type='table'"`

## Common tasks

### Check migration status

```bash
npm run db:status         # remote (production)
npm run db:status:local   # local dev database
```

These wrap `wrangler d1 migrations list` and print a table of which migrations are applied vs pending. Use this whenever you suspect drift, or before applying anything.

### Create a new migration

```bash
npm run db:create-migration -- add_new_feature
```

This creates `migrations/000N_add_new_feature.sql` with a numbered prefix. Edit the file with your SQL, then apply locally first to verify (see below).

### Apply migrations locally

```bash
npm run db:migrate:local
```

Run this after pulling new commits that include migrations, after creating a new migration, or after running `npm run db:seed` (which assumes the schema is current).

### Apply migrations to production

**You almost never run this manually.** Production migrations are applied automatically by the deploy workflow ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) before the worker is deployed. The pipeline halts on migration failure, so a worker that expects new schema cannot ship in front of a database that doesn't have it.

If you genuinely need to apply migrations manually (recovery, or hot-fixing outside the deploy flow):

```bash
npm run db:migrate:remote
```

This requires your local wrangler to be authenticated with permission to mutate the production D1 database. **Do not do this lightly.**

### Seed the local database with dev data

```bash
npm run db:seed
```

Applies `seeds/dev.sql`. Local-only, never touches production.

## Writing migrations

D1 supports the SQLite SQL dialect. A few conventions specific to this project:

### Always commit migrations alongside the code that needs them

If you add `WHERE p.status = 'active'` to a query, the migration that adds the `status` column to `plugins` must land in the **same PR**. Splitting them across commits invites the exact failure we hit recovering this project: a worker deployed against a schema that hadn't caught up.

### Make migrations idempotent when touching existing tables

D1's migration tracking is good but not perfect — local databases can drift from the tracking table if SQL is run outside of `wrangler d1 migrations apply` (manual `wrangler d1 execute`, hand-imported dumps, partial migration aborts). When that happens, re-running an old migration throws `duplicate column` or `table already exists` and halts the entire run.

You can guard against this by writing migrations that check schema state before mutating it. For example, instead of:

```sql
ALTER TABLE plugins ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
```

…you can write a defensive form that's safe to re-run, though it adds verbosity. For most migrations the simpler path is to **not run SQL outside `wrangler d1 migrations apply`** and accept that drift recovery is a manual process when it does happen (recipe below).

### Never edit a migration after it's been applied to remote

A migration is immutable once it lands on production. If a published migration is wrong, write a new one that fixes it forward. Editing `0007_*.sql` after it has run causes the file's content to drift from the database's actual state with no way for tooling to detect it.

### Heavy migrations should run in chunks

D1 has a 30-second statement timeout and a 100k row limit per query. If a migration backfills millions of rows, batch it: do it in a series of smaller migrations, or write a one-shot `scripts/` task that pages through the data in batches. Do not put long-running data backfills in the migration file directly.

## Recovery: tracking table drift

This is the failure mode we hit while recovering this project. It happens when the schema is correct but the `d1_migrations` tracking table is missing entries — usually because someone executed SQL through a route that wrangler doesn't track (manual `wrangler d1 execute`, an imported dump, or a partial run that succeeded at the schema level but didn't record itself).

**Symptom**: `npm run db:migrate:local` (or `:remote`) fails with `duplicate column name: <name>` or `table <name> already exists`, and the migration that fails is one whose changes are clearly already present in the live schema.

**Recovery**:

1. **Confirm the schema actually matches what the failing migration wants to add.** Don't skip this step — if the schema is genuinely missing what the migration adds, you have a different problem.

   ```bash
   wrangler d1 execute emdashcms-org --local --command \
     "SELECT sql FROM sqlite_master WHERE type='table' AND name='<table>'"
   ```

   Confirm the column or table the migration tries to add is already there.

2. **Inspect the tracking table to see what wrangler thinks is applied.**

   ```bash
   wrangler d1 execute emdashcms-org --local --command \
     "SELECT id, name, applied_at FROM d1_migrations ORDER BY id"
   ```

   The missing entries will be obvious — they correspond to the migrations that `npm run db:status:local` says are still pending.

3. **Insert phantom rows for the migrations whose schema is already present.** This tells wrangler "this one is done" without re-running the SQL. Use the exact filename, including the `.sql` extension.

   ```bash
   wrangler d1 execute emdashcms-org --local --command \
     "INSERT INTO d1_migrations (name, applied_at) VALUES \
      ('0014_author_bans.sql', datetime('now')), \
      ('0015_reports.sql', datetime('now'))"
   ```

4. **Re-run the migration command.** It should now skip the phantom-applied migrations and only apply the ones that are genuinely pending.

   ```bash
   npm run db:migrate:local
   ```

5. **Verify with `npm run db:status:local`.** Should show all migrations applied.

**For remote drift, use `--remote` everywhere instead of `--local`. Tread very carefully** — production data is involved. Always run step 1 (confirm the schema matches) before any inserts to the remote tracking table.

## Why D1 and not Postgres / MySQL / Drizzle?

D1 fits this project's constraints: free tier, edge-resident, zero ops, exactly the storage layer Cloudflare Workers expect. Drizzle ORM with D1 is the more modern OSS pattern and the project may migrate to it in a future milestone — but for now, plain SQL migrations with wrangler tooling are the simplest thing that works and the fewest dependencies to maintain.
