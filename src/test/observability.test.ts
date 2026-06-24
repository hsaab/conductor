import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDeployAnnouncement } from "../observability.js";
import type { ServiceHealth } from "../datadog.js";

const unknown: ServiceHealth = { errors: null, unknown: true };

test("a fresh deploy announces shipped + scanning, never healthy", () => {
  const a = buildDeployAnnouncement("compound", unknown, 2);
  assert.equal(a.headline, "🚀 compound shipped to production");
  assert.match(a.scanLine, /watching production logs and errors for 2 min/);
  assert.equal(a.observeNote, "");
  assert.doesNotMatch(a.headline, /healthy|no errors/i);
  assert.doesNotMatch(a.scanLine, /healthy|no errors/i);
});

test("no Datadog signal is treated as nothing-to-warn, not healthy", () => {
  const a = buildDeployAnnouncement("compound", { errors: 0, unknown: false }, 5);
  assert.equal(a.headline, "🚀 compound shipped to production");
  assert.equal(a.observeNote, "");
});

test("errors already present surface as a warning, not a verdict", () => {
  const a = buildDeployAnnouncement("compound", { errors: 3, unknown: false }, 2);
  assert.equal(a.headline, "⚠️ compound shipped with errors already in production");
  assert.match(a.scanLine, /3 error logs already in production/);
  assert.match(a.observeNote, /3 error logs already present\. $/);
});

test("a single already-present error is singular", () => {
  const a = buildDeployAnnouncement("compound", { errors: 1, unknown: false }, 2);
  assert.match(a.scanLine, /1 error log already in production/);
  assert.doesNotMatch(a.scanLine, /1 error logs/);
});
