/**
 * Shared GitHub helpers for the demo-baseline tooling.
 *
 * Detect and repair the FE-13 TTL / paced-quotes regression behavior in a
 * specific surface — NOT "is this branch byte-identical to a frozen tag."
 *
 * The TTL regression is value-shaped (`QUOTE_TTL_OPEN = 0` keeps quoteCache
 * tokens), so baseline-behavior loss markers alone are weak. Detection uses
 * directory-scoped positive markers under market-data/ and the quotes route;
 * restore stays exact-file scoped so unrelated files are never clobbered.
 */

/** Exact files FE-13 / hotfix touch. Restore uses this list only — never a directory sweep. */
export const REGRESSION_SURFACE_FILES = [
  "src/lib/market-data/alpha-vantage.ts",
  "src/lib/market-data/cached.ts",
  "src/lib/market-data/constants.ts",
  "src/lib/portfolio.ts",
  "src/app/api/market/quotes/route.ts",
  "src/lib/market-data/__tests__/alpha-vantage.test.ts",
  "src/lib/market-data/__tests__/cached.test.ts",
  "src/lib/__tests__/portfolio.test.ts",
];

/** Files that exist ONLY in some regressed variants (deleted on restore). */
export const REGRESSION_ADDED_FILES = ["src/lib/market-data/constants.ts"];

/** Directories scanned for positive (pacing / TTL-bypass) markers during detection. */
export const DETECTION_DIRS = [
  "src/lib/market-data/",
  "src/app/api/market/quotes/",
];

/**
 * Positive markers: content that appears in a regressed state.
 * Detection may hit any file under DETECTION_DIRS (or a scoped `path`).
 */
export const REGRESSION_MARKERS = [
  {
    pattern: /QUOTE_PACE_MS|(?<![A-Za-z0-9_])PACE_MS/,
    note: "per-symbol pacing constant (sequential live quotes)",
  },
  {
    pattern: /getQuotesLiveSequential/,
    note: "sequential per-symbol live-quote path",
  },
  {
    // Baseline fan-out never sleeps; pacing sleep under market-data is the slow path.
    pattern: /setTimeout\s*\(|await\s+sleep\s*\(|\.sleep\s*\(/,
    note: "pacing sleep in market-data / quotes path",
  },
  {
    path: "src/lib/market-data/cached.ts",
    pattern:
      /QUOTE_TTL_OPEN\s*=\s*0\b|quoteCache\s*=\s*new\s+Map[\s\S]{0,80}expiresAt:\s*0|ttl\s*=\s*0\b/,
    note: "quote TTL disabled / cache bypass (TTL=0)",
  },
];

/**
 * Baseline behaviors the regression typically strips. Alone, need
 * BASELINE_LOSS_THRESHOLD hits. With the TTL shape these are best-effort;
 * live latency is the primary gate.
 */
export const BASELINE_BEHAVIOR_MARKERS = [
  {
    path: "src/lib/market-data/alpha-vantage.ts",
    anyOf: ["concurrency"],
    note: "bounded-concurrency quote fan-out removed (per-symbol sequential path)",
  },
];

/** Minimum count of lost baseline behaviors that, alone, flags a regression. */
export const BASELINE_LOSS_THRESHOLD = 1;

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
    if (err.status === 404) return null;
    throw err;
  }
}

function inDetectionDir(path, dirs = DETECTION_DIRS) {
  return dirs.some((d) => path.startsWith(d) || path === d.replace(/\/$/, ""));
}

/**
 * Fingerprint whether `ref` carries the FE-13 TTL / paced-quotes regression.
 * Scans DETECTION_DIRS for positive markers; restore surface stays exact-file.
 */
export async function detectRegression(gh, ref, opts = {}) {
  const surfaceFiles = opts.surfaceFiles ?? REGRESSION_SURFACE_FILES;
  const addedFiles = opts.addedFiles ?? REGRESSION_ADDED_FILES;
  const markers = opts.markers ?? REGRESSION_MARKERS;
  const baselineMarkers = opts.baselineMarkers ?? BASELINE_BEHAVIOR_MARKERS;
  const lossThreshold = opts.lossThreshold ?? BASELINE_LOSS_THRESHOLD;
  const detectionDirs = opts.detectionDirs ?? DETECTION_DIRS;

  const tree = await treeFor(gh, ref);
  const scanPaths = new Set(surfaceFiles);
  for (const path of tree.byPath.keys()) {
    if (inDetectionDir(path, detectionDirs)) scanPaths.add(path);
  }

  const entries = await Promise.all(
    [...scanPaths].map(async (path) => [path, await readFileAtRef(gh, ref, path)]),
  );
  const contentByPath = new Map(entries);

  const positive = [];
  for (const [path, content] of entries) {
    if (content === null) continue;
    if (addedFiles.includes(path)) positive.push(`${path} present (regression-only file)`);
    for (const marker of markers) {
      if (marker.path && marker.path !== path) continue;
      if (!marker.path && !inDetectionDir(path, detectionDirs) && !surfaceFiles.includes(path)) {
        continue;
      }
      if (marker.pattern.test(content)) {
        positive.push(`${path}: /${marker.pattern.source}/ — ${marker.note}`);
      }
    }
  }

  const losses = [];
  for (const marker of baselineMarkers) {
    const content = contentByPath.get(marker.path);
    if (content == null) continue;
    if (!marker.anyOf.some((token) => content.includes(token))) {
      losses.push(`${marker.path}: ${marker.note}`);
    }
  }

  const regressed = positive.length > 0 || losses.length >= lossThreshold;
  return { regressed, reasons: [...positive, ...losses] };
}

/** True when `path` is inside one of the restore entries (dir prefix ending in `/`, or exact file). */
export function inRestoreSurface(entries, path) {
  return entries.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

/**
 * Diff `baseline` vs `main` over the exact restore surface into GitHub tree-change
 * entries. Scoped to exact files so nothing outside the surface is touched.
 */
export function diffRestoreSurface(baseline, main, entries) {
  const changes = [];

  for (const [path, entry] of baseline.byPath) {
    if (!inRestoreSurface(entries, path)) continue;
    if (main.byPath.get(path)?.sha === entry.sha) continue;
    changes.push({ path, mode: entry.mode, type: "blob", sha: entry.sha });
  }

  for (const [path] of main.byPath) {
    if (!inRestoreSurface(entries, path)) continue;
    if (!baseline.byPath.has(path)) {
      changes.push({ path, mode: "100644", type: "blob", sha: null });
    }
  }

  return changes;
}

/** Fixed 20-ticker basket for the Datadog synthetic and live-latency gate. */
export const SYNTHETIC_QUOTE_TICKERS = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "NVDA",
  "META",
  "TSLA",
  "BRK.B",
  "JPM",
  "V",
  "JNJ",
  "WMT",
  "PG",
  "MA",
  "HD",
  "CVX",
  "ABBV",
  "KO",
  "PEP",
  "COST",
];

export function quotesProbeUrl(baseUrl) {
  const tickers = SYNTHETIC_QUOTE_TICKERS.join(",");
  return `${baseUrl.replace(/\/$/, "")}/api/market/quotes?tickers=${encodeURIComponent(tickers)}`;
}
