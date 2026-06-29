import assert from "node:assert/strict";
import { test } from "node:test";

import { parseEvents } from "../pipeline/events.js";
import { markers } from "../config.js";
import type { LinearIssuePayload } from "../types.js";

function issue(comments: Array<{ body: string; createdAt?: string }>): LinearIssuePayload {
  return { id: "i", identifier: "ENG-9", title: "T", state: { name: "In Progress" }, comments };
}

test("parseEvents builds a chronological, marker-free activity feed", () => {
  const events = parseEvents(
    issue([
      {
        body: `${markers.fleetStarted}\n**🚀 Cursor bridge engaged — planning the fleet**\n\nTrigger: \`linear-webhook\``,
        createdAt: "2026-06-02T11:00:00.000Z",
      },
      {
        body: `${markers.bridge}\n**Cursor agent spawned**\n\nAgent ID: \`bc-aaa-111\`\nRepo: \`hsaab/compound\``,
        createdAt: "2026-06-02T11:00:05.000Z",
      },
    ]),
  );

  assert.equal(events.length, 2);
  // Headline is the first readable line, with markdown/markers stripped.
  assert.equal(events[0].message, "🚀 Cursor bridge engaged — planning the fleet");
  assert.equal(events[0].stage, "plan");
  assert.ok(!events[0].message.includes("<!--"));
  // Supporting lines collapse into detail.
  assert.equal(events[1].message, "Cursor agent spawned");
  assert.equal(events[1].stage, "build");
  assert.ok(events[1].detail?.includes("Agent ID: bc-aaa-111"));
});

test("parseEvents sorts out-of-order comments and ignores non-conductor noise", () => {
  const events = parseEvents(
    issue([
      { body: `${markers.deployed}\n**🚀 compound deployed to production**`, createdAt: "2026-06-02T12:00:00.000Z" },
      { body: "just a human comment with no markers", createdAt: "2026-06-02T11:30:00.000Z" },
      { body: `${markers.fleetStarted}\n**🚀 engaged**`, createdAt: "2026-06-02T11:00:00.000Z" },
    ]),
  );

  assert.equal(events.length, 2);
  assert.equal(events[0].stage, "plan");
  assert.equal(events[1].stage, "deploy");
});

test("parseEvents tags each pipeline stage from its hidden marker", () => {
  const events = parseEvents(
    issue([
      {
        body: `${markers.verifyPass}\n**✅ Verify passed**`,
        createdAt: "2026-06-02T13:00:00.000Z",
      },
      { body: `${markers.remediationDone("bc-fix-222")}\n**🛠️ Hotfix PR opened**`, createdAt: "2026-06-02T14:00:00.000Z" },
    ]),
  );

  assert.equal(events[0].stage, "verify");
  assert.equal(events[1].stage, "remediate");
});
