declare namespace App {
  interface Locals {
    /** Set by auth middleware when a valid session JWT is present */
    author?: {
      id: string;
      githubId: number;
      username: string;
    };
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
