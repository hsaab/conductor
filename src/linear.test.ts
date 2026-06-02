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
  parseDoneAgentIds,
  parseSpawnedAgents,
} from "./linear.js";
import { markers } from "./config.js";
import type { LinearIssuePayload } from "./types.js";

function issueWith(bodies: string[]): LinearIssuePayload {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Test",
    comments: bodies.map((body) => ({ body })),
  };
}

const heroSpawn = "**Cursor Hero agent spawned**\n\nAgent ID: `bc-aaa-111`\nRepo: `hsaab/compound`";
const chorusSpawn = "**Cursor Chorus agent spawned**\n\nAgent ID: `bc-bbb-222`\nRepo: `hsaab/server`";

test("parseSpawnedAgents extracts role, id, and repo from spawn comments", () => {
  const agents = parseSpawnedAgents(issueWith([markers.fleetStarted, heroSpawn, chorusSpawn]));
  assert.deepEqual(agents, [
    { role: "hero", agentId: "bc-aaa-111", repo: "hsaab/compound" },
    { role: "chorus", agentId: "bc-bbb-222", repo: "hsaab/server" },
  ]);
});

test("parseSpawnedAgents falls back to the role's default repo when none is listed", () => {
  const agents = parseSpawnedAgents(
    issueWith(["**Cursor Hero agent spawned**\n\nAgent ID: `bc-aaa-111`"]),
  );
  assert.equal(agents.length, 1);
  assert.equal(agents[0].repo, "hsaab/compound");
});

test("parseSpawnedAgents de-duplicates repeated agent ids", () => {
  const agents = parseSpawnedAgents(issueWith([heroSpawn, heroSpawn]));
  assert.equal(agents.length, 1);
});

test("parseSpawnedAgents ignores completion comments", () => {
  const done = `${markers.agentDone("bc-aaa-111")}\n**Cursor Hero agent finished**`;
  assert.deepEqual(parseSpawnedAgents(issueWith([done])), []);
});

test("parseDoneAgentIds reads agent-done markers", () => {
  const issue = issueWith([
    heroSpawn,
    `${markers.agentDone("bc-aaa-111")}\n**Cursor Hero agent finished**`,
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
  assert.ok(isBridgeComment(`${markers.bridge}\n**Cursor Hero agent spawned**`));
  // Legacy comments (pre-marker) must still be recognized by content signature
  // so reset removes them instead of leaving them to be re-reported.
  assert.ok(isBridgeComment(heroSpawn));
  assert.ok(isBridgeComment("**Cursor fleet accepted**\n\nTrigger: `linear-poller`"));
  assert.ok(!isBridgeComment("Looks good to me, shipping this."));
  assert.ok(!isBridgeComment(null));
});

test("bridgeReactionId is deterministic, unique per issue, and UUID-shaped", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const a = bridgeReactionId("issue-1");
  assert.equal(a, bridgeReactionId("issue-1"));
  assert.notEqual(a, bridgeReactionId("issue-2"));
  assert.match(a, uuid);
});
