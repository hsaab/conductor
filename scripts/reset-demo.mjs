#!/usr/bin/env node
/**
 * Reset the conductor closed-loop demo back to a clean, armed starting state.
 *
 * Surfaces:
 *  1. Linear tickets — wipe comments + reaction, move to Backlog (feature mode)
 *     or arm FE-13 mid-pipeline (hotfix mode).
 *  2. Conductor — derived from Linear markers; board check is mode-aware.
 *  3. Target app — gate on fast /api/market/quotes baseline (never mutates main).
 *
 * Modes (`DEMO_START_MODE`):
 *  - feature (default): tickets in Backlog, board empty, baseline must be fast.
 *  - hotfix: after reset, trigger a real FE-13 fleet, wait for its PR (do not
 *    merge), assert the PR head carries the regression fingerprint. Presenter
 *    merges live as the opening beat.
 *
 * Usage: pnpm reset-demo
 */

import {
  makeGithub,
  detectRegression,
  quotesProbeUrl,
} from "./github-baseline.mjs";

const {
  BRIDGE_URL,
  BRIDGE_TRIGGER_SECRET,
  LINEAR_API_KEY,
  TARGET_APP_URL,
  GH_TOKEN,
  GITHUB_TOKEN,
  GH_OWNER = "hsaab",
  DEPLOY_TARGET_REPO = "compound",
  RESET_TICKETS = "FE-5,FE-7,FE-13",
  RESET_TARGET_STATE = "Backlog",
  RESPONSE_TIME_MS = "1500",
  ALLOW_SLOW_BASELINE,
  DEMO_START_MODE = "feature",
  HOTFIX_TICKET = "FE-13",
  HOTFIX_ARM_TIMEOUT_MS = "900000",
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    console.error(`x Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

requireEnv("BRIDGE_URL", BRIDGE_URL);
requireEnv("BRIDGE_TRIGGER_SECRET", BRIDGE_TRIGGER_SECRET);
requireEnv("LINEAR_API_KEY", LINEAR_API_KEY);

const bridgeBase = BRIDGE_URL.replace(/\/$/, "");
const tickets = RESET_TICKETS.split(",").map((t) => t.trim()).filter(Boolean);
const threshold = Number(RESPONSE_TIME_MS);
const allowSlowBaseline = ["1", "true", "yes"].includes(
  (ALLOW_SLOW_BASELINE ?? "").trim().toLowerCase(),
);
const githubToken = GH_TOKEN || GITHUB_TOKEN;
const startMode = (DEMO_START_MODE || "feature").trim().toLowerCase();
if (startMode !== "feature" && startMode !== "hotfix") {
  console.error(`x DEMO_START_MODE must be "feature" or "hotfix" (got "${DEMO_START_MODE}")`);
  process.exit(1);
}

async function linearGraphql(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: LINEAR_API_KEY },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors?.length) {
    const msg = json.errors?.map((e) => e.message).join("; ") || res.statusText;
    throw new Error(`Linear GraphQL failed: ${msg}`);
  }
  return json.data;
}

async function resolveIssue(ref) {
  const data = await linearGraphql(
    `query($id: String!) {
      issue(id: $id) {
        id identifier state { name }
        team { states { nodes { id name type } } }
      }
    }`,
    { id: ref },
  );
  return data.issue;
}

async function resetViaBridge(uuid) {
  const res = await fetch(`${bridgeBase}/api/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BRIDGE_TRIGGER_SECRET}`,
    },
    body: JSON.stringify({ issueId: uuid }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/api/reset ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function moveToState(uuid, stateId) {
  const data = await linearGraphql(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success issue { identifier state { name } }
      }
    }`,
    { id: uuid, stateId },
  );
  if (!data.issueUpdate?.success) throw new Error("issueUpdate returned success: false");
  return data.issueUpdate.issue;
}

function pickTargetState(states, wantedName) {
  const wanted = wantedName.trim().toLowerCase();
  return (
    states.find((s) => s.name.toLowerCase() === wanted) ||
    states.find((s) => s.type === "backlog") ||
    null
  );
}

async function getBoard() {
  const res = await fetch(`${bridgeBase}/api/board?all=1`);
  if (!res.ok) throw new Error(`/api/board ${res.status}`);
  return res.json();
}

async function checkBaseline() {
  if (!TARGET_APP_URL) return null;
  const url = quotesProbeUrl(TARGET_APP_URL);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quotes probe ${res.status} (${url})`);
  return res.json();
}

async function checkMainFingerprint() {
  if (!githubToken) return null;
  const gh = makeGithub({
    token: githubToken,
    owner: GH_OWNER.trim(),
    repo: DEPLOY_TARGET_REPO.trim(),
  });
  return detectRegression(gh, "main");
}

/** Close open PRs that look like FE-13 / regression arms (owned by reset, not restore). */
async function closeStrayRegressionPrs() {
  if (!githubToken) {
    console.log("- Stray regression-PR cleanup skipped (set GH_TOKEN).");
    return;
  }
  const gh = makeGithub({
    token: githubToken,
    owner: GH_OWNER.trim(),
    repo: DEPLOY_TARGET_REPO.trim(),
  });
  const pulls = await gh("/pulls?state=open&per_page=50");
  const patterns = [
    /FE-13/i,
    /real-?time.*quote/i,
    /stale.*quote/i,
    /quotes-check latency/i,
    /market quotes latency/i,
    /sequential.*GLOBAL_QUOTE/i,
    /QUOTE_TTL/i,
  ];
  let closed = 0;
  for (const pr of pulls) {
    const hay = `${pr.title}\n${pr.body ?? ""}`;
    if (!patterns.some((re) => re.test(hay))) continue;
    await gh(`/pulls/${pr.number}`, {
      method: "PATCH",
      body: { state: "closed" },
    });
    console.log(`ok Closed stray regression PR #${pr.number}: ${pr.title}`);
    closed += 1;
  }
  if (closed === 0) console.log("ok No open stray regression PRs to close.");
}

async function triggerFleet(identifier) {
  const res = await fetch(`${bridgeBase}/api/trigger`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BRIDGE_TRIGGER_SECRET}`,
    },
    body: JSON.stringify({ identifier, source: "reset-demo-hotfix-arm" }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/api/trigger ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function reconcileOnce() {
  const res = await fetch(`${bridgeBase}/api/reconcile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BRIDGE_TRIGGER_SECRET}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/api/reconcile ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/**
 * Wait until FE-13 has an open build PR, then fingerprint its head.
 * Does not merge — presenter merges live.
 */
async function armHotfixMode() {
  if (!githubToken) {
    throw new Error("hotfix mode requires GH_TOKEN to fingerprint the PR head");
  }
  const ticket = HOTFIX_TICKET.trim();
  console.log(`\nArming hotfix start mode for ${ticket} (real fleet, stop before merge)...`);

  // Move ticket to In Progress so shouldSpawn filters match if needed, then trigger.
  const issue = await resolveIssue(ticket);
  if (!issue) throw new Error(`${ticket} not found`);
  const inProgress = (issue.team?.states?.nodes ?? []).find(
    (s) => s.name.toLowerCase() === "in progress" || s.type === "started",
  );
  if (inProgress && issue.state?.name?.toLowerCase() !== "in progress") {
    await moveToState(issue.id, inProgress.id);
    console.log(`ok ${ticket}: moved to "${inProgress.name}" for fleet arming.`);
  }

  const triggered = await triggerFleet(ticket);
  console.log(`ok /api/trigger: ${JSON.stringify(triggered)}`);

  const deadline = Date.now() + Number(HOTFIX_ARM_TIMEOUT_MS);
  let prUrl = null;
  let prNumber = null;
  while (Date.now() < deadline) {
    await reconcileOnce();
    const board = await getBoard();
    const job = (board.jobs ?? []).find((j) => j.identifier === ticket);
    const agents = job?.agents ?? [];
    const withPr = agents.find((a) => a.prUrl && (a.role === "build" || !a.role));
    if (withPr?.prUrl) {
      prUrl = withPr.prUrl;
      const m = prUrl.match(/\/pull\/(\d+)/);
      prNumber = m ? Number(m[1]) : null;
      break;
    }
    // Also look at open PRs mentioning the ticket.
    const gh = makeGithub({
      token: githubToken,
      owner: GH_OWNER.trim(),
      repo: DEPLOY_TARGET_REPO.trim(),
    });
    const pulls = await gh("/pulls?state=open&per_page=20");
    const hit = pulls.find(
      (p) =>
        p.title.includes(ticket) ||
        (p.body ?? "").includes(ticket) ||
        /real-?time|stale.*quote|GLOBAL_QUOTE/i.test(`${p.title}\n${p.body ?? ""}`),
    );
    if (hit) {
      prUrl = hit.html_url;
      prNumber = hit.number;
      break;
    }
    console.log("- waiting for FE-13 build PR...");
    await new Promise((r) => setTimeout(r, 15_000));
  }

  if (!prUrl || !prNumber) {
    throw new Error(
      `Timed out waiting for ${ticket} PR (raise HOTFIX_ARM_TIMEOUT_MS or pre-warm the fleet)`,
    );
  }

  const gh = makeGithub({
    token: githubToken,
    owner: GH_OWNER.trim(),
    repo: DEPLOY_TARGET_REPO.trim(),
  });
  const pr = await gh(`/pulls/${prNumber}`);
  const headSha = pr.head.sha;
  const fp = await detectRegression(gh, headSha);
  if (!fp.regressed) {
    throw new Error(
      `PR #${prNumber} head ${headSha.slice(0, 7)} does not carry the FE-13 regression fingerprint — refuse to arm`,
    );
  }
  console.log(`ok Hotfix armed: PR #${prNumber} ${prUrl}`);
  console.log(`  head ${headSha.slice(0, 7)} regression signals: ${fp.reasons.length}`);
  for (const reason of fp.reasons.slice(0, 4)) console.log(`    - ${reason}`);
  console.log("  Presenter opening beat: merge this PR live (do not merge from reset).");
  return { prUrl, prNumber, headSha };
}

async function checkBaselineGate() {
  let ghRegressed = false;
  let ghHealthy = false;
  try {
    const fp = await checkMainFingerprint();
    if (fp === null) {
      console.log(
        "\n- Baseline source-of-truth check skipped (set GH_TOKEN to fingerprint main).",
      );
    } else if (fp.regressed) {
      ghRegressed = true;
      console.warn(
        `\n! Baseline REGRESSED (source of truth): main carries the FE-13 fingerprint (${fp.reasons.length} signal(s)):`,
      );
      for (const reason of fp.reasons.slice(0, 4)) console.warn(`    - ${reason}`);
    } else {
      ghHealthy = true;
      console.log(
        "\nok Baseline clean (source of truth): no FE-13 regression markers on main.",
      );
    }
  } catch (err) {
    console.warn(`\n- Baseline source-of-truth check unavailable: ${err.message}`);
  }

  let liveSlow = false;
  let liveHealthy = false;
  try {
    const baseline = await checkBaseline();
    if (!baseline) {
      console.log("- Baseline live-latency check skipped (set TARGET_APP_URL to enable).");
    } else if (baseline.durationMs > threshold) {
      liveSlow = true;
      console.warn(`! Baseline SLOW (live): durationMs=${baseline.durationMs} > ${threshold}.`);
    } else {
      liveHealthy = true;
      console.log(
        `ok Baseline healthy (live): durationMs=${baseline.durationMs} < ${threshold}.`,
      );
    }
  } catch (err) {
    console.warn(`- Baseline live-latency check unavailable: ${err.message}`);
  }

  // Live latency is primary; fingerprint is best-effort for the TTL shape.
  const regressed = liveSlow || (ghRegressed && !liveHealthy);
  const verifiedHealthy = liveHealthy || (ghHealthy && !liveSlow);

  if (regressed) {
    console.error(
      "\nx Baseline gate FAILED: /api/market/quotes still slow or main is regressed.\n" +
        "  Fix: run `pnpm restore-baseline`, then re-run `pnpm reset-demo`.\n" +
        "  Override: set ALLOW_SLOW_BASELINE=1 to proceed anyway.",
    );
    return true;
  }
  if (!verifiedHealthy) {
    console.error(
      "\nx Baseline gate FAILED: baseline is UNVERIFIED (no working signal).\n" +
        "  Fix: set GH_TOKEN and/or TARGET_APP_URL.\n" +
        "  Override: set ALLOW_SLOW_BASELINE=1 to proceed without a verified baseline.",
    );
    return true;
  }

  console.log("ok Baseline gate passed: main is on the fast quotes baseline.");
  return false;
}

async function main() {
  console.log(`Resetting the conductor demo (mode=${startMode})...\n`);
  let hadError = false;

  for (const ref of tickets) {
    try {
      const issue = await resolveIssue(ref);
      if (!issue) {
        console.warn(`- ${ref}: not found in this workspace; skipping.`);
        continue;
      }
      const reset = await resetViaBridge(issue.id);
      const cleared = reset.clearedComments ?? 0;

      const current = issue.state?.name ?? "(unknown)";
      if (current.toLowerCase() === RESET_TARGET_STATE.trim().toLowerCase()) {
        console.log(
          `ok ${issue.identifier}: cleared ${cleared} comment(s); already in "${current}".`,
        );
      } else {
        const target = pickTargetState(
          issue.team?.states?.nodes ?? [],
          RESET_TARGET_STATE,
        );
        if (!target) {
          console.warn(
            `! ${issue.identifier}: cleared ${cleared} comment(s) but no "${RESET_TARGET_STATE}" state found; left in "${current}".`,
          );
          hadError = true;
          continue;
        }
        const moved = await moveToState(issue.id, target.id);
        console.log(
          `ok ${issue.identifier}: cleared ${cleared} comment(s); moved "${current}" -> "${moved.state.name}".`,
        );
      }
    } catch (err) {
      console.error(`x ${ref}: ${err.message}`);
      hadError = true;
    }
  }

  try {
    await closeStrayRegressionPrs();
  } catch (err) {
    console.error(`x Stray PR cleanup failed: ${err.message}`);
    hadError = true;
  }

  const baselineFailing = await checkBaselineGate();
  if (baselineFailing && allowSlowBaseline) {
    console.warn(
      "! ALLOW_SLOW_BASELINE set — proceeding despite the baseline gate (treated as a warning).",
    );
  }
  const baselineBlocked = baselineFailing && !allowSlowBaseline;
  if (baselineBlocked) hadError = true;

  if (startMode === "hotfix" && !baselineBlocked) {
    try {
      await armHotfixMode();
    } catch (err) {
      console.error(`x Hotfix arming failed: ${err.message}`);
      hadError = true;
    }
  }

  try {
    const board = await getBoard();
    const remaining = board.jobs ?? [];
    if (startMode === "feature") {
      if (remaining.length === 0) {
        console.log("\nok Board is clean - no fleets in flight.");
      } else {
        console.warn(
          `\n! Board still shows ${remaining.length} fleet(s): ${remaining.map((j) => j.identifier).join(", ")}`,
        );
        hadError = true;
      }
    } else {
      const ticket = HOTFIX_TICKET.trim();
      const job = remaining.find((j) => j.identifier === ticket);
      const hasPr = (job?.agents ?? []).some((a) => a.prUrl);
      if (job && (hasPr || remaining.length >= 1)) {
        console.log(
          `\nok Hotfix board: ${ticket} mid-pipeline (${remaining.length} fleet(s)).`,
        );
      } else {
        console.warn(
          `\n! Hotfix board expected ${ticket} mid-pipeline with an open PR; got: ${remaining.map((j) => j.identifier).join(", ") || "(empty)"}`,
        );
        hadError = true;
      }
    }
  } catch (err) {
    console.error(`\nx Board check failed: ${err.message}`);
    hadError = true;
  }

  console.log(
    hadError
      ? "\nDone with warnings. Review the lines above."
      : "\nDone. Demo reset and re-armed.",
  );
  process.exit(hadError ? 1 : 0);
}

main().catch((err) => {
  console.error("reset-demo failed:", err);
  process.exit(1);
});
