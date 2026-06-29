/**
 * Minimal Datadog client for conductor's own post-deploy error scan. This is the
 * read path conductor uses to surface errors that are already in production at
 * deploy time. It never asserts health; the all-clear verdict is produced later,
 * at observe-window close. The richer per-span context for remediation comes from
 * the Datadog MCP that the spawned remediation agent uses.
 *
 * Entirely optional: if no Datadog keys are configured, {@link checkServiceHealth}
 * returns an "unknown" result and conductor simply has nothing to warn about, so
 * the loop never blocks on Datadog being wired up.
 */
import { datadogApiKey, datadogAppKey, datadogSite } from "../config.js";

export interface ServiceHealth {
  /** Number of error logs in the window, or null when Datadog is not configured/queryable. */
  errors: number | null;
  /** True when we have no error signal (no keys or query failed), so there is nothing to warn about. */
  unknown: boolean;
}

/**
 * Datadog auth headers, preferring a Personal/Service Access Token (ddpat_/ddsat_)
 * which authenticates via `Authorization: Bearer` and needs no API key pairing.
 * Falls back to classic DD-API-KEY + DD-APPLICATION-KEY. Returns null when no
 * usable credential is configured.
 */
function datadogAuthHeaders(): Record<string, string> | null {
  const apiKey = datadogApiKey();
  const appKey = datadogAppKey();
  const token = [apiKey, appKey].find((k) => /^dd(pat|sat)_/.test(k));
  if (token) return { Authorization: `Bearer ${token}` };
  if (apiKey && appKey) return { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": appKey };
  return null;
}

/**
 * Count recent error logs for a service via the Datadog Logs Events Search API.
 * Best-effort: any failure resolves to `{ errors: null, unknown: true }`.
 */
export async function checkServiceHealth(service: string, minutes = 10): Promise<ServiceHealth> {
  const auth = datadogAuthHeaders();
  if (!auth) return { errors: null, unknown: true };

  const from = `now-${minutes}m`;
  try {
    const res = await fetch(`https://api.${datadogSite()}/api/v2/logs/events/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...auth,
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
