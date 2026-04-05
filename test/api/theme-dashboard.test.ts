import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  registerTheme,
  getThemesByAuthor,
  getThemeOwner,
  updateThemeMetadata,
  updateThemeThumbnailKey,
  updateThemeScreenshotKeys,
} from "../../src/lib/publishing/theme-queries";
import {
  validateImageUpload,
  MIME_TO_EXT,
  MAX_IMAGE_SIZE,
  ALLOWED_MIME_TYPES,
} from "../../src/lib/publishing/image-storage";

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "td-author-1",
      5001,
      "theme-dev",
      "https://avatars.githubusercontent.com/u/5001",
      0,
      "2026-04-01T08:00:00Z",
      "2026-04-01T08:00:00Z",
    )
    .run();
});

// ---------------------------------------------------------------------------
// Theme Registration
// ---------------------------------------------------------------------------

describe("theme registration", () => {
  it("registerTheme creates a record retrievable by getThemeOwner", async () => {
    await registerTheme(env.DB, "td-author-1", {
      id: "td-test-theme",
      name: "Test Theme",
      description: "A theme for testing",
      keywords: ["test", "demo"],
      preview_url: "https://preview.example.com",
      demo_url: "https://demo.example.com",
      repository_url: "https://github.com/test/theme",
      homepage_url: "https://theme.example.com",
      license: "MIT",
    });

    const owner = await getThemeOwner(env.DB, "td-test-theme");
    expect(owner).not.toBeNull();
    expect(owner!.authorId).toBe("td-author-1");
  });

  it("getThemesByAuthor returns correct themes ordered by updated_at DESC", async () => {
    // Register a second theme to verify ordering
    await registerTheme(env.DB, "td-author-1", {
      id: "td-second-theme",
      name: "Second Theme",
      description: "Another theme",
    });

    // Set explicit different timestamps to ensure deterministic ordering
    await env.DB.prepare(
      "UPDATE themes SET updated_at = '2026-04-01T10:00:00Z' WHERE id = ?",
    )
      .bind("td-test-theme")
      .run();
    await env.DB.prepare(
      "UPDATE themes SET updated_at = '2026-04-02T10:00:00Z' WHERE id = ?",
    )
      .bind("td-second-theme")
      .run();

    const themes = await getThemesByAuthor(env.DB, "td-author-1");
    expect(themes.length).toBe(2);
    // Second theme has later updated_at, so it should appear first (DESC order)
    expect(themes[0].id).toBe("td-second-theme");
    expect(themes[1].id).toBe("td-test-theme");
  });

  it("getThemeOwner returns null for nonexistent theme", async () => {
    const owner = await getThemeOwner(env.DB, "nonexistent-theme-xyz");
    expect(owner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Theme Metadata Updates
// ---------------------------------------------------------------------------

describe("theme metadata updates", () => {
  it("updateThemeMetadata updates only provided fields", async () => {
    await updateThemeMetadata(env.DB, "td-test-theme", {
      description: "Updated description",
      license: "Apache-2.0",
    });

    const row = await env.DB.prepare(
      "SELECT description, license, keywords FROM themes WHERE id = ?",
    )
      .bind("td-test-theme")
      .first<{ description: string; license: string; keywords: string }>();

    expect(row!.description).toBe("Updated description");
    expect(row!.license).toBe("Apache-2.0");
    // Keywords should remain unchanged
    expect(JSON.parse(row!.keywords)).toEqual(["test", "demo"]);
  });

  it("updateThemeMetadata with empty input does not throw", async () => {
    await expect(
      updateThemeMetadata(env.DB, "td-test-theme", {}),
    ).resolves.toBeUndefined();
  });

  it("updateThemeThumbnailKey sets thumbnail_key", async () => {
    await updateThemeThumbnailKey(
      env.DB,
      "td-test-theme",
      "themes/td-test-theme/thumbnail.png",
    );

    const row = await env.DB.prepare(
      "SELECT thumbnail_key FROM themes WHERE id = ?",
    )
      .bind("td-test-theme")
      .first<{ thumbnail_key: string }>();

    expect(row!.thumbnail_key).toBe("themes/td-test-theme/thumbnail.png");
  });

  it("updateThemeScreenshotKeys stores JSON array", async () => {
    const keys = [
      "themes/td-test-theme/screenshots/0.jpg",
      "themes/td-test-theme/screenshots/1.png",
    ];
    await updateThemeScreenshotKeys(env.DB, "td-test-theme", keys);

    const row = await env.DB.prepare(
      "SELECT screenshot_keys FROM themes WHERE id = ?",
    )
      .bind("td-test-theme")
      .first<{ screenshot_keys: string }>();

    expect(JSON.parse(row!.screenshot_keys)).toEqual(keys);
  });
});

// ---------------------------------------------------------------------------
// Image Validation
// ---------------------------------------------------------------------------

describe("image validation", () => {
  it("validateImageUpload accepts valid MIME types", async () => {
    for (const type of ALLOWED_MIME_TYPES) {
      const file = new File([new ArrayBuffer(1024)], "test.img", { type });
      const result = validateImageUpload(file);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    }
  });

  it("validateImageUpload rejects invalid MIME types with correct error message", async () => {
    const file = new File([new ArrayBuffer(1024)], "test.gif", {
      type: "image/gif",
    });
    const result = validateImageUpload(file);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "Only JPEG, PNG, and WebP images are accepted.",
    );
  });

  it("validateImageUpload rejects oversized files with correct error message", async () => {
    const file = new File(
      [new ArrayBuffer(6 * 1024 * 1024)],
      "large.jpg",
      { type: "image/jpeg" },
    );
    const result = validateImageUpload(file);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Each image must be under 5MB.");
  });

  it("MIME_TO_EXT maps correctly", () => {
    expect(MIME_TO_EXT["image/jpeg"]).toBe("jpg");
    expect(MIME_TO_EXT["image/png"]).toBe("png");
    expect(MIME_TO_EXT["image/webp"]).toBe("webp");
  });

  it("MAX_IMAGE_SIZE is 5MB", () => {
    expect(MAX_IMAGE_SIZE).toBe(5 * 1024 * 1024);
  });
});
