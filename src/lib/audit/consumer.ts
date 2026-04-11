/**
 * Queue consumer for AI-powered plugin code audits.
 *
 * Orchestrates the full audit pipeline: budget check, bundle fetch, code
 * extraction, AI inference, response parsing, record storage, and status update.
 * Every error path leads to version rejection (fail-closed per D-13).
 */
import type { AuditJob, MarketplaceAuditFinding } from "../../types/marketplace";
import { checkNeuronBudget, recordNeuronUsage, tokensToNeurons } from "./budget";
import {
  SYSTEM_PROMPT,
  extractCodeFiles,
  buildPromptContent,
  extractJsonFromResponse,
  resolveAuditModel,
} from "./prompt";
import {
  createAuditRecord,
  createBatchAuditPending,
  rejectVersion,
} from "./audit-queries";
import { runStaticScan, type StaticFinding } from "./static-scanner";
import { manifestSchema } from "../publishing/manifest-schema";
import { emitAuditNotification } from "../notifications/emitter";

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
  /**
   * Optional NOTIF_QUEUE producer. When provided, terminal-state audits
   * (pass/warn/fail/error) emit notification jobs after the audit row is
   * written. Optional so existing tests that pre-date Phase 12 still
   * construct an `AuditBindings` without a queue.
   */
  notifQueue?: Queue;
}

/**
 * Internal helper: emit an audit notification, swallowing every error.
 *
 * The audit pipeline is the source of truth for the version's lifecycle —
 * if the notifications subsystem breaks for any reason (queue down, fan-out
 * query throws, plugin row missing), the audit MUST still complete.
 */
async function tryEmitAuditNotification(
  bindings: AuditBindings,
  job: AuditJob,
  auditId: string,
  verdict: "pass" | "warn" | "fail" | null,
  riskScore: number,
  findingCount: number,
  errorMessage?: string,
): Promise<void> {
  if (!bindings.notifQueue) return;
  try {
    const nameRow = await bindings.db
      .prepare("SELECT name FROM plugins WHERE id = ?")
      .bind(job.pluginId)
      .first<{ name: string }>();
    await emitAuditNotification(bindings.db, bindings.notifQueue, {
      auditId,
      pluginId: job.pluginId,
      pluginName: nameRow?.name ?? job.pluginId,
      version: job.version,
      verdict,
      riskScore,
      findingCount,
      errorMessage,
    });
  } catch (err) {
    console.error(
      `[notifications] audit emit failed plugin=${job.pluginId} version=${job.version}:`,
      err,
    );
  }
}

/**
 * Reject a version (records an error audit row + flips the version
 * status) AND emit an `audit_error` notification. Used by every AI-mode
 * error branch so the publisher learns their version was rejected even
 * when no human verdict exists.
 *
 * Notification emission is best-effort — if the emit step fails the
 * version is still rejected and the function still returns.
 */
async function rejectAndNotify(
  bindings: AuditBindings,
  job: AuditJob,
  versionId: string,
  errorMessage: string,
): Promise<void> {
  await rejectVersion(bindings.db, versionId, errorMessage);
  if (!bindings.notifQueue) return;
  try {
    // Look up the audit row we just wrote (the most recent one for this
    // version) so the emit hook has a stable eventId for idempotency.
    const auditRow = await bindings.db
      .prepare(
        `SELECT id FROM plugin_audits WHERE plugin_version_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(versionId)
      .first<{ id: string }>();
    if (!auditRow?.id) return;
    await tryEmitAuditNotification(
      bindings,
      job,
      auditRow.id,
      null,
      0,
      0,
      errorMessage,
    );
  } catch (err) {
    console.error(
      `[notifications] error-emit lookup failed plugin=${job.pluginId} version=${job.version}:`,
      err,
    );
  }
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
 *
 * Transient signals we match:
 *  - 429 / 503 — HTTP rate limit or service unavailable
 *  - timeout — network or model wall-clock overrun
 *  - 3050 "Max retries exhausted" — Workers AI's own retry budget for
 *    the upstream call gave up. This fires on newly-launched or
 *    capacity-constrained models (e.g. gemma-4-26b-a4b in its first
 *    days on Workers AI). Upstream capacity is the cause, not our
 *    request, so queue-retrying a minute or two later is the right
 *    move — not a permanent version rejection.
 *  - 5004 / 5007 — Workers AI server-side errors; retried same as 5xx HTTP.
 *  - capacity / overloaded — free-text capacity signals from the runtime.
 *
 * Everything else (invalid model, invalid request, schema mismatches) is
 * permanent and fail-closes the version.
 */
function isTransientAiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("timeout") ||
    msg.includes("3050") ||
    msg.includes("max retries") ||
    msg.includes("5004") ||
    msg.includes("5007") ||
    msg.includes("capacity") ||
    msg.includes("overloaded")
  );
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
  console.log(
    `[audit] START processAuditJob: plugin=${job.pluginId} version=${job.version} resolvedMode=${mode} (override=${job.auditModeOverride ?? "none"}, global=${bindings.auditMode ?? "none"})`,
  );

  // 1. Resolve version ID
  const versionId = await resolveVersionId(bindings.db, job.pluginId, job.version);
  if (!versionId) {
    console.error(`[audit] Version not found: plugin=${job.pluginId} version=${job.version}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // 2. Fetch bundle from R2 (needed for static scan AND any AI path)
  const r2Object = await bindings.artifacts.get(job.bundleKey);
  if (!r2Object) {
    await rejectAndNotify(bindings, job, versionId, "Bundle not found in R2");
    console.error(`[audit] Bundle not found: key=${job.bundleKey}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  // 3. Extract code files
  let codeFiles: Map<string, string>;
  try {
    codeFiles = await extractCodeFiles(await r2Object.arrayBuffer());
  } catch (err) {
    const msg = `Failed to extract bundle: ${err instanceof Error ? err.message : String(err)}`;
    await rejectAndNotify(bindings, job, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  if (codeFiles.size === 0) {
    await rejectAndNotify(
      bindings,
      job,
      versionId,
      "No code files found in bundle",
    );
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
      const auditId = await createAuditRecord(bindings.db, {
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
      // Static-first reject is a terminal `rejected` transition — surface
      // it as an `audit_fail` so the publisher gets the same treatment as
      // a real AI fail verdict.
      await tryEmitAuditNotification(
        bindings,
        job,
        auditId,
        "fail",
        staticScore,
        staticFindings.length,
      );
      return { verdict: null, status: "complete", neuronsUsed: 0 };
    }

    const targetStatus = hasSoftFindings ? "flagged" : "published";
    console.log(
      `[audit] static-first ${targetStatus.toUpperCase()} plugin=${job.pluginId} version=${job.version} findings=${staticFindings.length}`,
    );
    const auditId = await createAuditRecord(bindings.db, {
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
    // Static-first publish is a terminal transition — synthesize a
    // verdict so the right event type fires (warn for soft findings,
    // pass for a clean scan).
    await tryEmitAuditNotification(
      bindings,
      job,
      auditId,
      hasSoftFindings ? "warn" : "pass",
      staticScore,
      staticFindings.length,
    );
    return { verdict: null, status: "complete", neuronsUsed: 0 };
  }

  // 5b. Manual / off modes: skip AI, record static findings, leave pending.
  if (mode !== "auto") {
    console.log(
      `[audit] mode=${mode} — skipping AI, plugin=${job.pluginId} version=${job.version} stays pending with ${staticFindings.length} static findings`,
    );
    const auditId = await createAuditRecord(bindings.db, {
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
    // Manual/off mode leaves the version `pending` — NOT a terminal
    // state, so do not emit a notification. The publisher will hear
    // about the version when an admin runs the audit and the version
    // transitions to a terminal state.
    void auditId;
    return { verdict: null, status: "complete", neuronsUsed: 0 };
  }

  // 6. Auto mode: check neuron budget
  const budget = await checkNeuronBudget(bindings.db);
  if (!budget.allowed) {
    // Budget exhausted — record static findings only, leave pending for manual review.
    console.warn(
      `[audit] Daily neuron budget exhausted (${budget.used}) — falling back to static-only for plugin=${job.pluginId} version=${job.version}`,
    );
    const auditId = await createAuditRecord(bindings.db, {
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
    void auditId;
    return { verdict: null, status: "complete", neuronsUsed: 0 };
  }

  const promptContent = buildPromptContent(codeFiles);

  // 6. Resolve which model to call. Admin-supplied modelOverride wins;
  //    unknown keys fall back to the default inside resolveAuditModel.
  const modelDef = resolveAuditModel(job.modelOverride);
  const modelId = modelDef.workersAiId;
  console.log(
    `[audit] AI call starting: plugin=${job.pluginId} version=${job.version} model=${modelId} batchCapable=${modelDef.batchCapable} promptLength=${promptContent.length} budget=${budget.used}`,
  );

  // 6a. Batch-capable models: submit via the Async Batch API and ack.
  //     Cloudflare docs: https://developers.cloudflare.com/workers-ai/features/batch-api/
  //
  //     The submit returns immediately with a `request_id`. We write a
  //     `status='pending'` audit row carrying that id, then ack the queue
  //     message. The polling cron (`scheduled` handler, `*/2 * * * *`)
  //     picks it up later via `findPendingBatchAudits` → `ai.run(model,
  //     { request_id })` and finalises the row via `completeBatchAudit`.
  //
  //     Static findings recorded above are NOT merged yet — they'll be
  //     merged by the poller when the batch result lands. That way the
  //     single audit row contains the full picture when it's read.
  if (modelDef.batchCapable) {
    type BatchSubmitResponse = { request_id?: string; status?: string };
    let submitResult: BatchSubmitResponse;
    try {
      submitResult = (await (bindings.ai as Ai).run(
        modelId as Parameters<Ai["run"]>[0],
        {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: promptContent },
          ],
          max_tokens: 1024,
          max_completion_tokens: 1024,
          temperature: 0.1,
        },
        // `queueRequest: true` is the flag that routes this call through
        // the Async Batch API. Only batch-capable models accept it; for
        // non-batch models Workers AI errors out, which is why we gate
        // on `modelDef.batchCapable`.
        { queueRequest: true } as unknown as Parameters<Ai["run"]>[2],
      )) as unknown as BatchSubmitResponse;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[audit] Batch submit failed: plugin=${job.pluginId} version=${job.version} model=${modelId} err=${errMsg}`,
      );
      // Fall closed: treat batch submission failure as a permanent error
      // for this audit. The queue's own retries are the wrong mechanism
      // here because the failure is likely "model doesn't support batch"
      // or "invalid request" — not transient capacity.
      await rejectAndNotify(
        bindings,
        job,
        versionId,
        `Batch submit failed: ${errMsg}`,
      );
      return { verdict: null, status: "error", neuronsUsed: 0 };
    }

    const requestId = submitResult?.request_id;
    if (!requestId || typeof requestId !== "string") {
      console.error(
        `[audit] Batch submit returned no request_id: plugin=${job.pluginId} version=${job.version} response=${JSON.stringify(submitResult)}`,
      );
      await rejectAndNotify(
        bindings,
        job,
        versionId,
        "Batch submit returned no request_id",
      );
      return { verdict: null, status: "error", neuronsUsed: 0 };
    }

    const pendingAuditId = await createBatchAuditPending(bindings.db, {
      versionId,
      model: modelId,
      batchRequestId: requestId,
    });
    console.log(
      `[audit] Batch submitted: plugin=${job.pluginId} version=${job.version} model=${modelId} auditId=${pendingAuditId} requestId=${requestId}`,
    );

    // Return 'complete' so the queue handler acks the message. The
    // Worker invocation ends here; the poller cron takes over for the
    // result-handling half of the lifecycle.
    return { verdict: null, status: "complete", neuronsUsed: 0 };
  }

  // 7. Call Workers AI.
  // Two response shapes are observed across Workers AI text-gen models:
  //   a) Standard:   { response: string,                 usage: {...} }
  //   b) OpenAI-compat (e.g. gemma-4-26b-a4b-it):
  //      { choices: [{ message: { content: string } }],  usage: {...} }
  // Below we send both `max_tokens` and `max_completion_tokens` so each
  // model receives the parameter it expects (Workers AI ignores the
  // unrecognised one). The shape is normalised after the call by
  // extractAiResponseText() so the rest of the pipeline only sees a
  // single { response, usage } envelope regardless of the model.
  // Envelope supports three shapes we've observed on Workers AI:
  //   a) Standard text-gen: { response: string, usage: {...} }
  //      e.g. @cf/meta/llama-3.2-3b-instruct
  //   b) OpenAI-compat with visible content: { choices: [{ message: { content } }], usage }
  //   c) OpenAI-compat with reasoning: { choices: [{ message: { content, reasoning_content } }], usage }
  //      e.g. @cf/zai-org/glm-4.7-flash, @cf/openai/gpt-oss-*, any model
  //      with internal chain-of-thought. These may fill reasoning_content
  //      and leave `content` empty if the completion budget is tight.
  type AiResponseEnvelope = {
    response?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
      };
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  let raw: AiResponseEnvelope;
  try {
    // No response_format — many Workers AI models reject json_schema with
    // "5025: This model doesn't support JSON Schema". The prompt mandates
    // JSON-only output and extractJsonFromResponse() recovers it even if
    // the model wraps it in code fences or adds prose.
    //
    // max_tokens = 4096 gives reasoning models (GLM-4.7, GPT-OSS, etc.)
    // enough room to complete their internal chain-of-thought AND emit
    // the final JSON. Llama 3.2 3B (the previous default) never needed
    // more than ~200 output tokens, but reasoning models can spend 1000+
    // tokens thinking before they write a single visible token — if
    // max_tokens caps them mid-thought, `content` comes back empty.
    raw = await (bindings.ai as Ai).run(modelId as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: promptContent },
      ],
      max_tokens: 4096,
      max_completion_tokens: 4096,
      temperature: 0.1,
    }) as unknown as AiResponseEnvelope;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const transient = isTransientAiError(err);
    console.error(
      `[audit] AI call failed: plugin=${job.pluginId} version=${job.version} model=${modelId} transient=${transient} err=${errMsg}`,
    );
    if (transient) {
      throw new TransientError(`AI inference failed: ${errMsg}`);
    }
    const msg = `AI inference error: ${errMsg}`;
    await rejectAndNotify(bindings, job, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  console.log(
    `[audit] AI call returned: plugin=${job.pluginId} version=${job.version} model=${modelId} hasResponse=${!!raw.response} hasChoices=${!!raw.choices} usage=${JSON.stringify(raw.usage ?? null)} elapsed=${Date.now() - startTime}ms`,
  );

  // 7. Normalise the response shape. Four paths we try in order:
  //    a) `response` as STRING (standard text-gen, e.g. llama-*)
  //    b) `response` as OBJECT (pre-parsed JSON, e.g. qwen2.5-coder-32b —
  //       Workers AI detects valid JSON output and parses it for us).
  //       We stringify it so extractJsonFromResponse() still works.
  //    c) `choices[0].message.content` (OpenAI-compat visible output)
  //    d) `choices[0].message.reasoning_content` (fallback for reasoning
  //       models that spent their whole output budget on chain-of-thought
  //       — the target JSON is still in the reasoning trace, and our
  //       extractJsonFromResponse() can pull it out of surrounding prose)
  const firstChoice = raw.choices?.[0]?.message;
  const rawResponse = raw.response as unknown;
  const responseText =
    (typeof rawResponse === "string"
      ? rawResponse
      : rawResponse && typeof rawResponse === "object"
        ? JSON.stringify(rawResponse)
        : undefined) ??
    (firstChoice?.content && firstChoice.content.length > 0
      ? firstChoice.content
      : firstChoice?.reasoning_content) ??
    "";

  // Diagnostic log on empty responses so future mysteries triage faster
  // without a new round of tail-watching.
  if (!responseText || !responseText.trim()) {
    console.error(
      `[audit] empty response envelope: plugin=${job.pluginId} version=${job.version} model=${modelId} rawKeys=${Object.keys(raw).join(",")} choiceKeys=${firstChoice ? Object.keys(firstChoice).join(",") : "none"} contentLen=${firstChoice?.content?.length ?? 0} reasoningLen=${firstChoice?.reasoning_content?.length ?? 0}`,
    );
  }

  // 8. Parse and validate response. The model may add prose, markdown
  // fences, or trailing chatter — extractJsonFromResponse handles all of
  // those and returns null only if no parseable JSON object exists.
  let parsed: { verdict: "pass" | "warn" | "fail"; riskScore: number; findings: unknown[] };

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
    await rejectAndNotify(bindings, job, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }

  if (!validateAuditResponse(extracted)) {
    const msg = "Malformed AI response: JSON did not match required schema (verdict/riskScore/findings)";
    await rejectAndNotify(bindings, job, versionId, msg);
    console.error(`[audit] ${msg}`);
    return { verdict: null, status: "error", neuronsUsed: 0 };
  }
  parsed = extracted;

  // 9. Calculate neurons (usage shape is identical across both response
  // envelopes — same prompt_tokens / completion_tokens field names).
  const promptTokens = raw.usage?.prompt_tokens ?? 0;
  const completionTokens = raw.usage?.completion_tokens ?? 0;
  if (!raw.usage) {
    console.warn(`[audit] WARNING: No usage data from AI response`);
  }
  const neuronsUsed = tokensToNeurons(promptTokens, completionTokens);

  // 10. Store audit record (atomically updates version status).
  // Merge static-scan findings with AI findings — the static signals stay
  // useful even when AI passes the verdict.
  const aiFindings = parsed.findings as MarketplaceAuditFinding[];
  const mergedFindings: MarketplaceAuditFinding[] = [
    ...staticFindings.map(staticFindingToMarketplace),
    ...aiFindings,
  ];
  const auditId = await createAuditRecord(bindings.db, {
    versionId,
    status: "complete",
    model: modelId,
    promptTokens,
    completionTokens,
    neuronsUsed,
    rawResponse: responseText,
    verdict: parsed.verdict,
    riskScore: parsed.riskScore,
    findings: mergedFindings,
  });

  console.log(
    `[audit] Record stored: plugin=${job.pluginId} version=${job.version} auditId=${auditId} verdict=${parsed.verdict} riskScore=${parsed.riskScore} findings=${mergedFindings.length}`,
  );

  // 10. Update neuron budget
  await recordNeuronUsage(bindings.db, neuronsUsed);

  // 11. Log outcome
  console.log(
    `[audit] plugin=${job.pluginId} version=${job.version} model=${modelDef.key} verdict=${parsed.verdict} neurons=${neuronsUsed} duration=${Date.now() - startTime}ms`,
  );

  // 12. Emit notification for the terminal AI verdict. This is wrapped in
  //     a try/catch inside `tryEmitAuditNotification` so a notifications
  //     failure can never strand the audit pipeline.
  await tryEmitAuditNotification(
    bindings,
    job,
    auditId,
    parsed.verdict,
    parsed.riskScore,
    mergedFindings.length,
  );

  return { verdict: parsed.verdict, status: "complete", neuronsUsed };
}
