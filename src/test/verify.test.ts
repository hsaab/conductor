import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatVerifyResultsSlack,
  parseVerifyFindings,
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

// --- parseVerifyFindings: typed parse of the verify agent's markdown ---

const STRUCTURED_FINDINGS = [
  "Verified against production.",
  "",
  "### 1. Portfolio load shows live prices — **PASS**",
  "AAPL matched GLOBAL_QUOTE.",
  "#### Observed behavior",
  "Prices updated on load.",
  "",
  "### 2. Quote refresh under 1s - FAIL",
  "Refresh took 3.2s.",
  "",
  "### 3. Notes",
  "Manual follow-up needed.",
  "",
  "VERIFY_RESULT: FAIL — 1 of 2 cases failed",
].join("\n");

test("parseVerifyFindings splits cases, statuses, evidence, preamble, and verdict summary", () => {
  const parsed = parseVerifyFindings(STRUCTURED_FINDINGS);

  assert.equal(parsed.cases.length, 3);
  // A mid-case sub-heading is evidence (prefix stripped), not a new case.
  assert.deepEqual(parsed.cases[0], {
    title: "1. Portfolio load shows live prices",
    status: "pass",
    evidence: ["AAPL matched GLOBAL_QUOTE.", "Observed behavior", "Prices updated on load."],
  });
  // Plain hyphen and unbolded status still parse.
  assert.deepEqual(parsed.cases[1], {
    title: "2. Quote refresh under 1s",
    status: "fail",
    evidence: ["Refresh took 3.2s."],
  });
  // Heading without a status suffix keeps its full title and a null status.
  assert.deepEqual(parsed.cases[2], {
    title: "3. Notes",
    status: null,
    evidence: ["Manual follow-up needed."],
  });
  assert.deepEqual(parsed.preamble, ["Verified against production."]);
  assert.equal(parsed.verdictSummary, "1 of 2 cases failed");
});

test("parseVerifyFindings returns a null summary when the verdict line has no dash", () => {
  const parsed = parseVerifyFindings("### 1. Case — **PASS**\nVERIFY_RESULT: PASS");
  assert.equal(parsed.cases.length, 1);
  assert.equal(parsed.verdictSummary, null);
  // The VERIFY_RESULT line never leaks into evidence or preamble.
  assert.deepEqual(parsed.cases[0].evidence, []);
  assert.deepEqual(parsed.preamble, []);
});

test("parseVerifyFindings puts unparseable input in the preamble with zero cases", () => {
  const parsed = parseVerifyFindings("the agent rambled\nwithout any headings");
  assert.deepEqual(parsed.cases, []);
  assert.equal(parsed.verdictSummary, null);
  assert.deepEqual(parsed.preamble, ["the agent rambled", "without any headings"]);
});

// --- formatVerifyResultsSlack: per-case verify results posted to Slack ---

interface TestBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
}

function blocksOf(msg: { blocks?: unknown[] }): TestBlock[] {
  return (msg.blocks ?? []) as TestBlock[];
}

test("formatVerifyResultsSlack renders one Block Kit section per parsed case", () => {
  const iss = { ...issue([]), url: "https://linear.app/acme/issue/ENG-9" };
  const msg = formatVerifyResultsSlack(iss, "verify", "fail", STRUCTURED_FINDINGS);
  const blocks = blocksOf(msg);

  assert.deepEqual(blocks[0], {
    type: "header",
    text: { type: "plain_text", text: "❌ ENG-9 · verify failed" },
  });
  assert.equal(
    blocks[1].text?.text,
    "*T*\nVerified against production.\n1/2 checks passed\n<https://linear.app/acme/issue/ENG-9|View on Linear>",
  );
  assert.equal(blocks[2].type, "divider");

  const sections = blocks.filter((b) => b.type === "section").map((b) => b.text?.text ?? "");
  assert.ok(
    sections.includes(
      "✅ *1. Portfolio load shows live prices*\nAAPL matched GLOBAL_QUOTE.\nObserved behavior\nPrices updated on load.",
    ),
  );
  assert.ok(sections.includes("❌ *2. Quote refresh under 1s*\nRefresh took 3.2s."));
  assert.ok(sections.includes("▫️ *3. Notes*\nManual follow-up needed."));

  const contexts = blocks.filter((b) => b.type === "context").map((b) => b.elements?.[0]?.text);
  assert.deepEqual(contexts, ["VERIFY_RESULT: FAIL — 1 of 2 cases failed", "conductor"]);

  // Notification fallback text: headline, title, preamble, one line per case, verdict.
  assert.match(msg.text, /^❌ ENG-9 · verify failed\nT\nVerified against production\.\n/);
  assert.ok(msg.text.includes("✅ 1. Portfolio load shows live prices"));
  assert.ok(msg.text.includes("VERIFY_RESULT: FAIL — 1 of 2 cases failed"));
  assert.ok(!msg.text.includes("###"));
  assert.ok(!msg.text.includes("**"));
});

test("formatVerifyResultsSlack labels each verdict and the late-findings case", () => {
  const pass = formatVerifyResultsSlack(issue([]), "hotfix verify", "pass", FINDINGS);
  assert.equal(blocksOf(pass)[0].text?.text, "✅ ENG-9 · hotfix verify passed");
  assert.match(pass.text, /VERIFY_RESULT: PASS — all five cases passed/);

  const late = formatVerifyResultsSlack(issue([]), "verify", null, "### 1. Case\nno verdict line here");
  assert.equal(blocksOf(late)[0].text?.text, "🔎 ENG-9 · verify findings");
});

test("formatVerifyResultsSlack caps rendered cases at 10 and evidence at 300 chars", () => {
  const findings = Array.from(
    { length: 12 },
    (_, i) => `### ${i + 1}. Case — **PASS**\n${"x".repeat(400)}`,
  ).join("\n");
  const msg = formatVerifyResultsSlack(issue([]), "verify", "pass", findings);
  const sections = blocksOf(msg).filter((b) => b.type === "section");

  // Summary section + 10 case sections + the overflow pointer.
  assert.equal(sections.length, 12);
  assert.equal(sections[11].text?.text, "… 2 more check(s) — full findings on the Linear ticket");
  const caseText = sections[1].text?.text ?? "";
  assert.ok(caseText.endsWith("…"));
  assert.ok(caseText.length < 350);
  assert.ok(msg.text.length < 3000);
});

test("formatVerifyResultsSlack caps a pathologically long case title so the section stays under Slack's limit", () => {
  const longTitle = "x".repeat(5000);
  const msg = formatVerifyResultsSlack(issue([]), "verify", "pass", `### 1. ${longTitle} — **PASS**\nevidence`);
  const caseSection = blocksOf(msg)
    .filter((b) => b.type === "section")
    .find((b) => b.text?.text.startsWith("✅"));

  assert.ok(caseSection);
  assert.ok((caseSection.text?.text.length ?? 0) < 3000);
  assert.ok(caseSection.text?.text.includes("…"));
});

test("capText truncation never severs an emoji surrogate pair", () => {
  // 400 rocket emojis (each a UTF-16 surrogate pair) as evidence: the 300-char
  // cap must land on a whole emoji, never half of one.
  const msg = formatVerifyResultsSlack(issue([]), "verify", "pass", `### 1. Case — **PASS**\n${"🚀".repeat(400)}`);
  const caseSection = blocksOf(msg)
    .filter((b) => b.type === "section")
    .find((b) => b.text?.text.startsWith("✅"));

  assert.ok(caseSection);
  // No lone surrogate (U+FFFD replacement or unpaired half) leaked into the text.
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(caseSection.text?.text ?? ""));
});

test("formatVerifyResultsSlack falls back to the flat rendering for unstructured findings", () => {
  const findings = Array.from({ length: 200 }, (_, i) => `case ${i + 1} looked fine ${"x".repeat(40)}`).join("\n");
  const msg = formatVerifyResultsSlack(issue([]), "verify", "pass", findings);

  assert.match(msg.text, /✅ ENG-9 — verify passed — test-plan results/);
  assert.ok(msg.text.length < 3200);
  assert.ok(msg.text.includes("truncated — full findings on the Linear ticket"));
  // Flat path keeps the statusBlocks shape: bold headline section, no header block.
  assert.equal(blocksOf(msg)[0].type, "section");
});
