import assert from "node:assert/strict";
import { test } from "node:test";

import { markers } from "../config.js";
import { routeGuidance, routingCommentBody } from "../pipeline/routing.js";
import type { PlannedTask } from "../pipeline/planner.js";

test("routeGuidance always routes through route-task and carries the planner's chosen skill", () => {
  const task: PlannedTask = {
    repo: "hsaab/compound",
    instructions: "Fix stale quotes",
    kind: "bug",
    skill: "fix-bug",
  };
  const guidance = routeGuidance(task);
  assert.match(guidance, /route-task/);
  assert.match(guidance, /suggests `fix-bug`/);
  assert.match(guidance, /not present in this repo/);
});

test("routeGuidance uses the planner reason when provided", () => {
  const task: PlannedTask = {
    repo: "hsaab/compound",
    instructions: "Fix stale quotes",
    kind: "bug",
    skill: "fix-bug",
    reason: "ticket labels Bug and mentions regression",
  };
  const guidance = routeGuidance(task);
  assert.match(guidance, /ticket labels Bug and mentions regression/);
});

test("routeGuidance lets route-task pick the skill when the planner chose none", () => {
  const task: PlannedTask = {
    repo: "hsaab/compound",
    instructions: "Add middleware",
    kind: "feature",
  };
  const guidance = routeGuidance(task);
  assert.match(guidance, /route-task/);
  assert.match(guidance, /select the child skill/);
  assert.doesNotMatch(guidance, /planner suggests/);
});

test("routingCommentBody carries the routing marker and per-task skill lines", () => {
  const body = routingCommentBody([
    { repo: "hsaab/compound", instructions: "Build chat", kind: "feature", skill: "build-feature" },
    {
      repo: "hsaab/server",
      instructions: "Fix enricher",
      kind: "bug",
      skill: "fix-bug",
      reason: "defect in request pipeline",
    },
  ]);
  assert.match(body, new RegExp(markers.routing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body, /Routing decision/);
  assert.match(body, /hsaab\/compound.*build-feature.*feature/);
  assert.match(body, /hsaab\/server.*fix-bug.*bug.*defect in request pipeline/);
});

test("routingCommentBody shows route-task when the planner chose no skill", () => {
  const body = routingCommentBody([
    { repo: "hsaab/compound", instructions: "Add tests", kind: "test" },
  ]);
  assert.match(body, /hsaab\/compound.*route-task.*test/);
  assert.match(body, /agent selects the child skill via route-task/);
});
