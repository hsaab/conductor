import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatVerifyResultsSlack,
  shouldCloseVerifyWindow,
  shouldReportVerifyFindings,
  verifyFindingsComment,
  verifyWindowElapsed,
} from "../pipeline/verify.js";
import { HOTFIX_PIPELINE_CYCLE, INITIAL_PIPELINE_CYCLE } from "../pipeline/cycle.js";
import { parseVerifyFindingsIds } from "../integrations/linear.js";
import { markers } from "../config.js";
import type { LinearIssuePayload } from "../types.js";

const NOW = Date.parse("2026-06-02T12:00:00.000Z");

const verifySpawn = `${markers.verifySpawned("bc-verify-1")}\n**Verify agent dispatched**\n\nAgent ID: \`bc-verify-1\`\nRepo: \`hsaab/compound\``;

function issue(comments: Array<{ body: string; createdAt?: string }>): LinearIssuePayload {
  return { id: "i", identifier: "ENG-9", title: "T", state: { name: "In Progress" }, comments };
}

// --- verify findings: report the test-plan evidence exactly once per agent ---

const FINDINGS = `### 1. Portfolio load shows live prices — **PASS**\nAAPL matched GLOBAL_QUOTE.\n\nVERIFY_RESULT: PASS — all five cases passed`;

test("verify findings post once even after a window-pass already closed the stage", () => {
  // Live FE-13 incident: the (old) window fallback posted verify-pass at
  // 16:29:59; the verify agent finished later with full per-case findings and
  // they were never posted. A settled verdict must not swallow the findings.
  const settled = issue([
    { body: markers.deployed },
    { body: verifySpawn },
    { body: `${markers.verifyPass}\n**✅ Verify window passed**` },
  ]);
  assert.equal(
    shouldReportVerifyFindings({
      terminal: true,
      alreadyReported: parseVerifyFindingsIds(settled).has("bc-verify-1"),
    }),
    true,
  );
});

test("verify findings comment round-trips through the per-agent marker (idempotency)", () => {
  const body = verifyFindingsComment("bc-verify-1", FINDINGS);
  assert.ok(body.includes(markers.verifyFindings("bc-verify-1")));
  assert.ok(body.includes("bc-verify-1"));
  assert.ok(body.includes("VERIFY_RESULT: PASS"));

  const reported = issue([
    { body: markers.deployed },
    { body: verifySpawn },
    { body: `${markers.verifyPass}\n**✅ Verify window passed**` },
    { body },
  ]);
  assert.equal(parseVerifyFindingsIds(reported).has("bc-verify-1"), true);
  assert.equal(
    shouldReportVerifyFindings({
      terminal: true,
      alreadyReported: parseVerifyFindingsIds(reported).has("bc-verify-1"),
    }),
    false,
  );
});

test("a verdict comment that embeds the findings marker also counts as reported", () => {
  // The explicit pass/fail paths embed resultText, so they stamp the per-agent
  // findings marker inline — a later tick must not post a duplicate report.
  const verdictWithFindings = issue([
    { body: markers.deployed },
    { body: verifySpawn },
    { body: `${markers.verifyPass}\n${markers.verifyFindings("bc-verify-1")}\n**✅ Verify passed**\n\n${FINDINGS}` },
  ]);
  assert.equal(parseVerifyFindingsIds(verdictWithFindings).has("bc-verify-1"), true);
});

test("a still-running verify agent posts no findings", () => {
  assert.equal(shouldReportVerifyFindings({ terminal: false, alreadyReported: false }), false);
});

// --- shouldCloseVerifyWindow: the window-elapsed fallback's pure gate ---

test("window fallback never closes verify while remediation is dispatched", () => {
  // Live FE-13 incident: Datadog dispatched a hotfix at 16:28:53, yet the window
  // fallback posted "✅ Verify window passed" at 16:29:59. Remediation IS a
  // reported failure (via Datadog), so the all-clear must not fire.
  const decision = shouldCloseVerifyWindow({
    hasVerifyAgents: true,
    windowElapsed: true,
    remediated: true,
    verifyRunActive: false,
  });
  assert.equal(decision.close, false);
  assert.match(decision.close === false ? decision.reason : "", /remediation/);
});

test("window fallback lets the window slide while the verify run is still active", () => {
  // The 2-min window routinely elapses mid-run (verify agents take longer).
  // An active run means the verdict is still coming: do nothing this tick.
  const decision = shouldCloseVerifyWindow({
    hasVerifyAgents: true,
    windowElapsed: true,
    remediated: false,
    verifyRunActive: true,
  });
  assert.equal(decision.close, false);
  assert.match(decision.close === false ? decision.reason : "", /still running/);
});

test("window fallback closes verify when the run ended without a verdict", () => {
  const decision = shouldCloseVerifyWindow({
    hasVerifyAgents: true,
    windowElapsed: true,
    remediated: false,
    verifyRunActive: false,
  });
  assert.equal(decision.close, true);
});

test("window fallback stays quiet before the window elapses or without agents", () => {
  assert.equal(
    shouldCloseVerifyWindow({ hasVerifyAgents: true, windowElapsed: false, remediated: false, verifyRunActive: false }).close,
    false,
  );
  assert.equal(
    shouldCloseVerifyWindow({ hasVerifyAgents: false, windowElapsed: true, remediated: false, verifyRunActive: false }).close,
    false,
  );
});

// --- verifyWindowElapsed: per-cycle window timing ---

test("verifyWindowElapsed uses the verify-agent comment as the window start", () => {
  const deployedAt = "2026-06-02T12:00:00.000Z";
  const verifyAt = "2026-06-02T12:01:00.000Z";
  const iss = issue([
    { body: markers.deployed, createdAt: deployedAt },
    { body: verifySpawn, createdAt: verifyAt },
  ]);
  const windowMs = 120_000;
  assert.equal(
    verifyWindowElapsed(iss, Date.parse("2026-06-02T12:02:59.000Z"), windowMs, INITIAL_PIPELINE_CYCLE),
    false,
  );
  assert.equal(
    verifyWindowElapsed(iss, Date.parse("2026-06-02T12:03:00.000Z"), windowMs, INITIAL_PIPELINE_CYCLE),
    true,
  );
});

test("verifyWindowElapsed scopes the hotfix cycle to the hotfix deploy and spawn", () => {
  const iss = issue([
    { body: markers.deployed, createdAt: "2026-06-02T11:00:00.000Z" },
    { body: verifySpawn, createdAt: "2026-06-02T11:01:00.000Z" },
    { body: markers.hotfixDeployed, createdAt: "2026-06-02T11:59:00.000Z" },
  ]);
  const windowMs = 120_000;
  // Initial window (started ~an hour ago) has long elapsed; the hotfix window
  // (started at 11:59) has not.
  assert.equal(verifyWindowElapsed(iss, NOW, windowMs, INITIAL_PIPELINE_CYCLE), true);
  assert.equal(verifyWindowElapsed(iss, NOW, windowMs, HOTFIX_PIPELINE_CYCLE), false);
  assert.equal(
    verifyWindowElapsed(iss, Date.parse("2026-06-02T12:01:00.000Z"), windowMs, HOTFIX_PIPELINE_CYCLE),
    true,
  );
});

// --- formatVerifyResultsSlack: per-case verify results posted to Slack ---

test("formatVerifyResultsSlack posts every case result to Slack in mrkdwn", () => {
  const findings = [
    "### 1. Portfolio load shows live prices — **PASS**",
    "AAPL matched GLOBAL_QUOTE.",
    "",
    "### 2. Quote refresh under 1s — **FAIL**",
    "Refresh took 3.2s.",
    "",
    "VERIFY_RESULT: FAIL — 1 of 2 cases failed",
  ].join("\n");
  const msg = formatVerifyResultsSlack(issue([]), "verify", "fail", findings);

  assert.match(msg.text, /❌ ENG-9 — verify failed — test-plan results/);
  assert.ok(msg.text.includes("1. Portfolio load shows live prices — *PASS*"));
  assert.ok(msg.text.includes("AAPL matched GLOBAL_QUOTE."));
  assert.ok(msg.text.includes("2. Quote refresh under 1s — *FAIL*"));
  assert.ok(msg.text.includes("VERIFY_RESULT: FAIL"));
  // Slack mrkdwn: markdown headings stripped, double-asterisk bold converted.
  assert.ok(!msg.text.includes("###"));
  assert.ok(!msg.text.includes("**"));
});

test("formatVerifyResultsSlack labels each verdict and the late-findings case", () => {
  const pass = formatVerifyResultsSlack(issue([]), "hotfix verify", "pass", FINDINGS);
  assert.match(pass.text, /✅ ENG-9 — hotfix verify passed — test-plan results/);

  const late = formatVerifyResultsSlack(issue([]), "verify", null, "no verdict line here");
  assert.match(late.text, /🔎 ENG-9 — verify findings/);
});

test("formatVerifyResultsSlack truncates oversized findings and points at Linear", () => {
  const findings = Array.from({ length: 200 }, (_, i) => `### ${i + 1}. Case — **PASS** ${"x".repeat(40)}`).join("\n");
  const msg = formatVerifyResultsSlack(issue([]), "verify", "pass", findings);
  assert.ok(msg.text.length < 3200);
  assert.ok(msg.text.includes("truncated — full findings on the Linear ticket"));
});
