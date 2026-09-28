import type { RegistryAccess } from "./client";

// Plain-English labels for the registry's declaredAccess areas
// (com.emdashcms.experimental.package.releaseExtension). Unknown areas
// fall back to the raw key so new upstream permissions still render.
const AREAS: Record<string, string> = {
  admin: "Admin panel",
  content: "Site content",
  comments: "Comments",
  schema: "Content schema",
  taxonomies: "Categories and tags",
  bylines: "Bylines",
  redirects: "Redirects",
  media: "Media library",
  network: "Outbound network requests",
  email: "Email",
  page: "Public pages",
  users: "User accounts",
};

const words = (op: string) => op.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

export function describeAccess(access: RegistryAccess[]): Array<{ label: string; detail: string }> {
  return access.map((a) => ({
    label: AREAS[a.area] ?? a.area,
    detail:
      a.hosts.length > 0
        ? `Can contact: ${a.hosts.join(", ")}`
        : a.operations.length > 0
          ? `Can ${a.operations.map(words).join(", ")}`
          : "Declared",
  }));
}
