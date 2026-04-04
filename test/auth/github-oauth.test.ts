import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { upsertAuthor, type GitHubUser } from "../../src/lib/auth/github";

describe("Author upsert", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM authors").run();
  });

  it("creates a new author row in D1", async () => {
    const user: GitHubUser = {
      id: 99,
      login: "newuser",
      avatar_url: "https://example.com/avatar.jpg",
    };
    const authorId = await upsertAuthor(user);
    expect(typeof authorId).toBe("string");
    expect(authorId.length).toBeGreaterThan(0);

    const row = await env.DB.prepare(
      "SELECT * FROM authors WHERE github_id = ?",
    )
      .bind(99)
      .first();
    expect(row).not.toBeNull();
    expect(row!.github_id).toBe(99);
    expect(row!.github_username).toBe("newuser");
    expect(row!.avatar_url).toBe("https://example.com/avatar.jpg");
  });

  it("new author has verified=0", async () => {
    const user: GitHubUser = {
      id: 100,
      login: "unverified",
      avatar_url: null,
    };
    await upsertAuthor(user);

    const row = await env.DB.prepare(
      "SELECT verified FROM authors WHERE github_id = ?",
    )
      .bind(100)
      .first();
    expect(row!.verified).toBe(0);
  });

  it("updates github_username on subsequent login", async () => {
    const user: GitHubUser = {
      id: 200,
      login: "oldname",
      avatar_url: "https://example.com/a.jpg",
    };
    await upsertAuthor(user);

    const updated: GitHubUser = {
      id: 200,
      login: "newname",
      avatar_url: "https://example.com/a.jpg",
    };
    await upsertAuthor(updated);

    const row = await env.DB.prepare(
      "SELECT github_username FROM authors WHERE github_id = ?",
    )
      .bind(200)
      .first();
    expect(row!.github_username).toBe("newname");
  });

  it("updates avatar_url on subsequent login", async () => {
    const user: GitHubUser = {
      id: 300,
      login: "avataruser",
      avatar_url: "https://example.com/old.jpg",
    };
    await upsertAuthor(user);

    const updated: GitHubUser = {
      id: 300,
      login: "avataruser",
      avatar_url: "https://example.com/new.jpg",
    };
    await upsertAuthor(updated);

    const row = await env.DB.prepare(
      "SELECT avatar_url FROM authors WHERE github_id = ?",
    )
      .bind(300)
      .first();
    expect(row!.avatar_url).toBe("https://example.com/new.jpg");
  });

  it("returns the same author id on subsequent login", async () => {
    const user: GitHubUser = {
      id: 400,
      login: "stableuser",
      avatar_url: null,
    };
    const firstId = await upsertAuthor(user);
    const secondId = await upsertAuthor(user);
    expect(firstId).toBe(secondId);
  });
});
