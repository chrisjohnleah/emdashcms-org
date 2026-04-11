#!/usr/bin/env -S npx tsx
/**
 * Audit model benchmark.
 *
 * Runs every enabled model in AUDIT_MODELS against one or more plugin
 * tarball fixtures and produces a comparison table of latency, token
 * usage, neuron cost, verdict, and hallucination heuristics. The goal
 * is to give empirical evidence for which model to set as
 * `DEFAULT_AUDIT_MODEL` based on actual results on *your* plugins —
 * not on vendor benchmarks run against general tasks.
 *
 * Usage:
 *   npm run bench -- bench-fixtures/serpdelta-0.2.4.tgz
 *   npm run bench -- bench-fixtures/a.tgz bench-fixtures/b.tgz
 *   npm run bench -- --only glm-4.7-flash,gemma-4-26b-a4b bench-fixtures/a.tgz
 *
 * Required env vars (or put them in a gitignored .env.bench file):
 *   CLOUDFLARE_ACCOUNT_ID   Cloudflare account id
 *   CLOUDFLARE_API_TOKEN    API token with `Workers AI: Read + Run`
 *
 * Why REST API instead of the bindings: this script runs from your
 * laptop, not inside a deployed Worker, so we can't call `env.AI.run`.
 * The REST endpoint is the same model behind the binding, so numbers
 * are comparable to production within a few hundred milliseconds of
 * network overhead.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  AUDIT_MODELS,
  SYSTEM_PROMPT,
  extractCodeFiles,
  buildPromptContent,
  extractJsonFromResponse,
  type AuditModelDef,
} from "../src/lib/audit/prompt";

// --- Config ---

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error(
    "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN env var.\n" +
      "Export them before running:\n" +
      '  export CLOUDFLARE_ACCOUNT_ID="82fe5f2eb4c1b22c90c902f7e8f330a7"\n' +
      '  export CLOUDFLARE_API_TOKEN="cfut_..."\n' +
      "The token needs Workers AI Read + Run permissions.",
  );
  process.exit(1);
}

/**
 * Cloudflare Workers AI pricing per million tokens (USD). Verified
 * against each model's page on developers.cloudflare.com. Neurons
 * equal $11 per million, so 1 neuron ≈ $0.000011.
 *
 * Keep this table in sync with AUDIT_MODELS — when adding a new model
 * to the registry, add its pricing here so the cost column stays
 * accurate.
 */
const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  "@cf/zai-org/glm-4.7-flash": { inputPerM: 0.06, outputPerM: 0.4 },
  "@cf/meta/llama-3.2-3b-instruct": { inputPerM: 0.051, outputPerM: 0.34 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inputPerM: 0.29, outputPerM: 2.25 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { inputPerM: 0.051, outputPerM: 0.34 },
  "@cf/google/gemma-4-26b-a4b-it": { inputPerM: 0.1, outputPerM: 0.3 },
};

const NEURONS_PER_USD = 1_000_000 / 11; // 1M neurons = $11 per CF pricing

function usdToNeurons(usd: number): number {
  return Math.round(usd * NEURONS_PER_USD);
}

function costUsd(modelId: string, inTokens: number, outTokens: number): number {
  const p = PRICING[modelId];
  if (!p) return 0;
  return (inTokens / 1_000_000) * p.inputPerM + (outTokens / 1_000_000) * p.outputPerM;
}

// --- Types ---

interface BenchmarkResult {
  fixture: string;
  modelKey: string;
  modelId: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
  promptTokens: number;
  completionTokens: number;
  neurons: number;
  usd: number;
  verdict: "pass" | "warn" | "fail" | null;
  riskScore: number;
  findingsCount: number;
  findings: Array<{
    severity: string;
    title: string;
    description: string;
    category: string;
    location: string | null;
  }>;
  hallucinationFlags: string[];
  rawResponsePreview: string;
  rawResponseFull: string;
  batchPolls?: number;
}

// --- Hallucination heuristic ---

/**
 * Heuristic red flags for hallucinated findings. If a finding's
 * description contains any of these strings we bump the hallucination
 * counter — these are phrases we know appear in false-positive
 * findings against the trusted plugin SDK or standard library usage.
 *
 * Not perfect, but good enough to let us eyeball which models produce
 * the "emdash library is not properly sanitized" class of nonsense.
 */
const HALLUCINATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /emdash\s+library/i, label: "flags emdash SDK as risk" },
  { pattern: /@emdash-cms\/blocks/i, label: "flags @emdash-cms/blocks as risk" },
  { pattern: /not\s+properly\s+sanit[iz]ed/i, label: "vague 'not sanitized' claim" },
  { pattern: /potentially\s+allow(ing)?/i, label: "vague 'potentially' claim" },
  { pattern: /may\s+allow/i, label: "vague 'may allow' claim" },
  { pattern: /definePlugin\s+.*\b(risk|danger|unsafe|vulnerab)/i, label: "flags definePlugin helper" },
  { pattern: /ctx\.(kv|log|http)\s+.*\b(risk|danger|unsafe|vulnerab)/i, label: "flags ctx.* SDK primitive" },
];

function detectHallucinations(findings: BenchmarkResult["findings"]): string[] {
  const flags: string[] = [];
  for (const f of findings) {
    const haystack = `${f.title} ${f.description}`;
    for (const { pattern, label } of HALLUCINATION_PATTERNS) {
      if (pattern.test(haystack) && !flags.includes(label)) {
        flags.push(label);
      }
    }
  }
  return flags;
}

// --- Workers AI REST API calls ---

interface SyncEnvelope {
  result?: {
    response?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        // GLM-4.7-Flash also exposes `reasoning` as an alias for
        // `reasoning_content`. Observed in the live envelope keys list:
        //   ["annotations","audio","content","function_call","reasoning",
        //    "reasoning_content","refusal","role","tool_calls"]
        reasoning?: string | null;
      };
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  success?: boolean;
  errors?: Array<{ message: string; code: number }>;
}

interface BatchSubmitEnvelope {
  result?: {
    request_id?: string;
    status?: string;
  };
  success?: boolean;
  errors?: Array<{ message: string; code: number }>;
}

interface BatchPollEnvelope {
  result?: {
    status?: string;
    responses?: Array<{
      id?: number;
      result?: {
        response?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
      };
      success?: boolean;
      errors?: Array<{ message: string }>;
    }>;
  };
  success?: boolean;
  errors?: Array<{ message: string; code: number }>;
}

async function callModelSync(
  modelId: string,
  prompt: string,
): Promise<SyncEnvelope> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${modelId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 4096,
      max_completion_tokens: 4096,
      temperature: 0.1,
    }),
  });
  return (await res.json()) as SyncEnvelope;
}

async function submitBatch(
  modelId: string,
  prompt: string,
): Promise<BatchSubmitEnvelope> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${modelId}?queueRequest=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          max_tokens: 4096,
          max_completion_tokens: 4096,
          temperature: 0.1,
          external_reference: "audit-benchmark",
        },
      ],
    }),
  });
  return (await res.json()) as BatchSubmitEnvelope;
}

async function pollBatch(
  modelId: string,
  requestId: string,
): Promise<BatchPollEnvelope> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${modelId}?queueRequest=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ request_id: requestId }),
  });
  return (await res.json()) as BatchPollEnvelope;
}

// --- Response normalisation (mirrors consumer.ts) ---

function extractResponseText(envelope: SyncEnvelope | BatchPollEnvelope): string {
  // Batch response: choices inside `responses[0].result`
  if ("result" in envelope && envelope.result && "responses" in envelope.result) {
    const r = envelope.result.responses?.[0]?.result;
    if (!r) return "";
    return (
      r.response ??
      r.choices?.[0]?.message?.content ??
      ""
    );
  }
  // Sync response: direct `.result.response` or `.result.choices[0].message.content/reasoning_content`
  const r = envelope.result as SyncEnvelope["result"];
  if (!r) return "";
  const firstChoice = r.choices?.[0]?.message;
  return (
    r.response ??
    (firstChoice?.content && firstChoice.content.length > 0
      ? firstChoice.content
      : firstChoice?.reasoning_content ?? "") ??
    ""
  );
}

function extractUsage(
  envelope: SyncEnvelope | BatchPollEnvelope,
): { prompt_tokens: number; completion_tokens: number } {
  if ("result" in envelope && envelope.result && "responses" in envelope.result) {
    const u = envelope.result.responses?.[0]?.result?.usage;
    return {
      prompt_tokens: u?.prompt_tokens ?? 0,
      completion_tokens: u?.completion_tokens ?? 0,
    };
  }
  const u = (envelope.result as SyncEnvelope["result"])?.usage;
  return {
    prompt_tokens: u?.prompt_tokens ?? 0,
    completion_tokens: u?.completion_tokens ?? 0,
  };
}

// --- Per-model benchmark runner ---

async function benchmarkModel(
  model: AuditModelDef,
  fixturePath: string,
  prompt: string,
): Promise<BenchmarkResult> {
  const base: Omit<BenchmarkResult, "latencyMs" | "ok"> = {
    fixture: basename(fixturePath),
    modelKey: model.key,
    modelId: model.workersAiId,
    promptTokens: 0,
    completionTokens: 0,
    neurons: 0,
    usd: 0,
    verdict: null,
    riskScore: 0,
    findingsCount: 0,
    findings: [],
    hallucinationFlags: [],
    rawResponsePreview: "",
    rawResponseFull: "",
  };

  const start = performance.now();

  try {
    let envelope: SyncEnvelope | BatchPollEnvelope;
    let polls = 0;

    if (model.batchCapable) {
      // Submit
      const submitRes = await submitBatch(model.workersAiId, prompt);
      if (!submitRes.success || !submitRes.result?.request_id) {
        return {
          ...base,
          latencyMs: performance.now() - start,
          ok: false,
          error: `batch submit failed: ${JSON.stringify(submitRes.errors ?? submitRes)}`,
        };
      }
      const requestId = submitRes.result.request_id;

      // Poll
      const pollMaxMs = 10 * 60 * 1000; // 10 min
      const pollIntervalMs = 5000;
      let poll: BatchPollEnvelope | null = null;
      while (performance.now() - start < pollMaxMs) {
        polls++;
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        poll = await pollBatch(model.workersAiId, requestId);
        const status = poll.result?.status;
        if (status === "queued" || status === "running") continue;
        break;
      }
      if (!poll) {
        return {
          ...base,
          latencyMs: performance.now() - start,
          ok: false,
          error: `batch poll timeout after ${polls} polls`,
          batchPolls: polls,
        };
      }
      envelope = poll;
    } else {
      envelope = await callModelSync(model.workersAiId, prompt);
    }

    const latencyMs = performance.now() - start;

    // Check for API-level errors in the envelope
    if ("success" in envelope && envelope.success === false) {
      return {
        ...base,
        latencyMs,
        ok: false,
        error: `API error: ${JSON.stringify(envelope.errors ?? "unknown")}`,
        batchPolls: polls || undefined,
      };
    }

    const text = extractResponseText(envelope);
    const usage = extractUsage(envelope);
    const parsed = extractJsonFromResponse(text);

    let verdict: "pass" | "warn" | "fail" | null = null;
    let riskScore = 0;
    let findings: BenchmarkResult["findings"] = [];
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (["pass", "warn", "fail"].includes(obj.verdict as string)) {
        verdict = obj.verdict as "pass" | "warn" | "fail";
      }
      if (typeof obj.riskScore === "number") riskScore = obj.riskScore;
      if (Array.isArray(obj.findings)) {
        findings = obj.findings as BenchmarkResult["findings"];
      }
    }

    const hallucinationFlags = detectHallucinations(findings);
    const usd = costUsd(model.workersAiId, usage.prompt_tokens, usage.completion_tokens);

    return {
      ...base,
      latencyMs,
      ok: text.length > 0 && verdict !== null,
      error:
        text.length === 0
          ? "empty response"
          : verdict === null
            ? "could not parse JSON verdict from response"
            : undefined,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      neurons: usdToNeurons(usd),
      usd,
      verdict,
      riskScore,
      findingsCount: findings.length,
      findings,
      hallucinationFlags,
      rawResponsePreview: text.slice(0, 400),
      rawResponseFull: text,
      batchPolls: polls || undefined,
    };
  } catch (err) {
    return {
      ...base,
      latencyMs: performance.now() - start,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- CLI ---

function parseArgs(argv: string[]): { fixtures: string[]; onlyModels: string[] | null } {
  const fixtures: string[] = [];
  let onlyModels: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only" && argv[i + 1]) {
      onlyModels = argv[++i].split(",").map((s) => s.trim());
      continue;
    }
    if (a.startsWith("-")) continue;
    fixtures.push(a);
  }
  return { fixtures, onlyModels };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function printComparisonTable(results: BenchmarkResult[]): void {
  const header =
    pad("model", 32) +
    pad("ok", 4) +
    pad("latency", 10) +
    pad("in/out", 14) +
    pad("neurons", 10) +
    pad("usd/audit", 12) +
    pad("verdict", 8) +
    pad("findings", 10) +
    "hallucinations";
  console.log(header);
  console.log("─".repeat(140));

  for (const r of results) {
    console.log(
      pad(r.modelKey, 32) +
        pad(r.ok ? "✓" : "✗", 4) +
        pad(`${(r.latencyMs / 1000).toFixed(1)}s`, 10) +
        pad(`${r.promptTokens}/${r.completionTokens}`, 14) +
        pad(String(r.neurons), 10) +
        pad(`$${r.usd.toFixed(5)}`, 12) +
        pad(r.verdict ?? "—", 8) +
        pad(String(r.findingsCount), 10) +
        (r.hallucinationFlags.length > 0
          ? `⚠ ${r.hallucinationFlags.join(", ")}`
          : r.error
            ? `ERR: ${r.error.slice(0, 60)}`
            : "—"),
    );
  }
}

async function main(): Promise<void> {
  const { fixtures, onlyModels } = parseArgs(process.argv.slice(2));

  if (fixtures.length === 0) {
    console.error(
      "Usage: npm run bench -- <fixture1.tgz> [fixture2.tgz ...] [--only glm-4.7-flash,gemma-4-26b-a4b]",
    );
    process.exit(1);
  }

  const models = Object.values(AUDIT_MODELS).filter((m) => {
    if (m.disabled) return false;
    if (onlyModels && !onlyModels.includes(m.key)) return false;
    return true;
  });

  if (models.length === 0) {
    console.error("No enabled models to benchmark (did --only filter exclude all?)");
    process.exit(1);
  }

  console.log(
    `Benchmarking ${models.length} model(s) against ${fixtures.length} fixture(s)`,
  );
  console.log(`Models: ${models.map((m) => m.key).join(", ")}`);

  const allResults: BenchmarkResult[] = [];

  for (const fixturePath of fixtures) {
    const absPath = resolve(fixturePath);
    if (!existsSync(absPath)) {
      console.error(`Fixture not found: ${absPath}`);
      continue;
    }

    const tarballBytes = readFileSync(absPath);
    const codeFiles = await extractCodeFiles(
      tarballBytes.buffer.slice(
        tarballBytes.byteOffset,
        tarballBytes.byteOffset + tarballBytes.byteLength,
      ) as ArrayBuffer,
    );
    const prompt = buildPromptContent(codeFiles);

    console.log(`\n=== ${basename(absPath)} ===`);
    console.log(
      `Files extracted: ${codeFiles.size}, prompt length: ${prompt.length.toLocaleString()} chars (~${Math.round(prompt.length / 4).toLocaleString()} tokens)`,
    );

    const fixtureResults: BenchmarkResult[] = [];
    for (const model of models) {
      process.stdout.write(`  running ${model.key}... `);
      const result = await benchmarkModel(model, absPath, prompt);
      fixtureResults.push(result);
      allResults.push(result);
      process.stdout.write(
        result.ok
          ? `done (${(result.latencyMs / 1000).toFixed(1)}s, verdict=${result.verdict}, findings=${result.findingsCount}${result.hallucinationFlags.length > 0 ? ", HALLUCINATED" : ""})\n`
          : `FAILED (${result.error})\n`,
      );
    }

    console.log();
    printComparisonTable(fixtureResults);
  }

  // Write JSON dump
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = resolve("bench-results", `${timestamp}.json`);
  if (!existsSync("bench-results")) mkdirSync("bench-results");
  writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nResults written to ${outPath}`);

  // Rollup
  if (fixtures.length > 1) {
    console.log("\n=== ROLLUP (averaged across fixtures) ===");
    const byModel = new Map<string, BenchmarkResult[]>();
    for (const r of allResults) {
      if (!byModel.has(r.modelKey)) byModel.set(r.modelKey, []);
      byModel.get(r.modelKey)!.push(r);
    }
    const rollup: BenchmarkResult[] = [];
    for (const [key, rs] of byModel.entries()) {
      const okRs = rs.filter((r) => r.ok);
      if (okRs.length === 0) {
        rollup.push({ ...rs[0], ok: false, error: "all runs failed" });
        continue;
      }
      const avg = (fn: (r: BenchmarkResult) => number) =>
        okRs.reduce((sum, r) => sum + fn(r), 0) / okRs.length;
      rollup.push({
        ...okRs[0],
        fixture: `avg of ${okRs.length}/${rs.length}`,
        latencyMs: avg((r) => r.latencyMs),
        promptTokens: Math.round(avg((r) => r.promptTokens)),
        completionTokens: Math.round(avg((r) => r.completionTokens)),
        neurons: Math.round(avg((r) => r.neurons)),
        usd: avg((r) => r.usd),
        findingsCount: Math.round(avg((r) => r.findingsCount)),
        hallucinationFlags: [
          ...new Set(okRs.flatMap((r) => r.hallucinationFlags)),
        ],
      });
    }
    printComparisonTable(rollup);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
