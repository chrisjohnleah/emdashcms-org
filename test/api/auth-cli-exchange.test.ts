import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { POST } from "../../src/pages/api/v1/auth/cli/exchange";

const GITHUB_USER = {
  id: 88001,
  login: "cli-publisher",
  avatar_url: "https://example.com/a.png",
};
const GITHUB_EMAILS = [
  { email: "cli@example.com", primary: true, verified: true, visibility: null },
];

function mockGitHub(opts: {
  user?: unknown | null;
  userStatus?: number;
  emails?: unknown;
  emailsStatus?: number;
}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/user/emails")) {
        return Promise.resolve(
          new Response(JSON.stringify(opts.emails ?? GITHUB_EMAILS), {
            status: opts.emailsStatus ?? 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.endsWith("/user")) {
        return Promise.resolve(
          new Response(
            opts.user === null ? "" : JSON.stringify(opts.user ?? GITHUB_USER),
            {
              status: opts.userStatus ?? (opts.user === null ? 401 : 200),
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
}

function invoke(body: unknown): Promise<Response> {
  const request = new Request("https://emdashcms.org/api/v1/auth/cli/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return (POST as unknown as (ctx: { request: Request }) => Promise<Response>)({
    request,
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM authors WHERE github_id = ?")
    .bind(GITHUB_USER.id)
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/auth/cli/exchange", () => {
  it("returns a marketplace JWT and author payload in the shape the CLI expects", async () => {
    mockGitHub({});
    const res = await invoke({ access_token: "gho_realtoken" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      author: { id: number; name: string };
    };
    expect(typeof body.token).toBe("string");
    expect(body.token.split(".")).toHaveLength(3);
    expect(body.author.id).toBe(GITHUB_USER.id);
    expect(body.author.name).toBe(GITHUB_USER.login);
  });

  it("rejects requests without an access_token", async () => {
    const res = await invoke({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/access_token/);
  });

  it("rejects malformed JSON bodies", async () => {
    const res = await invoke("{not json");
    expect(res.status).toBe(400);
  });

  it("returns 401 when the GitHub access token is rejected by GitHub", async () => {
    mockGitHub({ user: null, userStatus: 401 });
    const res = await invoke({ access_token: "expired" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for banned authors", async () => {
    mockGitHub({});
    // First call creates the author row, second call after we ban it.
    const first = await invoke({ access_token: "gho_realtoken" });
    expect(first.status).toBe(200);

    await env.DB.prepare(
      "UPDATE authors SET banned = 1, banned_reason = 'spam' WHERE github_id = ?",
    )
      .bind(GITHUB_USER.id)
      .run();

    const res = await invoke({ access_token: "gho_realtoken" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/banned/);
  });
});
