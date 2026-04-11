import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { packTar, createGzipEncoder } from "modern-tar";
import {
  processAuditJob,
  TransientError,
} from "../../src/lib/audit/consumer";
import type { AuditBindings } from "../../src/lib/audit/consumer";
import { verdictToStatus } from "../../src/lib/audit/audit-queries";
import {
  tokensToNeurons,
  DAILY_NEURON_LIMIT,
} from "../../src/lib/audit/budget";
import { MODEL_ID } from "../../src/lib/audit/prompt";
import type { AuditJob } from "../../src/types/marketplace";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockAiResponse {
  response: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function createMockAi(response: MockAiResponse) {
  return { run: vi.fn().mockResolvedValue(response) };
}

function createErrorAi(error: Error) {
  return { run: vi.fn().mockRejectedValue(error) };
}

async function seedTestAuthor(
  db: D1Database,
  id: string,
  githubId: number,
  username: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      githubId,
      username,
      `https://avatars.githubusercontent.com/u/${githubId}`,
      0,
      "2026-04-04T08:00:00Z",
      "2026-04-04T08:00:00Z",
    )
    .run();
}

async function createTestTarball(
  files: Record<string, string | Uint8Array>,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, content]) => {
    const data =
      typeof content === "string" ? encoder.encode(content) : content;
    return {
      header: { name, size: data.byteLength, type: "file" as const },
      body: data,
    };
  });

  const tarBuffer = await packTar(entries);
  const stream = new Blob([tarBuffer])
    .stream()
    .pipeThrough(createGzipEncoder());
  return new Response(stream).arrayBuffer();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHOR_ID = "audit-test-author";
const PLUGIN_ID = "audit-test-plugin";
const VERSION = "1.0.0";
const BUNDLE_KEY = `plugins/${PLUGIN_ID}/${VERSION}/bundle.tgz`;
const VERSION_ID = "audit-version-001";

function makeJob(overrides: Partial<AuditJob> = {}): AuditJob {
  return {
    pluginId: PLUGIN_ID,
    version: VERSION,
    authorId: AUTHOR_ID,
    bundleKey: BUNDLE_KEY,
    ...overrides,
  };
}

function makeBindings(
  ai: { run: ReturnType<typeof vi.fn> },
  auditMode: "manual" | "auto" | "off" | "static-first" = "auto",
): AuditBindings {
  return {
    db: env.DB,
    ai: ai as unknown as Ai,
    artifacts: env.ARTIFACTS,
    auditMode,
  };
}

function makePassResponse(overrides: Partial<MockAiResponse> = {}): MockAiResponse {
  return {
    response: JSON.stringify({
      verdict: "pass",
      riskScore: 15,
      findings: [],
    }),
    usage: {
      prompt_tokens: 5000,
      completion_tokens: 500,
      total_tokens: 5500,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean all tables
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_audits"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM authors"),
    env.DB.prepare("DELETE FROM audit_budget"),
  ]);

  // Seed author
  await seedTestAuthor(env.DB, AUTHOR_ID, 7001, "audit-publisher");

  // Register plugin
  await env.DB.prepare(
    `INSERT INTO plugins (id, author_id, name, description, capabilities, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      PLUGIN_ID,
      AUTHOR_ID,
      "Audit Test Plugin",
      "A plugin used in audit consumer tests",
      '["content:read"]',
      "2026-04-04T08:00:00Z",
      "2026-04-04T08:00:00Z",
    )
    .run();

  // Create version record with status "pending"
  await env.DB.prepare(
    `INSERT INTO plugin_versions (
      id, plugin_id, version, status, bundle_key, manifest,
      file_count, compressed_size, decompressed_size,
      checksum, screenshots, retry_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', ?, ?, 2, 1000, 2000, 'sha256:audit-test', '[]', 0, ?, ?)`,
  )
    .bind(
      VERSION_ID,
      PLUGIN_ID,
      VERSION,
      BUNDLE_KEY,
      JSON.stringify({
        id: PLUGIN_ID,
        version: VERSION,
        capabilities: ["content:read"],
        allowedHosts: [],
        hooks: [],
        routes: [],
      }),
      "2026-04-04T08:00:00Z",
      "2026-04-04T08:00:00Z",
    )
    .run();

  // Create and store test tarball in R2
  const tarball = await createTestTarball({
    "manifest.json": JSON.stringify({
      id: PLUGIN_ID,
      version: VERSION,
      capabilities: ["content:read"],
      allowedHosts: [],
      hooks: [],
      routes: [],
    }),
    "src/index.ts": 'export default { activate() { console.log("hello"); } }',
  });

  await env.ARTIFACTS.put(BUNDLE_KEY, tarball);
});

beforeEach(async () => {
  // Reset version status to "pending" and clear published_at
  await env.DB.prepare(
    "UPDATE plugin_versions SET status = 'pending', published_at = NULL WHERE id = ?",
  )
    .bind(VERSION_ID)
    .run();

  // Delete any audit records for this version
  await env.DB.prepare(
    "DELETE FROM plugin_audits WHERE plugin_version_id = ?",
  )
    .bind(VERSION_ID)
    .run();

  // Delete all audit_budget rows
  await env.DB.prepare("DELETE FROM audit_budget").run();
});

// ---------------------------------------------------------------------------
// AUDT-02: verdict-to-status mapping (pure function)
// ---------------------------------------------------------------------------

describe("verdict-to-status mapping (AUDT-02)", () => {
  it("maps pass to published", () => {
    expect(verdictToStatus("pass")).toBe("published");
  });

  it("maps warn to flagged", () => {
    expect(verdictToStatus("warn")).toBe("flagged");
  });

  it("maps fail to rejected", () => {
    expect(verdictToStatus("fail")).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// COST-02: token-to-neuron conversion
// ---------------------------------------------------------------------------

describe("token-to-neuron conversion (COST-02)", () => {
  it("calculates neurons from token counts", () => {
    // Input: 15000 * 9091 / 1_000_000 = 136.365
    // Output: 1000 * 27273 / 1_000_000 = 27.273
    // Total: ceil(136.365 + 27.273) = ceil(163.638) = 164
    expect(tokensToNeurons(15000, 1000)).toBe(164);
  });

  it("returns 0 for zero tokens", () => {
    expect(tokensToNeurons(0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AUDT-01, AUDT-02, AUDT-03: processAuditJob - pass verdict
// ---------------------------------------------------------------------------

describe("processAuditJob - pass verdict (AUDT-01, AUDT-02, AUDT-03)", () => {
  it("processes a pass verdict and publishes the version", async () => {
    const mockAi = createMockAi(makePassResponse());
    const result = await processAuditJob(makeJob(), makeBindings(mockAi));

    // Verify return value
    expect(result.verdict).toBe("pass");
    expect(result.status).toBe("complete");
    expect(result.neuronsUsed).toBeGreaterThan(0);
  });

  it("sets version status to published and published_at in D1", async () => {
    const mockAi = createMockAi(makePassResponse());
    await processAuditJob(makeJob(), makeBindings(mockAi));

    const row = await env.DB.prepare(
      "SELECT status, published_at FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string; published_at: string | null }>();

    expect(row).not.toBeNull();
    expect(row!.status).toBe("published");
    expect(row!.published_at).not.toBeNull();
  });

  it("stores audit record with correct fields in D1", async () => {
    const mockAi = createMockAi(makePassResponse());
    await processAuditJob(makeJob(), makeBindings(mockAi));

    const audit = await env.DB.prepare(
      `SELECT status, model, prompt_tokens, completion_tokens,
              verdict, risk_score, findings
       FROM plugin_audits WHERE plugin_version_id = ?`,
    )
      .bind(VERSION_ID)
      .first<{
        status: string;
        model: string;
        prompt_tokens: number;
        completion_tokens: number;
        verdict: string;
        risk_score: number;
        findings: string;
      }>();

    expect(audit).not.toBeNull();
    expect(audit!.status).toBe("complete");
    expect(audit!.model).toBe(MODEL_ID);
    expect(audit!.prompt_tokens).toBe(5000);
    expect(audit!.completion_tokens).toBe(500);
    expect(audit!.verdict).toBe("pass");
    expect(audit!.risk_score).toBe(15);
    expect(audit!.findings).toBe("[]");
  });

  it("calls AI with model name and messages array", async () => {
    const mockAi = createMockAi(makePassResponse());
    await processAuditJob(makeJob(), makeBindings(mockAi));

    expect(mockAi.run).toHaveBeenCalledOnce();
    const [modelId, params] = mockAi.run.mock.calls[0];
    expect(modelId).toBe(MODEL_ID);
    expect(params.messages).toBeInstanceOf(Array);
    expect(params.messages.length).toBe(2);
    expect(params.messages[0].role).toBe("system");
    expect(params.messages[1].role).toBe("user");
  });

  it("records neuron usage in audit_budget", async () => {
    const mockAi = createMockAi(makePassResponse());
    await processAuditJob(makeJob(), makeBindings(mockAi));

    const budget = await env.DB.prepare(
      "SELECT neurons_used FROM audit_budget WHERE date = date('now')",
    ).first<{ neurons_used: number }>();

    expect(budget).not.toBeNull();
    expect(budget!.neurons_used).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AUDT-02: processAuditJob - warn verdict
// ---------------------------------------------------------------------------

describe("processAuditJob - warn verdict (AUDT-02)", () => {
  it("flags the version and stores findings", async () => {
    const finding = {
      severity: "medium",
      title: "Network access",
      description: "Plugin makes HTTP requests to external hosts",
      category: "network",
    };
    const mockAi = createMockAi({
      response: JSON.stringify({
        verdict: "warn",
        riskScore: 55,
        findings: [finding],
      }),
      usage: { prompt_tokens: 5000, completion_tokens: 500, total_tokens: 5500 },
    });

    await processAuditJob(makeJob(), makeBindings(mockAi));

    // Verify version status
    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("flagged");

    // Verify audit record with findings
    const audit = await env.DB.prepare(
      "SELECT verdict, findings FROM plugin_audits WHERE plugin_version_id = ?",
    )
      .bind(VERSION_ID)
      .first<{ verdict: string; findings: string }>();
    expect(audit!.verdict).toBe("warn");
    const parsedFindings = JSON.parse(audit!.findings);
    expect(parsedFindings).toHaveLength(1);
    expect(parsedFindings[0].title).toBe("Network access");
  });
});

// ---------------------------------------------------------------------------
// AUDT-02: processAuditJob - fail verdict
// ---------------------------------------------------------------------------

describe("processAuditJob - fail verdict (AUDT-02)", () => {
  it("rejects the version with critical findings", async () => {
    const finding = {
      severity: "critical",
      title: "Eval usage",
      description: "Plugin uses eval() to execute arbitrary code",
      category: "security",
      location: "src/index.ts:5",
    };
    const mockAi = createMockAi({
      response: JSON.stringify({
        verdict: "fail",
        riskScore: 90,
        findings: [finding],
      }),
      usage: { prompt_tokens: 5000, completion_tokens: 500, total_tokens: 5500 },
    });

    await processAuditJob(makeJob(), makeBindings(mockAi));

    // Verify version status
    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("rejected");

    // Verify audit record
    const audit = await env.DB.prepare(
      "SELECT verdict, risk_score FROM plugin_audits WHERE plugin_version_id = ?",
    )
      .bind(VERSION_ID)
      .first<{ verdict: string; risk_score: number }>();
    expect(audit!.verdict).toBe("fail");
    expect(audit!.risk_score).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// AUDT-04: processAuditJob - fail-closed behavior
// ---------------------------------------------------------------------------

describe("processAuditJob - fail-closed (AUDT-04)", () => {
  it("rejects version on malformed AI JSON", async () => {
    const mockAi = createMockAi({
      response: "not valid json {{{",
      usage: { prompt_tokens: 5000, completion_tokens: 500, total_tokens: 5500 },
    });

    const result = await processAuditJob(makeJob(), makeBindings(mockAi));

    expect(result.status).toBe("error");
    expect(result.verdict).toBeNull();

    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("rejected");
  });

  it("recovers JSON wrapped in markdown fences", async () => {
    // Realistic shape returned by llama-3.2-3b-instruct and similar models
    // that don't honour 'JSON only' prompts strictly.
    const wrapped = "```json\n" + JSON.stringify({
      verdict: "pass",
      riskScore: 12,
      findings: [],
    }) + "\n```";
    const mockAi = createMockAi({
      response: wrapped,
      usage: { prompt_tokens: 5000, completion_tokens: 500, total_tokens: 5500 },
    });

    const result = await processAuditJob(makeJob(), makeBindings(mockAi));
    expect(result.status).toBe("complete");
    expect(result.verdict).toBe("pass");
  });

  it("recovers JSON after a prose preamble", async () => {
    const text = "Here is the audit:\n" + JSON.stringify({
      verdict: "warn",
      riskScore: 35,
      findings: [],
    });
    const mockAi = createMockAi({
      response: text,
      usage: { prompt_tokens: 5000, completion_tokens: 500, total_tokens: 5500 },
    });

    const result = await processAuditJob(makeJob(), makeBindings(mockAi));
    expect(result.status).toBe("complete");
    expect(result.verdict).toBe("warn");
  });

  it("rejects version when R2 bundle is missing", async () => {
    const mockAi = createMockAi(makePassResponse());
    const jobWithMissingBundle = makeJob({
      bundleKey: "plugins/nonexistent/0.0.0/bundle.tgz",
    });

    const result = await processAuditJob(
      jobWithMissingBundle,
      makeBindings(mockAi),
    );

    expect(result.status).toBe("error");
    expect(result.verdict).toBeNull();

    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("rejected");
  });

  it("throws TransientError on 503 from AI", async () => {
    const mockAi = createErrorAi(new Error("Service Unavailable 503"));

    await expect(
      processAuditJob(makeJob(), makeBindings(mockAi)),
    ).rejects.toThrow(TransientError);

    // Version should remain pending (not permanently rejected)
    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("pending");
  });

  it("throws TransientError on Workers AI 3050 (max retries exhausted)", async () => {
    // Newly-launched or capacity-constrained models (e.g. gemma-4-26b-a4b
    // in its first days on Workers AI) surface upstream overload as
    // "3050: Max retries exhausted". Fail-closed rejection here is wrong:
    // the request was valid, the runtime was saturated, and a queue retry
    // a minute later is the correct recovery.
    const mockAi = createErrorAi(
      new Error("AiError: 3050: Max retries exhausted"),
    );

    await expect(
      processAuditJob(makeJob(), makeBindings(mockAi)),
    ).rejects.toThrow(TransientError);

    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("pending");
  });

  it("rejects version on non-transient AI error", async () => {
    const mockAi = createErrorAi(new Error("Model not found"));

    const result = await processAuditJob(makeJob(), makeBindings(mockAi));

    expect(result.status).toBe("error");
    expect(result.verdict).toBeNull();

    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("rejected");
  });

  // -------------------------------------------------------------------------
  // Batch API submission path (Workers AI Async Batch API)
  // -------------------------------------------------------------------------

  it("batch-capable model: submits via queueRequest and writes pending audit row", async () => {
    // Llama 3.3 70B fp8-fast is batch-capable per AUDIT_MODELS. When the
    // consumer receives a job for it, the consumer should call `ai.run`
    // with `queueRequest: true`, receive a request_id in return, write a
    // `status='pending'` audit row carrying that id, and return
    // `{status:"complete", verdict:null}` so the queue message gets
    // acked. The version itself MUST stay pending — it's the batch
    // poller's job to finalise it later.
    const fakeRequestId = "req-00000000-1111-2222-3333-444444444444";
    const mockAi = {
      run: vi.fn().mockResolvedValue({ request_id: fakeRequestId }),
    };

    const result = await processAuditJob(
      makeJob({ modelOverride: "llama-3.3-70b-fast" }),
      makeBindings(mockAi),
    );

    // Consumer returns ok so the queue message is acked.
    expect(result.status).toBe("complete");
    expect(result.verdict).toBeNull();
    expect(result.neuronsUsed).toBe(0);

    // ai.run should have been called with queueRequest:true as the 3rd arg.
    expect(mockAi.run).toHaveBeenCalledOnce();
    const [modelId, payload, options] = mockAi.run.mock.calls[0];
    expect(modelId).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(payload.messages).toBeInstanceOf(Array);
    expect(options).toEqual({ queueRequest: true });

    // A pending batch audit row should exist carrying the request_id.
    const audit = await env.DB.prepare(
      "SELECT status, model, batch_request_id, verdict FROM plugin_audits WHERE plugin_version_id = ? AND batch_request_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
      .bind(VERSION_ID)
      .first<{
        status: string;
        model: string;
        batch_request_id: string;
        verdict: string | null;
      }>();
    expect(audit).not.toBeNull();
    expect(audit!.status).toBe("pending");
    expect(audit!.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(audit!.batch_request_id).toBe(fakeRequestId);
    expect(audit!.verdict).toBeNull();

    // Version status should still be pending — batch poller finalises it.
    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("pending");
  });

  it("batch-capable model: submit failure rejects version", async () => {
    // If Cloudflare's batch submit itself errors (e.g. the model isn't
    // actually wired to batch yet, or the request is malformed), we
    // cannot queue-retry — the failure isn't capacity related. Fall
    // closed: the version gets rejected and an error audit row is
    // written.
    const mockAi = createErrorAi(new Error("Batch submit rejected"));

    const result = await processAuditJob(
      makeJob({ modelOverride: "llama-3.3-70b-fast" }),
      makeBindings(mockAi),
    );

    expect(result.status).toBe("error");
    expect(result.verdict).toBeNull();

    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// COST-02: neuron budget enforcement
// ---------------------------------------------------------------------------

describe("neuron budget enforcement (COST-02)", () => {
  it("falls back to manual review when budget is exhausted", async () => {
    // Set budget to the limit
    await env.DB.prepare(
      "INSERT INTO audit_budget (date, neurons_used) VALUES (date('now'), ?)",
    )
      .bind(DAILY_NEURON_LIMIT)
      .run();

    const mockAi = createMockAi(makePassResponse());

    // No longer throws — falls back to manual review (no audit record, version stays pending)
    const result = await processAuditJob(makeJob(), makeBindings(mockAi));
    expect(result.status).toBe("complete");
    expect(result.verdict).toBeNull();
    expect(result.neuronsUsed).toBe(0);

    // Version should remain pending (admin will moderate manually)
    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("pending");

    // AI should NOT have been called
    expect(mockAi.run).not.toHaveBeenCalled();
  });

  it("allows audit when no budget row exists", async () => {
    // Ensure no budget rows exist (beforeEach already deletes)
    const mockAi = createMockAi(makePassResponse());
    const result = await processAuditJob(makeJob(), makeBindings(mockAi));

    expect(result.status).toBe("complete");
    expect(result.verdict).toBe("pass");

    // Verify budget row was created
    const budget = await env.DB.prepare(
      "SELECT neurons_used FROM audit_budget WHERE date = date('now')",
    ).first<{ neurons_used: number }>();
    expect(budget).not.toBeNull();
    expect(budget!.neurons_used).toBeGreaterThan(0);
  });

  it("updates budget after successful audit", async () => {
    const mockAi = createMockAi({
      response: JSON.stringify({
        verdict: "pass",
        riskScore: 10,
        findings: [],
      }),
      usage: {
        prompt_tokens: 10000,
        completion_tokens: 1000,
        total_tokens: 11000,
      },
    });

    await processAuditJob(makeJob(), makeBindings(mockAi));

    const expectedNeurons = tokensToNeurons(10000, 1000);
    const budget = await env.DB.prepare(
      "SELECT neurons_used FROM audit_budget WHERE date = date('now')",
    ).first<{ neurons_used: number }>();

    expect(budget).not.toBeNull();
    expect(budget!.neurons_used).toBe(expectedNeurons);
  });
});

// ---------------------------------------------------------------------------
// AUDIT-MODE: manual mode skips AI entirely, leaves version pending
// ---------------------------------------------------------------------------

describe("audit mode switch", () => {
  it("manual mode skips AI and leaves version pending with static-only audit", async () => {
    const mockAi = createMockAi(makePassResponse());
    const result = await processAuditJob(
      makeJob(),
      makeBindings(mockAi, "manual"),
    );

    expect(result.status).toBe("complete");
    expect(result.verdict).toBeNull();
    expect(result.neuronsUsed).toBe(0);
    expect(mockAi.run).not.toHaveBeenCalled();

    // Version stays pending — admin will approve via the moderation queue
    const version = await env.DB.prepare(
      "SELECT status FROM plugin_versions WHERE id = ?",
    )
      .bind(VERSION_ID)
      .first<{ status: string }>();
    expect(version!.status).toBe("pending");

    // A static-only audit record IS created so the admin sees scan findings
    const audit = await env.DB.prepare(
      "SELECT model, verdict, neurons_used FROM plugin_audits WHERE plugin_version_id = ?",
    )
      .bind(VERSION_ID)
      .first<{ model: string; verdict: string | null; neurons_used: number }>();
    expect(audit).not.toBeNull();
    expect(audit!.model).toBe("static-only");
    expect(audit!.verdict).toBeNull();
    expect(audit!.neurons_used).toBe(0);
  });

  it("off mode also skips AI and leaves version pending", async () => {
    const mockAi = createMockAi(makePassResponse());
    const result = await processAuditJob(
      makeJob(),
      makeBindings(mockAi, "off"),
    );

    expect(result.status).toBe("complete");
    expect(result.verdict).toBeNull();
    expect(mockAi.run).not.toHaveBeenCalled();
  });

  it("defaults to manual when auditMode is undefined", async () => {
    const mockAi = createMockAi(makePassResponse());
    const result = await processAuditJob(makeJob(), {
      db: env.DB,
      ai: mockAi as unknown as Ai,
      artifacts: env.ARTIFACTS,
      // auditMode intentionally omitted
    });

    expect(result.verdict).toBeNull();
    expect(mockAi.run).not.toHaveBeenCalled();
  });

  it("per-job auditModeOverride='auto' forces AI even when global mode is manual", async () => {
    const mockAi = createMockAi(makePassResponse());
    const result = await processAuditJob(
      makeJob({ auditModeOverride: "auto" }),
      makeBindings(mockAi, "manual"),
    );

    // AI should have been called despite the global manual mode
    expect(mockAi.run).toHaveBeenCalledOnce();
    expect(result.verdict).toBe("pass");
    expect(result.neuronsUsed).toBeGreaterThan(0);
  });

  it("per-job auditModeOverride='manual' skips AI even when global mode is auto", async () => {
    const mockAi = createMockAi(makePassResponse());
    const result = await processAuditJob(
      makeJob({ auditModeOverride: "manual" }),
      makeBindings(mockAi, "auto"),
    );

    expect(mockAi.run).not.toHaveBeenCalled();
    expect(result.verdict).toBeNull();
    expect(result.neuronsUsed).toBe(0);

    // Static-only audit record exists
    const audit = await env.DB.prepare(
      "SELECT model FROM plugin_audits WHERE plugin_version_id = ?",
    )
      .bind(VERSION_ID)
      .first<{ model: string }>();
    expect(audit!.model).toBe("static-only");
  });
});

// ---------------------------------------------------------------------------
// static-first audit mode: publish/flag/reject based on static scan alone
// ---------------------------------------------------------------------------

describe("static-first audit mode", () => {
  /**
   * Swap the R2 bundle for a custom one before each static-first test so we
   * can control what the static scanner sees. The afterEach-style cleanup
   * in the outer beforeEach resets the DB but leaves R2 alone, so we always
   * restore the default bundle at the end of each test.
   */
  async function withBundle(
    files: Record<string, string>,
    fn: () => Promise<void>,
  ): Promise<void> {
    // NOTE: use a valid capability name. `content:read` is invalid per
    // PLUGIN_CAPABILITIES — the correct form is `read:content`. If the
    // manifest fails schema validation the static scan is silently
    // skipped, which looks identical to a clean scan in the consumer.
    const manifest = {
      id: PLUGIN_ID,
      version: VERSION,
      capabilities: ["read:content"],
      allowedHosts: [],
      hooks: [],
      routes: [],
    };
    const bundle = await createTestTarball({
      "manifest.json": JSON.stringify(manifest),
      ...files,
    });
    await env.ARTIFACTS.put(BUNDLE_KEY, bundle);
    try {
      await fn();
    } finally {
      // Restore the baseline clean bundle for the rest of the suite.
      const cleanBundle = await createTestTarball({
        "manifest.json": JSON.stringify(manifest),
        "src/index.ts":
          'export default { activate() { console.log("hello"); } }',
      });
      await env.ARTIFACTS.put(BUNDLE_KEY, cleanBundle);
    }
  }

  it("publishes a clean bundle immediately with a static-only audit record", async () => {
    await withBundle(
      {
        "src/index.ts":
          "export default { activate() { return 'clean plugin'; } };",
      },
      async () => {
        const mockAi = createMockAi(makePassResponse());
        const result = await processAuditJob(
          makeJob(),
          makeBindings(mockAi, "static-first"),
        );

        expect(result.status).toBe("complete");
        expect(result.verdict).toBeNull();
        expect(mockAi.run).not.toHaveBeenCalled();

        const version = await env.DB.prepare(
          "SELECT status, published_at FROM plugin_versions WHERE id = ?",
        )
          .bind(VERSION_ID)
          .first<{ status: string; published_at: string | null }>();
        expect(version!.status).toBe("published");
        expect(version!.published_at).not.toBeNull();

        const audit = await env.DB.prepare(
          "SELECT model, verdict, findings FROM plugin_audits WHERE plugin_version_id = ?",
        )
          .bind(VERSION_ID)
          .first<{ model: string; verdict: string | null; findings: string }>();
        expect(audit!.model).toBe("static-only");
        expect(audit!.verdict).toBeNull();
        expect(JSON.parse(audit!.findings)).toEqual([]);
      },
    );
  });

  it("flags a bundle with soft findings (require call) instead of rejecting it", async () => {
    await withBundle(
      {
        // NOTE: `dist/` and `build/` are excluded by extractCodeFiles, so
        // bundled CJS shims in those folders never reach the scanner.
        // Place the CJS file at the root to exercise the require pattern.
        "vendor.cjs":
          "var lodash = require('lodash'); module.exports = { lodash };",
      },
      async () => {
        const mockAi = createMockAi(makePassResponse());
        const result = await processAuditJob(
          makeJob(),
          makeBindings(mockAi, "static-first"),
        );

        expect(result.status).toBe("complete");
        expect(mockAi.run).not.toHaveBeenCalled();

        const version = await env.DB.prepare(
          "SELECT status FROM plugin_versions WHERE id = ?",
        )
          .bind(VERSION_ID)
          .first<{ status: string }>();
        expect(version!.status).toBe("flagged");

        const audit = await env.DB.prepare(
          "SELECT model, findings FROM plugin_audits WHERE plugin_version_id = ?",
        )
          .bind(VERSION_ID)
          .first<{ model: string; findings: string }>();
        expect(audit!.model).toBe("static-only");
        const findings = JSON.parse(audit!.findings) as Array<{
          title: string;
        }>;
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.some((f) => f.title.includes("require"))).toBe(true);
      },
    );
  });

  it("rejects a bundle with a blocking finding and preserves the findings list", async () => {
    await withBundle(
      {
        "src/payload.ts":
          "export default { run(input) { return eval(input); } };",
      },
      async () => {
        const mockAi = createMockAi(makePassResponse());
        const result = await processAuditJob(
          makeJob(),
          makeBindings(mockAi, "static-first"),
        );

        expect(result.status).toBe("complete");
        expect(mockAi.run).not.toHaveBeenCalled();

        const version = await env.DB.prepare(
          "SELECT status FROM plugin_versions WHERE id = ?",
        )
          .bind(VERSION_ID)
          .first<{ status: string }>();
        expect(version!.status).toBe("rejected");

        // Critically: findings must be preserved so the contributor knows
        // WHY their upload was blocked. The old rejectVersion() path used
        // to throw these away.
        const audit = await env.DB.prepare(
          "SELECT model, findings, raw_response FROM plugin_audits WHERE plugin_version_id = ?",
        )
          .bind(VERSION_ID)
          .first<{ model: string; findings: string; raw_response: string }>();
        expect(audit!.model).toBe("static-only");
        const findings = JSON.parse(audit!.findings) as Array<{
          title: string;
        }>;
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.some((f) => f.title.includes("eval"))).toBe(true);
        expect(audit!.raw_response).toContain("eval");
      },
    );
  });

  it("rejects on child_process reference (blocking pattern)", async () => {
    await withBundle(
      {
        "src/exec.ts":
          "import { spawn } from 'child_process'; spawn('ls');",
      },
      async () => {
        const result = await processAuditJob(
          makeJob(),
          makeBindings(createMockAi(makePassResponse()), "static-first"),
        );
        expect(result.status).toBe("complete");

        const version = await env.DB.prepare(
          "SELECT status FROM plugin_versions WHERE id = ?",
        )
          .bind(VERSION_ID)
          .first<{ status: string }>();
        expect(version!.status).toBe("rejected");
      },
    );
  });
});
