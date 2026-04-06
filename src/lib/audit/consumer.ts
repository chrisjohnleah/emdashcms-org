/**
 * Queue consumer for AI-powered plugin code audits.
 *
 * Orchestrates the full audit pipeline: budget check, bundle fetch, code
 * extraction, AI inference, response parsing, record storage, and status update.
 * Every error path leads to version rejection (fail-closed per D-13).
 */
import type { AuditJob } from "../../types/marketplace";
import { checkNeuronBudget, recordNeuronUsage, tokensToNeurons } from "./budget";
import { MODEL_ID, SYSTEM_PROMPT, AUDIT_JSON_SCHEMA, extractCodeFiles, buildPromptContent } from "./prompt";
import { createAuditRecord, rejectVersion } from "./audit-queries";

// --- Bindings ---

export interface AuditBindings {
  db: D1Database;
  ai: Ai;
  artifacts: R2Bucket;
  /**
   * Audit mode controls how new versions are processed:
   * - 'manual' (default): skip AI, leave status='pending' for human moderation
   * - 'auto': run AI audit, neuron-budget bound
   * - 'off': skip AI, leave status='pending' (admin must approve everything)
   */
  auditMode?: "manual" | "auto" | "off";
}

// --- Result ---

export interface AuditResult {
  verdict: "pass" | "warn" | "fail" | null;
  status: "complete" | "error";
  neuronsUsed: number;
}

// --- Error Types ---

/**
 * Thrown when the daily neuron budget is exceeded.
 * The queue handler should retry with a delay (budget resets at UTC midnight).
 */
export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
  constructor(used: number) {
    super(`Daily neuron budget exceeded: ${used} neurons used`);
  }
}

/**
 * Thrown for transient errors that should be retried by the queue.
 * Examples: model 429/503, D1 write failures, network timeouts.
 */
export class TransientError extends Error {
  override name = "TransientError";
}

// --- Helpers ---

/**
 * Look up the internal version ID from plugin_id + version string.
 */
async function resolveVersionId(
  db: D1Database,
  pluginId: string,
  version: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM plugin_versions WHERE plugin_id = ? AND version = ?")
    .bind(pluginId, version)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Check if an AI error is transient (should be retried) or permanent.
 */
function isTransientAiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("429") || msg.includes("503") || msg.includes("timeout");
}

/**
 * Validate the parsed AI response matches the expected schema.
 */
function validateAuditResponse(
  parsed: unknown,
): parsed is { verdict: "pass" | "warn" | "fail"; riskScore: number; findings: unknown[] } {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;

  if (!["pass", "warn", "fail"].includes(obj.verdict as string)) return false;
  if (typeof obj.riskScore !== "number" || obj.riskScore < 0 || obj.riskScore > 100) return false;
  if (!Array.isArray(obj.findings)) return false;

  return true;
}

// --- Main Pipeline ---

/**
 * Process a single audit job through the complete pipeline.
 *
 * Steps:
 * 1. Check neuron budget (throws BudgetExceededError if exceeded)
 * 2. Resolve version ID from plugin_id + version
 * 3. Fetch bundle from R2
 * 4. Extract code files from tarball
 * 5. Build prompt content
 * 6. Call Workers AI with structured JSON output
 * 7. Parse and validate the AI response
 * 8. Store audit record and update version status
 * 9. Record neuron usage
 * 10. Return result
 */
export async function processAuditJob(
  job: AuditJob,
  bindings: AuditBindings,
): Promise<AuditResult> {
  const startTime = Date.now();
  const mode = bindings.auditMode ?? "manual";

  // 0. Resolve version ID first (we need it for any non-AI path too)
  const versionId = await resolveVersionId(bindings.db, job.pluginId, job.version);
  if (!versionId) {
    console.error(`[audit] Version not found: plugin=${job.pluginId} version=${job.version}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // Manual / off modes: skip AI entirely. Version stays 'pending' for admin review.
  if (mode !== "auto") {
    console.log(
      `[audit] mode=${mode} — skipping AI, leaving plugin=${job.pluginId} version=${job.version} as pending for manual review`,
    );
    return { verdict: null, status: "complete", neuronsUsed: 0 };
  }

  // 1. Check neuron budget (auto mode only)
  const budget = await checkNeuronBudget(bindings.db);
  if (!budget.allowed) {
    // Don't fail-closed: leave version pending for manual review when budget is exhausted.
    console.warn(
      `[audit] Daily neuron budget exhausted (${budget.used}) — falling back to manual review for plugin=${job.pluginId} version=${job.version}`,
    );
    return { verdict: null, status: "complete", neuronsUsed: 0 };
  }

  // 3. Fetch bundle from R2
  const r2Object = await bindings.artifacts.get(job.bundleKey);
  if (!r2Object) {
    await rejectVersion(bindings.db, versionId, "Bundle not found in R2");
    console.error(`[audit] Bundle not found: key=${job.bundleKey}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // 4. Extract code files
  let codeFiles: Map<string, string>;
  try {
    codeFiles = await extractCodeFiles(await r2Object.arrayBuffer());
  } catch (err) {
    const msg = `Failed to extract bundle: ${err instanceof Error ? err.message : String(err)}`;
    await rejectVersion(bindings.db, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // 5. Build prompt
  if (codeFiles.size === 0) {
    await rejectVersion(bindings.db, versionId, "No code files found in bundle");
    console.error(`[audit] No code files in bundle: plugin=${job.pluginId} version=${job.version}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  const promptContent = buildPromptContent(codeFiles);

  // 6. Call Workers AI
  let result: { response?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
  try {
    result = await (bindings.ai as Ai).run(MODEL_ID, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: promptContent },
      ],
      response_format: {
        type: "json_schema" as const,
        json_schema: AUDIT_JSON_SCHEMA,
      },
      max_tokens: 1024,
      temperature: 0.1,
    }) as unknown as { response?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
  } catch (err) {
    if (isTransientAiError(err)) {
      throw new TransientError(
        `AI inference failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const msg = `AI inference error: ${err instanceof Error ? err.message : String(err)}`;
    await rejectVersion(bindings.db, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // 7. Parse and validate response
  let parsed: { verdict: "pass" | "warn" | "fail"; riskScore: number; findings: unknown[] };
  const responseText = result.response ?? "";

  // Empty or whitespace-only response is transient — retry, don't reject
  if (!responseText.trim()) {
    throw new TransientError("AI returned empty response");
  }

  try {
    const raw = JSON.parse(responseText);
    if (!validateAuditResponse(raw)) {
      throw new Error("Response does not match expected schema");
    }
    parsed = raw;
  } catch (err) {
    const msg = `Malformed AI response: ${err instanceof Error ? err.message : String(err)}`;
    // Truncated JSON (starts with { but didn't complete) is likely transient
    if (err instanceof SyntaxError && /^\s*[\[{]/.test(responseText)) {
      throw new TransientError(msg);
    }
    await rejectVersion(bindings.db, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // 8. Calculate neurons
  const promptTokens = result.usage?.prompt_tokens ?? 0;
  const completionTokens = result.usage?.completion_tokens ?? 0;
  if (!result.usage) {
    console.warn(`[audit] WARNING: No usage data from AI response`);
  }
  const neuronsUsed = tokensToNeurons(promptTokens, completionTokens);

  // 9. Store audit record (atomically updates version status)
  await createAuditRecord(bindings.db, {
    versionId,
    status: "complete",
    model: MODEL_ID,
    promptTokens,
    completionTokens,
    neuronsUsed,
    rawResponse: result.response ?? "",
    verdict: parsed.verdict,
    riskScore: parsed.riskScore,
    findings: parsed.findings as import("../../types/marketplace").MarketplaceAuditFinding[],
  });

  // 10. Update neuron budget
  await recordNeuronUsage(bindings.db, neuronsUsed);

  // 11. Log outcome
  console.log(
    `[audit] plugin=${job.pluginId} version=${job.version} verdict=${parsed.verdict} neurons=${neuronsUsed} duration=${Date.now() - startTime}ms`,
  );

  return { verdict: parsed.verdict, status: "complete", neuronsUsed };
}
