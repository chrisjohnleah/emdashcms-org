import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { packTar } from "modern-tar";
import {
  REGISTRY_DAILY_NEURON_LIMIT,
  enqueueRegistryAudits,
  getRegistryAudit,
  isRegistryAuditJob,
  processRegistryAuditJob,
  type RegistryAuditJob,
} from "../../../src/lib/registry/audit";
import { TransientError } from "../../../src/lib/audit/consumer";
import { DAILY_NEURON_LIMIT } from "../../../src/lib/audit/budget";

const DID = "did:plc:testregistry";
const JOB: RegistryAuditJob = { kind: "registry", did: DID, slug: "linguadash", version: "0.1.0" };
const BUNDLE_URL = `https://cdn.em-da.sh/r/${DID}/com.emdashcms.experimental.package.release/linguadash:0.1.0/bafyrecord/bafyblob`;

async function tgz(files: Record<string, string>): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const tar = await packTar(
    Object.entries(files).map(([name, body]) => ({
      header: { name, size: enc.encode(body).byteLength, type: "file" as const },
      body: enc.encode(body),
    })),
  );
  return new Response(new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

const release = (version = "0.1.0") => ({
  uri: `at://${DID}/com.emdashcms.experimental.package.release/linguadash:${version}`,
  cid: "bafyrecord",
  did: DID,
  version,
  release: { artifacts: { package: { blob: { ref: { $link: "bafyblob" }, size: 1000 } } } },
  artifactCaches: [{ serviceEndpoint: "https://cdn.em-da.sh" }],
});

function fetcher(opts: { version?: string; bundle?: ArrayBuffer; packages?: unknown[] } = {}) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("getLatestRelease")) return Response.json(release(opts.version));
    if (url.includes("searchPackages")) return Response.json({ packages: opts.packages ?? [] });
    if (url === BUNDLE_URL) return new Response(opts.bundle ?? null);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const aiReturning = (response: string) =>
  ({
    run: vi.fn().mockResolvedValue({ response, usage: { prompt_tokens: 10_000, completion_tokens: 500, total_tokens: 10_500 } }),
  }) as unknown as Ai & { run: ReturnType<typeof vi.fn> };

let bundle: ArrayBuffer;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM registry_audits"), env.DB.prepare("DELETE FROM audit_budget")]);
  bundle = await tgz({
    "manifest.json": JSON.stringify({ id: "linguadash", version: "0.1.0", capabilities: ["content:read"], allowedHosts: [] }),
    "backend.js": 'export default { async run() { return fetch("https://evil.example.com/x"); } };',
  });
});

describe("processRegistryAuditJob", () => {
  it("stores a complete audit with static + AI findings and charges the shared budget", async () => {
    const ai = aiReturning(JSON.stringify({ verdict: "warn", riskScore: 40, findings: [{ severity: "medium", title: "AI finding", description: "d", category: "security", location: null }] }));
    expect(await processRegistryAuditJob(JOB, { db: env.DB, ai, fetcher: fetcher({ bundle }) })).toBe("complete");

    const audit = await getRegistryAudit(env.DB, DID, "linguadash", "0.1.0");
    expect(audit?.status).toBe("complete");
    expect(audit?.verdict).toBe("warn");
    expect(audit?.riskScore).toBe(40);
    const titles = audit!.findings.map((f) => f.title);
    expect(titles).toContain("AI finding");
    expect(titles.some((t) => /not declared/i.test(t))).toBe(true); // static scan saw evil.example.com
    const spent = await env.DB.prepare("SELECT neurons_used FROM audit_budget").first<{ neurons_used: number }>();
    expect(spent?.neurons_used).toBeGreaterThan(0);

    // Idempotent: a completed release isn't audited twice.
    expect(await processRegistryAuditJob(JOB, { db: env.DB, ai, fetcher: fetcher({ bundle }) })).toBe("skipped");
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a malformed AI response", async () => {
    const ai = aiReturning('{"verdict":"maybe"}');
    expect(await processRegistryAuditJob(JOB, { db: env.DB, ai, fetcher: fetcher({ bundle }) })).toBe("error");
    const audit = await getRegistryAudit(env.DB, DID, "linguadash", "0.1.0");
    expect(audit?.status).toBe("error");
    expect(audit?.verdict).toBeNull();
  });

  it("defers without calling AI when the registry cap or the shared cap is spent", async () => {
    const ai = aiReturning("{}");
    await env.DB.prepare(
      "INSERT INTO registry_audits (did, slug, version, status, neurons_used) VALUES ('did:plc:other', 'x', '1.0.0', 'complete', ?)",
    ).bind(REGISTRY_DAILY_NEURON_LIMIT).run();
    expect(await processRegistryAuditJob(JOB, { db: env.DB, ai, fetcher: fetcher({ bundle }) })).toBe("skipped");

    await env.DB.prepare("DELETE FROM registry_audits").run();
    await env.DB.prepare("INSERT INTO audit_budget (date, neurons_used) VALUES (date('now'), ?)").bind(DAILY_NEURON_LIMIT).run();
    expect(await processRegistryAuditJob(JOB, { db: env.DB, ai, fetcher: fetcher({ bundle }) })).toBe("skipped");

    expect(ai.run).not.toHaveBeenCalled();
    expect(await getRegistryAudit(env.DB, DID, "linguadash", "0.1.0")).toBeNull();
  });

  it("skips a job whose version is no longer the latest release", async () => {
    const ai = aiReturning("{}");
    expect(await processRegistryAuditJob(JOB, { db: env.DB, ai, fetcher: fetcher({ bundle, version: "0.2.0" }) })).toBe("skipped");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("throws TransientError on retryable AI failures and writes nothing", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("503 Service Unavailable")) } as unknown as Ai;
    await expect(processRegistryAuditJob(JOB, { db: env.DB, ai, fetcher: fetcher({ bundle }) })).rejects.toBeInstanceOf(TransientError);
    expect(await getRegistryAudit(env.DB, DID, "linguadash", "0.1.0")).toBeNull();
  });

  it("records an error for an unreadable bundle", async () => {
    const ai = aiReturning("{}");
    const junk = new TextEncoder().encode("not a tarball").buffer as ArrayBuffer;
    expect(await processRegistryAuditJob(JOB, { db: env.DB, ai, fetcher: fetcher({ bundle: junk }) })).toBe("error");
    expect(ai.run).not.toHaveBeenCalled();
  });
});

describe("enqueueRegistryAudits", () => {
  const pkg = (slug: string) => ({ did: DID, handle: "t.example", slug, latestVersion: "1.0.0", profile: { name: slug } });

  it("enqueues at most 3 unaudited releases per run", async () => {
    await env.DB.prepare(
      "INSERT INTO registry_audits (did, slug, version, status) VALUES (?, 'done', '1.0.0', 'complete')",
    ).bind(DID).run();
    const send = vi.fn();
    const n = await enqueueRegistryAudits(
      { DB: env.DB, AUDIT_QUEUE: { send } as unknown as Queue },
      fetcher({ packages: ["done", "a", "b", "c", "d"].map(pkg) }),
    );
    expect(n).toBe(3);
    expect(send.mock.calls.map((c) => c[0].slug)).toEqual(["a", "b", "c"]);
    expect(isRegistryAuditJob(send.mock.calls[0][0])).toBe(true);
  });

  it("enqueues nothing once today's registry cap is spent", async () => {
    await env.DB.prepare(
      "INSERT INTO registry_audits (did, slug, version, status, neurons_used) VALUES (?, 'done', '1.0.0', 'complete', ?)",
    ).bind(DID, REGISTRY_DAILY_NEURON_LIMIT).run();
    const send = vi.fn();
    expect(await enqueueRegistryAudits({ DB: env.DB, AUDIT_QUEUE: { send } as unknown as Queue }, fetcher({ packages: [pkg("a")] }))).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
