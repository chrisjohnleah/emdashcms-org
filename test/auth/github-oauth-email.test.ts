import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { env } from "cloudflare:test";
import {
  pickPublishableEmail,
  fetchPrimaryEmail,
  upsertAuthor,
  type GitHubEmail,
  type GitHubUser,
} from "../../src/lib/auth/github";

// ---------------------------------------------------------------------------
// pickPublishableEmail
// ---------------------------------------------------------------------------

describe("pickPublishableEmail", () => {
  it("returns the primary verified email when available", () => {
    const emails: GitHubEmail[] = [
      {
        email: "a@example.com",
        primary: true,
        verified: true,
        visibility: null,
      },
    ];
    expect(pickPublishableEmail(emails)).toBe("a@example.com");
  });

  it("filters out @users.noreply.github.com primary addresses", () => {
    const emails: GitHubEmail[] = [
      {
        email: "12345678+user@users.noreply.github.com",
        primary: true,
        verified: true,
        visibility: null,
      },
    ];
    expect(pickPublishableEmail(emails)).toBeNull();
  });

  it("returns null when the primary is not verified", () => {
    const emails: GitHubEmail[] = [
      {
        email: "a@example.com",
        primary: true,
        verified: false,
        visibility: null,
      },
    ];
    expect(pickPublishableEmail(emails)).toBeNull();
  });

  it("returns null when no primary address exists", () => {
    const emails: GitHubEmail[] = [
      {
        email: "b@example.com",
        primary: false,
        verified: true,
        visibility: null,
      },
    ];
    expect(pickPublishableEmail(emails)).toBeNull();
  });

  it("returns null for empty email list", () => {
    expect(pickPublishableEmail([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchPrimaryEmail
// ---------------------------------------------------------------------------

describe("fetchPrimaryEmail", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls /user/emails with Bearer auth", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            email: "primary@example.com",
            primary: true,
            verified: true,
            visibility: null,
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const result = await fetchPrimaryEmail("test-token");
    expect(result).toBe("primary@example.com");

    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call![0]).toBe("https://api.github.com/user/emails");
    const init = call![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("returns null when /user/emails returns non-OK", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    );
    expect(await fetchPrimaryEmail("bad")).toBeNull();
  });

  it("returns null when primary is a noreply address", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            email: "12345+u@users.noreply.github.com",
            primary: true,
            verified: true,
            visibility: null,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    expect(await fetchPrimaryEmail("tok")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upsertAuthor with email
// ---------------------------------------------------------------------------

describe("upsertAuthor (extended with email)", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "DELETE FROM authors WHERE github_id BETWEEN ? AND ?",
    )
      .bind(850000, 859999)
      .run();
  });

  it("writes email on first insert", async () => {
    const user: GitHubUser = {
      id: 850001,
      login: "e1",
      avatar_url: "https://example.com/avatar.jpg",
    };
    const id = await upsertAuthor(user, "first@example.com");
    const row = await env.DB.prepare(
      "SELECT email FROM authors WHERE id = ?",
    )
      .bind(id)
      .first<{ email: string | null }>();
    expect(row?.email).toBe("first@example.com");
  });

  it("updates email on subsequent login when different", async () => {
    const user: GitHubUser = {
      id: 850002,
      login: "e2",
      avatar_url: null,
    };
    const id = await upsertAuthor(user, "old@example.com");
    await upsertAuthor(user, "new@example.com");
    const row = await env.DB.prepare(
      "SELECT email FROM authors WHERE id = ?",
    )
      .bind(id)
      .first<{ email: string | null }>();
    expect(row?.email).toBe("new@example.com");
  });

  it("clears email_bounced_at when email is updated", async () => {
    const user: GitHubUser = {
      id: 850003,
      login: "e3",
      avatar_url: null,
    };
    const id = await upsertAuthor(user, "stale@example.com");
    await env.DB.prepare(
      "UPDATE authors SET email_bounced_at = ? WHERE id = ?",
    )
      .bind("2026-04-01T00:00:00Z", id)
      .run();
    await upsertAuthor(user, "fresh@example.com");
    const row = await env.DB.prepare(
      "SELECT email_bounced_at FROM authors WHERE id = ?",
    )
      .bind(id)
      .first<{ email_bounced_at: string | null }>();
    expect(row?.email_bounced_at).toBeNull();
  });

  it("does not overwrite stored email when called with null", async () => {
    const user: GitHubUser = {
      id: 850004,
      login: "e4",
      avatar_url: null,
    };
    const id = await upsertAuthor(user, "kept@example.com");
    await upsertAuthor(user, null);
    const row = await env.DB.prepare(
      "SELECT email FROM authors WHERE id = ?",
    )
      .bind(id)
      .first<{ email: string | null }>();
    expect(row?.email).toBe("kept@example.com");
  });

  it("defaults email to null on insert when not provided (backward compat)", async () => {
    const user: GitHubUser = {
      id: 850005,
      login: "e5",
      avatar_url: null,
    };
    // Call with single argument — default email param = null
    const id = await upsertAuthor(user);
    const row = await env.DB.prepare(
      "SELECT email FROM authors WHERE id = ?",
    )
      .bind(id)
      .first<{ email: string | null }>();
    expect(row?.email).toBeNull();
  });

  it("does not clear email_bounced_at when email is unchanged", async () => {
    const user: GitHubUser = {
      id: 850006,
      login: "e6",
      avatar_url: null,
    };
    const id = await upsertAuthor(user, "same@example.com");
    await env.DB.prepare(
      "UPDATE authors SET email_bounced_at = ? WHERE id = ?",
    )
      .bind("2026-04-01T00:00:00Z", id)
      .run();
    // Calling upsert with the SAME email should NOT clear the bounce flag
    await upsertAuthor(user, "same@example.com");
    const row = await env.DB.prepare(
      "SELECT email_bounced_at FROM authors WHERE id = ?",
    )
      .bind(id)
      .first<{ email_bounced_at: string | null }>();
    expect(row?.email_bounced_at).toBe("2026-04-01T00:00:00Z");
  });
});
