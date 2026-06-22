/**
 * Minimal Datadog client for conductor's own deploy-health checks. This is the
 * read path conductor uses to confirm a deploy is healthy before announcing it.
 * The richer per-span context for remediation comes from the Datadog MCP that
 * the spawned remediation agent uses.
 *
 * Entirely optional: if no Datadog keys are configured, {@link checkServiceHealth}
 * returns an "unknown" result and conductor assumes healthy, so the loop never
 * blocks on Datadog being wired up.
 */
import { datadogApiKey, datadogAppKey, datadogSite } from "./config.js";

export interface ServiceHealth {
  /** Number of error logs in the window, or null when Datadog is not configured/queryable. */
  errors: number | null;
  /** True when we have no error signal (no keys or query failed) and assume healthy. */
  unknown: boolean;
}

/**
 * Count recent error logs for a service via the Datadog Logs Events Search API.
 * Best-effort: any failure resolves to `{ errors: null, unknown: true }`.
 */
export async function checkServiceHealth(service: string, minutes = 10): Promise<ServiceHealth> {
  const apiKey = datadogApiKey();
  const appKey = datadogAppKey();
  if (!apiKey || !appKey) return { errors: null, unknown: true };

  const from = `now-${minutes}m`;
  try {
    const res = await fetch(`https://api.${datadogSite()}/api/v2/logs/events/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": apiKey,
        "DD-APPLICATION-KEY": appKey,
      },
      body: JSON.stringify({
        filter: { query: `service:${service} status:error`, from, to: "now" },
        page: { limit: 100 },
      }),
    });
    if (!res.ok) {
      console.error(`[datadog] logs search returned ${res.status}`);
      return { errors: null, unknown: true };
    }
    const json = (await res.json()) as { data?: unknown[] };
    return { errors: Array.isArray(json.data) ? json.data.length : 0, unknown: false };
  } catch (err) {
    console.error("[datadog] health query failed:", err);
    return { errors: null, unknown: true };
  }
}

/** Builds a link to the compound service page in Datadog APM for the Slack message. */
export function datadogServiceUrl(service: string): string {
  return `https://app.${datadogSite()}/apm/services/${encodeURIComponent(service)}`;
}
