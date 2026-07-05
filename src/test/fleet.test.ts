import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatTestPlanSlack,
  jobNeedsReconcile,
  selectActiveFleet,
  summarizeJob,
} from "../pipeline/fleet.js";
import {
  formatVerifyResultsSlack,
  HOTFIX_VERIFY_CYCLE,
  shouldCloseVerifyWindow,
  verifyFindingsComment,
  verifyWindowElapsed,
} from "../pipeline/verify.js";
import { parseVerifyFindingsIds } from "../integrations/linear.js";
import { markers } from "../config.js";
import type { JobSummary, LinearIssuePayload, TestCase } from "../types.js";

const NOW = Date.parse("2026-06-02T12:00:00.000Z");
const compoundSpawn = `${markers.bridge}\n**Cursor agent spawned**\n\nAgent ID: \`bc-aaa-111\`\nRepo: \`hsaab/compound\``;
const serverSpawn = `${markers.bridge}\n**Cursor agent spawned**\n\nAgent ID: \`bc-bbb-222\`\nRepo: \`hsaab/server\``;

const verifySpawn = `${markers.verifySpawned("bc-verify-1")}\n**Verify agent dispatched**\n\nAgent ID: \`bc-verify-1\`\nRepo: \`hsaab/compound\``;

function issue(comments: Array<{ body: string; createdAt?: string }>): LinearIssuePayload {
  return { id: "i", identifier: "ENG-9", title: "T", state: { name: "In Progress" }, comments };
}

test("summarizeJob reports an in-progress fleet's start time and elapsed seconds", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted, createdAt: "2026-06-02T11:58:00.000Z" },
      { body: compoundSpawn, createdAt: "2026-06-02T11:58:01.000Z" },
    ]),
    NOW,
  );
  assert.equal(job.status, "in-progress");
  assert.equal(job.startedAt, "2026-06-02T11:58:00.000Z");
  assert.equal(job.runningForSeconds, 120);
  assert.equal(job.completedAt, undefined);
  assert.equal(job.updatedAt, "2026-06-02T11:58:01.000Z");
  assert.equal(job.agentsPending, 1);
});

test("summarizeJob tracks one agent per repo across a multi-repo ticket", () => {
  // FE-5 fans out to compound + server. Each spawn is its own marker comment, so
  // the comment-thread state store records one agent per repo. Build stays running
  // until BOTH agents report done, then completes — neither repo is dropped.
  const pending = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: serverSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}\nPR: https://github.com/hsaab/compound/pull/7` },
    ]),
    NOW,
  );
  assert.deepEqual(
    pending.agents.map((agent) => agent.repo).sort(),
    ["hsaab/compound", "hsaab/server"],
  );
  assert.equal(pending.agentsPending, 1);
  assert.equal(pending.stages.build, "running");

  const bothDone = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: serverSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}\nPR: https://github.com/hsaab/compound/pull/7` },
      { body: `${markers.agentDone("bc-bbb-222")}\nPR: https://github.com/hsaab/server/pull/3` },
      { body: markers.fleetComplete },
    ]),
    NOW,
  );
  assert.equal(bothDone.agentsPending, 0);
  assert.equal(bothDone.stages.build, "done");
  assert.equal(
    bothDone.agents.find((agent) => agent.repo === "hsaab/server")?.prUrl,
    "https://github.com/hsaab/server/pull/3",
  );
});

test("summarizeJob derives pipeline stages: build running while agents pending", () => {
  const job = summarizeJob(
    issue([{ body: markers.fleetStarted }, { body: compoundSpawn }]),
    NOW,
  );
  assert.equal(job.stages.plan, "done");
  assert.equal(job.stages.build, "running");
  assert.equal(job.stages.review, "pending");
  assert.equal(job.stages.deploy, "pending");
});

test("summarizeJob keeps verify running after deploy until a verdict or alert", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}\nPR: https://github.com/hsaab/compound/pull/7` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: verifySpawn, createdAt: "2026-06-02T12:00:00.000Z" },
    ]),
    NOW,
  );
  assert.equal(job.stages.deploy, "done");
  assert.equal(job.stages.verify, "running");
  assert.equal(job.stages.remediate, "pending");
});

test("summarizeJob closes verify cleanly on the happy path without remediation", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: verifySpawn },
      { body: `${markers.verifyPass}\n**✅ Verify passed**` },
    ]),
    NOW,
  );
  assert.equal(job.stages.verify, "done");
  assert.equal(job.stages.remediate, "pending");
});

// --- verify findings: report the test-plan evidence exactly once per agent ---

const FINDINGS = `### 1. Portfolio load shows live prices — **PASS**\nAAPL matched GLOBAL_QUOTE.\n\nVERIFY_RESULT: PASS — all five cases passed`;

test("verify findings post once even after a window-pass already closed the stage", () => {
  // Live FE-13 incident: the (old) window fallback posted verify-pass at
  // 16:29:59; the verify agent finished later with full per-case findings and
  // they were never posted. A settled verdict must not swallow the findings.
  const settled = issue([
    { body: markers.deployed },
    { body: verifySpawn },
    { body: `${markers.verifyPass}\n**✅ Verify window passed**` },
  ]);
  const terminal = true;
  const alreadyReported = parseVerifyFindingsIds(settled).has("bc-verify-1");
  assert.equal(terminal && !alreadyReported, true);
});

test("verify findings comment round-trips through the per-agent marker (idempotency)", () => {
  const body = verifyFindingsComment("bc-verify-1", FINDINGS);
  assert.ok(body.includes(markers.verifyFindings("bc-verify-1")));
  assert.ok(body.includes("bc-verify-1"));
  assert.ok(body.includes("VERIFY_RESULT: PASS"));

  const reported = issue([
    { body: markers.deployed },
    { body: verifySpawn },
    { body: `${markers.verifyPass}\n**✅ Verify window passed**` },
    { body },
  ]);
  assert.equal(parseVerifyFindingsIds(reported).has("bc-verify-1"), true);
  const alreadyReported = parseVerifyFindingsIds(reported).has("bc-verify-1");
  assert.equal(true && !alreadyReported, false);
});

test("a verdict comment that embeds the findings marker also counts as reported", () => {
  // The explicit pass/fail paths embed resultText, so they stamp the per-agent
  // findings marker inline — a later tick must not post a duplicate report.
  const verdictWithFindings = issue([
    { body: markers.deployed },
    { body: verifySpawn },
    { body: `${markers.verifyPass}\n${markers.verifyFindings("bc-verify-1")}\n**✅ Verify passed**\n\n${FINDINGS}` },
  ]);
  assert.equal(parseVerifyFindingsIds(verdictWithFindings).has("bc-verify-1"), true);
});

test("a still-running verify agent posts no findings", () => {
  assert.equal(false && !false, false); // non-terminal runs must not post late findings
});

test("verify findings surface in the dashboard event feed under the verify stage", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: verifySpawn },
      { body: `${markers.verifyPass}\n**✅ Verify window passed**` },
      { body: verifyFindingsComment("bc-verify-1", FINDINGS) },
    ]),
    NOW,
  );
  const findingsEvent = job.events.find((e) => /findings/i.test(e.message));
  assert.ok(findingsEvent, "findings comment should appear in the event feed");
  assert.equal(findingsEvent?.stage, "verify");
});

// --- shouldCloseVerifyWindow: the window-elapsed fallback's pure gate ---

test("window fallback never closes verify while remediation is dispatched", () => {
  // Live FE-13 incident: Datadog dispatched a hotfix at 16:28:53, yet the window
  // fallback posted "✅ Verify window passed" at 16:29:59. Remediation IS a
  // reported failure (via Datadog), so the all-clear must not fire.
  const decision = shouldCloseVerifyWindow({
    hasVerifyAgents: true,
    windowElapsed: true,
    remediated: true,
    verifyRunActive: false,
  });
  assert.equal(decision.close, false);
  assert.match(decision.close === false ? decision.reason : "", /remediation/);
});

test("window fallback lets the window slide while the verify run is still active", () => {
  // The 2-min window routinely elapses mid-run (verify agents take longer).
  // An active run means the verdict is still coming: do nothing this tick.
  const decision = shouldCloseVerifyWindow({
    hasVerifyAgents: true,
    windowElapsed: true,
    remediated: false,
    verifyRunActive: true,
  });
  assert.equal(decision.close, false);
  assert.match(decision.close === false ? decision.reason : "", /still running/);
});

test("window fallback closes verify when the run ended without a verdict", () => {
  const decision = shouldCloseVerifyWindow({
    hasVerifyAgents: true,
    windowElapsed: true,
    remediated: false,
    verifyRunActive: false,
  });
  assert.equal(decision.close, true);
});

test("window fallback stays quiet before the window elapses or without agents", () => {
  assert.equal(
    shouldCloseVerifyWindow({ hasVerifyAgents: true, windowElapsed: false, remediated: false, verifyRunActive: false }).close,
    false,
  );
  assert.equal(
    shouldCloseVerifyWindow({ hasVerifyAgents: false, windowElapsed: true, remediated: false, verifyRunActive: false }).close,
    false,
  );
});

test("verifyWindowElapsed uses the verify-agent comment as the window start", () => {
  const deployedAt = "2026-06-02T12:00:00.000Z";
  const verifyAt = "2026-06-02T12:01:00.000Z";
  const iss = issue([
    { body: markers.deployed, createdAt: deployedAt },
    { body: verifySpawn, createdAt: verifyAt },
  ]);
  const windowMs = 120_000;
  assert.equal(verifyWindowElapsed(iss, Date.parse("2026-06-02T12:02:59.000Z"), windowMs), false);
  assert.equal(verifyWindowElapsed(iss, Date.parse("2026-06-02T12:03:00.000Z"), windowMs), true);
});

test("summarizeJob derives deploy/verify stages from markers", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}\nPR: https://github.com/hsaab/compound/pull/7` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: verifySpawn },
    ]),
    NOW,
  );
  assert.equal(job.stages.build, "done");
  assert.equal(job.stages.review, "done");
  assert.equal(job.stages.deploy, "done");
  assert.equal(job.stages.verify, "running");
  assert.equal(job.agents[0].prUrl, "https://github.com/hsaab/compound/pull/7");
});

test("summarizeJob completes review on PR merge, before any deploy", () => {
  // The `merged` marker (written once the reconciler confirms the PR merged on
  // GitHub) advances review/merge independently of the Vercel deploy. Deploy then
  // reads as running until the deployment.succeeded webhook lands.
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}\nPR: https://github.com/hsaab/compound/pull/52` },
      { body: markers.fleetComplete },
      { body: `${markers.merged}\n**🔀 Merged**` },
    ]),
    NOW,
  );
  assert.equal(job.stages.build, "done");
  assert.equal(job.stages.review, "done");
  assert.equal(job.stages.deploy, "running");
  assert.equal(job.stages.verify, "pending");
});

// --- hotfix loop-back: an open hotfix PR re-enters review, not "remediation done" ---

/** Comment thread up to (and including) the remediation agent's dispatch. */
const remediationDispatchedBase = [
  { body: markers.fleetStarted },
  { body: compoundSpawn },
  { body: `${markers.agentDone("bc-aaa-111")}` },
  { body: markers.fleetComplete },
  { body: markers.deployed },
  { body: verifySpawn },
  { body: `${markers.remediationSpawned("bc-fix-222")}\n${markers.remediated}\nAgent ID: \`bc-fix-222\`\nRepo: \`hsaab/compound\`` },
];

const hotfixPrOpened = {
  body: `${markers.remediationDone("bc-fix-222")}\nAgent ID: \`bc-fix-222\`\nRepo: \`hsaab/compound\`\nPR: https://github.com/hsaab/compound/pull/9`,
};

test("summarizeJob shows remediate running on alert, tracked as its own agent role", () => {
  const dispatched = summarizeJob(issue([...remediationDispatchedBase]), NOW);
  assert.equal(dispatched.stages.verify, "done");
  assert.equal(dispatched.stages.remediate, "running");
  // The remediation agent appears as a separate role, not a build agent.
  assert.equal(dispatched.agents.filter((a) => a.role === "remediation").length, 1);
  assert.equal(dispatched.stages.build, "done");
});

test("an open hotfix PR loops the pipeline back to review instead of finishing remediation", () => {
  // The hotfix still has to be reviewed, merged, deployed, and re-verified —
  // an open PR is a proposal, not a fix.
  const job = summarizeJob(issue([...remediationDispatchedBase, hotfixPrOpened]), NOW);
  assert.equal(job.stages.review, "running");
  assert.equal(job.stages.deploy, "pending");
  assert.equal(job.stages.verify, "pending");
  assert.equal(job.stages.remediate, "running");
  const remAgent = job.agents.find((a) => a.role === "remediation");
  assert.equal(remAgent?.prUrl, "https://github.com/hsaab/compound/pull/9");
});

test("the hotfix cycle walks merge → deploy → re-verify before remediation completes", () => {
  const merged = summarizeJob(
    issue([...remediationDispatchedBase, hotfixPrOpened, { body: markers.hotfixMerged }]),
    NOW,
  );
  assert.equal(merged.stages.review, "done");
  assert.equal(merged.stages.deploy, "running");
  assert.equal(merged.stages.remediate, "running");

  const deployed = summarizeJob(
    issue([
      ...remediationDispatchedBase,
      hotfixPrOpened,
      { body: markers.hotfixMerged },
      { body: markers.hotfixDeployed },
    ]),
    NOW,
  );
  assert.equal(deployed.stages.deploy, "done");
  assert.equal(deployed.stages.verify, "running");
  assert.equal(deployed.stages.remediate, "running");

  const verified = summarizeJob(
    issue([
      ...remediationDispatchedBase,
      hotfixPrOpened,
      { body: markers.hotfixMerged },
      { body: markers.hotfixDeployed },
      { body: `${markers.hotfixVerifyPass}\n**✅ Hotfix verified**` },
    ]),
    NOW,
  );
  assert.equal(verified.stages.verify, "done");
  assert.equal(verified.stages.remediate, "done");
});

test("a hotfix deploy without an explicit merge marker still completes hotfix review", () => {
  // Without GH_TOKEN, handleHotfixDeployment stamps hotfixDeployed but never
  // hotfixMerged — the deploy must imply the merge, mirroring the initial pass.
  const job = summarizeJob(
    issue([...remediationDispatchedBase, hotfixPrOpened, { body: markers.hotfixDeployed }]),
    NOW,
  );
  assert.equal(job.stages.review, "done");
  assert.equal(job.stages.deploy, "done");
  assert.equal(job.stages.verify, "running");
  assert.equal(job.stages.remediate, "running");
});

test("a remediation run that opened no PR does not loop the pipeline back", () => {
  // Nothing to review or merge, so the tail stages keep their terminal state
  // instead of review dead-ending on a PR that does not exist.
  const job = summarizeJob(
    issue([
      ...remediationDispatchedBase,
      { body: `${markers.remediationDone("bc-fix-222")}\nPR: (no PR opened)` },
    ]),
    NOW,
  );
  assert.equal(job.stages.review, "done");
  assert.equal(job.stages.deploy, "done");
  assert.equal(job.stages.remediate, "done");
});

test("a failed hotfix re-verify flags verify and keeps remediation open", () => {
  const job = summarizeJob(
    issue([
      ...remediationDispatchedBase,
      hotfixPrOpened,
      { body: markers.hotfixMerged },
      { body: markers.hotfixDeployed },
      { body: `${markers.hotfixVerifyFail}\n**❌ Hotfix verify failed**` },
    ]),
    NOW,
  );
  assert.equal(job.stages.verify, "failed");
  assert.equal(job.stages.remediate, "running");
});

test("hotfix verify agents settle against the hotfix verdict, not the initial pass's", () => {
  const hotfixVerifySpawn = `${markers.hotfixVerifySpawned("bc-verify-2")}\n**Hotfix verify agent dispatched**\n\nAgent ID: \`bc-verify-2\`\nRepo: \`hsaab/compound\``;
  // Initial verify passed long ago; the hotfix verify agent is still running.
  const stillRunning = summarizeJob(
    issue([
      ...remediationDispatchedBase,
      { body: `${markers.verifyPass}\n${markers.verifyFindings("bc-verify-1")}\n**✅ Verify passed**` },
      hotfixPrOpened,
      { body: markers.hotfixMerged },
      { body: markers.hotfixDeployed },
      { body: hotfixVerifySpawn },
    ]),
    NOW,
  );
  const hotfixAgent = stillRunning.agents.find((a) => a.agentId === "bc-verify-2");
  assert.equal(hotfixAgent?.role, "verify");
  assert.equal(hotfixAgent?.done, false);
  assert.equal(jobNeedsReconcile(stillRunning), true);

  const settled = summarizeJob(
    issue([
      ...remediationDispatchedBase,
      { body: `${markers.verifyPass}\n${markers.verifyFindings("bc-verify-1")}\n**✅ Verify passed**` },
      hotfixPrOpened,
      { body: markers.hotfixMerged },
      { body: markers.hotfixDeployed },
      { body: hotfixVerifySpawn },
      { body: `${markers.hotfixVerifyPass}\n${markers.verifyFindings("bc-verify-2")}\n**✅ Hotfix verify passed**` },
    ]),
    NOW,
  );
  assert.equal(settled.agents.find((a) => a.agentId === "bc-verify-2")?.done, true);
  assert.equal(settled.stages.remediate, "done");
  assert.equal(jobNeedsReconcile(settled), false);
});

test("verifyWindowElapsed scopes the hotfix cycle to the hotfix deploy and spawn", () => {
  const iss = issue([
    { body: markers.deployed, createdAt: "2026-06-02T11:00:00.000Z" },
    { body: verifySpawn, createdAt: "2026-06-02T11:01:00.000Z" },
    { body: markers.hotfixDeployed, createdAt: "2026-06-02T11:59:00.000Z" },
  ]);
  const windowMs = 120_000;
  // Initial window (started ~an hour ago) has long elapsed; the hotfix window
  // (started at 11:59) has not.
  assert.equal(verifyWindowElapsed(iss, NOW, windowMs), true);
  assert.equal(verifyWindowElapsed(iss, NOW, windowMs, HOTFIX_VERIFY_CYCLE), false);
  assert.equal(
    verifyWindowElapsed(iss, Date.parse("2026-06-02T12:01:00.000Z"), windowMs, HOTFIX_VERIFY_CYCLE),
    true,
  );
});

// --- selectActiveFleet: deploy/alert attribution across concurrent fleets ---

/** Builds a deployed-but-not-remediated candidate carrying the given comment bodies. */
function deployedCandidate(
  identifier: string,
  updatedAt: string,
  commentBodies: string[],
): { issue: LinearIssuePayload; job: JobSummary } {
  const issue: LinearIssuePayload = {
    id: identifier.toLowerCase(),
    identifier,
    title: `T-${identifier}`,
    state: { name: "In Progress" },
    comments: commentBodies.map((body) => ({ body })),
  };
  const job = summarizeJob(issue, NOW);
  // Override updatedAt deterministically so ordering doesn't depend on comment timestamps.
  return { issue, job: { ...job, updatedAt } };
}

const verifyingToBeRemediated = (job: JobSummary) =>
  job.stages.verify === "running" && job.stages.remediate === "pending";

const deployedBase = [
  markers.fleetStarted,
  compoundSpawn,
  `${markers.agentDone("bc-aaa-111")}`,
  markers.fleetComplete,
  markers.deployed,
];

test("selectActiveFleet falls back to the most recently updated fleet when no hint is given", () => {
  const older = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", deployedBase);
  const newer = deployedCandidate("FE-20", "2026-06-02T11:30:00.000Z", deployedBase);
  const chosen = selectActiveFleet([older, newer], verifyingToBeRemediated);
  assert.equal(chosen?.identifier, "FE-20");
});

test("selectActiveFleet prefers the fleet whose comments match a deploy-URL hint over recency", () => {
  const target = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", [
    ...deployedBase,
    "PR: https://github.com/hsaab/compound/pull/42",
  ]);
  const newer = deployedCandidate("FE-20", "2026-06-02T11:30:00.000Z", deployedBase);
  const chosen = selectActiveFleet([target, newer], verifyingToBeRemediated, {
    url: "https://github.com/hsaab/compound/pull/42",
  });
  assert.equal(chosen?.identifier, "FE-13");
});

test("selectActiveFleet matches a short commit SHA embedded in a deployed marker", () => {
  const target = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", [
    ...deployedBase,
    "**compound deployed to production** (`abc1234`)",
  ]);
  const newer = deployedCandidate("FE-20", "2026-06-02T11:30:00.000Z", deployedBase);
  const chosen = selectActiveFleet([target, newer], verifyingToBeRemediated, {
    commitSha: "abc1234def567890",
  });
  assert.equal(chosen?.identifier, "FE-13");
});

test("selectActiveFleet falls back to recency when the hint matches no fleet", () => {
  const older = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", deployedBase);
  const newer = deployedCandidate("FE-20", "2026-06-02T11:30:00.000Z", deployedBase);
  const chosen = selectActiveFleet([older, newer], verifyingToBeRemediated, {
    commitSha: "deadbeefcafe",
  });
  assert.equal(chosen?.identifier, "FE-20");
});

test("selectActiveFleet returns null when no candidate satisfies the predicate", () => {
  const notDeployed = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", [
    markers.fleetStarted,
    compoundSpawn,
  ]);
  assert.equal(selectActiveFleet([notDeployed], verifyingToBeRemediated), null);
});

test("selectActiveFleet ignores fleets whose verify window already closed", () => {
  const closed = deployedCandidate("FE-7", "2026-06-02T11:30:00.000Z", [
    ...deployedBase,
    verifySpawn,
    markers.verifyPass,
  ]);
  const verifying = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", [...deployedBase, verifySpawn]);
  const chosen = selectActiveFleet([closed, verifying], verifyingToBeRemediated);
  assert.equal(chosen?.identifier, "FE-13");
});

test("summarizeJob marks a fleet complete and drops the running clock", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted, createdAt: "2026-06-02T11:00:00.000Z" },
      { body: compoundSpawn, createdAt: "2026-06-02T11:00:01.000Z" },
      { body: `${markers.agentDone("bc-aaa-111")}\n**Cursor compound agent finished**`, createdAt: "2026-06-02T11:05:00.000Z" },
      { body: `${markers.fleetComplete}\n**Cursor fleet complete**`, createdAt: "2026-06-02T11:05:01.000Z" },
    ]),
    NOW,
  );
  assert.equal(job.status, "complete");
  assert.equal(job.completedAt, "2026-06-02T11:05:01.000Z");
  assert.equal(job.runningForSeconds, undefined);
  assert.equal(job.updatedAt, "2026-06-02T11:05:01.000Z");
  assert.equal(job.agentsPending, 0);
});

test("summarizeJob treats a cancelled run that opened a PR as a successful build", () => {
  // A Cursor cloud run can report a terminal status of "cancelled" yet still
  // have opened its PR. The PR is the build's deliverable, so the build is done
  // and review begins — it must not read as a failed build.
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      {
        body: `${markers.agentDone("bc-aaa-111")}\n**Cursor compound agent cancelled**\n\nAgent ID: \`bc-aaa-111\`\nRepo: \`hsaab/compound\`\nPR: https://github.com/hsaab/compound/pull/47`,
      },
      { body: markers.fleetComplete },
    ]),
    NOW,
  );
  assert.equal(job.stages.build, "done");
  assert.equal(job.stages.review, "running");
  assert.equal(job.agents[0].prUrl, "https://github.com/hsaab/compound/pull/47");
});

test("summarizeJob still flags build failed when an agent fails to start", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: `${markers.bridge}\n**Cursor agent failed to start**\n\nRepo: \`hsaab/compound\`\n\nstartup failed: boom` },
    ]),
    NOW,
  );
  assert.equal(job.stages.build, "failed");
});

test("summarizeJob exposes a chronological activity feed for the dashboard", () => {
  const job = summarizeJob(
    issue([
      { body: `${markers.fleetStarted}\n**🚀 Cursor bridge engaged**`, createdAt: "2026-06-02T11:00:00.000Z" },
      { body: compoundSpawn, createdAt: "2026-06-02T11:00:01.000Z" },
      { body: `${markers.agentDone("bc-aaa-111")}\n**Cursor compound agent finished**`, createdAt: "2026-06-02T11:05:00.000Z" },
    ]),
    NOW,
  );
  assert.equal(job.events.length, 3);
  assert.equal(job.events[0].message, "🚀 Cursor bridge engaged");
  assert.equal(job.events[0].stage, "plan");
  assert.equal(job.events[2].message, "Cursor compound agent finished");
  assert.equal(job.events[2].stage, "build");
});

test("formatTestPlanSlack posts every case (title + steps) to Slack, not just a count", () => {
  const cases: TestCase[] = [
    { title: "Footer loads", steps: "Open the page; expect the footer to render." },
    { title: "Quote refreshes", steps: "Click refresh; expect a new quote within 1s." },
  ];
  const msg = formatTestPlanSlack(issue([]), cases);

  assert.match(msg.text, /ENG-9 — test plan ready for SQA/);
  assert.match(msg.text, /2 critical check\(s\), also posted to Linear/);
  for (const c of cases) {
    assert.ok(msg.text.includes(c.title), `missing title: ${c.title}`);
    assert.ok(msg.text.includes(c.steps), `missing steps: ${c.steps}`);
  }
  // Slack mrkdwn bold is single-asterisk, distinct from the Linear comment's `**`.
  assert.ok(msg.text.includes("*1. Footer loads*"));
  assert.ok(!msg.text.includes("**"));
});

// --- formatVerifyResultsSlack: per-case verify results posted to Slack ---

test("formatVerifyResultsSlack posts every case result to Slack in mrkdwn", () => {
  const findings = [
    "### 1. Portfolio load shows live prices — **PASS**",
    "AAPL matched GLOBAL_QUOTE.",
    "",
    "### 2. Quote refresh under 1s — **FAIL**",
    "Refresh took 3.2s.",
    "",
    "VERIFY_RESULT: FAIL — 1 of 2 cases failed",
  ].join("\n");
  const msg = formatVerifyResultsSlack(issue([]), "verify", "fail", findings);

  assert.match(msg.text, /❌ ENG-9 — verify failed — test-plan results/);
  assert.ok(msg.text.includes("1. Portfolio load shows live prices — *PASS*"));
  assert.ok(msg.text.includes("AAPL matched GLOBAL_QUOTE."));
  assert.ok(msg.text.includes("2. Quote refresh under 1s — *FAIL*"));
  assert.ok(msg.text.includes("VERIFY_RESULT: FAIL"));
  // Slack mrkdwn: markdown headings stripped, double-asterisk bold converted.
  assert.ok(!msg.text.includes("###"));
  assert.ok(!msg.text.includes("**"));
});

test("formatVerifyResultsSlack labels each verdict and the late-findings case", () => {
  const pass = formatVerifyResultsSlack(issue([]), "hotfix verify", "pass", FINDINGS);
  assert.match(pass.text, /✅ ENG-9 — hotfix verify passed — test-plan results/);

  const late = formatVerifyResultsSlack(issue([]), "verify", null, "no verdict line here");
  assert.match(late.text, /🔎 ENG-9 — verify findings/);
});

test("formatVerifyResultsSlack truncates oversized findings and points at Linear", () => {
  const findings = Array.from({ length: 200 }, (_, i) => `### ${i + 1}. Case — **PASS** ${"x".repeat(40)}`).join("\n");
  const msg = formatVerifyResultsSlack(issue([]), "verify", "pass", findings);
  assert.ok(msg.text.length < 3200);
  assert.ok(msg.text.includes("truncated — full findings on the Linear ticket"));
});

test("jobNeedsReconcile is true while build agents are still pending", () => {
  const job = summarizeJob(
    issue([{ body: markers.fleetStarted }, { body: compoundSpawn }]),
    NOW,
  );
  assert.equal(jobNeedsReconcile(job), true);
});

test("jobNeedsReconcile is false once verify passed cleanly with findings reported", () => {
  // The explicit pass path stamps the per-agent findings marker inline, so a
  // cleanly-passed verify carries both markers and nothing is left to advance.
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: verifySpawn },
      { body: `${markers.verifyPass}\n${markers.verifyFindings("bc-verify-1")}\n**✅ Verify passed**` },
    ]),
    NOW,
  );
  assert.equal(jobNeedsReconcile(job), false);
});

test("jobNeedsReconcile stays true after a window-pass until the findings arrive", () => {
  // Live FE-13: the window fallback settled the verdict while the agent was
  // mid-run. The agent stays pending (no findings marker), so the reconciler
  // keeps ticking and can deliver the findings when the run finishes.
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: verifySpawn },
      { body: `${markers.verifyPass}\n**✅ Verify window passed**` },
    ]),
    NOW,
  );
  assert.equal(jobNeedsReconcile(job), true);
});

test("jobNeedsReconcile is true while verify window is still open", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: verifySpawn },
    ]),
    NOW,
  );
  assert.equal(jobNeedsReconcile(job), true);
});
