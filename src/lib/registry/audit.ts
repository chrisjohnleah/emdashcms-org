/**
 * Security audits for plugins in the official EmDash registry.
 *
 * Same analysis as our own submissions (static scan + Workers AI review
 * with the same prompt and model), but the result only annotates the
 * /registry mirror page — nothing is published or rejected, and nothing
 * touches plugins / plugin_versions / plugin_audits.
 *
 * Budget: registry audits draw from the shared daily Workers AI budget
 * (audit_budget) AND have their own cap, so a burst of registry releases
 * can never starve audits of plugins submitted here.
 *
 * Fail-closed: any error writes status='error', which the page shows as
 * "audit could not complete" — never as a pass.
 */
import type { MarketplaceAuditFinding } from "../../types/marketplace";
import { checkNeuronBudget, recordNeuronUsage, tokensToNeurons } from "../audit/budget";
import {
  SYSTEM_PROMPT,
  buildPromptContent,
  extractCodeFiles,
  extractJsonFromResponse,
  resolveAuditModel,
} from "../audit/prompt";
import { runStaticScan, type StaticFinding } from "../audit/static-scanner";
import {
  TransientError,
  extractAiResponseText,
  staticFindingToMarketplace,
  validateAuditResponse,
  type AiResponseEnvelope,
} from "../audit/consumer";
import { getLatestRegistryRelease, listRegistryPackages } from "./client";

/** Share of the 8,000/day shared cap that registry audits may use. */
export const REGISTRY_DAILY_NEURON_LIMIT = 2000;
/** Registry bundles larger than this are not downloaded. */
export const MAX_REGISTRY_BUNDLE_BYTES = 5 * 1024 * 1024;
/** New jobs enqueued per cron tick — keeps the hourly producer tiny. */
const ENQUEUE_PER_RUN = 3;

export interface RegistryAuditJob {
  kind: "registry";
  did: string;
  slug: string;
  version: string;
}

export function isRegistryAuditJob(body: unknown): body is RegistryAuditJob {
  return !!body && typeof body === "object" && (body as { kind?: unknown }).kind === "registry";
}

export interface RegistryAudit {
  version: string;
  status: "complete" | "error";
  verdict: "pass" | "warn" | "fail" | null;
  riskScore: number | null;
  findings: MarketplaceAuditFinding[];
  model: string | null;
  error: string | null;
  createdAt: string;
}

// --- Queries ---

type Row = {
  did: string;
  slug: string;
  version: string;
  status: "complete" | "error";
  verdict: "pass" | "warn" | "fail" | null;
  risk_score: number | null;
  findings: string;
  model: string | null;
  error: string | null;
  created_at: string;
};

const mapRow = (r: Row): RegistryAudit => {
  let findings: MarketplaceAuditFinding[] = [];
  try {
    const parsed = JSON.parse(r.findings);
    if (Array.isArray(parsed)) findings = parsed;
  } catch {
    // Corrupt findings never hide the verdict; show it without detail.
  }
  return {
    version: r.version,
    status: r.status,
    verdict: r.verdict,
    riskScore: r.risk_score,
    findings,
    model: r.model,
    error: r.error,
    createdAt: r.created_at,
  };
};

export async function getRegistryAudit(
  db: D1Database,
  did: string,
  slug: string,
  version: string,
): Promise<RegistryAudit | null> {
  const row = await db
    .prepare("SELECT * FROM registry_audits WHERE did = ? AND slug = ? AND version = ?")
    .bind(did, slug, version)
    .first<Row>();
  return row ? mapRow(row) : null;
}

/** Audits keyed by `did/slug/version`, for listing pages. */
export async function getRegistryAuditMap(db: D1Database): Promise<Map<string, RegistryAudit>> {
  const { results } = await db.prepare("SELECT * FROM registry_audits").all<Row>();
  return new Map((results ?? []).map((r) => [`${r.did}/${r.slug}/${r.version}`, mapRow(r)]));
}

async function registrySpentToday(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(neurons_used), 0) AS used FROM registry_audits WHERE created_at >= date('now')",
    )
    .first<{ used: number }>();
  return row?.used ?? 0;
}

async function writeAudit(
  db: D1Database,
  job: RegistryAuditJob,
  a: {
    status: "complete" | "error";
    verdict?: "pass" | "warn" | "fail" | null;
    riskScore?: number | null;
    findings?: MarketplaceAuditFinding[];
    model?: string | null;
    neuronsUsed?: number;
    error?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO registry_audits
         (did, slug, version, status, verdict, risk_score, findings, model, neurons_used, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      job.did,
      job.slug,
      job.version,
      a.status,
      a.verdict ?? null,
      a.riskScore ?? null,
      JSON.stringify(a.findings ?? []),
      a.model ?? null,
      a.neuronsUsed ?? 0,
      a.error ?? null,
    )
    .run();
}

// --- Producer (hourly cron — must stay within the 10ms cron CPU budget) ---

/**
 * Enqueue audits for registry releases that have no audit row yet. At most
 * ENQUEUE_PER_RUN per tick; the next tick picks up the rest. Skips entirely
 * when the registry cap is spent, so jobs don't pile up and retry.
 */
export async function enqueueRegistryAudits(
  env: { DB: D1Database; AUDIT_QUEUE: Queue },
  fetcher: typeof fetch = fetch,
): Promise<number> {
  if ((await registrySpentToday(env.DB)) >= REGISTRY_DAILY_NEURON_LIMIT) return 0;

  const packages = await listRegistryPackages(fetcher);
  const audited = await getRegistryAuditMap(env.DB);
  const todo = packages
    .filter((p) => p.latestVersion && !audited.has(`${p.did}/${p.slug}/${p.latestVersion}`))
    .slice(0, ENQUEUE_PER_RUN);

  for (const p of todo) {
    await env.AUDIT_QUEUE.send({
      kind: "registry",
      did: p.did,
      slug: p.slug,
      version: p.latestVersion!,
    } satisfies RegistryAuditJob);
  }
  if (todo.length) console.log(`[registry-audit] enqueued ${todo.length}`);
  return todo.length;
}

// --- Consumer ---

export interface RegistryAuditBindings {
  db: D1Database;
  ai: Ai;
  fetcher?: typeof fetch;
}

/**
 * Audit one registry release. Returns without writing when the budget is
 * spent (the next cron tick re-enqueues it). Throws TransientError for
 * retryable failures; every other failure writes an 'error' row.
 */
export async function processRegistryAuditJob(
  job: RegistryAuditJob,
  bindings: RegistryAuditBindings,
): Promise<"complete" | "error" | "skipped"> {
  const { db } = bindings;
  const fetcher = bindings.fetcher ?? fetch;

  const existing = await getRegistryAudit(db, job.did, job.slug, job.version);
  if (existing?.status === "complete") return "skipped";

  const [global, spent] = await Promise.all([checkNeuronBudget(db), registrySpentToday(db)]);
  if (!global.allowed || spent >= REGISTRY_DAILY_NEURON_LIMIT) {
    console.log(`[registry-audit] budget spent (global=${global.used} registry=${spent}) — deferring ${job.slug}@${job.version}`);
    return "skipped";
  }

  const fail = async (error: string) => {
    console.error(`[registry-audit] ${job.slug}@${job.version}: ${error}`);
    await writeAudit(db, job, { status: "error", error });
    return "error" as const;
  };

  // 1. Locate the bundle. Only audit the release the job names — if the
  //    registry has moved on, the next cron tick enqueues the new version.
  const release = await getLatestRegistryRelease(job, fetcher);
  if (!release) throw new TransientError("registry release lookup failed");
  if (release.version !== job.version) return "skipped";
  if (!release.bundleUrl) return fail("Release has no downloadable bundle");
  if (release.bundleSize !== null && release.bundleSize > MAX_REGISTRY_BUNDLE_BYTES) {
    return fail(`Bundle is ${release.bundleSize} bytes, over the ${MAX_REGISTRY_BUNDLE_BYTES}-byte audit limit`);
  }

  // 2. Download.
  let bytes: ArrayBuffer;
  try {
    const res = await fetcher(release.bundleUrl);
    if (res.status >= 500) throw new TransientError(`bundle download ${res.status}`);
    if (!res.ok) return fail(`Bundle download failed: HTTP ${res.status}`);
    bytes = await res.arrayBuffer();
  } catch (err) {
    if (err instanceof TransientError) throw err;
    throw new TransientError(`bundle download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (bytes.byteLength > MAX_REGISTRY_BUNDLE_BYTES) return fail("Bundle exceeds the audit size limit");

  // 3. Extract.
  let codeFiles: Map<string, string>;
  try {
    codeFiles = await extractCodeFiles(bytes);
  } catch (err) {
    return fail(`Could not unpack bundle: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (codeFiles.size === 0) return fail("No code files found in bundle");

  // 4. Static scan. The scanner only reads capabilities + allowedHosts, so
  //    a loosely parsed registry manifest is enough (registry capability
  //    names can be newer than our strict manifest schema).
  let staticFindings: StaticFinding[] = [];
  try {
    const m = JSON.parse(codeFiles.get("manifest.json") ?? "{}") as Record<string, unknown>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    staticFindings = runStaticScan(codeFiles, {
      capabilities: strings(m.capabilities),
      allowedHosts: strings(m.allowedHosts),
    } as unknown as Parameters<typeof runStaticScan>[1]).findings;
  } catch (err) {
    console.warn(`[registry-audit] static scan skipped for ${job.slug}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. AI review — same prompt and default model as our own submissions.
  const model = resolveAuditModel(undefined).workersAiId;
  let raw: AiResponseEnvelope;
  try {
    raw = (await bindings.ai.run(model as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPromptContent(codeFiles) },
      ],
      max_tokens: 4096,
      max_completion_tokens: 4096,
      temperature: 0.1,
    })) as unknown as AiResponseEnvelope;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/429|503|timeout|3050|max retries|5004|5007|capacity|overloaded/i.test(msg)) {
      throw new TransientError(`AI inference failed: ${msg}`);
    }
    return fail(`AI inference error: ${msg}`);
  }

  const neuronsUsed = tokensToNeurons(raw.usage?.prompt_tokens ?? 0, raw.usage?.completion_tokens ?? 0);
  await recordNeuronUsage(db, neuronsUsed);

  const text = extractAiResponseText(raw);
  if (!text.trim()) throw new TransientError("AI returned empty response");
  const parsed = extractJsonFromResponse(text);
  if (!validateAuditResponse(parsed)) {
    await writeAudit(db, job, { status: "error", model, neuronsUsed, error: "AI response did not match the audit schema" });
    return "error";
  }

  await writeAudit(db, job, {
    status: "complete",
    verdict: parsed.verdict,
    riskScore: parsed.riskScore,
    findings: [...staticFindings.map(staticFindingToMarketplace), ...(parsed.findings as MarketplaceAuditFinding[])],
    model,
    neuronsUsed,
  });
  console.log(`[registry-audit] ${job.slug}@${job.version} verdict=${parsed.verdict} neurons=${neuronsUsed}`);
  return "complete";
}
