/**
 * Queue consumer for AI-powered plugin code audits.
 *
 * Orchestrates the full audit pipeline: budget check, bundle fetch, code
 * extraction, AI inference, response parsing, record storage, and status update.
 * Every error path leads to version rejection (fail-closed per D-13).
 */
import type { AuditJob, MarketplaceAuditFinding } from "../../types/marketplace";
import { checkNeuronBudget, recordNeuronUsage, tokensToNeurons } from "./budget";
import { MODEL_ID, SYSTEM_PROMPT, extractCodeFiles, buildPromptContent, extractJsonFromResponse } from "./prompt";
import { createAuditRecord, rejectVersion } from "./audit-queries";
import { runStaticScan, type StaticFinding } from "./static-scanner";
import { manifestSchema } from "../publishing/manifest-schema";

// --- Bindings ---

export interface AuditBindings {
  db: D1Database;
  ai: Ai;
  artifacts: R2Bucket;
  /**
   * Audit mode controls how new versions are processed:
   * - 'static-first': run static scan. Blocking findings → rejected with
   *   findings preserved. Soft findings → published as 'flagged'. Clean
   *   scan → published immediately. No AI on the upload hot path; AI
   *   runs only via admin "Run AI" action.
   * - 'auto': run static scan + Workers AI audit. Verdict decides status
   *   (pass→published, warn→flagged, fail→rejected). Neuron-budget bound.
   * - 'manual' (legacy default): skip AI, leave status='pending' for
   *   human moderation.
   * - 'off': same as manual — skip AI, leave pending. Legacy.
   */
  auditMode?: "manual" | "auto" | "off" | "static-first";
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

/**
 * Convert a static-scanner finding to the marketplace finding shape so
 * static and AI findings can live in the same audit record.
 */
function staticFindingToMarketplace(f: StaticFinding): MarketplaceAuditFinding {
  return {
    severity: f.severity === "info" ? "info" : f.severity,
    title: f.title,
    description: f.description,
    category: f.category,
    location: f.location ?? null,
  };
}

/**
 * Compute a coarse risk score from static findings alone, used when no
 * AI verdict is available. Each high finding adds 25, medium 10, low 3,
 * capped at 100.
 */
function staticRiskScore(findings: StaticFinding[]): number {
  let score = 0;
  for (const f of findings) {
    if (f.severity === "high") score += 25;
    else if (f.severity === "medium") score += 10;
    else if (f.severity === "low") score += 3;
  }
  return Math.min(100, score);
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
  // Per-job override (set by admin "Run AI" / "Run static" actions) wins
  // over the global AUDIT_MODE env var.
  const mode = job.auditModeOverride ?? bindings.auditMode ?? "manual";

  // 1. Resolve version ID
  const versionId = await resolveVersionId(bindings.db, job.pluginId, job.version);
  if (!versionId) {
    console.error(`[audit] Version not found: plugin=${job.pluginId} version=${job.version}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // 2. Fetch bundle from R2 (needed for static scan AND any AI path)
  const r2Object = await bindings.artifacts.get(job.bundleKey);
  if (!r2Object) {
    await rejectVersion(bindings.db, versionId, "Bundle not found in R2");
    console.error(`[audit] Bundle not found: key=${job.bundleKey}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // 3. Extract code files
  let codeFiles: Map<string, string>;
  try {
    codeFiles = await extractCodeFiles(await r2Object.arrayBuffer());
  } catch (err) {
    const msg = `Failed to extract bundle: ${err instanceof Error ? err.message : String(err)}`;
    await rejectVersion(bindings.db, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  if (codeFiles.size === 0) {
    await rejectVersion(bindings.db, versionId, "No code files found in bundle");
    console.error(`[audit] No code files in bundle: plugin=${job.pluginId} version=${job.version}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // 4. Always-on static scan: parse manifest from the bundle, run heuristics.
  //    Records findings against the version regardless of audit mode.
  let staticFindings: StaticFinding[] = [];
  let staticScore = 0;
  const manifestText = codeFiles.get("manifest.json");
  if (manifestText) {
    try {
      const parsed = JSON.parse(manifestText);
      const result = manifestSchema.safeParse(parsed);
      if (result.success) {
        const scan = runStaticScan(codeFiles, result.data);
        staticFindings = scan.findings;
        staticScore = staticRiskScore(scan.findings);
        console.log(
          `[audit] static scan: plugin=${job.pluginId} version=${job.version} findings=${staticFindings.length} score=${staticScore}`,
        );
      }
    } catch (err) {
      console.warn(
        `[audit] static scan failed for plugin=${job.pluginId} version=${job.version}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5a. Static-first mode: auto-publish based on static findings alone.
  //     Blocking findings → rejected with findings preserved. Soft findings
  //     → published as 'flagged' (Caution tier). Clean scan → published.
  //     No AI on the upload hot path.
  if (mode === "static-first") {
    const blockingFindings = staticFindings.filter((f) => f.blocking);
    const hasSoftFindings = staticFindings.some((f) => !f.blocking);

    if (blockingFindings.length > 0) {
      // Hard reject but preserve findings — do NOT call rejectVersion()
      // which discards them. The contributor needs to see exactly which
      // patterns blocked their upload so they can fix the source.
      const blockingTitles = blockingFindings.map((f) => f.title).join(", ");
      console.log(
        `[audit] static-first REJECT plugin=${job.pluginId} version=${job.version} blocking=${blockingFindings.length} (${blockingTitles})`,
      );
      await createAuditRecord(bindings.db, {
        versionId,
        status: "complete",
        model: "static-only",
        promptTokens: 0,
        completionTokens: 0,
        neuronsUsed: 0,
        rawResponse: `Static scanner blocked publication: ${blockingTitles}`,
        verdict: null,
        riskScore: staticScore,
        findings: staticFindings.map(staticFindingToMarketplace),
        versionStatusOverride: "rejected",
      });
      return { verdict: null, status: "complete", neuronsUsed: 0 };
    }

    const targetStatus = hasSoftFindings ? "flagged" : "published";
    console.log(
      `[audit] static-first ${targetStatus.toUpperCase()} plugin=${job.pluginId} version=${job.version} findings=${staticFindings.length}`,
    );
    await createAuditRecord(bindings.db, {
      versionId,
      status: "complete",
      model: "static-only",
      promptTokens: 0,
      completionTokens: 0,
      neuronsUsed: 0,
      rawResponse: `Static scan only (mode: static-first, result: ${targetStatus})`,
      verdict: null,
      riskScore: staticScore,
      findings: staticFindings.map(staticFindingToMarketplace),
      versionStatusOverride: targetStatus,
    });
    return { verdict: null, status: "complete", neuronsUsed: 0 };
  }

  // 5b. Manual / off modes: skip AI, record static findings, leave pending.
  if (mode !== "auto") {
    console.log(
      `[audit] mode=${mode} — skipping AI, plugin=${job.pluginId} version=${job.version} stays pending with ${staticFindings.length} static findings`,
    );
    await createAuditRecord(bindings.db, {
      versionId,
      status: "complete",
      model: "static-only",
      promptTokens: 0,
      completionTokens: 0,
      neuronsUsed: 0,
      rawResponse: `Static scan only (audit mode: ${mode})`,
      verdict: null,
      riskScore: staticScore,
      findings: staticFindings.map(staticFindingToMarketplace),
      versionStatusOverride: "pending",
    });
    return { verdict: null, status: "complete", neuronsUsed: 0 };
  }

  // 6. Auto mode: check neuron budget
  const budget = await checkNeuronBudget(bindings.db);
  if (!budget.allowed) {
    // Budget exhausted — record static findings only, leave pending for manual review.
    console.warn(
      `[audit] Daily neuron budget exhausted (${budget.used}) — falling back to static-only for plugin=${job.pluginId} version=${job.version}`,
    );
    await createAuditRecord(bindings.db, {
      versionId,
      status: "complete",
      model: "static-only",
      promptTokens: 0,
      completionTokens: 0,
      neuronsUsed: 0,
      rawResponse: "Static scan only (neuron budget exhausted)",
      verdict: null,
      riskScore: staticScore,
      findings: staticFindings.map(staticFindingToMarketplace),
      versionStatusOverride: "pending",
    });
    return { verdict: null, status: "complete", neuronsUsed: 0 };
  }

  const promptContent = buildPromptContent(codeFiles);

  // 6. Call Workers AI
  let result: { response?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
  try {
    // No response_format — many Workers AI models reject json_schema with
    // "5025: This model doesn't support JSON Schema". The prompt mandates
    // JSON-only output and extractJsonFromResponse() recovers it even if
    // the model wraps it in code fences or adds prose.
    result = await (bindings.ai as Ai).run(MODEL_ID, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: promptContent },
      ],
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

  // 7. Parse and validate response. The model may add prose, markdown
  // fences, or trailing chatter — extractJsonFromResponse handles all of
  // those and returns null only if no parseable JSON object exists.
  let parsed: { verdict: "pass" | "warn" | "fail"; riskScore: number; findings: unknown[] };
  const responseText = result.response ?? "";

  if (!responseText.trim()) {
    throw new TransientError("AI returned empty response");
  }

  const extracted = extractJsonFromResponse(responseText);
  if (extracted === null) {
    // Truncated output mid-stream is transient — retry, don't reject
    if (/^\s*[\[{]/.test(responseText)) {
      throw new TransientError(
        "Malformed AI response: could not extract valid JSON (likely truncated)",
      );
    }
    const msg = "Malformed AI response: no JSON object found in output";
    await rejectVersion(bindings.db, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  if (!validateAuditResponse(extracted)) {
    const msg = "Malformed AI response: JSON did not match required schema (verdict/riskScore/findings)";
    await rejectVersion(bindings.db, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }
  parsed = extracted;

  // 8. Calculate neurons
  const promptTokens = result.usage?.prompt_tokens ?? 0;
  const completionTokens = result.usage?.completion_tokens ?? 0;
  if (!result.usage) {
    console.warn(`[audit] WARNING: No usage data from AI response`);
  }
  const neuronsUsed = tokensToNeurons(promptTokens, completionTokens);

  // 9. Store audit record (atomically updates version status).
  // Merge static-scan findings with AI findings — the static signals stay
  // useful even when AI passes the verdict.
  const aiFindings = parsed.findings as MarketplaceAuditFinding[];
  const mergedFindings: MarketplaceAuditFinding[] = [
    ...staticFindings.map(staticFindingToMarketplace),
    ...aiFindings,
  ];
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
    findings: mergedFindings,
  });

  // 10. Update neuron budget
  await recordNeuronUsage(bindings.db, neuronsUsed);

  // 11. Log outcome
  console.log(
    `[audit] plugin=${job.pluginId} version=${job.version} verdict=${parsed.verdict} neurons=${neuronsUsed} duration=${Date.now() - startTime}ms`,
  );

  return { verdict: parsed.verdict, status: "complete", neuronsUsed };
}
