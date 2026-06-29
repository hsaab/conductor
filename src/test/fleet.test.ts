import assert from "node:assert/strict";
import { test } from "node:test";

import { jobNeedsReconcile, verifyWindowElapsed, selectActiveFleet, summarizeJob } from "../pipeline/fleet.js";
import { markers } from "../config.js";
import type { JobSummary, LinearIssuePayload } from "../types.js";

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

test("summarizeJob shows remediate running on alert, then done once the hotfix PR lands", () => {
  const dispatched = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: verifySpawn },
      { body: `${markers.remediationSpawned("bc-fix-222")}\n${markers.remediated}\nAgent ID: \`bc-fix-222\`\nRepo: \`hsaab/compound\`` },
    ]),
    NOW,
  );
  assert.equal(dispatched.stages.verify, "done");
  assert.equal(dispatched.stages.remediate, "running");
  // The remediation agent appears as a separate role, not a build agent.
  assert.equal(dispatched.agents.filter((a) => a.role === "remediation").length, 1);
  assert.equal(dispatched.stages.build, "done");

  const fixed = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: verifySpawn },
      { body: `${markers.remediationSpawned("bc-fix-222")}\n${markers.remediated}\nAgent ID: \`bc-fix-222\`\nRepo: \`hsaab/compound\`` },
      { body: `${markers.remediationDone("bc-fix-222")}\nPR: https://github.com/hsaab/compound/pull/9` },
    ]),
    NOW,
  );
  assert.equal(fixed.stages.remediate, "done");
  const remAgent = fixed.agents.find((a) => a.role === "remediation");
  assert.equal(remAgent?.prUrl, "https://github.com/hsaab/compound/pull/9");
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

test("jobNeedsReconcile is true while build agents are still pending", () => {
  const job = summarizeJob(
    issue([{ body: markers.fleetStarted }, { body: compoundSpawn }]),
    NOW,
  );
  assert.equal(jobNeedsReconcile(job), true);
});

test("jobNeedsReconcile is false once verify passed cleanly", () => {
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
  assert.equal(jobNeedsReconcile(job), false);
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
