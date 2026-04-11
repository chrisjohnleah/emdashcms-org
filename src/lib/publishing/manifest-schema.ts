import * as z from "zod/mini";

/**
 * Zod/mini validation schema for plugin manifest.json files.
 *
 * Mirrors the upstream schema in:
 *   github.com/emdash-cms/emdash/packages/core/src/plugins/manifest-schema.ts
 *
 * Whenever upstream adds a capability or hook, the corresponding constant
 * below must be updated. The constants are exported so the rest of the
 * marketplace (form pickers, API validation, capability badges) shares one
 * source of truth.
 */

/** The 11 plugin capabilities recognised by EmDash core. */
export const PLUGIN_CAPABILITIES = [
  "network:fetch",
  "network:fetch:any",
  "read:content",
  "write:content",
  "read:media",
  "write:media",
  "read:users",
  "email:send",
  "email:provide",
  "email:intercept",
  "page:inject",
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/** The 20 hook names recognised by EmDash core. */
export const HOOK_NAMES = [
  "plugin:install",
  "plugin:activate",
  "plugin:deactivate",
  "plugin:uninstall",
  "content:beforeSave",
  "content:afterSave",
  "content:beforeDelete",
  "content:afterDelete",
  "media:beforeUpload",
  "media:afterUpload",
  "cron",
  "email:beforeSend",
  "email:deliver",
  "email:afterSend",
  "comment:beforeCreate",
  "comment:moderate",
  "comment:afterCreate",
  "comment:afterModerate",
  "page:metadata",
  "page:fragments",
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

const PLUGIN_CAPABILITIES_SET: ReadonlySet<string> = new Set(PLUGIN_CAPABILITIES);
const HOOK_NAMES_SET: ReadonlySet<string> = new Set(HOOK_NAMES);

const capabilitySchema = z.string().check(
  z.refine((val) => PLUGIN_CAPABILITIES_SET.has(val), {
    message: `Capability must be one of: ${PLUGIN_CAPABILITIES.join(", ")}`,
  }),
);

const hookNameSchema = z.string().check(
  z.refine((val) => HOOK_NAMES_SET.has(val), {
    message: `Hook name must be one of: ${HOOK_NAMES.join(", ")}`,
  }),
);

export const manifestSchema = z.object({
  // Required: lowercase or @scope/name, per D-01
  id: z.string().check(z.regex(/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/)),

  // Required: strict semver X.Y.Z
  version: z.string().check(z.regex(/^\d+\.\d+\.\d+$/)),

  // Required: array of capability strings, each from PLUGIN_CAPABILITIES
  capabilities: z.array(capabilitySchema),

  // Required: array of allowed external hosts
  allowedHosts: z.array(z.string()),

  // Optional/nullable: key-value storage declarations.
  // Upstream requires this; we accept null/undefined for backwards compatibility
  // with the very first prod plugin which omitted it. Treat missing as {}.
  storage: z.nullable(z.optional(z.record(z.string(), z.unknown()))),

  // Required: hook declarations (string from HOOK_NAMES, or structured object).
  hooks: z.array(
    z.union([
      hookNameSchema,
      z.object({
        name: hookNameSchema,
        exclusive: z.optional(z.boolean()),
        priority: z.optional(z.number()),
        timeout: z.optional(z.number()),
      }),
    ]),
  ),

  // Required: route declarations (string or structured object)
  routes: z.array(
    z.union([
      z.string(),
      z.object({
        name: z.string(),
        public: z.optional(z.boolean()),
      }),
    ]),
  ),

  // Optional/nullable: admin panel configuration
  admin: z.nullable(
    z.optional(
      z.object({
        entry: z.optional(z.string()),
        settingsSchema: z.optional(z.record(z.string(), z.unknown())),
        pages: z.optional(
          z.array(
            z.object({
              path: z.string(),
              label: z.string(),
              icon: z.optional(z.string()),
            }),
          ),
        ),
        widgets: z.optional(
          z.array(
            z.object({
              id: z.string(),
              size: z.optional(z.string()),
              title: z.optional(z.string()),
            }),
          ),
        ),
        fieldWidgets: z.optional(
          z.array(
            z.object({
              name: z.string(),
              label: z.string(),
              fieldTypes: z.array(z.string()),
              elements: z.array(z.string()),
            }),
          ),
        ),
      }),
    ),
  ),

  // Optional publishing metadata
  name: z.optional(z.string().check(z.maxLength(256))),
  // Caps on the two long-form prose fields are DOS-hardening, not
  // content policy. They're rendered through markdown-it at request
  // time; Workers free-tier CPU is 10ms and a multi-megabyte markdown
  // parse would blow that budget, so we reject at upload instead of
  // rendering. 8KB is more than a generous README intro — longer
  // prose belongs in the repo.
  description: z.optional(z.string().check(z.maxLength(8192))),
  minEmDashVersion: z.optional(z.string().check(z.maxLength(64))),
  changelog: z.optional(z.string().check(z.maxLength(8192))),
});

export type ValidatedManifest = z.infer<typeof manifestSchema>;

/**
 * Extract user-friendly error messages from a Zod/mini validation error.
 */
export function formatManifestErrors(error: z.core.$ZodError): string[] {
  return error.issues.map((issue: z.core.$ZodIssue) => {
    const path = issue.path?.length ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}

/**
 * Normalise a hook entry to its name string. Accepts both legacy plain
 * strings and structured objects per the upstream contract.
 */
export function hookName(entry: string | { name: string }): string {
  return typeof entry === "string" ? entry : entry.name;
}
