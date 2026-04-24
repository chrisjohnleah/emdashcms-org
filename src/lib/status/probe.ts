/**
 * Status probe library — single-surface fetch with classification.
 *
 * Per 15-CONTEXT D-22 each probe is a `fetch()` call with a 5s
 * AbortController timeout; the response is classified into one of
 * four states: ok | slow | fail | timeout. The `slow` threshold is
 * locked at 2000ms (15-CONTEXT discretion + UI-SPEC).
 *
 * Fetch is INJECTED so tests can pass a mock without vi.stubGlobal.
 * The cron handler injects the global fetch at call time.
 */

export interface Surface {
  name:
    | "landing"
    | "plugins_list"
    | "plugin_detail"
    | "bundle"
    | "publishing_api";
  /** Human-readable label, used in logs and on the rendered status page. */
  label: string;
  /** Path template — `{canaryId}` and `{canaryVersion}` are substituted. */
  pathTemplate: string;
  method: "GET" | "HEAD";
  acceptableStatusFloor: number;
  /** Inclusive upper bound. Bundle uses 399 to permit 302 redirects to R2. */
  acceptableStatusCeiling: number;
  /** plugin_detail and bundle require the canary plugin id. */
  requiresCanary: boolean;
}

export interface ProbeSample {
  surface: Surface["name"];
  sampledAt: string; // ISO timestamp
  status: "ok" | "slow" | "fail" | "timeout";
  httpStatus: number | null;
  latencyMs: number | null;
}

export const ALL_SURFACES: readonly Surface[] = [
  {
    name: "landing",
    label: "Landing page",
    pathTemplate: "/",
    method: "GET",
    acceptableStatusFloor: 200,
    acceptableStatusCeiling: 299,
    requiresCanary: false,
  },
  {
    name: "plugins_list",
    label: "Plugins list",
    pathTemplate: "/plugins",
    method: "GET",
    acceptableStatusFloor: 200,
    acceptableStatusCeiling: 299,
    requiresCanary: false,
  },
  {
    name: "plugin_detail",
    label: "Plugin detail",
    pathTemplate: "/plugins/{canaryId}",
    method: "GET",
    acceptableStatusFloor: 200,
    acceptableStatusCeiling: 299,
    requiresCanary: true,
  },
  {
    name: "bundle",
    label: "Bundle download",
    pathTemplate: "/api/v1/plugins/{canaryId}/versions/{canaryVersion}/bundle",
    method: "HEAD",
    acceptableStatusFloor: 200,
    acceptableStatusCeiling: 399, // D-22 — redirect to R2 signed URL is acceptable
    requiresCanary: true,
  },
  {
    name: "publishing_api",
    label: "Publishing API",
    pathTemplate: "/api/v1/plugins?limit=1",
    method: "GET",
    acceptableStatusFloor: 200,
    acceptableStatusCeiling: 299,
    requiresCanary: false,
  },
];

const SLOW_THRESHOLD_MS = 2000;
const TIMEOUT_MS = 5000;

/**
 * Probe a single surface. NEVER throws — always resolves to a
 * ProbeSample. Tests inject a mock fetch via the first parameter so
 * we don't need vi.stubGlobal.
 */
export async function probeSurface(
  fetchFn: typeof fetch,
  surface: Surface,
  absoluteUrl: string,
): Promise<ProbeSample> {
  const sampledAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetchFn(absoluteUrl, {
      method: surface.method,
      signal: controller.signal,
      redirect: "manual",
    });
    const latencyMs = Date.now() - started;
    const httpStatus = response.status;
    const inRange =
      httpStatus >= surface.acceptableStatusFloor &&
      httpStatus <= surface.acceptableStatusCeiling;

    if (!inRange) {
      return {
        surface: surface.name,
        sampledAt,
        status: "fail",
        httpStatus,
        latencyMs,
      };
    }
    if (latencyMs > SLOW_THRESHOLD_MS) {
      return {
        surface: surface.name,
        sampledAt,
        status: "slow",
        httpStatus,
        latencyMs,
      };
    }
    return {
      surface: surface.name,
      sampledAt,
      status: "ok",
      httpStatus,
      latencyMs,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        surface: surface.name,
        sampledAt,
        status: "timeout",
        httpStatus: null,
        latencyMs: null,
      };
    }
    return {
      surface: surface.name,
      sampledAt,
      status: "fail",
      httpStatus: null,
      latencyMs: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
