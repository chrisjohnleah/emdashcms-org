# EmDash Registry

The community plugin and theme registry for [EmDash CMS](https://emdashcms.com).

Browse, share, and install community-built plugins and themes for EmDash.

## Status

Early development. Not yet launched.

## Stack

- [Astro 6](https://astro.build) — full-stack framework
- [Cloudflare Workers](https://workers.cloudflare.com) — runtime and deployment
- [Cloudflare D1](https://developers.cloudflare.com/d1/) — database
- [Cloudflare R2](https://developers.cloudflare.com/r2/) — bundle storage
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) — automated security audit pipeline

## Development

```bash
npm install
npm run db:migrate:local
npm run db:seed
npm run dev
```

For more, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Deployment

Production deploys run via [GitHub Actions](.github/workflows/deploy.yml) on every push to `main`. The pipeline runs tests, builds the worker, applies any pending [D1 migrations](docs/database.md) against production, and only then deploys. If migrations fail, the deploy is halted and the previous worker keeps serving — see [`docs/deployment.md`](docs/deployment.md) for the full pipeline and [`docs/database.md`](docs/database.md) for the database runbook.

A separate [CI workflow](.github/workflows/ci.yml) runs on every pull request and on every push to a non-main branch, validating tests, types, and build without touching any Cloudflare resources. Forks can run it without configuring secrets.

## Disclaimer

This is an independent community project. Not affiliated with Cloudflare or the EmDash project.

## License

MIT
