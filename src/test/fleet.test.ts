import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeJob } from "../fleet.js";
import { markers } from "../config.js";
import type { LinearIssuePayload } from "../types.js";

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
