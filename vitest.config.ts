import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker-test-entry.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      // Disable remote bindings — tests mock all external services (AI,
      // fetch, etc.) so the pool doesn't need to dial Cloudflare's edge.
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          JWT_SECRET: "test-jwt-secret-at-least-32-characters-long-for-hs256",
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret-at-least-32-characters",
          GITHUB_APP_PRIVATE_KEY: "test-placeholder",
          GITHUB_APP_ID: "12345",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    // Exclude nested git worktrees (`.claude/worktrees/*`) and the
    // standard noisy paths so vitest only picks up THIS worktree's tests.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      ".claude/**",
    ],
  },
});
