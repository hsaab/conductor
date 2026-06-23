import assert from "node:assert/strict";
import { test } from "node:test";

import { observeWindowElapsed, selectActiveFleet, summarizeJob } from "../fleet.js";
import { markers } from "../config.js";
import type { JobSummary, LinearIssuePayload } from "../types.js";

const NOW = Date.parse("2026-06-02T12:00:00.000Z");
const compoundSpawn = `${markers.bridge}\n**Cursor agent spawned**\n\nAgent ID: \`bc-aaa-111\`\nRepo: \`hsaab/compound\``;

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

test("summarizeJob keeps observe running after deploy until the window closes or an alert fires", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}\nPR: https://github.com/hsaab/compound/pull/7` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: `${markers.verified}\n**🔭 Observability:** healthy`, createdAt: "2026-06-02T12:00:00.000Z" },
    ]),
    NOW,
  );
  assert.equal(job.stages.deploy, "done");
  assert.equal(job.stages.observe, "running");
  assert.equal(job.stages.remediate, "pending");
});

test("summarizeJob closes observe cleanly on the happy path without remediation", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: markers.verified },
      { body: `${markers.observeComplete}\n**✅ Observe window passed**` },
    ]),
    NOW,
  );
  assert.equal(job.stages.observe, "done");
  assert.equal(job.stages.remediate, "pending");
});

test("observeWindowElapsed uses the verified comment as the window start", () => {
  const deployedAt = "2026-06-02T12:00:00.000Z";
  const verifiedAt = "2026-06-02T12:01:00.000Z";
  const iss = issue([
    { body: markers.deployed, createdAt: deployedAt },
    { body: markers.verified, createdAt: verifiedAt },
  ]);
  const windowMs = 120_000;
  assert.equal(observeWindowElapsed(iss, Date.parse("2026-06-02T12:02:59.000Z"), windowMs), false);
  assert.equal(observeWindowElapsed(iss, Date.parse("2026-06-02T12:03:00.000Z"), windowMs), true);
});

test("summarizeJob derives deploy/observe stages from markers", () => {
  const job = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}\nPR: https://github.com/hsaab/compound/pull/7` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
    ]),
    NOW,
  );
  assert.equal(job.stages.build, "done");
  assert.equal(job.stages.review, "done");
  assert.equal(job.stages.merge, "done");
  assert.equal(job.stages.deploy, "done");
  assert.equal(job.stages.observe, "running");
  assert.equal(job.agents[0].prUrl, "https://github.com/hsaab/compound/pull/7");
});

test("summarizeJob shows remediate running on alert, then done once the hotfix PR lands", () => {
  const dispatched = summarizeJob(
    issue([
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}` },
      { body: markers.fleetComplete },
      { body: markers.deployed },
      { body: markers.verified },
      { body: `${markers.remediationSpawned("bc-fix-222")}\n${markers.remediated}\nAgent ID: \`bc-fix-222\`\nRepo: \`hsaab/compound\`` },
    ]),
    NOW,
  );
  assert.equal(dispatched.stages.observe, "done");
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
      { body: markers.verified },
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

const observingToBeRemediated = (job: JobSummary) =>
  job.stages.observe === "running" && job.stages.remediate === "pending";

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
  const chosen = selectActiveFleet([older, newer], observingToBeRemediated);
  assert.equal(chosen?.identifier, "FE-20");
});

test("selectActiveFleet prefers the fleet whose comments match a deploy-URL hint over recency", () => {
  const target = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", [
    ...deployedBase,
    "PR: https://github.com/hsaab/compound/pull/42",
  ]);
  const newer = deployedCandidate("FE-20", "2026-06-02T11:30:00.000Z", deployedBase);
  const chosen = selectActiveFleet([target, newer], observingToBeRemediated, {
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
  const chosen = selectActiveFleet([target, newer], observingToBeRemediated, {
    commitSha: "abc1234def567890",
  });
  assert.equal(chosen?.identifier, "FE-13");
});

test("selectActiveFleet falls back to recency when the hint matches no fleet", () => {
  const older = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", deployedBase);
  const newer = deployedCandidate("FE-20", "2026-06-02T11:30:00.000Z", deployedBase);
  const chosen = selectActiveFleet([older, newer], observingToBeRemediated, {
    commitSha: "deadbeefcafe",
  });
  assert.equal(chosen?.identifier, "FE-20");
});

test("selectActiveFleet returns null when no candidate satisfies the predicate", () => {
  const notDeployed = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", [
    markers.fleetStarted,
    compoundSpawn,
  ]);
  assert.equal(selectActiveFleet([notDeployed], observingToBeRemediated), null);
});

test("selectActiveFleet ignores fleets whose observe window already closed", () => {
  const closed = deployedCandidate("FE-7", "2026-06-02T11:30:00.000Z", [
    ...deployedBase,
    markers.verified,
    markers.observeComplete,
  ]);
  const observing = deployedCandidate("FE-13", "2026-06-02T11:00:00.000Z", [...deployedBase, markers.verified]);
  const chosen = selectActiveFleet([closed, observing], observingToBeRemediated);
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
  assert.equal(job.stages.merge, "running");
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
