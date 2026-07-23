#!/usr/bin/env node
/**
 * Restore the target app (compound) back to its fast `/api/market/quotes`
 * baseline so the next FE-13 run can re-introduce the regression cleanly.
 *
 * Opt-in counterpart to `reset-demo.mjs`: that script gates; this one fixes.
 * Never force-pushes. Reverts only REGRESSION_SURFACE_FILES from demo-baseline.
 *
 *   pnpm restore-baseline
 */

import {
  REGRESSION_SURFACE_FILES,
  makeGithub,
  treeFor,
  diffRestoreSurface,
  detectRegression,
  quotesProbeUrl,
} from "./github-baseline.mjs";

const {
  GH_TOKEN,
  GITHUB_TOKEN,
  GH_OWNER = "hsaab",
  DEPLOY_TARGET_REPO = "compound",
  BASELINE_TAG = "demo-baseline",
  TARGET_APP_URL,
  RESPONSE_TIME_MS = "1500",
  RESTORE_PATHS,
} = process.env;

const token = GH_TOKEN || GITHUB_TOKEN;
if (!token) {
  console.error(
    "x Missing GH_TOKEN (or GITHUB_TOKEN) — needs repo write on the target to open+merge the restore PR.",
  );
  process.exit(1);
}

const owner = GH_OWNER.trim();
const repo = DEPLOY_TARGET_REPO.trim();
const baselineRef = BASELINE_TAG.trim();
const threshold = Number(RESPONSE_TIME_MS);
const surfaceFiles = RESTORE_PATHS
  ? RESTORE_PATHS.split(",").map((p) => p.trim()).filter(Boolean)
  : REGRESSION_SURFACE_FILES;

const gh = makeGithub({ token, owner, repo });

async function pollBaseline() {
  if (!TARGET_APP_URL) {
    console.log(
      "- Post-merge latency check skipped (set TARGET_APP_URL to enable). Wait for the redeploy, then re-run reset-demo.",
    );
    return;
  }
  const url = quotesProbeUrl(TARGET_APP_URL);
  console.log(`\nWaiting for the redeploy to serve the fast baseline (${url})...`);
  for (let attempt = 1; attempt <= 10; attempt++) {
    await new Promise((r) => setTimeout(r, 15_000));
    try {
      const res = await fetch(url);
      const json = await res.json().catch(() => ({}));
      const ms = json.durationMs;
      if (typeof ms === "number" && ms < threshold) {
        console.log(
          `ok Baseline healthy: durationMs=${ms} < ${threshold} (attempt ${attempt}).`,
        );
        return;
      }
      console.log(`- attempt ${attempt}: durationMs=${ms ?? "?"} (waiting for redeploy)`);
    } catch (err) {
      console.log(`- attempt ${attempt}: ${err.message}`);
    }
  }
  console.warn(
    "! Redeploy not observed under threshold yet — check Vercel, then re-run `pnpm reset-demo` to confirm.",
  );
}

async function main() {
  console.log(`Restoring ${owner}/${repo} main to the "${baselineRef}" baseline...\n`);

  const regression = await detectRegression(gh, "main", { surfaceFiles });
  if (!regression.regressed) {
    console.log("ok main shows no FE-13 regression markers — nothing to restore.");
    process.exit(0);
  }
  console.log(
    `Detected the FE-13 regression on main (${regression.reasons.length} signal(s)):`,
  );
  for (const reason of regression.reasons.slice(0, 6)) console.log(`  - ${reason}`);
  console.log("");

  const [baseline, main] = await Promise.all([
    treeFor(gh, baselineRef),
    treeFor(gh, "main"),
  ]);
  const changes = diffRestoreSurface(baseline, main, surfaceFiles);

  if (changes.length === 0) {
    console.log("ok Surface files already match the baseline — nothing to do.");
    process.exit(0);
  }

  console.log(`Restoring ${changes.length} file(s) from ${baselineRef}:`);
  for (const c of changes) console.log(`  ${c.sha ? "revert" : "delete"}  ${c.path}`);

  const branch = `restore/fast-baseline-${Date.now()}`;
  const newTree = await gh("/git/trees", {
    method: "POST",
    body: { base_tree: main.treeSha, tree: changes },
  });
  const commit = await gh("/git/commits", {
    method: "POST",
    body: {
      message: `hotfix: restore fast market quotes baseline from ${baselineRef}\n\nReverts the FE-13 TTL/paced-quotes regression surface to the known-fast\nbaseline so the Datadog synthetic recovers and the next FE-13 run re-adds it.`,
      tree: newTree.sha,
      parents: [main.commitSha],
    },
  });
  await gh("/git/refs", {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });

  const pr = await gh("/pulls", {
    method: "POST",
    body: {
      title: "Hotfix: restore fast market quotes baseline (re-arm demo)",
      head: branch,
      base: "main",
      body:
        `Restores the regression surface to \`${baselineRef}\` so \`/api/market/quotes\` ` +
        `drops back under ${threshold}ms and the Datadog synthetic recovers.\n\n` +
        `Opened by \`conductor restore-baseline\` to re-arm the demo; the next FE-13 run re-introduces the regression.`,
    },
  });
  console.log(`\nok Opened PR #${pr.number}: ${pr.html_url}`);

  const merge = await gh(`/pulls/${pr.number}/merge`, {
    method: "PUT",
    body: { merge_method: "squash" },
  });
  console.log(`ok Merged (${merge.sha?.slice(0, 7)}).`);

  await gh(`/git/refs/heads/${branch}`, { method: "DELETE" }).catch((err) =>
    console.warn(`- could not delete branch ${branch}: ${err.message}`),
  );

  await pollBaseline();
  console.log(
    "\nDone. Baseline restored — re-run `pnpm reset-demo` to confirm a clean, armed start.",
  );
}

main().catch((err) => {
  console.error("restore-baseline failed:", err.message);
  process.exit(1);
});
