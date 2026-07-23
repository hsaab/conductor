/**
 * Unit tests for the Datadog remediation webhook's pure decision helpers.
 * No network: these exercise payload parsing and the dispatch gate only.
 *
 * Run with: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractAlert,
  isDispatchableAlert,
  isRemediable,
  shouldDispatchToFleet,
} from "../pipeline/remediation.js";
import { INITIAL_PIPELINE_CYCLE } from "../pipeline/cycle.js";
import { summarizeJob } from "../pipeline/fleet.js";
import { verifyWindowElapsed } from "../pipeline/verify.js";
import { markers } from "../config.js";
import type { LinearIssuePayload } from "../types.js";

/** Mirrors the custom payload Datadog sends (scripts/setup-datadog.mjs). */
const realDatadogPayload = {
  title: "compound — market quotes latency",
  body: "responseTime 4200ms > 1500ms",
  alert_type: "error",
  route: "/api/market/quotes",
  monitor_id: "12345",
};

const compoundSpawn = `${markers.bridge}\n**Cursor agent spawned**\n\nAgent ID: \`bc-aaa-111\`\nRepo: \`hsaab/compound\``;
const verifySpawn = `${markers.verifySpawned("bc-verify-1")}\n**Verify agent dispatched**\n\nAgent ID: \`bc-verify-1\``;

/**
 * A fleet whose feature shipped, deployed, and PASSED the functional verify test
 * plan — the exact happy path whose latency regression the Datadog synthetic must
 * still be able to remediate. Deployed marker + verify-agent comment are stamped
 * so {@link verifyWindowElapsed} can measure the post-deploy observe window.
 */
function deployedVerifyPassedIssue(): LinearIssuePayload {
  return {
    id: "fe-13",
    identifier: "FE-13",
    title: "Portfolio prices look stale",
    state: { name: "In Progress" },
    comments: [
      { body: markers.fleetStarted },
      { body: compoundSpawn },
      { body: `${markers.agentDone("bc-aaa-111")}\nPR: https://github.com/hsaab/compound/pull/78` },
      { body: markers.fleetComplete },
      { body: markers.deployed, createdAt: "2026-06-02T12:00:00.000Z" },
      { body: verifySpawn, createdAt: "2026-06-02T12:00:05.000Z" },
      { body: `${markers.verifyPass}\n**✅ Verify passed**` },
    ],
  };
}

const WINDOW_MS = 120_000;

test("isDispatchableAlert rejects an empty body (wrong/no Content-Type leaves req.body={})", () => {
  const { alert, alertType } = extractAlert({});
  // extractAlert defaults the title but leaves alert_type/route undefined.
  assert.equal(alertType, undefined);
  assert.equal(isDispatchableAlert(alert, alertType), false);
});

test("isDispatchableAlert rejects a payload with only an unknown alert_type and no latency markers", () => {
  const { alert, alertType } = extractAlert({ alert_type: "info", title: "Datadog daily digest" });
  assert.equal(isDispatchableAlert(alert, alertType), false);
});

test("isDispatchableAlert accepts the real Datadog custom payload (firing type + route)", () => {
  const { alert, alertType } = extractAlert(realDatadogPayload);
  assert.equal(isDispatchableAlert(alert, alertType), true);
});

test("isDispatchableAlert accepts a firing alert_type even without a route", () => {
  const { alert, alertType } = extractAlert({ alert_type: "error", title: "Monitor triggered" });
  assert.equal(isDispatchableAlert(alert, alertType), true);
});

test("isDispatchableAlert accepts a latency-route match even when alert_type is absent", () => {
  const { alert, alertType } = extractAlert({ route: "/api/market/quotes", title: "latency" });
  assert.equal(alertType, undefined);
  assert.equal(isDispatchableAlert(alert, alertType), true);
});

test("shouldDispatchToFleet does not dispatch when no fleet matches (prevents unbounded spawns)", () => {
  const decision = shouldDispatchToFleet({ hasFleet: false, withinWindow: false, alreadyRemediated: false, inFlight: false });
  assert.equal(decision.dispatch, false);
  assert.match(decision.dispatch === false ? decision.reason : "", /no deployed fleet/);
});

test("shouldDispatchToFleet does not dispatch once the post-deploy observe window has elapsed", () => {
  const decision = shouldDispatchToFleet({ hasFleet: true, withinWindow: false, alreadyRemediated: false, inFlight: false });
  assert.equal(decision.dispatch, false);
  assert.match(decision.dispatch === false ? decision.reason : "", /observe window elapsed/);
});

test("shouldDispatchToFleet does not dispatch when the fleet was already remediated", () => {
  const decision = shouldDispatchToFleet({ hasFleet: true, withinWindow: true, alreadyRemediated: true, inFlight: false });
  assert.equal(decision.dispatch, false);
  assert.match(decision.dispatch === false ? decision.reason : "", /already dispatched/);
});

test("shouldDispatchToFleet does not dispatch when remediation is already in flight (concurrency guard)", () => {
  const decision = shouldDispatchToFleet({ hasFleet: true, withinWindow: true, alreadyRemediated: false, inFlight: true });
  assert.equal(decision.dispatch, false);
  assert.match(decision.dispatch === false ? decision.reason : "", /in flight/);
});

test("shouldDispatchToFleet dispatches for a clean matched fleet inside the window", () => {
  const decision = shouldDispatchToFleet({ hasFleet: true, withinWindow: true, alreadyRemediated: false, inFlight: false });
  assert.equal(decision.dispatch, true);
});

// --- Decoupling remediation from the functional verify verdict ---

test("isRemediable stays true after a clean verify pass (a slow-but-working deploy is still remediable)", () => {
  const job = summarizeJob(deployedVerifyPassedIssue(), Date.parse("2026-06-02T12:01:00.000Z"));
  // The functional test plan passed: the feature works, so verify is "done"
  // (not "running"). The old gate keyed on `verify === "running"`, so it dropped
  // a latency alert for exactly this fleet — that is the regression this guards.
  assert.equal(job.stages.verify, "done");
  // Deployed + not-yet-remediated ⇒ a Datadog latency alert can still remediate.
  assert.equal(job.stages.deploy, "done");
  assert.equal(job.stages.remediate, "pending");
  assert.equal(isRemediable(job), true);
});

test("isRemediable is false before deploy and once remediation was dispatched", () => {
  const notDeployed = summarizeJob(
    { id: "x", identifier: "FE-1", title: "T", state: { name: "In Progress" }, comments: [
      { body: markers.fleetStarted },
      { body: compoundSpawn },
    ] },
    Date.parse("2026-06-02T12:01:00.000Z"),
  );
  assert.equal(isRemediable(notDeployed), false);

  const alreadyRemediated = summarizeJob(
    { id: "y", identifier: "FE-2", title: "T", state: { name: "In Progress" }, comments: [
      ...deployedVerifyPassedIssue().comments!,
      { body: `${markers.remediationSpawned("bc-fix-1")}\n${markers.remediated}` },
    ] },
    Date.parse("2026-06-02T12:01:00.000Z"),
  );
  assert.equal(alreadyRemediated.stages.remediate, "running");
  assert.equal(isRemediable(alreadyRemediated), false);
});

test("a latency alert after a clean verify still dispatches within the observe window", () => {
  const iss = deployedVerifyPassedIssue();
  const withinWindow = !verifyWindowElapsed(iss, Date.parse("2026-06-02T12:01:59.000Z"), WINDOW_MS, INITIAL_PIPELINE_CYCLE);
  assert.equal(withinWindow, true);
  const decision = shouldDispatchToFleet({ hasFleet: true, withinWindow, alreadyRemediated: false, inFlight: false });
  assert.equal(decision.dispatch, true);
});

test("the same latency alert is ignored once the observe window elapses", () => {
  const iss = deployedVerifyPassedIssue();
  const withinWindow = !verifyWindowElapsed(iss, Date.parse("2026-06-02T12:05:00.000Z"), WINDOW_MS, INITIAL_PIPELINE_CYCLE);
  assert.equal(withinWindow, false);
  const decision = shouldDispatchToFleet({ hasFleet: true, withinWindow, alreadyRemediated: false, inFlight: false });
  assert.equal(decision.dispatch, false);
  assert.match(decision.dispatch === false ? decision.reason : "", /observe window elapsed/);
});
