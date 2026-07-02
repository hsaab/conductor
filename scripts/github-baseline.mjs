/**
 * Shared GitHub helpers for the demo-baseline tooling.
 *
 * Design intent: detect and repair the *specific FE-13 regression behavior* in a
 * *specific, exact set of files* — NOT "is this branch byte-identical to a frozen
 * tag." That distinction matters because the target app keeps evolving: unrelated
 * features (new files, edits elsewhere, even edits to these files that don't
 * reintroduce the slow path) must never be flagged as a regression or clobbered
 * by a restore.
 *
 * So:
 *  - `reset-demo.mjs` uses {@link detectRegression} (content fingerprint) to
 *    decide whether `main` still carries the regression.
 *  - `restore-baseline.mjs` uses the same detector as a precondition (no-op when
 *    clean) and then reverts ONLY the exact files in {@link REGRESSION_SURFACE_FILES}
 *    to the baseline tag — a whole-directory sweep is never used, so a future
 *    `src/lib/market-data/anything-new.ts` is left untouched.
 */

/**
 * The exact files FE-13 touches (and the hotfix reverts). Exact paths only — no
 * directory prefixes — so restore can never delete or revert files a later
 * feature adds under the same folders.
 */
export const REGRESSION_SURFACE_FILES = [
  "src/lib/market-data/alpha-vantage.ts",
  "src/lib/market-data/cached.ts",
  "src/lib/market-data/constants.ts",
  "src/lib/portfolio.ts",
  "src/app/api/market/quotes-check/route.ts",
  "src/lib/market-data/__tests__/alpha-vantage.test.ts",
  "src/lib/market-data/__tests__/cached.test.ts",
  "src/lib/__tests__/portfolio.test.ts",
];

/** Files that exist ONLY in the regressed state (their mere presence is a fingerprint; deleted on restore). */
export const REGRESSION_ADDED_FILES = ["src/lib/market-data/constants.ts"];

/**
 * Content markers that appear ONLY in the regressed state (verified against the
 * baseline tag vs the FE-13 commit). Their presence in a surface file is the
 * behavioral fingerprint of the slow per-symbol quote path. Deliberately narrow:
 * `GLOBAL_QUOTE` / `REALTIME_BULK_QUOTES` exist in the baseline too, so they are
 * NOT used.
 */
export const REGRESSION_MARKERS = [
  { token: "QUOTE_PACE_MS", note: "per-symbol pacing constant (sequential live quotes)" },
  { token: "getQuotesLiveSequential", note: "sequential per-symbol live-quote path" },
];

/** Build a bound GitHub REST client for one repo. Throws with a useful message on non-2xx. */
export function makeGithub({ token, owner, repo }) {
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
  return async function gh(path, { method = "GET", body } = {}) {
    const res = await fetch(path.startsWith("http") ? path : `${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "conductor-demo-baseline",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.message ? `${json.message}` : res.statusText;
      const err = new Error(`GitHub ${method} ${path} -> ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };
}

/** Recursive blob tree (path -> entry) for a commit-ish ref (branch, tag, or sha). */
export async function treeFor(gh, commitish) {
  const commit = await gh(`/commits/${commitish}`);
  const treeSha = commit.commit.tree.sha;
  const tree = await gh(`/git/trees/${treeSha}?recursive=1`);
  const byPath = new Map();
  for (const entry of tree.tree) {
    if (entry.type === "blob") byPath.set(entry.path, entry);
  }
  return { commitSha: commit.sha, treeSha, byPath };
}

/** Read a file's UTF-8 content at a ref, or `null` when it does not exist there. */
export async function readFileAtRef(gh, ref, path) {
  try {
    const res = await gh(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (res?.encoding === "base64" && typeof res.content === "string") {
      return Buffer.from(res.content, "base64").toString("utf8");
    }
    return null;
  } catch (err) {
    if (err.status === 404) return null; // absent at this ref
    throw err;
  }
}

/**
 * Fingerprint whether `ref` carries the FE-13 regression, by content — not by
 * comparison to a frozen snapshot. Returns `{ regressed, reasons }`, where
 * `reasons` explains exactly what tripped it. Reads only the surface files, so it
 * is cheap and immune to unrelated changes elsewhere in the repo.
 */
export async function detectRegression(gh, ref, opts = {}) {
  const surfaceFiles = opts.surfaceFiles ?? REGRESSION_SURFACE_FILES;
  const addedFiles = opts.addedFiles ?? REGRESSION_ADDED_FILES;
  const markers = opts.markers ?? REGRESSION_MARKERS;

  const entries = await Promise.all(
    surfaceFiles.map(async (path) => [path, await readFileAtRef(gh, ref, path)]),
  );

  const reasons = [];
  for (const [path, content] of entries) {
    if (content === null) continue;
    if (addedFiles.includes(path)) reasons.push(`${path} present (regression-only file)`);
    for (const marker of markers) {
      if (content.includes(marker.token)) reasons.push(`${path}: "${marker.token}" — ${marker.note}`);
    }
  }

  return { regressed: reasons.length > 0, reasons };
}

/** True when `path` is inside one of the restore entries (dir prefix ending in `/`, or exact file). */
export function inRestoreSurface(entries, path) {
  return entries.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

/**
 * Diff `baseline` vs `main` over the exact restore surface into GitHub tree-change
 * entries: baseline blobs overwrite differing paths; surface paths present on
 * `main` but absent from `baseline` (e.g. `constants.ts`) are deleted
 * (`sha: null`). Scoped to exact files, so nothing outside the surface is touched.
 * An empty result means `main` already matches the baseline for that surface.
 */
export function diffRestoreSurface(baseline, main, entries) {
  const changes = [];

  for (const [path, entry] of baseline.byPath) {
    if (!inRestoreSurface(entries, path)) continue;
    if (main.byPath.get(path)?.sha === entry.sha) continue; // already identical
    changes.push({ path, mode: entry.mode, type: "blob", sha: entry.sha });
  }

  for (const [path] of main.byPath) {
    if (!inRestoreSurface(entries, path)) continue;
    if (!baseline.byPath.has(path)) {
      changes.push({ path, mode: "100644", type: "blob", sha: null }); // delete regression-added file
    }
  }

  return changes;
}
