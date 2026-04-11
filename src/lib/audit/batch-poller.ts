/**
 * Workers AI Async Batch API poller.
 *
 * Context: Batch-capable models (Llama 3.3 70B, Qwen3 30B, future Gemma
 * 4 26B) submit via `ai.run(model, payload, { queueRequest: true })`
 * which returns a `request_id` immediately and ends the Worker
 * invocation. This module runs on a every-2-minute cron and fetches
 * results for every pending batch audit row:
 *
 *   for each pending row:
 *     result = await ai.run(model, { request_id })
 *     switch (result.status):
 *       'queued' / 'running'  → try again next cron
 *       complete (has .response / .choices) → completeBatchAudit
 *       error                → failBatchAudit
 *     if (batch_polls > MAX_POLLS) → circuit breaker → failBatchAudit
 *
 * Why a cron and not a Durable Object alarm: simpler free-tier fit,
 * one scheduled handler handles every pending audit across all
 * plugins, and the partial index keeps the query cheap.
 *
 * Cloudflare docs: https://developers.cloudflare.com/workers-ai/features/batch-api/
 */
import {
  completeBatchAudit,
  failBatchAudit,
  findPendingBatchAudits,
  incrementBatchPolls,
  type PendingBatchAudit,
} from "./audit-queries";
import { extractJsonFromResponse } from "./prompt";
import { tokensToNeurons, recordNeuronUsage } from "./budget";
import { emitAuditNotification } from "../notifications/emitter";
import type { MarketplaceAuditFinding } from "../../types/marketplace";

/**
 * Maximum number of polls before the circuit breaker fires. At the
 * default every-2-minute cron (every 2 minutes) this equals 2 hours —
 * well past the docs' stated "usually within 5 minutes" for batch
 * completion, but generous enough that a queue backlog doesn't
 * prematurely reject a legitimate submission.
 */
export const MAX_BATCH_POLLS = 60;

/**
 * Workers AI batch-response envelope. Three shapes are observed:
 *   1. Still queued/running:
 *      { status: "queued" | "running", request_id: "..." }
 *   2. Complete, standard text-gen (e.g. Llama 3.3):
 *      { response: string, usage: { prompt_tokens, completion_tokens, ... } }
 *   3. Complete, OpenAI-compat (e.g. Qwen3 30B):
 *      { choices: [{ message: { content: string } }], usage: {...} }
 *
 * We normalise (2) and (3) into a single `responseText + usage`
 * upstream, mirroring the sync-path envelope handling in consumer.ts.
 */
interface BatchPollEnvelope {
  status?: string;
  request_id?: string;
  response?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  errors?: Array<{ message?: string }>;
}

export interface BatchPollerBindings {
  db: D1Database;
  ai: Ai;
  notifQueue?: Queue;
}

export interface BatchPollerStats {
  scanned: number;
  stillPending: number;
  completed: number;
  failed: number;
  circuitBroken: number;
}

/**
 * Parse + validate a batch result payload. Mirrors the validation
 * logic in consumer.ts so sync and batch paths apply the same rules.
 */
function parseAndValidateResult(
  responseText: string,
):
  | {
      ok: true;
      verdict: "pass" | "warn" | "fail";
      riskScore: number;
      findings: MarketplaceAuditFinding[];
    }
  | { ok: false; reason: string } {
  if (!responseText.trim()) {
    return { ok: false, reason: "empty response" };
  }
  const extracted = extractJsonFromResponse(responseText);
  if (extracted === null || typeof extracted !== "object") {
    return { ok: false, reason: "no JSON object in response" };
  }
  const obj = extracted as Record<string, unknown>;
  if (!["pass", "warn", "fail"].includes(obj.verdict as string)) {
    return { ok: false, reason: "missing or invalid verdict" };
  }
  if (
    typeof obj.riskScore !== "number" ||
    obj.riskScore < 0 ||
    obj.riskScore > 100
  ) {
    return { ok: false, reason: "missing or out-of-range riskScore" };
  }
  if (!Array.isArray(obj.findings)) {
    return { ok: false, reason: "missing findings array" };
  }
  return {
    ok: true,
    verdict: obj.verdict as "pass" | "warn" | "fail",
    riskScore: obj.riskScore,
    findings: obj.findings as MarketplaceAuditFinding[],
  };
}

/**
 * Try to emit an audit notification. Mirrors consumer.ts's
 * `tryEmitAuditNotification` helper — swallows every error so a
 * notifications outage never strands a completed audit.
 */
async function tryEmitNotification(
  bindings: BatchPollerBindings,
  row: PendingBatchAudit,
  verdict: "pass" | "warn" | "fail" | null,
  riskScore: number,
  findingCount: number,
  errorMessage?: string,
): Promise<void> {
  if (!bindings.notifQueue) return;
  try {
    const nameRow = await bindings.db
      .prepare("SELECT name FROM plugins WHERE id = ?")
      .bind(row.pluginId)
      .first<{ name: string }>();
    await emitAuditNotification(bindings.db, bindings.notifQueue, {
      auditId: row.auditId,
      pluginId: row.pluginId,
      pluginName: nameRow?.name ?? row.pluginId,
      version: row.version,
      verdict,
      riskScore,
      findingCount,
      errorMessage,
    });
  } catch (err) {
    console.error(
      `[batch-poller] notification emit failed plugin=${row.pluginId} version=${row.version}:`,
      err,
    );
  }
}

/**
 * Poll every pending batch audit once.
 *
 * Called from the scheduled handler in worker.ts every 2 minutes. All
 * work happens inside `ctx.waitUntil()` so the cron acknowledges fast
 * while the polling happens in the background.
 */
export async function pollPendingBatches(
  bindings: BatchPollerBindings,
): Promise<BatchPollerStats> {
  const stats: BatchPollerStats = {
    scanned: 0,
    stillPending: 0,
    completed: 0,
    failed: 0,
    circuitBroken: 0,
  };

  const pending = await findPendingBatchAudits(bindings.db);
  stats.scanned = pending.length;
  if (pending.length === 0) {
    console.log("[batch-poller] no pending batch audits");
    return stats;
  }

  console.log(
    `[batch-poller] polling ${pending.length} pending batch audit(s)`,
  );

  for (const row of pending) {
    // Always bump the poll count first, so a row that repeatedly
    // crashes the handler still trips the circuit breaker eventually.
    await incrementBatchPolls(bindings.db, row.auditId);

    // Circuit breaker — stop chasing a batch that never comes back.
    if (row.batchPolls + 1 >= MAX_BATCH_POLLS) {
      console.warn(
        `[batch-poller] circuit breaker: plugin=${row.pluginId} version=${row.version} auditId=${row.auditId} polls=${row.batchPolls + 1} — failing audit`,
      );
      await failBatchAudit(bindings.db, {
        auditId: row.auditId,
        versionId: row.versionId,
        errorMessage: `Batch poll timeout: no result after ${MAX_BATCH_POLLS} polls (~${Math.round(MAX_BATCH_POLLS * 2 / 60)}h)`,
      });
      await tryEmitNotification(
        bindings,
        row,
        null,
        0,
        0,
        "Batch poll timeout",
      );
      stats.circuitBroken++;
      continue;
    }

    let envelope: BatchPollEnvelope;
    try {
      envelope = (await (bindings.ai as Ai).run(
        row.model as Parameters<Ai["run"]>[0],
        { request_id: row.batchRequestId } as unknown as Parameters<Ai["run"]>[1],
      )) as unknown as BatchPollEnvelope;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[batch-poller] poll call failed plugin=${row.pluginId} version=${row.version} auditId=${row.auditId}: ${errMsg}`,
      );
      // A poll-call failure is NOT terminal — Workers AI itself might
      // be having a blip. Leave the row pending and try again next
      // cron tick. The circuit breaker above catches genuinely stuck
      // rows.
      stats.stillPending++;
      continue;
    }

    // Status-only responses mean the batch is still in flight. Leave
    // the row alone and the next cron tick will try again.
    if (envelope.status === "queued" || envelope.status === "running") {
      console.log(
        `[batch-poller] still ${envelope.status}: plugin=${row.pluginId} version=${row.version} auditId=${row.auditId} poll=${row.batchPolls + 1}`,
      );
      stats.stillPending++;
      continue;
    }

    // Explicit error payload from the batch API → fail terminally.
    if (envelope.errors && envelope.errors.length > 0) {
      const errMsg =
        envelope.errors.map((e) => e.message ?? "unknown").join("; ") ||
        "batch API returned errors";
      console.error(
        `[batch-poller] batch error plugin=${row.pluginId} version=${row.version} auditId=${row.auditId}: ${errMsg}`,
      );
      await failBatchAudit(bindings.db, {
        auditId: row.auditId,
        versionId: row.versionId,
        errorMessage: `Batch API error: ${errMsg}`,
      });
      await tryEmitNotification(bindings, row, null, 0, 0, errMsg);
      stats.failed++;
      continue;
    }

    // Normalise the response text across Workers AI envelope shapes.
    const responseText =
      envelope.response ?? envelope.choices?.[0]?.message?.content ?? "";

    if (!responseText) {
      console.error(
        `[batch-poller] batch returned no response text plugin=${row.pluginId} version=${row.version}`,
      );
      await failBatchAudit(bindings.db, {
        auditId: row.auditId,
        versionId: row.versionId,
        errorMessage: "Batch returned empty response payload",
      });
      await tryEmitNotification(
        bindings,
        row,
        null,
        0,
        0,
        "Batch returned empty response payload",
      );
      stats.failed++;
      continue;
    }

    const parsed = parseAndValidateResult(responseText);
    if (!parsed.ok) {
      console.error(
        `[batch-poller] malformed batch result plugin=${row.pluginId} version=${row.version}: ${parsed.reason}`,
      );
      await failBatchAudit(bindings.db, {
        auditId: row.auditId,
        versionId: row.versionId,
        errorMessage: `Malformed batch response: ${parsed.reason}`,
      });
      await tryEmitNotification(
        bindings,
        row,
        null,
        0,
        0,
        `Malformed batch response: ${parsed.reason}`,
      );
      stats.failed++;
      continue;
    }

    const promptTokens = envelope.usage?.prompt_tokens ?? 0;
    const completionTokens = envelope.usage?.completion_tokens ?? 0;
    const neuronsUsed = tokensToNeurons(promptTokens, completionTokens);

    await completeBatchAudit(bindings.db, {
      auditId: row.auditId,
      versionId: row.versionId,
      promptTokens,
      completionTokens,
      neuronsUsed,
      rawResponse: responseText,
      verdict: parsed.verdict,
      riskScore: parsed.riskScore,
      findings: parsed.findings,
    });
    await recordNeuronUsage(bindings.db, neuronsUsed);
    console.log(
      `[batch-poller] batch complete plugin=${row.pluginId} version=${row.version} auditId=${row.auditId} verdict=${parsed.verdict} neurons=${neuronsUsed}`,
    );

    await tryEmitNotification(
      bindings,
      row,
      parsed.verdict,
      parsed.riskScore,
      parsed.findings.length,
    );
    stats.completed++;
  }

  console.log(
    `[batch-poller] done: scanned=${stats.scanned} stillPending=${stats.stillPending} completed=${stats.completed} failed=${stats.failed} circuitBroken=${stats.circuitBroken}`,
  );
  return stats;
}
