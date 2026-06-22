import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePlanText, sanitizePlan } from "../planner.js";

test("sanitizePlan normalizes bare repo names to owner/repo", () => {
  const plan = sanitizePlan([{ repo: "compound", instructions: "Add middleware" }]);
  assert.deepEqual(plan, [{ repo: "hsaab/compound", instructions: "Add middleware" }]);
});

test("sanitizePlan keeps fully qualified repos from the ticket", () => {
  const plan = sanitizePlan([
    { repo: "acme/web", instructions: "Update footer" },
    { repo: "compound", instructions: "Add logging" },
  ]);
  assert.deepEqual(plan, [
    { repo: "acme/web", instructions: "Update footer" },
    { repo: "hsaab/compound", instructions: "Add logging" },
  ]);
});

test("sanitizePlan deduplicates by normalized repo", () => {
  const plan = sanitizePlan([
    { repo: "compound", instructions: "First" },
    { repo: "hsaab/compound", instructions: "Duplicate" },
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].instructions, "First");
});

test("sanitizePlan drops empty repo or instructions", () => {
  const plan = sanitizePlan([
    { repo: "", instructions: "Nope" },
    { repo: "compound", instructions: "   " },
    { repo: "server", instructions: "Valid" },
  ]);
  assert.deepEqual(plan, [{ repo: "hsaab/server", instructions: "Valid" }]);
});

test("sanitizePlan keeps repos not in the known hints list", () => {
  const plan = sanitizePlan([{ repo: "brand-new-repo", instructions: "Ship it" }]);
  assert.deepEqual(plan, [{ repo: "hsaab/brand-new-repo", instructions: "Ship it" }]);
});

test("parsePlanText reads a bare JSON object from the agent reply", () => {
  const text = '{"tasks":[{"repo":"acme/web","instructions":"Update footer"}]}';
  assert.deepEqual(parsePlanText(text), [{ repo: "acme/web", instructions: "Update footer" }]);
});

test("parsePlanText reads JSON wrapped in a fenced block and surrounding prose", () => {
  const text = 'Here is the plan:\n```json\n{"tasks":[{"repo":"compound","instructions":"Add middleware"}]}\n```\nDone.';
  assert.deepEqual(parsePlanText(text), [{ repo: "compound", instructions: "Add middleware" }]);
});

test("parsePlanText returns empty on unparseable text", () => {
  assert.deepEqual(parsePlanText("no json here"), []);
  assert.deepEqual(parsePlanText(""), []);
});
