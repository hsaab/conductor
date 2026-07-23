/**
 * Post-deploy verify stage: window timing, verdict reconciliation, and Slack
 * rendering of test-plan findings. Runs once per {@link PipelineCycle}.
 */
import { markers, observeWindowMs } from "../config.js";
import {
  parseVerifyVerdict,
  readAgentRunResult,
  spawnRemediationAgent,
} from "./agents.js";
import { type PipelineCycle, PIPELINE_CYCLES } from "./cycle.js";
import {
  commentCreatedAt,
  hasComment,
  parseVerifyFindingsIds,
  postComment,
} from "../integrations/linear.js";
import { postSlack, statusBlocks, type SlackMessage } from "../integrations/slack.js";
import type { LinearIssuePayload } from "../types.js";

/**
 * True when the post-deploy verify window has elapsed. Uses the cycle's
 * verify-agent spawn timestamp when present, otherwise its deployed marker.
 */
export function verifyWindowElapsed(
  issue: LinearIssuePayload,
  nowMs: number,
  windowMs: number,
  cycle: PipelineCycle,
): boolean {
  const verifyStarted = commentCreatedAt(issue, cycle.spawnNeedle);
  const startedAt = verifyStarted ?? commentCreatedAt(issue, cycle.deployedMarker);
  if (!startedAt) return false;
  return nowMs - Date.parse(startedAt) >= windowMs;
}

/**
 * Findings comment body for one verify agent. Carries the per-agent
 * `verifyFindings` marker (idempotency) and the run's full result text.
 */
export function verifyFindingsComment(agentId: string, findings: string): string {
  return `${markers.verifyFindings(agentId)}
**🔎 Verify findings** — test-plan results from the verify agent.

Agent ID: \`${agentId}\`

${findings.trim()}`;
}

function findingsToSlackLines(findings: string): string[] {
  return findings
    .split("\n")
    .map((line) => line.trim().replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "*"))
    .filter(Boolean);
}

/** Slack caps a section's mrkdwn at 3000 chars; leave headroom for the title line. */
const SLACK_FINDINGS_CHAR_BUDGET = 2800;

/** One test-plan case parsed from the verify agent's findings markdown. */
export interface VerifyCaseResult {
  /** Heading text without the `###` prefix and without the PASS/FAIL suffix. */
  title: string;
  status: "pass" | "fail" | null;
  /** Trimmed non-empty lines under the heading, `#` heading prefixes stripped. */
  evidence: string[];
}

/** Typed view of the verify agent's findings, parsed once at the LLM boundary. */
export interface ParsedVerifyFindings {
  cases: VerifyCaseResult[];
  /** Text after the `VERIFY_RESULT: PASS/FAIL` dash, e.g. "all five cases passed". */
  verdictSummary: string | null;
  /** Trimmed non-empty lines before the first case heading, VERIFY_RESULT line excluded. */
  preamble: string[];
}

// Only numbered headings (`### 1. …`, `## 2) …`) start a case; sub-headings like
// `#### Observed behavior` belong to the current case's evidence.
const CASE_HEADING = /^#{1,6}\s+(\d+[.)].*)$/;
const HEADING_PREFIX = /^#{1,6}\s+/;
// The dash may be an em dash, en dash, or hyphen; the LLM sometimes drops the bold.
const CASE_STATUS_SUFFIX = /\s*[—–-]\s*\*{0,2}(PASS|FAIL)\*{0,2}\s*$/i;
const VERDICT_LINE = /^VERIFY_RESULT:\s*(?:PASS|FAIL)\b\s*(?:[—–-]\s*(.*))?$/i;

/**
 * Parses the verify agent's findings markdown into per-case results. Findings
 * are LLM-authored, so anything that doesn't match the expected shape lands in
 * `preamble` (or yields zero cases, which callers treat as unstructured).
 */
export function parseVerifyFindings(findings: string): ParsedVerifyFindings {
  const cases: VerifyCaseResult[] = [];
  const preamble: string[] = [];
  let verdictSummary: string | null = null;

  for (const raw of findings.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const verdict = line.match(VERDICT_LINE);
    if (verdict) {
      verdictSummary = verdict[1]?.trim() || null;
      continue;
    }

    const heading = line.match(CASE_HEADING);
    if (heading) {
      const status = heading[1].match(CASE_STATUS_SUFFIX);
      cases.push({
        title: heading[1].replace(CASE_STATUS_SUFFIX, "").trim(),
        status: status ? (status[1].toUpperCase() === "PASS" ? "pass" : "fail") : null,
        evidence: [],
      });
      continue;
    }

    (cases.length > 0 ? cases[cases.length - 1].evidence : preamble).push(line.replace(HEADING_PREFIX, ""));
  }

  return { cases, verdictSummary, preamble };
}

const MAX_RENDERED_CASES = 10;
const MRKDWN_SNIPPET_CHAR_CAP = 300;
/** Keep the notification/screen-reader fallback text under Slack's ~3000-char comfort zone. */
const SLACK_TEXT_CHAR_CAP = 3000;

function caseEmoji(status: VerifyCaseResult["status"]): string {
  return status === "pass" ? "✅" : status === "fail" ? "❌" : "▫️";
}

/** Joins parsed lines (evidence or preamble) into a capped mrkdwn snippet. */
function mrkdwnSnippet(lines: string[]): string {
  const text = lines.map((line) => line.replace(/\*\*/g, "*")).join("\n");
  return text.length > MRKDWN_SNIPPET_CHAR_CAP ? `${text.slice(0, MRKDWN_SNIPPET_CHAR_CAP)}…` : text;
}

function mrkdwnSection(text: string): { type: "section"; text: { type: "mrkdwn"; text: string } } {
  return { type: "section", text: { type: "mrkdwn", text } };
}

/** Flat rendering for findings that don't parse into cases (unstructured LLM output). */
function formatFlatVerifyResultsSlack(
  issue: LinearIssuePayload,
  cycleLabel: string,
  verdict: "pass" | "fail" | null,
  findings: string,
): SlackMessage {
  const headline =
    verdict === "pass"
      ? `✅ ${issue.identifier} — ${cycleLabel} passed — test-plan results`
      : verdict === "fail"
        ? `❌ ${issue.identifier} — ${cycleLabel} failed — test-plan results`
        : `🔎 ${issue.identifier} — ${cycleLabel} findings`;

  const lines: string[] = [issue.title];
  let used = issue.title.length;
  for (const line of findingsToSlackLines(findings)) {
    if (used + line.length > SLACK_FINDINGS_CHAR_BUDGET) {
      lines.push("… (truncated — full findings on the Linear ticket)");
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return statusBlocks(headline, lines);
}

/**
 * Slack rendering of a verify run's per-case results. `verdict` is null when
 * the findings arrive after the stage already settled (late report). Findings
 * that parse into cases get a structured Block Kit layout (header, summary,
 * one section per case); unstructured findings keep the flat rendering.
 */
export function formatVerifyResultsSlack(
  issue: LinearIssuePayload,
  cycleLabel: string,
  verdict: "pass" | "fail" | null,
  findings: string,
): SlackMessage {
  const parsed = parseVerifyFindings(findings);
  if (parsed.cases.length === 0) {
    return formatFlatVerifyResultsSlack(issue, cycleLabel, verdict, findings);
  }

  const headline =
    verdict === "pass"
      ? `✅ ${issue.identifier} · ${cycleLabel} passed`
      : verdict === "fail"
        ? `❌ ${issue.identifier} · ${cycleLabel} failed`
        : `🔎 ${issue.identifier} · ${cycleLabel} findings`;

  const casesWithStatus = parsed.cases.filter((c) => c.status !== null);
  const passCount = casesWithStatus.filter((c) => c.status === "pass").length;

  const preamble = mrkdwnSnippet(parsed.preamble);
  const summaryLines = [`*${issue.title}*`];
  if (preamble) summaryLines.push(preamble);
  if (casesWithStatus.length > 0) {
    summaryLines.push(`${passCount}/${casesWithStatus.length} checks passed`);
  }
  if (issue.url) summaryLines.push(`<${issue.url}|View on Linear>`);

  const renderedCases = parsed.cases.slice(0, MAX_RENDERED_CASES);
  const remaining = parsed.cases.length - renderedCases.length;

  const caseSections = renderedCases.map((c) => {
    const evidence = mrkdwnSnippet(c.evidence);
    return mrkdwnSection(`${caseEmoji(c.status)} *${c.title}*${evidence ? `\n${evidence}` : ""}`);
  });
  if (remaining > 0) {
    caseSections.push(mrkdwnSection(`… ${remaining} more check(s) — full findings on the Linear ticket`));
  }

  // The summary only appears when the findings carried a VERIFY_RESULT line,
  // so re-parsing the verdict from them is safe when the arg is null (late report).
  const verdictLine = parsed.verdictSummary
    ? `VERIFY_RESULT: ${(verdict ?? parseVerifyVerdict(findings)) === "fail" ? "FAIL" : "PASS"} — ${parsed.verdictSummary}`
    : null;

  const textLines = [headline, issue.title];
  if (preamble) textLines.push(preamble);
  textLines.push(...renderedCases.map((c) => `${caseEmoji(c.status)} ${c.title}`));
  if (verdictLine) textLines.push(verdictLine);
  const text = textLines.join("\n");

  return {
    text: text.length > SLACK_TEXT_CHAR_CAP ? `${text.slice(0, SLACK_TEXT_CHAR_CAP - 1)}…` : text,
    blocks: [
      { type: "header", text: { type: "plain_text", text: headline } },
      mrkdwnSection(summaryLines.join("\n")),
      { type: "divider" },
      ...caseSections,
      ...(verdictLine ? [{ type: "context", elements: [{ type: "mrkdwn", text: verdictLine }] }] : []),
      { type: "context", elements: [{ type: "mrkdwn", text: "conductor" }] },
    ],
  };
}

/**
 * Whether a verify agent's test-plan findings should be posted as a late
 * report: the run must have ended and the per-agent findings marker must not
 * already be on the ticket. Guards the FE-13 failure mode where a window-pass
 * settled the verdict mid-run and the findings were never delivered.
 */
export function shouldReportVerifyFindings(input: {
  terminal: boolean;
  alreadyReported: boolean;
}): boolean {
  return input.terminal && !input.alreadyReported;
}

/** A pure decision for the verify window-elapsed fallback. Mirrors FleetDispatchDecision. */
export type VerifyCloseDecision = { close: true } | { close: false; reason: string };

/**
 * Decides whether the window-elapsed fallback may close verify as a pass.
 * The fallback stays quiet when a failure was reported out-of-band or while
 * the verify run is still active.
 */
export function shouldCloseVerifyWindow(input: {
  hasVerifyAgents: boolean;
  windowElapsed: boolean;
  remediated: boolean;
  verifyRunActive: boolean;
}): VerifyCloseDecision {
  if (!input.hasVerifyAgents) return { close: false, reason: "no verify agent dispatched" };
  if (!input.windowElapsed) return { close: false, reason: "verify window still open" };
  if (input.remediated) return { close: false, reason: "remediation dispatched — a failure was reported" };
  if (input.verifyRunActive) return { close: false, reason: "verify agent still running — verdict pending" };
  return { close: true };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface VerifyAgentPassState {
  verdictSettled: boolean;
  verifyAgents: ReturnType<PipelineCycle["parseAgents"]>;
  verifyRunActive: boolean;
}

/**
 * Reads each verify agent's run and posts pass/fail verdicts or late findings.
 * At most one verdict settles per tick; the remaining agents still get their
 * findings reported (each exactly once, via the per-agent findings marker).
 */
async function reconcileVerifyAgentResults(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
): Promise<VerifyAgentPassState> {
  let verdictSettled = hasComment(issue, cycle.passMarker) || hasComment(issue, cycle.failMarker);
  const reportedFindings = parseVerifyFindingsIds(issue);
  const verifyAgents = cycle.parseAgents(issue);
  let verifyRunActive = false;

  for (const agent of verifyAgents) {
    if (verdictSettled && reportedFindings.has(agent.agentId)) continue;

    const result = await readAgentRunResult(agent.agentId);
    if (!result) continue;
    if (!result.terminal) verifyRunActive = true;

    const verdict = result.resultText ? parseVerifyVerdict(result.resultText) : null;
    if (!verdictSettled && (verdict === "pass" || (result.terminal && verdict !== "fail"))) {
      const findings = result.resultText?.trim() ?? "Verify agent finished without reporting failures.";
      await postComment(
        issue.id,
        `${cycle.passMarker}
${markers.verifyFindings(agent.agentId)}
**✅ ${capitalize(cycle.label)} passed** — critical acceptance checks passed on production.

${findings}`,
      );
      console.log(`[verify] ${issue.identifier} ${cycle.label} passed`);
      await postSlack(formatVerifyResultsSlack(issue, cycle.label, "pass", findings));
      verdictSettled = true;
      reportedFindings.add(agent.agentId);
      continue;
    }

    if (!verdictSettled && verdict === "fail") {
      const summary = result.resultText?.trim() ?? "Verify agent reported failed checks.";
      await postComment(
        issue.id,
        `${cycle.failMarker}\n${markers.verifyFindings(agent.agentId)}\n**❌ ${capitalize(cycle.label)} failed**\n\n${summary}`,
      );
      console.log(`[verify] ${issue.identifier} ${cycle.label} failed`);
      await postSlack(formatVerifyResultsSlack(issue, cycle.label, "fail", summary));
      if (!hasComment(issue, markers.remediated)) {
        await spawnRemediationAgent({
          title: "Verify agent — acceptance checks failed",
          body: summary,
          issue,
        });
      }
      verdictSettled = true;
      reportedFindings.add(agent.agentId);
      continue;
    }

    if (
      shouldReportVerifyFindings({
        terminal: result.terminal,
        alreadyReported: reportedFindings.has(agent.agentId),
      })
    ) {
      const findings = result.resultText?.trim() ?? "Verify agent finished without reporting findings.";
      await postComment(issue.id, verifyFindingsComment(agent.agentId, findings));
      console.log(`[verify] ${issue.identifier} posted findings for ${agent.agentId}`);
      await postSlack(formatVerifyResultsSlack(issue, cycle.label, parseVerifyVerdict(findings), findings));
      reportedFindings.add(agent.agentId);
    }
  }

  return { verdictSettled, verifyAgents, verifyRunActive };
}

/**
 * Closes verify as a pass when the post-deploy window elapsed with no failure.
 */
async function closeVerifyWindowIfEligible(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
  state: VerifyAgentPassState,
): Promise<void> {
  if (state.verdictSettled) return;

  const windowDecision = shouldCloseVerifyWindow({
    hasVerifyAgents: state.verifyAgents.length > 0,
    windowElapsed: verifyWindowElapsed(issue, Date.now(), observeWindowMs(), cycle),
    remediated: cycle.outOfBandFailure?.(issue) ?? false,
    verifyRunActive: state.verifyRunActive,
  });
  if (!windowDecision.close) return;

  const windowMin = Math.round(observeWindowMs() / 60_000);
  await postComment(
    issue.id,
    `${cycle.passMarker}
**✅ ${capitalize(cycle.label)} window passed** — no failures reported in the last ${windowMin} min.`,
  );
  console.log(`[verify] ${issue.identifier} ${cycle.label} window elapsed with no failure verdict`);
  await postSlack(
    statusBlocks(`✅ ${issue.identifier} — ${cycle.label} window passed`, [
      issue.title,
      `No verify failures during the ${windowMin}-minute window.`,
    ]),
  );
}

/**
 * Ends one cycle's verify stage when its verify agent reports a verdict, or
 * when the post-deploy window passes with no explicit failure. Each agent's
 * findings are reported exactly once, even after a window fallback.
 */
export async function reconcileVerify(issue: LinearIssuePayload, cycle: PipelineCycle): Promise<void> {
  if (!hasComment(issue, cycle.deployedMarker)) return;

  const agentState = await reconcileVerifyAgentResults(issue, cycle);
  await closeVerifyWindowIfEligible(issue, cycle, agentState);
}

/** Reconcile verify for every pipeline cycle on one issue. */
export async function reconcileAllVerifyCycles(issue: LinearIssuePayload): Promise<void> {
  for (const cycle of PIPELINE_CYCLES) {
    await reconcileVerify(issue, cycle);
  }
}
