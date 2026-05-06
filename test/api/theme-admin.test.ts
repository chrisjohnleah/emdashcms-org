import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  getAdminThemeDetail,
  getAllThemes,
  setThemeStatus,
} from "../../src/lib/db/admin-queries";

const AUTHOR_ID = "theme-admin-author";
const THEME_ID = "theme-admin-theme";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      AUTHOR_ID,
      910001,
      "theme-admin",
      "https://avatars.githubusercontent.com/u/910001",
      1,
      "2026-04-01T08:00:00Z",
      "2026-04-01T08:00:00Z",
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO themes (
        id, author_id, name, short_description, description, keywords,
        category, repository_url, preview_url, homepage_url, license,
        status, downloads_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      THEME_ID,
      AUTHOR_ID,
      "Admin Theme",
      "Admin-visible theme",
      "Theme admin moderation test",
      '["admin","theme"]',
      "docs",
      "https://github.com/example/admin-theme",
      "https://preview.example.com/admin-theme",
      "https://admin-theme.example.com",
      "MIT",
      "active",
      7,
      "2026-04-02T08:00:00Z",
      "2026-04-02T08:00:00Z",
    ),
  ]);
});

describe("theme admin moderation queries", () => {
  it("getAllThemes exposes status and moderation metadata", async () => {
    const themes = await getAllThemes(env.DB);
    const theme = themes.find((item) => item.id === THEME_ID);
    expect(theme).toBeDefined();
    expect(theme!.status).toBe("active");
    expect(theme!.authorUsername).toBe("theme-admin");
    expect(theme!.downloadCount).toBe(7);
    expect(theme!.openReportCount).toBe(0);
  });

  it("setThemeStatus revokes and restores a theme", async () => {
    expect(await setThemeStatus(env.DB, THEME_ID, "revoked")).toBe(true);
    let detail = await getAdminThemeDetail(env.DB, THEME_ID);
    expect(detail!.status).toBe("revoked");

    expect(await setThemeStatus(env.DB, THEME_ID, "active")).toBe(true);
    detail = await getAdminThemeDetail(env.DB, THEME_ID);
    expect(detail!.status).toBe("active");
  });

  it("getAdminThemeDetail returns revoked themes to staff", async () => {
    await setThemeStatus(env.DB, THEME_ID, "revoked");

    const detail = await getAdminThemeDetail(env.DB, THEME_ID);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(THEME_ID);
    expect(detail!.status).toBe("revoked");
    expect(detail!.keywords).toEqual(["admin", "theme"]);
    expect(detail!.repositoryUrl).toBe("https://github.com/example/admin-theme");

    await setThemeStatus(env.DB, THEME_ID, "active");
  });
});
