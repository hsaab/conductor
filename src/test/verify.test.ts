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
  assert.equal(parsed.verdictStatus, "fail");
  assert.equal(parsed.verdictSummary, "1 of 2 cases failed");
});

test("parseVerifyFindings returns a null summary when the verdict line has no dash", () => {
  const parsed = parseVerifyFindings("### 1. Case — **PASS**\nVERIFY_RESULT: PASS");
  assert.equal(parsed.cases.length, 1);
  assert.equal(parsed.verdictStatus, "pass");
  assert.equal(parsed.verdictSummary, null);
  // The VERIFY_RESULT line never leaks into evidence or preamble.
  assert.deepEqual(parsed.cases[0].evidence, []);
  assert.deepEqual(parsed.preamble, []);
});

test("parseVerifyFindings puts unparseable input in the preamble with zero cases", () => {
  const parsed = parseVerifyFindings("the agent rambled\nwithout any headings");
  assert.deepEqual(parsed.cases, []);
  assert.equal(parsed.verdictStatus, null);
  assert.equal(parsed.verdictSummary, null);
  assert.deepEqual(parsed.preamble, ["the agent rambled", "without any headings"]);
});

// Live FE-13 shape: plain `Case N — title — STATUS` (no ###), PARTIAL FAIL, --- separators,
// glued same-line evidence after FAIL, and a standalone Verdict label before VERIFY_RESULT.
const FE13_FINDINGS = [
  "FE-13 post-deploy verification",
  "Site: https://compound-ce0mk0dz6-hassansaab-9511s-projects.vercel.app",
  "When: Thu Jul 23, 2026 ~23:11 UTC (US market closed; asOf = 2026-07-23T21:00:00.000Z)",
  "---",
  "Case 1 — Back-to-back quotes always live — FAIL",
  "| Call | durationMs | ok | Cache-Control | AAPL / MSFT |",
  "|------|-------------|------|-----------------|-------------|",
  "| 1 | 238 | true | no-store | price 321.66 / 381.58 |",
  "| 2 (+2s) | 0 | true | no-store | same prices + same asOf |",
  "Repeat call durationMs=0 = in-memory TTL cache hit, not second upstream fetch. Header no-store OK; live-on-every-call not met.",
  "---",
  "Case 2 — Multi-ticker sequential, paced ≥250ms — FAIL",
  "| Request | Tickers | 1st call durationMs | Wall | Min sequential |",
  "|---------|---------|----------------------|------|----------------|",
  "| Cold-ish | KO, PEP, COST | 93 | ~170ms | ≥500ms |",
  "Multi-symbol cold fetches finish in tens–low hundreds of ms. Pattern matches concurrent fan-out + TTL cache.",
  "---",
  "Case 3 — Closed-market bypasses quote cache — FAILNVDA call 1: durationMs=0  price=208.76  asOf=2026-07-23T21:00:00.000Z",
  "NVDA call 2: durationMs=0  price=208.76  asOf=2026-07-23T21:00:00.000Z",
  "Both instant cache hits on closed market. 15min closed-market TTL still active; no live upstream per call.",
  "---",
  "Case 4 — Holdings live poll uses fresh path — FAIL",
  "- Auth OK: /holdings → 200 after seed-user login.",
  "- Simulated 12-ticker holdings poll (same endpoint useLiveQuotes hits):",
  "| Poll | durationMs | Resolved |",
  "|------|-------------|----------|",
  "| 1 | 10490 | 11/12 |",
  "| 2 (+2s) | 42 | 12/12 |",
  "Poll 2 ~42ms with unchanged prices/asOf = cached quotes, not fresh upstream.",
  "---",
  "Case 5 — Datadog synthetic basket — PARTIAL FAILGET /api/market/quotes?tickers=<20-ticker basket>",
  "→ HTTP 200, ok:true, durationMs=85, resolved=11/20, degraded=false",
  "GET /api/market/quotes-check → HTTP 404 ✓",
  "Pass: 200, ok:true, durationMs present, no quotes-check.",
  "Fail: 85ms for 20 symbols (not slow sequential live path); only 11/20 resolved.",
  "---",
  "Verdict",
  "Deployed site still shows TTL quote cache (repeat durationMs=0) and fast multi-ticker responses inconsistent with sequential ≥250ms pacing. FE-13 acceptance criteria not met on production.",
  "VERIFY_RESULT: FAIL - Quote TTL cache still active (repeat calls durationMs=0); multi-ticker requests not sequentially paced and holdings/synthetic polls reuse cached quotes instead of live upstream fetches.",
].join("\n");

test("parseVerifyFindings accepts plain Case N headings, PARTIAL FAIL, and skips --- / Verdict", () => {
  const parsed = parseVerifyFindings(FE13_FINDINGS);

  assert.equal(parsed.cases.length, 5);
  assert.deepEqual(
    parsed.cases.map((c) => ({ title: c.title, status: c.status })),
    [
      { title: "Case 1 — Back-to-back quotes always live", status: "fail" },
      { title: "Case 2 — Multi-ticker sequential, paced ≥250ms", status: "fail" },
      { title: "Case 3 — Closed-market bypasses quote cache", status: "fail" },
      { title: "Case 4 — Holdings live poll uses fresh path", status: "fail" },
      { title: "Case 5 — Datadog synthetic basket", status: "fail" },
    ],
  );
  // Same-line evidence after a glued FAIL token stays on that case.
  assert.ok(parsed.cases[2].evidence[0]?.startsWith("NVDA call 1:"));
  assert.ok(parsed.cases[4].evidence[0]?.startsWith("GET /api/market/quotes?tickers="));
  // Separators and the Verdict label never land in evidence; post-Verdict narrative is omitted.
  for (const c of parsed.cases) {
    assert.ok(!c.evidence.some((line) => line === "---" || /^-+$/.test(line)));
    assert.ok(!c.evidence.some((line) => /^verdict$/i.test(line)));
    assert.ok(!c.evidence.some((line) => /acceptance criteria not met/i.test(line)));
  }
  assert.deepEqual(parsed.preamble, [
    "FE-13 post-deploy verification",
    "Site: https://compound-ce0mk0dz6-hassansaab-9511s-projects.vercel.app",
    "When: Thu Jul 23, 2026 ~23:11 UTC (US market closed; asOf = 2026-07-23T21:00:00.000Z)",
  ]);
  assert.equal(parsed.verdictStatus, "fail");
  assert.match(parsed.verdictSummary ?? "", /Quote TTL cache still active/);
});

test("parseVerifyFindings uses the rightmost status marker when a case title contains PASS or FAIL", () => {
  const parsed = parseVerifyFindings(
    [
      "Case 1 — PASS criteria remain unmet — FAIL",
      "Observed failure.",
      "Case 2 — Non-FAIL response handling — PASS",
      "Observed success.",
    ].join("\n"),
  );

  assert.deepEqual(
    parsed.cases.map(({ title, status }) => ({ title, status })),
    [
      { title: "Case 1 — PASS criteria remain unmet", status: "fail" },
      { title: "Case 2 — Non-FAIL response handling", status: "pass" },
    ],
  );
});

test("formatVerifyResultsSlack renders FE-13 plain-case findings as scannable Block Kit", () => {
  const iss = {
    ...issue([]),
    identifier: "FE-13",
    title: "Always fetch live quotes on /api/market/quotes",
    url: "https://linear.app/acme/issue/FE-13",
  };
  const msg = formatVerifyResultsSlack(iss, "verify", "fail", FE13_FINDINGS);
  const blocks = blocksOf(msg);

  assert.equal(blocks[0].text?.text, "❌ FE-13 · verify failed");
  assert.match(blocks[1].text?.text ?? "", /0\/5 checks passed/);
  assert.match(blocks[1].text?.text ?? "", /View on Linear/);

  const sections = blocks.filter((b) => b.type === "section").map((b) => b.text?.text ?? "");
  assert.ok(sections.some((t) => t.startsWith("❌ *Case 1 — Back-to-back quotes always live*")));
  assert.ok(sections.some((t) => t.startsWith("❌ *Case 5 — Datadog synthetic basket*")));
  // Prose preferred over markdown tables in the Slack snippet.
  const case1 = sections.find((t) => t.includes("Case 1 — Back-to-back")) ?? "";
  assert.ok(case1.includes("Repeat call durationMs=0"));
  assert.ok(!case1.includes("| Call | durationMs"));
  // Flat dump of raw findings must not win.
  assert.equal(blocks[0].type, "header");
  assert.ok(!msg.text.includes("Case 1 — Back-to-back quotes always live — FAIL"));
  assert.match(msg.text, /VERIFY_RESULT: FAIL — Quote TTL cache still active/);
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

test("formatVerifyResultsSlack keeps a bare VERIFY_RESULT line with no dash-summary", () => {
  const msg = formatVerifyResultsSlack(issue([]), "verify", "pass", "### 1. Case — **PASS**\nVERIFY_RESULT: PASS");
  const contexts = blocksOf(msg).filter((b) => b.type === "context").map((b) => b.elements?.[0]?.text);
  assert.deepEqual(contexts, ["VERIFY_RESULT: PASS", "conductor"]);
  assert.ok(msg.text.includes("VERIFY_RESULT: PASS"));
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

test("fallback notification text truncation never severs an emoji surrogate pair", () => {
  // Oversized case titles land uncapped in the notification fallback `text`;
  // truncating by code points must not emit a lone UTF-16 surrogate.
  const findings = Array.from(
    { length: 10 },
    (_, i) => `### ${i + 1}. ${"🚀".repeat(200)} — **PASS**`,
  ).join("\n");
  const msg = formatVerifyResultsSlack(issue([]), "verify", "pass", findings);

  assert.ok([...msg.text].length <= 3001);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(msg.text));
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
