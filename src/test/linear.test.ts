/**
 * Unit tests for the comment-parsing helpers that back the reconciler. These
 * are pure functions (no network), so they run without any API keys.
 *
 * Run with: pnpm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bridgeReactionId,
  hasComment,
  isBridgeComment,
  issueRefFromBody,
  parseDoneAgentIds,
  parseSpawnedAgents,
} from "../linear.js";
import { markers } from "../config.js";
import type { LinearIssuePayload } from "../types.js";

function issueWith(bodies: string[]): LinearIssuePayload {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Test",
    comments: bodies.map((body) => ({ body })),
  };
}

const compoundSpawn = "**Cursor agent spawned**\n\nAgent ID: `bc-aaa-111`\nRepo: `hsaab/compound`";
const serverSpawn = "**Cursor agent spawned**\n\nAgent ID: `bc-bbb-222`\nRepo: `hsaab/server`";
const legacyHeroSpawn = "**Cursor Hero agent spawned**\n\nAgent ID: `bc-ccc-333`\nRepo: `hsaab/compound`";

test("parseSpawnedAgents extracts agent id and repo from spawn comments", () => {
  const agents = parseSpawnedAgents(issueWith([markers.fleetStarted, compoundSpawn, serverSpawn]));
  assert.deepEqual(agents, [
    { agentId: "bc-aaa-111", repo: "hsaab/compound" },
    { agentId: "bc-bbb-222", repo: "hsaab/server" },
  ]);
});

test("parseSpawnedAgents skips spawn comments without a repo line", () => {
  const agents = parseSpawnedAgents(
    issueWith(["**Cursor agent spawned**\n\nAgent ID: `bc-aaa-111`"]),
  );
  assert.deepEqual(agents, []);
});

test("parseSpawnedAgents de-duplicates repeated agent ids", () => {
  const agents = parseSpawnedAgents(issueWith([compoundSpawn, compoundSpawn]));
  assert.equal(agents.length, 1);
});

test("parseSpawnedAgents ignores completion comments", () => {
  const done = `${markers.agentDone("bc-aaa-111")}\n**Cursor compound agent finished**`;
  assert.deepEqual(parseSpawnedAgents(issueWith([done])), []);
});

test("parseDoneAgentIds reads agent-done markers", () => {
  const issue = issueWith([
    compoundSpawn,
    `${markers.agentDone("bc-aaa-111")}\n**Cursor compound agent finished**`,
  ]);
  const done = parseDoneAgentIds(issue);
  assert.ok(done.has("bc-aaa-111"));
  assert.ok(!done.has("bc-bbb-222"));
});

test("hasComment matches embedded markers", () => {
  const issue = issueWith([`${markers.fleetComplete}\n**Cursor fleet complete**`]);
  assert.ok(hasComment(issue, markers.fleetComplete));
  assert.ok(!hasComment(issue, markers.fleetStarted));
});

test("isBridgeComment recognizes every bridge marker and ignores user comments", () => {
  assert.ok(isBridgeComment(markers.fleetStarted));
  assert.ok(isBridgeComment(markers.fleetComplete));
  assert.ok(isBridgeComment(markers.agentDone("bc-aaa-111")));
  assert.ok(isBridgeComment(`${markers.bridge}\n**Cursor agent spawned**`));
  assert.ok(isBridgeComment(legacyHeroSpawn));
  assert.ok(isBridgeComment("**Cursor fleet accepted**\n\nTrigger: `linear-webhook`"));
  assert.ok(!isBridgeComment("Looks good to me, shipping this."));
  assert.ok(!isBridgeComment(null));
});

test("issueRefFromBody accepts issueId, identifier, or id and trims whitespace", () => {
  // /api/trigger and /api/reset must accept the same keys; DEMO_FLOW §7 sends `identifier`.
  assert.equal(issueRefFromBody({ issueId: "FE-7" }), "FE-7");
  assert.equal(issueRefFromBody({ identifier: "FE-13" }), "FE-13");
  assert.equal(issueRefFromBody({ id: "uuid-123" }), "uuid-123");
  assert.equal(issueRefFromBody({ identifier: "  FE-5  " }), "FE-5");
  // Precedence: issueId > identifier > id.
  assert.equal(issueRefFromBody({ issueId: "A", identifier: "B", id: "C" }), "A");
});

test("issueRefFromBody returns undefined for missing/blank/non-string refs", () => {
  assert.equal(issueRefFromBody({}), undefined);
  assert.equal(issueRefFromBody({ identifier: "   " }), undefined);
  assert.equal(issueRefFromBody({ issueId: 123 }), undefined);
  assert.equal(issueRefFromBody(undefined), undefined);
  assert.equal(issueRefFromBody(null), undefined);
});

test("bridgeReactionId is deterministic, unique per issue, and UUID-shaped", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const a = bridgeReactionId("issue-1");
  assert.equal(a, bridgeReactionId("issue-1"));
  assert.notEqual(a, bridgeReactionId("issue-2"));
  assert.match(a, uuid);
});
