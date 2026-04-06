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
  auditMode: "manual" | "auto" | "off" = "auto",
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
  it("manual mode skips AI and leaves version pending", async () => {
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

    // No audit record should be created in manual mode
    const audit = await env.DB.prepare(
      "SELECT id FROM plugin_audits WHERE plugin_version_id = ?",
    )
      .bind(VERSION_ID)
      .first();
    expect(audit).toBeNull();
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
});
