/**
 * Pure render functions for the /status page uptime strip.
 *
 * Plan 2's Astro page consumes these via `set:html={...}` (or a
 * per-row Astro wrapper) and Plan 2's anonymization test imports
 * them directly. Locking the render path here means both call the
 * same code and the test gives a real guarantee.
 *
 * Histogram geometry:
 *   84 bars × 2-hour buckets = 168h = 7 days (CONTEXT D-29).
 *   Bar width 8px + 2px gutter = 10px per bar; 84 × 10 − 2 = 838px.
 */

import type { Surface } from "./probe";
import type { HistogramBucket, StatusSampleRow } from "./status-queries";
import {
  buildHistogramBuckets,
  classifyCurrent,
  computeUptimePercent,
} from "./status-queries";

export interface SurfaceView {
  name: Surface["name"];
  label: string; // e.g. "Plugins list"
  subLabel: string; // e.g. "GET /plugins"
  uptimePercent: number | null;
  classification: "ok" | "degraded" | "outage" | "unknown";
  buckets: HistogramBucket[];
  sampleCount: number;
}

/**
 * Build the rendered shape for a single surface from raw samples.
 * Defaults to 2-hour buckets → 84 × 2h = 168h = 7 days.
 */
export function buildSurfaceView(
  name: Surface["name"],
  label: string,
  subLabel: string,
  samples: StatusSampleRow[],
  now: Date = new Date(),
): SurfaceView {
  return {
    name,
    label,
    subLabel,
    uptimePercent: computeUptimePercent(samples),
    classification: classifyCurrent(samples),
    buckets: buildHistogramBuckets(samples, now, 2),
    sampleCount: samples.length,
  };
}

const BAR_WIDTH = 8;
const BAR_GAP = 2;
const BAR_HEIGHT = 32;
const TOTAL_WIDTH = (BAR_WIDTH + BAR_GAP) * 84 - BAR_GAP;

function fillClassForStatus(worst: HistogramBucket["worstStatus"]): string {
  switch (worst) {
    case "ok":
      return "fill-success";
    case "slow":
      return "fill-warn";
    case "fail":
    case "timeout":
      return "fill-danger";
    case "missing":
    default:
      return "fill-paper-deep";
  }
}

function formatBucketTooltip(bucket: HistogramBucket): string {
  // "2h ending YYYY-MM-DD HH:MM UTC" — Plan 2's status page tooltip format.
  const end = new Date(bucket.bucketEnd);
  const yyyy = end.getUTCFullYear();
  const mm = String(end.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(end.getUTCDate()).padStart(2, "0");
  const hh = String(end.getUTCHours()).padStart(2, "0");
  const mi = String(end.getUTCMinutes()).padStart(2, "0");
  return `2h ending ${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

function formatUptime(p: number | null): string {
  if (p === null) return "— uptime";
  return `${p.toFixed(2)}% uptime`;
}

function statusForBadge(c: SurfaceView["classification"]): string {
  return c === "unknown" ? "pending" : c;
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]!);
}

/**
 * Render the per-surface uptime strip for the /status page.
 *
 * Returns an HTML fragment string consumed by `set:html={...}` in
 * `src/pages/status.astro`. Plan 2's anonymization test calls this
 * directly with seeded data — no entity tokens are passed in, so the
 * output never contains them.
 *
 * Each surface row contains exactly 84 <rect> elements, one per
 * 2-hour bucket. The badge slot uses a `data-status-badge` attribute
 * so Plan 2's Astro page can inject the actual <StatusBadge /> Astro
 * component alongside (or replace the placeholder span) — both
 * approaches result in the same DOM and the same anonymization
 * guarantee.
 */
export function renderStatusStrip(views: SurfaceView[]): string {
  return views
    .map((view) => {
      const ariaLabel = `7-day uptime histogram for ${view.label}. Current status: ${view.classification}. Uptime ${view.uptimePercent === null ? "unknown" : view.uptimePercent.toFixed(2) + " percent"}.`;
      const bars = view.buckets
        .map((bucket, i) => {
          const x = i * (BAR_WIDTH + BAR_GAP);
          const fillClass = fillClassForStatus(bucket.worstStatus);
          const tooltip = escapeHtml(formatBucketTooltip(bucket));
          return `<rect x="${x}" y="0" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" class="${fillClass}"><title>${tooltip}</title></rect>`;
        })
        .join("");
      return `
        <div class="p-6 border border-rule rounded-lg bg-paper-soft">
          <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-4">
            <div>
              <h3 class="font-display text-lg text-ink">${escapeHtml(view.label)}</h3>
              <p class="text-sm text-ink-soft mt-1">${escapeHtml(view.subLabel)}</p>
            </div>
            <div class="flex items-center gap-4">
              <span class="font-mono text-base text-ink tabular-nums">${formatUptime(view.uptimePercent)}</span>
              <span data-status-badge="${statusForBadge(view.classification)}"></span>
            </div>
          </div>
          <svg viewBox="0 0 ${TOTAL_WIDTH} ${BAR_HEIGHT}" class="w-full h-8" role="img" tabindex="0" aria-label="${escapeHtml(ariaLabel)}" preserveAspectRatio="none">
            <title>${escapeHtml(view.label)} uptime — last 7 days, 2-hour buckets</title>
            ${bars}
          </svg>
        </div>
      `;
    })
    .join("");
}
