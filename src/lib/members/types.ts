/**
 * Member identity types — intent-only typing on top of the existing
 * `authors` D1 table.
 *
 * `MemberId` denotes any authenticated identity. `AuthorId` denotes the
 * subset of members who own or maintain a plugin/theme. Both are
 * runtime-identical `string`s today (the D1 column is `authors.id` to
 * match the upstream `MarketplaceClient` wire contract — see MEMB-07).
 *
 * The aliases are NOT branded types — assigning a `MemberId` to an
 * `AuthorId` (or vice versa) is intentionally allowed at the type level.
 * The split is documentation made executable: when a future
 * non-publisher surface lands (review browsing, /members/[username]) its
 * parameter types make the IDENTITY-vs-AUTHOR distinction explicit
 * without needing a runtime change. See PROJECT.md "Key Decisions" row
 * dated 2026-04-28 for the deferred ban-scope split.
 */

/** Any authenticated identity. Same string as `authors.id` in D1. */
export type MemberId = string;

/** A member who owns or maintains at least one plugin or theme. */
export type AuthorId = string;

/**
 * Document a member id as an author id at call sites where the caller
 * has already established (via `isAuthor()` or RBAC check) that the
 * member owns/maintains content. Pure pass-through at runtime — exists
 * only so consumers explicitly opt in to the narrower meaning.
 */
export function asAuthorId(id: MemberId): AuthorId {
  return id;
}
