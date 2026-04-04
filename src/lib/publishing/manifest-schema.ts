import * as z from "zod/mini";

/**
 * Zod/mini validation schema for plugin manifest.json files.
 * Validates all fields from the PluginManifest contract with stricter
 * type enforcement than the upstream TypeScript interface.
 */
export const manifestSchema = z.object({
  // Required: lowercase or @scope/name, per D-01
  id: z.string().check(z.regex(/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/)),

  // Required: strict semver X.Y.Z
  version: z.string().check(z.regex(/^\d+\.\d+\.\d+$/)),

  // Required: array of capability strings (can be empty)
  capabilities: z.array(z.string()),

  // Required: array of allowed external hosts
  allowedHosts: z.array(z.string()),

  // Optional/nullable: key-value storage declarations
  storage: z.nullable(z.optional(z.record(z.string(), z.unknown()))),

  // Required: hook declarations (string or structured object)
  hooks: z.array(
    z.union([
      z.string(),
      z.object({
        name: z.string(),
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
  name: z.optional(z.string()),
  description: z.optional(z.string()),
  minEmDashVersion: z.optional(z.string()),
  changelog: z.optional(z.string()),
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
