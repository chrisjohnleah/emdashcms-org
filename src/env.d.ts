declare namespace App {
  interface Locals {
    /** Set by auth middleware when a valid session JWT is present */
    author?: {
      id: string;
      githubId: number;
      username: string;
    };
    /**
     * The Cloudflare Workers ExecutionContext, injected by
     * @astrojs/cloudflare. Use `cfContext.waitUntil(promise)` to extend
     * the request lifetime past the response — handy for fire-and-forget
     * counter increments and analytics writes. Optional because Astro
     * dev (`astro dev`) does not run inside workerd; only `npm run
     * dev:worker` and production deploys populate it.
     */
    cfContext?: ExecutionContext;
  }
}

// Optional secrets — set via `wrangler secret put <NAME>` when ready.
// Not in wrangler.jsonc required[] so deploys succeed before they're provisioned.
declare namespace Cloudflare {
  interface Env {
    GITHUB_WEBHOOK_SECRET: string;
    GITHUB_APP_PRIVATE_KEY: string;
  }
}
