import { describe, it, expect, expectTypeOf } from "vitest";
import {
  asAuthorId,
  type MemberId,
  type AuthorId,
} from "../../../src/lib/members";

describe("members/types — intent-only aliases", () => {
  it("MemberId and AuthorId are runtime-identical strings", () => {
    const m: MemberId = "snap-id";
    const a: AuthorId = m;
    const m2: MemberId = a;
    expect(asAuthorId(m)).toBe(m);
    expect(m2).toBe(a);
  });

  it("aliases are assignable in both directions (compile-time check)", () => {
    // If a future commit converts these to branded types, the next two
    // assertions fail to compile and the build breaks. That is the
    // point — branded types would break wire-contract round-tripping
    // (we serialize an `authors.id` string and the upstream
    // `MarketplaceClient` reads it back as a plain string). See
    // MEMB-07: no wire-contract change.
    expectTypeOf<MemberId>().toEqualTypeOf<AuthorId>();
    expectTypeOf<AuthorId>().toEqualTypeOf<MemberId>();
  });
});
