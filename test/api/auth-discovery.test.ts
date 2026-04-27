import { describe, it, expect } from "vitest";
import { GET } from "../../src/pages/api/v1/auth/discovery";

async function invoke(): Promise<Response> {
  return (GET as unknown as () => Promise<Response> | Response)();
}

describe("GET /api/v1/auth/discovery", () => {
  it("returns the shape consumed by the upstream emdash CLI", async () => {
    const response = await invoke();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      github: {
        deviceAuthorizationEndpoint: string;
        tokenEndpoint: string;
        clientId: string;
      };
      marketplace: { deviceTokenEndpoint: string };
    };

    expect(body.github.deviceAuthorizationEndpoint).toBe(
      "https://github.com/login/device/code",
    );
    expect(body.github.tokenEndpoint).toBe(
      "https://github.com/login/oauth/access_token",
    );
    // Test env binds GITHUB_CLIENT_ID via wrangler.jsonc → must be present.
    expect(body.github.clientId).toBeTruthy();
    expect(typeof body.github.clientId).toBe("string");

    expect(body.marketplace.deviceTokenEndpoint).toBe(
      "/api/v1/auth/cli/exchange",
    );
  });
});
