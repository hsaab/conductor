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
 *  3. Target app: restoring the fast `quotes-check` baseline requires reverting
 *     the regression on `main` and a redeploy — a human merge this script cannot
 *     perform. It therefore only *measures* the live latency and warns when
 *     `main` still carries the regression.
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
 *   TARGET_APP_URL=...         Deployed target-app base URL (optional; enables
 *                              the baseline latency check)
 *   RESPONSE_TIME_MS=1500      Latency threshold the baseline must stay under
 *
 *   pnpm reset-demo
 */

const {
  BRIDGE_URL,
  BRIDGE_TRIGGER_SECRET,
  LINEAR_API_KEY,
  TARGET_APP_URL,
  RESET_TICKETS = "FE-5,FE-7,FE-13",
  RESET_TARGET_STATE = "Backlog",
  RESPONSE_TIME_MS = "1500",
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

  // 3. Report (don't mutate) the target-app baseline. This is informational: a slow
  // baseline is a human merge follow-up (step 3 of the skill), not a reset failure,
  // so it never affects this script's exit code.
  try {
    const baseline = await checkBaseline();
    if (!baseline) {
      console.log("- Target-app baseline check skipped (set TARGET_APP_URL to enable).");
    } else if (baseline.durationMs > threshold) {
      console.warn(
        `! Target-app baseline SLOW: durationMs=${baseline.durationMs} > ${threshold}. ` +
          `main still carries the quotes-check regression - merge the revert PR and redeploy to restore the fast baseline.`,
      );
    } else {
      console.log(`ok Target-app baseline healthy: durationMs=${baseline.durationMs} < ${threshold}.`);
    }
  } catch (err) {
    console.warn(`- Target-app baseline check unavailable: ${err.message}`);
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
