# Contributing

Thanks for your interest in emdashcms.org. This is the community plugin and theme registry for [EmDash CMS](https://emdashcms.com), and contributions are very welcome — code, docs, bug reports, design feedback, all of it.

## Quickstart

```bash
git clone https://github.com/chrisjohnleah/emdashcms-org.git
cd emdashcms-org
npm install
npm run db:migrate:local
npm run db:seed
npm run dev
```

That gives you a local server with a seeded database. Open http://localhost:4321 and you should see the site.

## What you'll want to read first

- **[`docs/database.md`](docs/database.md)** — how migrations work, how to create one, how to recover from drift. **Read this before touching anything in `migrations/` or writing a query that depends on new schema.**
- **[`docs/deployment.md`](docs/deployment.md)** — how production deploys work via GitHub Actions, including the migration gate. Useful context even if you never deploy.
- **[`CLAUDE.md`](CLAUDE.md)** — the project's working principles. Worth a skim regardless of whether you're using AI tooling.
- **The plugin contributor guide on the live site** at [`/docs/contributors`](https://emdashcms.org/docs/contributors) — covers the user-facing publishing flow if you're contributing a plugin or theme rather than code.

## Validating changes

Before opening a pull request:

```bash
npm test          # vitest run, ~15s
npm run build     # wrangler types && astro check && astro build
```

Both must pass. The [CI workflow](.github/workflows/ci.yml) runs the same checks on every PR and on every push to a non-main branch — no secrets needed, so forks can validate without extra setup.

## Pull request conventions

- **One concern per PR.** Mixing a bug fix and a refactor in one PR makes it hard to review and impossible to revert cleanly.
- **Conventional commits.** The repo uses `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:` prefixes with optional scope. Look at recent commits in `git log --oneline` to match the style.
- **Migrations land in the same PR as the code that needs them.** If your PR adds a query that references a new column, the migration that adds the column must be in the same commit. See [`docs/database.md`](docs/database.md#always-commit-migrations-alongside-the-code-that-needs-them) for the reasoning.
- **Keep diffs focused.** Don't reformat unrelated files. Don't update dependencies that aren't required for your change.

## What lands cleanly

Things this project tends to merge quickly:

- Bug fixes with a regression test
- Documentation improvements
- Accessibility fixes (ARIA, keyboard support, focus management)
- Performance improvements with a measurable before/after
- New plugin/theme manifest features that match the EmDash upstream contract

Things this project tends to push back on:

- New dependencies (the project tries to stay close to the platform — Astro + native Workers APIs)
- Speculative abstractions ahead of the second concrete use case
- UI changes that drift from the design direction (see [`CLAUDE.md`](CLAUDE.md) for the design context entry point)

## Code of conduct

By participating in this project, you agree to abide by the [Code of Conduct](https://emdashcms.org/code-of-conduct).

## Reporting security issues

Please do not file public issues for security vulnerabilities. See the [Security Policy](https://emdashcms.org/docs/security) on the live site for the responsible disclosure process.

## Independence statement

This is an independent community project. It is not affiliated with Cloudflare or the EmDash project itself, though it is designed to be API-compatible with EmDash CMS's marketplace contract and could plausibly become the official registry in the future. See the [README](README.md) for more on the project's stance.
