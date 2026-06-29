/**
 * Short-lived TTL cache for the read-only board snapshot.
 *
 * The dashboard polls `GET /api/board` every couple of seconds, and each read
 * hits Linear. Caching the snapshot for a few seconds collapses many concurrent
 * polls (and many open tabs) into at most one Linear request per `ttlMs`, which
 * keeps conductor under Linear's hourly rate limit. The data is read-only and
 * briefly stale by design; the reconcile path stays uncached because it makes
 * write decisions and must always see fresh Linear state.
 *
 * State is per serverless instance (best-effort): a cold start just repopulates
 * from Linear on the next read, so the cache is never a source of truth.
 */
import type { JobsReport } from "./types.js";

type BoardFetcher = (options: { includeComplete: boolean }) => Promise<JobsReport>;

export interface BoardCache {
  /** Returns a cached report when fresh, otherwise fetches (deduping concurrent misses). */
  get(includeComplete: boolean): Promise<JobsReport>;
}

/**
 * Builds a board cache around `fetch`, keyed by `includeComplete` (the two board
 * views are cached separately). `now` is injectable for deterministic tests.
 */
export function createBoardCache(
  fetch: BoardFetcher,
  ttlMs: number,
  now: () => number = Date.now,
): BoardCache {
  const slots = new Map<boolean, { report: JobsReport; expiresAt: number }>();
  const inFlight = new Map<boolean, Promise<JobsReport>>();

  async function load(includeComplete: boolean): Promise<JobsReport> {
    const report = await fetch({ includeComplete });
    slots.set(includeComplete, { report, expiresAt: now() + ttlMs });
    return report;
  }

  return {
    get(includeComplete) {
      const slot = slots.get(includeComplete);
      if (slot && now() < slot.expiresAt) return Promise.resolve(slot.report);
      // Dedupe concurrent misses so a burst of polls triggers a single fetch.
      // On failure the in-flight promise rejects for all waiters and is cleared,
      // so no error is cached and the next call retries fresh.
      let pending = inFlight.get(includeComplete);
      if (!pending) {
        pending = load(includeComplete).finally(() => inFlight.delete(includeComplete));
        inFlight.set(includeComplete, pending);
      }
      return pending;
    },
  };
}
