#!/usr/bin/env node
/**
 * Reset the conductor closed-loop demo back to a clean, armed starting state.
 *
 * The demo's state lives in three places; this script resets the two that are
 * safe to mutate programmatically and *verifies/reports* the third:
 *
 *  1. Linear tickets (the state store): for each demo ticket it deletes ALL
 *     comments + reaction (via POST /api/reset) and moves the ticket back to its
 *     armed state (Backlog by default).
 *  2. Conductor: stateless — its state is the Linear comments above, so clearing
 *     those re-arms it. The script then confirms the board (/api/board) is empty.
 *  3. Target app: this script is a *gate*, not a fixer — it never mutates `main`.
 *     It verifies the fast `quotes-check` baseline via two independent signals and
 *     BLOCKS (non-zero exit) when `main` still carries the regression:
 *       - source-of-truth (deploy-independent): fingerprints `main` for the
 *         FE-13 regression *behavior* in the specific surface files (marker
 *         content, not byte-equality with a tag), so features built on top of
 *         `main` never trip it (needs GH_TOKEN);
 *       - live latency: measures the deployed `quotes-check` route (needs
 *         TARGET_APP_URL).
 *     If neither signal can run, the baseline is UNVERIFIED and also blocks, so a
 *     silently-regressed `main` can never slip through. To fix a blocked baseline,
 *     run `pnpm restore-baseline` (the opt-in tool that opens+merges the revert
 *     PR). Set `ALLOW_SLOW_BASELINE=1` to downgrade the gate to a warning for
 *     intentional mid-Act-2 states.
 *
 * Idempotent: re-running on an already-clean demo clears 0 comments, skips
 * tickets already in the target state, and reports the same board/baseline.
 *
 * Usage (all via env; load .env or rely on injected secrets):
 *   BRIDGE_URL=...             Deployed conductor base URL (required)
 *   BRIDGE_TRIGGER_SECRET=...  Secret for /api/reset (required)
 *   LINEAR_API_KEY=...         Linear API key for the demo workspace (required)
 *   RESET_TICKETS=FE-5,FE-7,FE-13   Comma-separated identifiers (default shown)
 *   RESET_TARGET_STATE=Backlog      Workflow state to re-arm each ticket to
 *   TARGET_APP_URL=...         Deployed target-app base URL (enables the live
 *                              latency signal of the baseline gate)
 *   GH_TOKEN=...               GitHub token (enables the source-of-truth signal:
 *                              fingerprint main for the regression; GITHUB_TOKEN also read)
 *   GH_OWNER=hsaab             Target repo owner (default shown)
 *   DEPLOY_TARGET_REPO=compound   Target repo short name (default shown)
 *   RESPONSE_TIME_MS=1500      Latency threshold the baseline must stay under
 *   ALLOW_SLOW_BASELINE=1      Downgrade the baseline gate to a non-blocking warning
 *
 *   pnpm reset-demo
 */

import { makeGithub, detectRegression } from "./github-baseline.mjs";

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
const allowSlowBaseline = ["1", "true", "yes"].includes((ALLOW_SLOW_BASELINE ?? "").trim().toLowerCase());
const githubToken = GH_TOKEN || GITHUB_TOKEN;

/** Minimal Linear GraphQL client. Throws on transport or GraphQL errors. */
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

/** Resolve a ticket reference (identifier or UUID) to its canonical record + team states. */
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

/**
 * Clear all comments + reaction for an issue via the bridge. Passing the
 * canonical UUID (not the identifier) ensures the reaction — whose id derives
 * from the issue UUID — is removed even on conductor builds whose /api/reset
 * does not yet resolve identifiers.
 */
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

/** Move an issue to a workflow state by id. */
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

/** Pick the target workflow state: exact (case-insensitive) name match, else the backlog-typed state. */
function pickTargetState(states, wantedName) {
  const wanted = wantedName.trim().toLowerCase();
  return (
    states.find((s) => s.name.toLowerCase() === wanted) ||
    states.find((s) => s.type === "backlog") ||
    null
  );
}

/** Fetch the dashboard board (all jobs). */
async function getBoard() {
  const res = await fetch(`${bridgeBase}/api/board?all=1`);
  if (!res.ok) throw new Error(`/api/board ${res.status}`);
  return res.json();
}

/** Measure the live target-app quotes-check latency, when TARGET_APP_URL is configured. */
async function checkBaseline() {
  if (!TARGET_APP_URL) return null;
  const url = `${TARGET_APP_URL.replace(/\/$/, "")}/api/market/quotes-check`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quotes-check ${res.status}`);
  return res.json();
}

/**
 * Deploy-independent baseline signal: fingerprint the target repo's `main` for
 * the FE-13 regression *behavior* (marker content in the specific surface files),
 * not byte-equality against a frozen tag — so unrelated features built on top of
 * `main` never trip it. Returns `{ regressed, reasons }` when a token is
 * configured, or `null` when it is not (so the caller falls back to live latency).
 * Reads source-of-truth `main`, so it flags a regression the instant it merges —
 * before any redeploy.
 */
async function checkMainFingerprint() {
  if (!githubToken) return null;
  const gh = makeGithub({
    token: githubToken,
    owner: GH_OWNER.trim(),
    repo: DEPLOY_TARGET_REPO.trim(),
  });
  return detectRegression(gh, "main");
}

async function main() {
  console.log("Resetting the conductor demo...\n");
  let hadError = false;

  // 1 + 2. Reset each ticket's conductor markers and re-arm its state.
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
        console.log(`ok ${issue.identifier}: cleared ${cleared} comment(s); already in "${current}".`);
      } else {
        const target = pickTargetState(issue.team?.states?.nodes ?? [], RESET_TARGET_STATE);
        if (!target) {
          console.warn(`! ${issue.identifier}: cleared ${cleared} comment(s) but no "${RESET_TARGET_STATE}" state found; left in "${current}".`);
          hadError = true;
          continue;
        }
        const moved = await moveToState(issue.id, target.id);
        console.log(`ok ${issue.identifier}: cleared ${cleared} comment(s); moved "${current}" -> "${moved.state.name}".`);
      }
    } catch (err) {
      console.error(`x ${ref}: ${err.message}`);
      hadError = true;
    }
  }

  // 2. Verify the board is empty (no fleet should remain in flight).
  try {
    const board = await getBoard();
    const remaining = board.jobs ?? [];
    if (remaining.length === 0) {
      console.log("\nok Board is clean - no fleets in flight.");
    } else {
      console.warn(`\n! Board still shows ${remaining.length} fleet(s): ${remaining.map((j) => j.identifier).join(", ")}`);
      hadError = true;
    }
  } catch (err) {
    console.error(`\nx Board check failed: ${err.message}`);
    hadError = true;
  }

  // 3. Baseline GATE (never mutates `main`). Two independent signals decide whether
  // `main` is on the fast baseline; either one showing a regression blocks the reset
  // so a silently-regressed `main` can't slip into the next demo run. `restore-baseline`
  // is the opt-in fixer; `ALLOW_SLOW_BASELINE=1` downgrades the gate to a warning.
  const baselineFailing = await checkBaselineGate();
  if (baselineFailing && allowSlowBaseline) {
    console.warn("! ALLOW_SLOW_BASELINE set — proceeding despite the baseline gate (treated as a warning).");
  }
  const baselineBlocked = baselineFailing && !allowSlowBaseline;
  if (baselineBlocked) hadError = true;

  console.log(
    hadError
      ? "\nDone with warnings. Review the lines above."
      : "\nDone. Demo reset and re-armed.",
  );
  process.exit(hadError ? 1 : 0);
}

/**
 * Evaluate the baseline gate from the source-of-truth (GH) and live-latency
 * signals. Prints the verdict and returns `true` when the baseline is REGRESSED
 * or UNVERIFIED (i.e. the gate should block), or `false` when it is confirmed
 * healthy. Honors `ALLOW_SLOW_BASELINE` at the call site (this only reports).
 */
async function checkBaselineGate() {
  // Source-of-truth signal (deploy-independent).
  let ghRegressed = false;
  let ghHealthy = false;
  try {
    const fp = await checkMainFingerprint();
    if (fp === null) {
      console.log("\n- Baseline source-of-truth check skipped (set GH_TOKEN to fingerprint main for the regression).");
    } else if (fp.regressed) {
      ghRegressed = true;
      console.warn(`\n! Baseline REGRESSED (source of truth): main carries the FE-13 fingerprint (${fp.reasons.length} signal(s)):`);
      for (const reason of fp.reasons.slice(0, 4)) console.warn(`    - ${reason}`);
    } else {
      ghHealthy = true;
      console.log("\nok Baseline clean (source of truth): no FE-13 regression markers on main.");
    }
  } catch (err) {
    console.warn(`\n- Baseline source-of-truth check unavailable: ${err.message}`);
  }

  // Live latency signal (catches deploy lag even when main is clean).
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
      console.log(`ok Baseline healthy (live): durationMs=${baseline.durationMs} < ${threshold}.`);
    }
  } catch (err) {
    console.warn(`- Baseline live-latency check unavailable: ${err.message}`);
  }

  const regressed = ghRegressed || liveSlow;
  const verifiedHealthy = ghHealthy || liveHealthy;

  if (regressed) {
    console.error(
      "\nx Baseline gate FAILED: main still carries the quotes-check regression.\n" +
        "  Fix: run `pnpm restore-baseline` to open+merge the revert PR, then re-run `pnpm reset-demo`.\n" +
        "  Override: set ALLOW_SLOW_BASELINE=1 to proceed anyway (e.g. an intentional mid-Act-2 state).",
    );
    return true;
  }
  if (!verifiedHealthy) {
    console.error(
      "\nx Baseline gate FAILED: baseline is UNVERIFIED (no working signal).\n" +
        "  Fix: set GH_TOKEN (source-of-truth diff) and/or TARGET_APP_URL (live latency) so the baseline can be checked.\n" +
        "  Override: set ALLOW_SLOW_BASELINE=1 to proceed without a verified baseline.",
    );
    return true;
  }

  console.log("ok Baseline gate passed: main is on the fast baseline.");
  return false;
}

main().catch((err) => {
  console.error("reset-demo failed:", err);
  process.exit(1);
});
