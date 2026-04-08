# Deployment

emdashcms.org deploys to Cloudflare Workers via a GitHub Actions pipeline. The entire pipeline lives in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) — there is no Cloudflare dashboard build configuration to chase down.

## How it works

Every push to `main` triggers the [Deploy](../.github/workflows/deploy.yml) workflow. It runs:

1. **Checkout + Node 22 install + npm ci** — clean dependency tree.
2. **`npm test`** — vitest suite. If anything fails, the pipeline halts here.
3. **`npm run build`** — runs `wrangler types && astro check && astro build`. Type errors and astro check failures halt the pipeline.
4. **`wrangler d1 migrations list emdashcms-org --remote`** — visibility step. Prints the applied/pending table into the workflow log so anyone reviewing the run can see exactly what's about to be applied to production.
5. **`wrangler d1 migrations apply emdashcms-org --remote`** — the migration gate. If migrations fail (drift, syntax error, duplicate columns) the pipeline halts here. The previous worker keeps serving the previous schema. See [`docs/database.md`](database.md#recovery-tracking-table-drift) for recovery.
6. **`wrangler deploy`** — uploads the built worker. Cloudflare flips traffic to the new version atomically.

A separate [CI workflow](../.github/workflows/ci.yml) runs the same validation (tests + build) on every pull request and on every push to a non-main branch. It does not need any secrets, so contributors can fork the repo and validate their changes without configuring anything.

## Concurrency and safety

- The deploy workflow uses a `deploy-production` concurrency group with `cancel-in-progress: false`. Two simultaneous pushes will queue rather than cancel each other — important because the migration step is not safe to interrupt mid-way.
- The CI workflow uses `cancel-in-progress: true` because validating an outdated commit is a waste.
- Production secrets (`GITHUB_CLIENT_SECRET`, `JWT_SECRET`, `TURNSTILE_SECRET_KEY`) live on the worker itself via `wrangler secret put`. They are not in GitHub Actions and the deploy step never sees them.

## Manual setup (one-time, by the project owner)

These three steps are not in the repo because they involve credentials and external service configuration. They only need to happen once.

### 1. Create a Cloudflare API token

In the [Cloudflare dashboard](https://dash.cloudflare.com/profile/api-tokens), create a token with these permissions on the account that hosts emdashcms.org:

- **Account → Workers Scripts → Edit** — required to deploy the worker
- **Account → D1 → Edit** — required to apply migrations
- **Account → Workers KV Storage → Edit** — required to deploy bindings to KV namespaces
- **Account → Workers R2 Storage → Edit** — required to deploy bindings to R2 buckets
- **Account → Account Settings → Read** — required for account discovery
- **User → User Details → Read** — required for `wrangler whoami` checks during deploy

Scope the token to the specific account hosting the worker. Set no expiry, or rotate annually if you want a recurring chore.

### 2. Add the token and account ID as GitHub repository secrets

In the GitHub repo at **Settings → Secrets and variables → Actions → New repository secret**, add:

- `CLOUDFLARE_API_TOKEN` — the token from step 1
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID, visible in the dashboard URL or under any zone's overview page

These are referenced by name in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). Forks need to add their own values to deploy their own copy.

### 3. Disconnect the Cloudflare dashboard Git integration (if connected)

If this repo was previously connected to Cloudflare Workers Builds via the dashboard's Git integration, **disconnect it now**. Otherwise every push to main will trigger two parallel deploys: one from GitHub Actions (the new pipeline) and one from Cloudflare's dashboard build (the old one). They will race, the migration gate will be bypassed half the time, and the deploy history becomes a mess.

In the [Cloudflare dashboard](https://dash.cloudflare.com), navigate to **Workers & Pages → emdashcms-org → Settings → Build → Git repository → Disconnect**.

After disconnecting, the only path that deploys the worker is the GitHub Actions workflow.

## Verifying a deploy

After a workflow run completes, verify production with:

```bash
curl -sS -o /dev/null -w "%{http_code} %{size_download}b %{time_starttransfer}s\n" https://emdashcms.org/
```

A 200 with a non-trivial byte count and a sub-300ms TTFB is the happy path. If you see a 5xx, check the workflow run logs and the [Cloudflare dashboard worker logs](https://dash.cloudflare.com).

## Rollback

D1 has no first-class rollback — migrations are forward-only. If you need to revert the worker code (without touching the database), find the previous successful deploy in the GitHub Actions history and re-run it via **Re-run all jobs**, or manually:

```bash
git revert <bad-commit>
git push origin main
```

The revert push triggers a fresh deploy with the previous code. If the bad commit included a migration that needs to be undone, you'll need a new migration that reverses it — there is no automatic rollback for schema changes.
