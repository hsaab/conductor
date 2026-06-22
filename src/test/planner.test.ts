import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeKind, parsePlanText, sanitizePlan } from "../planner.js";

test("sanitizePlan normalizes bare repo names to owner/repo", () => {
  const plan = sanitizePlan([{ repo: "compound", instructions: "Add middleware", kind: "feature" }]);
  assert.deepEqual(plan, [{ repo: "hsaab/compound", instructions: "Add middleware", kind: "feature" }]);
});

test("sanitizePlan keeps fully qualified repos from the ticket", () => {
  const plan = sanitizePlan([
    { repo: "acme/web", instructions: "Update footer", kind: "feature" },
    { repo: "compound", instructions: "Add logging", kind: "bug" },
  ]);
  assert.deepEqual(plan, [
    { repo: "acme/web", instructions: "Update footer", kind: "feature" },
    { repo: "hsaab/compound", instructions: "Add logging", kind: "bug" },
  ]);
});

test("sanitizePlan deduplicates by normalized repo", () => {
  const plan = sanitizePlan([
    { repo: "compound", instructions: "First", kind: "feature" },
    { repo: "hsaab/compound", instructions: "Duplicate", kind: "feature" },
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].instructions, "First");
});

test("sanitizePlan drops empty repo or instructions", () => {
  const plan = sanitizePlan([
    { repo: "", instructions: "Nope", kind: "feature" },
    { repo: "compound", instructions: "   ", kind: "feature" },
    { repo: "server", instructions: "Valid", kind: "test" },
  ]);
  assert.deepEqual(plan, [{ repo: "hsaab/server", instructions: "Valid", kind: "test" }]);
});

test("sanitizePlan keeps repos not in the known hints list", () => {
  const plan = sanitizePlan([{ repo: "brand-new-repo", instructions: "Ship it", kind: "feature" }]);
  assert.deepEqual(plan, [{ repo: "hsaab/brand-new-repo", instructions: "Ship it", kind: "feature" }]);
});

test("sanitizePlan defaults an unknown kind to feature", () => {
  const plan = sanitizePlan([
    { repo: "compound", instructions: "Do it", kind: "nonsense" as unknown as "feature" },
  ]);
  assert.equal(plan[0].kind, "feature");
});

test("normalizeKind accepts known kinds and falls back to feature", () => {
  assert.equal(normalizeKind("bug"), "bug");
  assert.equal(normalizeKind("TEST"), "test");
  assert.equal(normalizeKind("feature"), "feature");
  assert.equal(normalizeKind(undefined), "feature");
  assert.equal(normalizeKind("weird"), "feature");
});

test("parsePlanText reads a bare JSON object from the agent reply", () => {
  const text = '{"tasks":[{"repo":"acme/web","kind":"bug","instructions":"Update footer"}]}';
  assert.deepEqual(parsePlanText(text), [{ repo: "acme/web", instructions: "Update footer", kind: "bug" }]);
});

test("parsePlanText defaults kind to feature when omitted", () => {
  const text = '{"tasks":[{"repo":"compound","instructions":"Add middleware"}]}';
  assert.deepEqual(parsePlanText(text), [{ repo: "compound", instructions: "Add middleware", kind: "feature" }]);
});

test("parsePlanText reads JSON wrapped in a fenced block and surrounding prose", () => {
  const text = 'Here is the plan:\n```json\n{"tasks":[{"repo":"compound","kind":"test","instructions":"Add middleware"}]}\n```\nDone.';
  assert.deepEqual(parsePlanText(text), [{ repo: "compound", instructions: "Add middleware", kind: "test" }]);
});

test("parsePlanText returns empty on unparseable text", () => {
  assert.deepEqual(parsePlanText("no json here"), []);
  assert.deepEqual(parsePlanText(""), []);
});
