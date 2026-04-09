/**
 * Recipient resolution: owner + maintainer(s) for a plugin or theme.
 *
 * Policy (CONTEXT.md D-11):
 *   - Notifications go to every author with role 'owner' or 'maintainer'
 *     on the target entity.
 *   - Contributors are EXCLUDED from notifications — they have upload
 *     rights but not governance visibility over audit/revoke/report events.
 *
 * This module deliberately does NOT look up author email addresses.
 * Email resolution is the consumer's job at send time, via
 * `preference-queries.resolveEffectiveEmail`, because the source-of-truth
 * for the address depends on the preference row (`email_override`) and
 * the author row (`email`, `email_bounced_at`).
 */

import { getCollaborators } from "../auth/collaborator-queries";
import type { NotificationEntityType } from "../../types/marketplace";

export interface Recipient {
  authorId: string;
  githubUsername: string;
  role: "owner" | "maintainer";
}

/**
 * Resolve the set of recipients for a notification targeting a specific
 * plugin or theme.
 *
 * `entityType` is accepted for call-site clarity but the underlying
 * `getCollaborators()` query already does a UNION ALL across plugins and
 * themes, so a single id dispatches correctly regardless of which table
 * owns the row.
 */
export async function resolveRecipients(
  db: D1Database,
  entityType: Extract<NotificationEntityType, "plugin" | "theme">,
  entityId: string,
): Promise<Recipient[]> {
  // Kept in the signature so future callers reading the code see the
  // intended entity type; the collaborator query is entity-agnostic.
  void entityType;

  const collaborators = await getCollaborators(db, entityId);
  return collaborators
    .filter((c) => c.role === "owner" || c.role === "maintainer")
    .map((c) => ({
      authorId: c.authorId,
      githubUsername: c.githubUsername,
      role: c.role as "owner" | "maintainer",
    }));
}
