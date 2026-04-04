/**
 * Neuron budget tracking for Workers AI audit costs.
 *
 * Cloudflare free tier allows 10,000 neurons/day. We enforce an 8,000 cap
 * to leave headroom for race conditions between concurrent queue consumers.
 *
 * Neuron rates for @cf/google/gemma-4-26b-a4b-it (verified 2026-04-04):
 * - Input: 9,091 neurons per million tokens
 * - Output: 27,273 neurons per million tokens
 * Source: https://developers.cloudflare.com/workers-ai/platform/pricing/
 */

/** Daily neuron budget cap (soft limit against 10K platform limit) */
export const DAILY_NEURON_LIMIT = 8000;

/** Neurons per million input tokens for gemma-4-26b-a4b-it */
export const NEURONS_PER_M_INPUT = 9091;

/** Neurons per million output tokens for gemma-4-26b-a4b-it */
export const NEURONS_PER_M_OUTPUT = 27273;

/**
 * Convert token counts from Workers AI response to neuron cost.
 */
export function tokensToNeurons(
  promptTokens: number,
  completionTokens: number,
): number {
  const inputNeurons = (promptTokens / 1_000_000) * NEURONS_PER_M_INPUT;
  const outputNeurons = (completionTokens / 1_000_000) * NEURONS_PER_M_OUTPUT;
  return Math.ceil(inputNeurons + outputNeurons);
}

/**
 * Check whether the daily neuron budget allows another audit.
 * Returns the current usage and whether inference is allowed.
 */
export async function checkNeuronBudget(
  db: D1Database,
): Promise<{ allowed: boolean; used: number }> {
  const row = await db
    .prepare("SELECT neurons_used FROM audit_budget WHERE date = date('now')")
    .first<{ neurons_used: number }>();

  const used = row?.neurons_used ?? 0;
  return { allowed: used < DAILY_NEURON_LIMIT, used };
}

/**
 * Record neuron usage after a successful AI inference call.
 * Uses UPSERT to atomically create or increment the daily counter.
 */
export async function recordNeuronUsage(
  db: D1Database,
  neurons: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_budget (date, neurons_used)
       VALUES (date('now'), ?)
       ON CONFLICT(date) DO UPDATE SET neurons_used = neurons_used + excluded.neurons_used`,
    )
    .bind(neurons)
    .run();
}
