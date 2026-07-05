import assert from "node:assert/strict";
import { test } from "node:test";

import { markers } from "../config.js";
import { routeForKind, routeGuidance, routingCommentBody } from "../pipeline/routing.js";
import type { PlannedTask } from "../pipeline/planner.js";

test("routeForKind maps feature, bug, and test to the correct child skills", () => {
  assert.equal(routeForKind("feature").skill, "build-feature");
  assert.equal(routeForKind("bug").skill, "fix-bug");
  assert.equal(routeForKind("test").skill, "add-tests");
  assert.ok(routeForKind("feature").why.length > 0);
});

test("routeGuidance mentions route-task, kind hint, and absent-skill fallback", () => {
  const task: PlannedTask = {
    repo: "hsaab/compound",
    instructions: "Add middleware",
    kind: "bug",
  };
  const guidance = routeGuidance(task);
  assert.match(guidance, /route-task/);
  assert.match(guidance, /kind=bug/);
  assert.match(guidance, /fix-bug/);
  assert.match(guidance, /not present in this repo/);
  assert.match(guidance, /BUG task/);
});

test("routeGuidance uses planner reason when provided", () => {
  const task: PlannedTask = {
    repo: "hsaab/compound",
    instructions: "Fix stale quotes",
    kind: "bug",
    reason: "ticket labels Bug and mentions regression",
  };
  const guidance = routeGuidance(task);
  assert.match(guidance, /ticket labels Bug and mentions regression/);
});

test("routingCommentBody carries the routing marker and per-task skill lines", () => {
  const body = routingCommentBody([
    { repo: "hsaab/compound", instructions: "Build chat", kind: "feature" },
    {
      repo: "hsaab/server",
      instructions: "Fix enricher",
      kind: "bug",
      reason: "defect in request pipeline",
    },
  ]);
  assert.match(body, new RegExp(markers.routing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body, /Routing decision/);
  assert.match(body, /hsaab\/compound.*build-feature.*feature/);
  assert.match(body, /hsaab\/server.*fix-bug.*bug.*defect in request pipeline/);
});

test("routingCommentBody falls back to default rationale when reason is absent", () => {
  const body = routingCommentBody([
    { repo: "hsaab/compound", instructions: "Add tests", kind: "test" },
  ]);
  assert.match(body, /add-tests.*test/);
  assert.match(body, /test coverage/);
});
