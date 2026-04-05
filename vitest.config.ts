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
  },
});
