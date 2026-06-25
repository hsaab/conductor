/**
 * Runtime health of the planner's critical dependency.
 *
 * @cursor/sdk loads its native sqlite3 binding at import time. If that binding is
 * missing on the deployed function, the planner and fleet silently fall back
 * ("unavailable"). This module turns that invisible degradation into an
 * observable signal: `/api/health` reports it for monitors, and the dashboard
 * raises a banner so a broken deploy is obvious instead of only showing up as
 * fallback plans hours into a demo.
 *
 * The probe is the import itself, memoized per process: a serverless instance's
 * binding state does not change after boot, so we check once. A new deploy means
 * new instances, which re-probe fresh.
 */
export type SdkHealth = {
  status: "ok" | "unavailable";
  /** Condensed error message when unavailable (e.g. "Could not locate the bindings file"). */
  error?: string;
};

let cached: SdkHealth | null = null;

/** Probe whether @cursor/sdk can be imported (i.e. the planner can run). Memoized. */
export async function sdkHealth(): Promise<SdkHealth> {
  if (cached) return cached;
  try {
    await import("@cursor/sdk");
    cached = { status: "ok" };
  } catch (err) {
    const raw = err instanceof Error ? err.message || err.name : String(err);
    cached = { status: "unavailable", error: raw.replace(/\s+/g, " ").trim().slice(0, 300) };
  }
  return cached;
}

/** Test-only: reset the memoized probe result. */
export function resetSdkHealthCache(): void {
  cached = null;
}
