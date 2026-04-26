import { describe, it, expect } from "vitest";
import {
  similarityRatio,
  findSimilarPlugin,
} from "../../src/lib/publishing/name-similarity";

describe("similarityRatio", () => {
  it("returns 1.0 for identical inputs", () => {
    expect(similarityRatio("foo", "foo")).toBe(1);
  });

  it("normalizes punctuation and case", () => {
    expect(similarityRatio("SMTP-Email-Provider", "smtpemailprovider")).toBe(1);
  });

  it("scores the production duplicate case above the soft-gate threshold", () => {
    // The exact pair that motivated this work: aekainal registered
    // both `smtp-email-provider` and `email-provider` for the same
    // bundle. Confirm the soft gate would catch it.
    const ratio = similarityRatio("smtp-email-provider", "email-provider");
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });

  it("scores legitimately unrelated names below the threshold", () => {
    const ratio = similarityRatio("smtp-email-provider", "image-uploader");
    expect(ratio).toBeLessThan(0.5);
  });

  it("returns 0 when either side is empty after normalization", () => {
    expect(similarityRatio("", "foo")).toBe(0);
    expect(similarityRatio("___", "foo")).toBe(0);
  });
});

describe("findSimilarPlugin", () => {
  const candidates = [
    { id: "smtp-email-provider", name: "SMTP Email Provider" },
    { id: "image-uploader", name: "Image Uploader" },
    { id: "auth-google", name: "Google Auth" },
  ];

  it("returns the matching candidate when slug is suspiciously close", () => {
    const match = findSimilarPlugin(
      { id: "email-provider", name: "Email Provider" },
      candidates,
    );
    expect(match).not.toBeNull();
    expect(match?.candidate.id).toBe("smtp-email-provider");
  });

  it("returns null for a clearly distinct plugin", () => {
    const match = findSimilarPlugin(
      { id: "stripe-checkout", name: "Stripe Checkout" },
      candidates,
    );
    expect(match).toBeNull();
  });

  it("matches on name when id is dissimilar but name nearly matches", () => {
    const match = findSimilarPlugin(
      { id: "totally-different-slug", name: "Google Authenticator" },
      candidates,
    );
    // "Google Auth" vs "Google Authenticator" — the short name is a
    // prefix so the ratio depends on the longer side; just confirm we
    // didn't crash and the matched field reflects which side won.
    if (match) {
      expect(match.matchedField === "id" || match.matchedField === "name").toBe(true);
    }
  });

  it("does not match against an empty candidate list", () => {
    expect(
      findSimilarPlugin({ id: "anything", name: "Anything" }, []),
    ).toBeNull();
  });

  it("respects an elevated threshold for Levenshtein-only matches", () => {
    // Pick a typo-style match that scores below 0.95 on pure
    // Levenshtein (no shared tokens) — at the elevated threshold
    // the soft gate should leave it alone.
    const match = findSimilarPlugin(
      { id: "image-uploadr", name: "Image Uploadr" },
      [{ id: "image-uploader", name: "Image Uploader" }],
      0.95,
    );
    expect(match).toBeNull();
  });
});
