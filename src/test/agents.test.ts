import assert from "node:assert/strict";
import { test } from "node:test";

import { isRunReportable, type AgentRunStatus } from "../agents.js";

test("isRunReportable reports a published PR even while the run is still running", () => {
  // The case that left the dashboard's build stage stuck on "running": the cloud
  // run opens its PR (the deliverable) but keeps running, so it is not terminal.
  const status: AgentRunStatus = {
    terminal: false,
    status: "running",
    prUrl: "https://github.com/hsaab/compound/pull/7",
  };
  assert.equal(isRunReportable(status), true);
});

test("isRunReportable reports a terminal run that produced no PR", () => {
  // A finished/cancelled/errored run with no PR has nothing more coming, so it
  // is reportable (and surfaces as a build with no PR rather than hanging).
  assert.equal(isRunReportable({ terminal: true, status: "finished" }), true);
  assert.equal(isRunReportable({ terminal: true, status: "cancelled" }), true);
});

test("isRunReportable does NOT report a still-running run with no PR yet", () => {
  // No PR and not terminal means the build is genuinely still in progress.
  assert.equal(isRunReportable({ terminal: false, status: "running" }), false);
});
