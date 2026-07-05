/**
 * Fleet orchestration: planning tasks from the ticket, launching agents (without
 * blocking on completion), and reconciling finished runs back into Linear.
 */
import { markers, observeWindowMs, triggerLabel, triggerState } from "../config.js";
import {
  checkAgentRun,
  isRunReportable,
  parseVerifyVerdict,
  readAgentRunResult,
  spawnAgent,
  spawnRemediationAgent,
  spawnVerifyAgent,
  type AgentRunStatus,
} from "./agents.js";
import { parseEvents } from "./events.js";
import { allPullRequestsMerged } from "../integrations/github.js";
import {
  addIssueReaction,
  deleteAllComments,
  deleteBridgeComments,
  hasComment,
  hasStartupFailure,
  hasRemediationDone,
  isBridgeComment,
  listFleetIssues,
  parseAgentResults,
  parseDoneAgentIds,
  parseHotfixVerifyAgents,
  parseRemediationAgents,
  parseRemediationDoneIds,
  parseRemediationResults,
  parseSpawnedAgents,
  parseVerifyAgents,
  parseVerifyFindingsIds,
  hasVerifyFail,
  hasVerifyPass,
  postComment,
  removeIssueReaction,
} from "../integrations/linear.js";
import { planFleet, type PlannedTask } from "./planner.js";
import { postSlack, statusBlocks, type SlackMessage } from "../integrations/slack.js";
import { repoShortName } from "../shared/repo.js";
import type {
  JobAgent,
  JobSummary,
  JobsReport,
  LinearIssuePayload,
  SpawnedAgent,
  StageState,
  TestCase,
  TriggerResult,
} from "../types.js";

/** Best-effort, per-instance guard against double-spawning while a trigger is in flight. */
const activeIssues = new Set<string>();

export function shouldSpawn(issue: LinearIssuePayload): boolean {
  const labels = issue.labels?.map((l) => l.name) ?? [];
  return labels.includes(triggerLabel) && issue.state?.name === triggerState;
}

function planTaskList(tasks: PlannedTask[]): string {
  return tasks.map((task) => `- \`${task.repo}\` (${task.kind})`).join("\n");
}

/** Human-readable + machine-parseable test plan comment for SQA and the verify agent. */
function formatTestPlanComment(cases: TestCase[]): string {
  const numbered = cases.map((c, i) => `${i + 1}. **${c.title}**\n   ${c.steps}`).join("\n\n");
  const json = JSON.stringify({ cases }, null, 2);
  return `${markers.testPlan}
${markers.bridge}
**📋 Test plan** (top ${cases.length} critical checks for SQA)

${numbered}

\`\`\`json
${json}
\`\`\``;
}

/**
 * Slack mrkdwn rendering of the full test plan. Mirrors the Linear comment so SQA
 * sees every case in Slack too, dropping the machine-readable JSON block (that
 * exists only for the verify agent to parse out of Linear). Slack mrkdwn uses
 * single-asterisk bold, unlike the double-asterisk Markdown in the Linear comment.
 */
export function formatTestPlanSlack(issue: LinearIssuePayload, cases: TestCase[]): SlackMessage {
  const numbered = cases.map((c, i) => `*${i + 1}. ${c.title}*\n${c.steps}`);
  return statusBlocks(`📋 ${issue.identifier} — test plan ready for SQA`, [
    issue.title,
    `${cases.length} critical check(s), also posted to Linear:`,
    ...numbered,
  ]);
}

function fallbackDetail(reason: string | undefined): string {
  return reason ? ` (${reason})` : "";
}

/**
 * Plans tasks from the ticket, posts the durable `fleetStarted` marker, then
 * spawns one cloud agent per planned task. Returns once all agents have been
 * started — it does not wait for runs to finish (see {@link reconcileAll}).
 */
export async function triggerFleet(
  issue: LinearIssuePayload,
  source: string,
): Promise<TriggerResult> {
  if (!shouldSpawn(issue)) return { queued: false, reason: "issue does not match trigger filters" };
  if (hasComment(issue, markers.fleetStarted)) {
    return { queued: false, reason: "fleet already started for this issue" };
  }
  if (activeIssues.has(issue.id)) {
    return { queued: false, reason: "fleet is already running for this issue" };
  }

  activeIssues.add(issue.id);
  try {
    console.log(
      `[fleet] Engaging on ${issue.identifier} "${issue.title}" (trigger: ${source})`,
    );

    // Instant demo signal first: react and post the engaged marker before the
    // (slower) planner agent runs, so dragging the ticket "does something" right
    // away. The fleetStarted marker also dedupes concurrent/repeat triggers.
    await addIssueReaction(issue.id);
    await postComment(
      issue.id,
      `${markers.fleetStarted}
**🚀 Cursor bridge engaged — planning the fleet**

Trigger: \`${source}\`
Issue: ${issue.url ?? issue.identifier}

A Cursor planner agent is reading the ticket to decide which repos need work.`,
    );
    console.log(`[fleet] Reacted 🚀 on ${issue.identifier}; planner agent is reading the ticket`);

    const { tasks: plan, testPlan, usedFallback, fallbackReason } = await planFleet(issue);

    const planHeadline = usedFallback
      ? `⚠️ Planner fallback${fallbackDetail(fallbackReason)} — defaulting to ${plan.length} agent(s)`
      : `🧭 Planner chose ${plan.length} agent(s)`;
    await postComment(
      issue.id,
      `${markers.bridge}
**${planHeadline}**

Repos:
${planTaskList(plan)}`,
    );

    if (testPlan.length > 0) {
      await postComment(issue.id, formatTestPlanComment(testPlan));
      await postSlack(formatTestPlanSlack(issue, testPlan));
    }

    console.log(
      `[fleet] Launching ${plan.length} agent(s) for ${issue.identifier}: ${plan.map((t) => t.repo).join(", ")}`,
    );
    await Promise.all(plan.map((task) => spawnAgent(task, issue)));

    console.log(
      `[fleet] All ${plan.length} agent(s) running for ${issue.identifier} — PRs will open in each repo in a few minutes`,
    );
    return { queued: true };
  } finally {
    activeIssues.delete(issue.id);
  }
}

export type ResetIssueOptions = { wipeAll?: boolean };

/**
 * Re-arms an issue so a fresh drag into "In Progress" launches a new fleet:
 * removes the bridge's reaction and deletes comments (which clears the
 * `fleetStarted` dedupe marker). Used when a ticket leaves "In Progress".
 *
 * When `wipeAll` is true (explicit `/api/reset`), every comment is removed.
 * Otherwise only conductor-authored comments are deleted.
 */
export async function resetIssue(
  issueId: string,
  opts?: ResetIssueOptions,
): Promise<{ clearedComments: number }> {
  await removeIssueReaction(issueId);
  const clearedComments = opts?.wipeAll
    ? await deleteAllComments(issueId)
    : await deleteBridgeComments(issueId);
  if (clearedComments > 0) {
    const scope = opts?.wipeAll ? "all" : "bridge";
    console.log(`[reset] re-armed ${issueId} (cleared ${clearedComments} ${scope} comment(s))`);
  }
  return { clearedComments };
}

function commentCreatedAt(issue: LinearIssuePayload, marker: string): string | undefined {
  return issue.comments?.find((comment) => comment.body?.includes(marker))?.createdAt;
}

function latestBridgeCommentAt(issue: LinearIssuePayload): string | undefined {
  return issue.comments
    ?.filter((comment) => comment.createdAt && isBridgeComment(comment.body))
    .map((comment) => comment.createdAt as string)
    .sort()
    .at(-1);
}

/**
 * Derives each pipeline stage's status purely from the issue's comment markers,
 * so the dashboard stays consistent with the rest of conductor's state store.
 *
 * Review combines Bugbot review + human merge (done when PRs merge). Verify
 * replaces the passive observe window with an active test-plan agent run.
 *
 * Once the remediation agent opens its hotfix PR, the loop re-enters review:
 * the tail stages (review → deploy → verify) reset and track the hotfix through
 * merge, production deploy, and re-verify. Remediation is only done once that
 * re-verify passes — an open hotfix PR is a proposal, not a fix.
 */
function deriveStages(issue: LinearIssuePayload, buildAgents: JobAgent[]): Record<string, StageState> {
  const started = hasComment(issue, markers.fleetStarted);
  const spawned = buildAgents.length > 0;
  const allDone = spawned && buildAgents.every((agent) => agent.done);
  const startupFailed = hasStartupFailure(issue);
  const deployed = hasComment(issue, markers.deployed);
  const merged = hasComment(issue, markers.merged) || deployed;
  const verifyPass = hasVerifyPass(issue);
  const verifyFail = hasVerifyFail(issue);
  const remediated = hasComment(issue, markers.remediated);
  const remediationDone = hasRemediationDone(issue);

  const stages: Record<string, StageState> = {
    plan: !started ? "pending" : spawned ? "done" : "running",
    build: startupFailed ? "failed" : !spawned ? "pending" : allDone ? "done" : "running",
    review: !allDone ? "pending" : merged ? "done" : "running",
    deploy: deployed ? "done" : merged ? "running" : "pending",
    verify: !deployed
      ? "pending"
      : verifyPass
        ? "done"
        : verifyFail
          ? "failed"
          : remediated
            ? "done"
            : "running",
    remediate: remediationDone ? "done" : remediated ? "running" : "pending",
  };

  if (hotfixPrOpened(issue)) {
    const hotfixDeployed = hasComment(issue, markers.hotfixDeployed);
    // Mirror the initial pass: a hotfix deploy implies the hotfix merged, even
    // if the explicit marker was never written (e.g. no GH_TOKEN configured).
    const hotfixMerged = hasComment(issue, markers.hotfixMerged) || hotfixDeployed;
    const hotfixVerifyPass = hasComment(issue, markers.hotfixVerifyPass);
    const hotfixVerifyFail = hasComment(issue, markers.hotfixVerifyFail);
    stages.review = hotfixMerged ? "done" : "running";
    stages.deploy = hotfixDeployed ? "done" : hotfixMerged ? "running" : "pending";
    stages.verify = hotfixVerifyPass
      ? "done"
      : hotfixVerifyFail
        ? "failed"
        : hotfixDeployed
          ? "running"
          : "pending";
    stages.remediate = hotfixVerifyPass ? "done" : "running";
  }

  return stages;
}

/**
 * One pass of the verify machinery. The pipeline runs it twice: once against
 * the initial deploy, and once against the hotfix deploy after remediation.
 * Both passes share the same reconcile logic; only the markers (and copy)
 * that scope each pass differ.
 */
interface VerifyCycle {
  /** Human label used in log lines, Slack copy, and comment headlines. */
  label: "verify" | "hotfix verify";
  /** Deploy marker that opens this cycle's verify window. */
  deployedMarker: string;
  passMarker: string;
  failMarker: string;
  /** Comment substring identifying this cycle's verify-agent spawns (window start). */
  spawnNeedle: string;
  parseAgents: (issue: LinearIssuePayload) => SpawnedAgent[];
  /**
   * Whether a failure was reported out-of-band (blocks the window fallback).
   * Only the initial cycle has such a channel: a Datadog alert dispatching
   * remediation. In the hotfix cycle a re-alert is blocked by the `remediated`
   * marker, so its only failure signal is the fail marker itself.
   */
  failureReported: (issue: LinearIssuePayload) => boolean;
}

export const INITIAL_VERIFY_CYCLE: VerifyCycle = {
  label: "verify",
  deployedMarker: markers.deployed,
  passMarker: markers.verifyPass,
  failMarker: markers.verifyFail,
  spawnNeedle: "conductor:verify-agent",
  parseAgents: parseVerifyAgents,
  failureReported: (issue) => hasComment(issue, markers.remediated),
};

export const HOTFIX_VERIFY_CYCLE: VerifyCycle = {
  label: "hotfix verify",
  deployedMarker: markers.hotfixDeployed,
  passMarker: markers.hotfixVerifyPass,
  failMarker: markers.hotfixVerifyFail,
  spawnNeedle: "conductor:hotfix-verify-agent",
  parseAgents: parseHotfixVerifyAgents,
  failureReported: () => false,
};

/**
 * True when the post-deploy verify window has elapsed. Uses the cycle's
 * verify-agent spawn timestamp when present, otherwise its deployed marker.
 */
export function verifyWindowElapsed(
  issue: LinearIssuePayload,
  nowMs: number,
  windowMs: number,
  cycle: VerifyCycle = INITIAL_VERIFY_CYCLE,
): boolean {
  const verifyStarted = issue.comments?.find((c) => c.body?.includes(cycle.spawnNeedle))?.createdAt;
  const startedAt = verifyStarted ?? commentCreatedAt(issue, cycle.deployedMarker);
  if (!startedAt) return false;
  return nowMs - Date.parse(startedAt) >= windowMs;
}

/** @deprecated Use {@link verifyWindowElapsed}. Kept for older tests/docs during transition. */
export const observeWindowElapsed = verifyWindowElapsed;

/**
 * Whether a verify agent's test-plan findings should be posted now: only once
 * (per-agent `verifyFindings` marker) and only when the run is terminal — an
 * active run's findings are still being produced. Pure, so it is unit-tested.
 */
export function shouldReportVerifyFindings(input: {
  terminal: boolean;
  alreadyReported: boolean;
}): boolean {
  return input.terminal && !input.alreadyReported;
}

/**
 * Findings comment body for one verify agent. Carries the per-agent
 * `verifyFindings` marker (idempotency) and the run's full result text — the
 * per-case pass/fail evidence the verify prompt mandates.
 */
export function verifyFindingsComment(agentId: string, findings: string): string {
  return `${markers.verifyFindings(agentId)}
**🔎 Verify findings** — test-plan results from the verify agent.

Agent ID: \`${agentId}\`

${findings.trim()}`;
}

/**
 * Reduces the verify agent's markdown findings to Slack mrkdwn lines: headings
 * become plain text, double-asterisk bold becomes Slack's single-asterisk bold,
 * and blank lines drop (Slack sections render tighter without them).
 */
function findingsToSlackLines(findings: string): string[] {
  return findings
    .split("\n")
    .map((line) => line.trim().replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "*"))
    .filter(Boolean);
}

/** Slack caps a section's mrkdwn at 3000 chars; leave headroom for the title line. */
const SLACK_FINDINGS_CHAR_BUDGET = 2800;

/**
 * Slack rendering of a verify run's per-case results, posted when the verify
 * stage settles — the counterpart to {@link formatTestPlanSlack}, which posts
 * the cases before they run. Shared by both verify cycles; `verdict` is null
 * when the findings arrive after the stage already settled (late report).
 * Long findings are truncated to fit Slack's section limit; the Linear ticket
 * always carries the full text.
 */
export function formatVerifyResultsSlack(
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

/** A pure decision for the verify window-elapsed fallback. Mirrors FleetDispatchDecision. */
export type VerifyCloseDecision = { close: true } | { close: false; reason: string };

/**
 * Decides whether the window-elapsed fallback may close verify as a pass.
 * Pure, so it is unit-tested; {@link reconcileVerify} supplies the inputs.
 *
 * The fallback exists for the happy path: window elapsed, nothing reported.
 * It must stay quiet when a failure WAS reported via Datadog (the `remediated`
 * marker — "no failures reported" would be false) and while the verify agent's
 * run is still active (its verdict is still coming; the next tick re-checks).
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

/**
 * Builds the read-only summary for one launched fleet from its Linear comments.
 * Pure (no network), so it is unit-testable.
 */
export function summarizeJob(issue: LinearIssuePayload, nowMs: number): JobSummary {
  const done = parseDoneAgentIds(issue);
  const results = parseAgentResults(issue);
  const buildAgents: JobAgent[] = parseSpawnedAgents(issue).map((agent) => ({
    ...agent,
    role: "build",
    done: done.has(agent.agentId),
    prUrl: results.get(agent.agentId)?.prUrl,
  }));

  const remDone = parseRemediationDoneIds(issue);
  const remResults = parseRemediationResults(issue);
  const remediationAgents: JobAgent[] = parseRemediationAgents(issue).map((agent) => ({
    ...agent,
    role: "remediation",
    done: remDone.has(agent.agentId),
    prUrl: remResults.get(agent.agentId)?.prUrl,
  }));

  // A verify agent is only done once the stage verdict settled AND its findings
  // were reported (per-agent marker). A window/remediation close without the
  // findings leaves the agent pending, which keeps jobNeedsReconcile true so the
  // opportunistic reconciler can still deliver the late-arriving findings.
  const verifyVerdictSettled =
    hasVerifyPass(issue) || hasVerifyFail(issue) || hasComment(issue, markers.remediated);
  const verifyFindingsIds = parseVerifyFindingsIds(issue);
  const verifyAgents: JobAgent[] = parseVerifyAgents(issue).map((agent) => ({
    ...agent,
    role: "verify",
    done: verifyVerdictSettled && verifyFindingsIds.has(agent.agentId),
  }));

  // The hotfix cycle's re-verify agents settle against the hotfix verdict
  // markers, never the initial pass's.
  const hotfixVerdictSettled =
    hasComment(issue, markers.hotfixVerifyPass) || hasComment(issue, markers.hotfixVerifyFail);
  const hotfixVerifyAgents: JobAgent[] = parseHotfixVerifyAgents(issue).map((agent) => ({
    ...agent,
    role: "verify",
    done: hotfixVerdictSettled && verifyFindingsIds.has(agent.agentId),
  }));

  const agents = [...buildAgents, ...verifyAgents, ...hotfixVerifyAgents, ...remediationAgents];
  const startedAt = commentCreatedAt(issue, markers.fleetStarted);
  const completedAt = commentCreatedAt(issue, markers.fleetComplete);
  const status: JobSummary["status"] = completedAt ? "complete" : "in-progress";
  const runningForSeconds =
    status === "in-progress" && startedAt
      ? Math.max(0, Math.round((nowMs - Date.parse(startedAt)) / 1000))
      : undefined;
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name,
    status,
    startedAt,
    completedAt,
    updatedAt: latestBridgeCommentAt(issue),
    runningForSeconds,
    agents,
    agentsPending: agents.filter((agent) => !agent.done).length,
    // Stage state ignores remediation agents for build/review/etc; remediation is its own stage.
    stages: deriveStages(issue, buildAgents),
    // The same comment thread that drives stage state, surfaced as a readable log.
    events: parseEvents(issue),
  };
}

/**
 * Whether the opportunistic reconciler still has work to advance for this fleet.
 * Pending agents need their runs checked; a running merge/observe/remediate stage
 * needs the reconciler to confirm the merge, close the observe window, or report
 * the hotfix. `deploy` is intentionally excluded: it advances via the Vercel
 * webhook, not the reconciler, so a fleet waiting only on deploy needs no tick.
 */
export function jobNeedsReconcile(job: JobSummary): boolean {
  if (job.agentsPending > 0) return true;
  const { build, review, verify, remediate } = job.stages;
  return build === "running" || review === "running" || verify === "running" || remediate === "running";
}

export async function listJobs(
  options: { includeComplete?: boolean } = {},
): Promise<JobsReport> {
  const now = Date.now();
  const issues = await listFleetIssues(triggerLabel);
  const jobs = issues
    .filter((issue) => hasComment(issue, markers.fleetStarted))
    .map((issue) => summarizeJob(issue, now));
  const inProgress = jobs.filter((job) => job.status === "in-progress");
  return {
    generatedAt: new Date(now).toISOString(),
    inProgress: inProgress.length,
    complete: jobs.length - inProgress.length,
    agentsPending: inProgress.reduce((sum, job) => sum + job.agentsPending, 0),
    needsReconcile: jobs.some(jobNeedsReconcile),
    jobs: options.includeComplete ? jobs : inProgress,
  };
}

/**
 * An identifying hint carried by a deploy/alert payload, used to attribute it to
 * the correct fleet when several are in flight. Vercel deploys can carry a commit
 * SHA and/or deploy URL; Datadog alerts carry neither (see DEMO_FLOW §"attribution").
 */
export interface FleetMatchHint {
  /** Commit SHA from the deploy payload (full or short form both work). */
  commitSha?: string;
  /** Deploy or PR URL from the payload. */
  url?: string;
}

/** Lower-cased, non-empty needles derived from a match hint (SHA + short SHA + URL). */
function hintNeedles(hint: FleetMatchHint): string[] {
  return [hint.commitSha, hint.commitSha?.slice(0, 7), hint.url]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => v.toLowerCase());
}

/** True when any of the issue's comments contains one of the needles. */
function commentsContainAny(issue: LinearIssuePayload, needles: string[]): boolean {
  return issue.comments?.some((comment) => {
    const body = (comment.body ?? "").toLowerCase();
    return needles.some((needle) => body.includes(needle));
  }) ?? false;
}

/**
 * Pure fleet-selection core: from already-summarized candidates, pick the fleet a
 * deploy/alert belongs to.
 *
 * Prefers an *exact* attribution when the payload carries an identifier (commit
 * SHA / deploy or PR URL) that appears in a fleet's recorded comments — this
 * disambiguates concurrent `cursor-fleet` tickets. Falls back to the most
 * recently updated matching fleet when no hint matches. Exposed for unit tests.
 */
export function selectActiveFleet(
  candidates: Array<{ issue: LinearIssuePayload; job: JobSummary }>,
  predicate: (job: JobSummary) => boolean,
  hint: FleetMatchHint = {},
): LinearIssuePayload | null {
  const matches = candidates
    .filter(({ job }) => predicate(job))
    .sort((a, b) => Date.parse(b.job.updatedAt ?? "0") - Date.parse(a.job.updatedAt ?? "0"));

  const needles = hintNeedles(hint);
  if (needles.length > 0) {
    const exact = matches.find(({ issue }) => commentsContainAny(issue, needles));
    if (exact) return exact.issue;
  }

  return matches[0]?.issue ?? null;
}

/**
 * Finds the launched fleet that a deploy or production alert most likely belongs
 * to, so observability/remediation can advance the right ticket on the dashboard.
 *
 * Vercel/Datadog payloads do not carry a Linear id. When a `hint` (commit
 * SHA/deploy URL) is supplied and matches a fleet's comments, that exact fleet
 * wins; otherwise we fall back to the most recently updated matching fleet. The
 * raw issue is returned so callers can post markers to it.
 *
 * NOTE: production deploys share one URL and Datadog alerts carry no hint, so the
 * fallback can still misattribute under multiple concurrent tickets — see the
 * "one ticket in flight" constraint in DEMO_FLOW.md.
 */
export async function findActiveFleet(
  predicate: (job: JobSummary) => boolean,
  hint: FleetMatchHint = {},
): Promise<LinearIssuePayload | null> {
  const now = Date.now();
  const issues = await listFleetIssues(triggerLabel);
  const candidates = issues
    .filter((issue) => hasComment(issue, markers.fleetStarted))
    .map((issue) => ({ issue, job: summarizeJob(issue, now) }));
  return selectActiveFleet(candidates, predicate, hint);
}

export interface ReconcileSummary {
  issuesScanned: number;
  agentsPending: number;
  agentsCompleted: number;
  fleetsCompleted: number;
}

function agentDoneComment(agent: SpawnedAgent, status: AgentRunStatus): string {
  const name = repoShortName(agent.repo);
  // An open PR is the success signal, so report it as such even when the run's
  // terminal status is "cancelled"/"error". Only surface the raw status when no
  // PR was produced (a genuinely unsuccessful run).
  const headline = status.prUrl ? "opened a PR" : status.status === "finished" ? "finished" : status.status;
  const prLine = status.prUrl ? `PR: ${status.prUrl}` : "PR: (no PR opened)";
  return `${markers.agentDone(agent.agentId)}
**Cursor ${name} agent ${headline}**

Agent ID: \`${agent.agentId}\`
Repo: \`${agent.repo}\`
${prLine}`;
}

function remediationDoneComment(agent: SpawnedAgent, status: AgentRunStatus): string {
  const prLine = status.prUrl ? `PR: ${status.prUrl}` : "PR: (no PR opened)";
  return `${markers.remediationDone(agent.agentId)}
**🛠️ Hotfix PR opened by remediation agent**

Agent ID: \`${agent.agentId}\`
Repo: \`${agent.repo}\`
${prLine}`;
}

/**
 * Comment body confirming the build PR(s) merged (review/merge stage done).
 * Shared by the reconciler and the Vercel deploy webhook, which can each be the
 * first to observe the merge, so both write the identical `merged` marker.
 */
export function mergedComment(prUrls: string[]): string {
  const count = prUrls.length === 1 ? "1 pull request" : `${prUrls.length} pull requests`;
  return `${markers.merged}\n**🔀 Merged** — ${count} merged to the default branch.\n${prUrls.join("\n")}`;
}

/**
 * Comment body confirming the hotfix PR(s) merged (hotfix-cycle review done).
 * Like {@link mergedComment}, written by whichever of the reconciler or the
 * deploy webhook observes the merge first.
 */
export function hotfixMergedComment(prUrls: string[]): string {
  const count = prUrls.length === 1 ? "1 hotfix pull request" : `${prUrls.length} hotfix pull requests`;
  return `${markers.hotfixMerged}\n**🔀 Hotfix merged** — ${count} merged to the default branch.\n${prUrls.join("\n")}`;
}

/** Hotfix PR URLs recorded by the remediation agents' completion comments. */
export function hotfixPrUrls(issue: LinearIssuePayload): string[] {
  return [...parseRemediationResults(issue).values()]
    .map((result) => result.prUrl)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
}

/**
 * True once a remediation agent has actually opened a hotfix PR — the trigger
 * for looping the pipeline back to review. A remediation run that ended with
 * no PR has nothing to review or merge, so it must not re-open the tail stages.
 */
export function hotfixPrOpened(issue: LinearIssuePayload): boolean {
  return hasRemediationDone(issue) && hotfixPrUrls(issue).length > 0;
}

/**
 * Reconciles a single issue's remediation agents (the post-alert track), posting
 * their hotfix PR back to Linear and Slack. Kept separate from the build-agent
 * loop so remediation never affects build/review stage derivation.
 */
async function reconcileRemediation(issue: LinearIssuePayload): Promise<number> {
  const done = parseRemediationDoneIds(issue);
  const pending = parseRemediationAgents(issue).filter((agent) => !done.has(agent.agentId));
  let completed = 0;
  for (const agent of pending) {
    const status = await checkAgentRun(agent.agentId);
    // A published hotfix PR is the deliverable, so report it even before the run
    // goes terminal (mirrors the build-agent loop). See isRunReportable.
    if (!status || !isRunReportable(status)) continue;
    await postComment(issue.id, remediationDoneComment(agent, status));
    completed += 1;
    const prNote = status.prUrl ? `PR: ${status.prUrl}` : "no PR opened";
    console.log(`[reconcile] remediation agent ${agent.agentId} ${status.status} → ${prNote} (${issue.identifier})`);
    await postSlack(
      statusBlocks("🛠️ Hotfix PR opened by remediation agent", [
        `Ticket: ${issue.identifier} — ${issue.title}`,
        `Repo: ${agent.repo}`,
        status.prUrl ? `PR: ${status.prUrl}` : "No PR opened (check the agent run)",
      ]),
    );
  }
  return completed;
}

export async function reconcileAll(): Promise<ReconcileSummary> {
  const issues = await listFleetIssues(triggerLabel);
  const summary: ReconcileSummary = {
    issuesScanned: issues.length,
    agentsPending: 0,
    agentsCompleted: 0,
    fleetsCompleted: 0,
  };

  for (const issue of issues) {
    const done = parseDoneAgentIds(issue);
    const spawned = parseSpawnedAgents(issue);
    const pending = spawned.filter((agent) => !done.has(agent.agentId));
    summary.agentsPending += pending.length;

    for (const agent of pending) {
      const status = await checkAgentRun(agent.agentId);
      // Report done as soon as a PR is published, not only on terminal runs —
      // otherwise a run that opens its PR and keeps running leaves the build
      // stage stuck on "running" on the dashboard. See isRunReportable.
      if (!status || !isRunReportable(status)) continue;
      await postComment(issue.id, agentDoneComment(agent, status));
      done.add(agent.agentId);
      summary.agentsCompleted += 1;
      const prNote = status.prUrl ? `PR: ${status.prUrl}` : "no PR opened";
      console.log(
        `[reconcile] ${repoShortName(agent.repo)} agent on ${agent.repo} ${status.status} → ${prNote} (posted to ${issue.identifier})`,
      );
    }

    const allDone = spawned.length > 0 && spawned.every((agent) => done.has(agent.agentId));
    if (allDone && !hasComment(issue, markers.fleetComplete)) {
      await postComment(
        issue.id,
        `${markers.fleetComplete}
**Cursor fleet complete** — ${spawned.length}/${spawned.length} agents finished.`,
      );
      summary.fleetsCompleted += 1;
      console.log(
        `[reconcile] ${issue.identifier} fleet complete — all ${spawned.length} agents finished and reported back to Linear`,
      );
    }

    // Advance review/merge by confirming the build PR(s) merged on GitHub.
    await reconcileMerge(issue, spawned, done);

    // Separate track: report any finished remediation agents (hotfix PRs).
    summary.agentsCompleted += await reconcileRemediation(issue);

    // Hotfix cycle: advance the looped-back review stage on the hotfix merge.
    await reconcileHotfixMerge(issue);

    // Close each verify window when monitoring elapsed with no alerts or verdict.
    await reconcileVerify(issue, INITIAL_VERIFY_CYCLE);
    await reconcileVerify(issue, HOTFIX_VERIFY_CYCLE);
  }
  return summary;
}

/**
 * Advances the merge stage by confirming the build's pull request(s) actually
 * merged on GitHub, so review/merge complete on the real merge rather than
 * waiting for the downstream Vercel deploy. No-ops without a `GH_TOKEN` (the
 * deploy then acts as the merge signal), until the build is done, or until every
 * build PR is merged. Idempotent via the `merged` marker.
 */
async function reconcileMerge(
  issue: LinearIssuePayload,
  spawned: SpawnedAgent[],
  done: Set<string>,
): Promise<void> {
  const allDone = spawned.length > 0 && spawned.every((agent) => done.has(agent.agentId));
  if (!allDone || hasComment(issue, markers.merged)) return;

  const results = parseAgentResults(issue);
  const prUrls = spawned
    .map((agent) => results.get(agent.agentId)?.prUrl)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
  // No PRs yet means nothing to merge; a later deploy can still advance the stage.
  if (prUrls.length === 0) return;

  let merged = false;
  try {
    merged = await allPullRequestsMerged(prUrls);
  } catch (err) {
    console.error(`[merge] PR merge check failed for ${issue.identifier}:`, err);
    return;
  }
  if (!merged) return;

  await postComment(issue.id, mergedComment(prUrls));
  console.log(`[merge] ${issue.identifier} PR(s) merged → review/merge complete`);
}

/**
 * Advances the hotfix cycle's looped-back review stage by confirming the hotfix
 * PR(s) merged on GitHub. Mirrors {@link reconcileMerge}: no-ops without a
 * `GH_TOKEN` (the hotfix deploy then acts as the merge signal), before the
 * remediation agent has opened its PR, or once already recorded. Idempotent via
 * the `hotfixMerged` marker.
 */
async function reconcileHotfixMerge(issue: LinearIssuePayload): Promise<void> {
  if (!hasRemediationDone(issue) || hasComment(issue, markers.hotfixMerged)) return;

  const prUrls = hotfixPrUrls(issue);
  if (prUrls.length === 0) return;

  let merged = false;
  try {
    merged = await allPullRequestsMerged(prUrls);
  } catch (err) {
    console.error(`[merge] hotfix PR merge check failed for ${issue.identifier}:`, err);
    return;
  }
  if (!merged) return;

  await postComment(issue.id, hotfixMergedComment(prUrls));
  console.log(`[merge] ${issue.identifier} hotfix PR(s) merged → hotfix review complete`);
}

/**
 * Ends one cycle's verify stage when its verify agent reports a verdict, or
 * when the cycle's post-deploy window passes with no explicit failure
 * (happy-path fallback). The fallback is gated by {@link shouldCloseVerifyWindow}:
 * it stays quiet when a failure was reported out-of-band (initial cycle only —
 * a Datadog alert dispatching remediation) or while the verify run is still
 * active (its verdict is still coming).
 *
 * Independently of the stage verdict, each verify agent's test-plan findings
 * are reported back to Linear/Slack exactly once when its run finishes — even
 * when a verdict/window marker already settled the stage first (the verdict is
 * never re-opened; only the evidence is posted). Idempotent per agent via the
 * `verifyFindings` marker, which the explicit verdict comments stamp inline.
 */
async function reconcileVerify(issue: LinearIssuePayload, cycle: VerifyCycle): Promise<void> {
  if (!hasComment(issue, cycle.deployedMarker)) return;

  const verdictSettled = hasComment(issue, cycle.passMarker) || hasComment(issue, cycle.failMarker);
  const reportedFindings = parseVerifyFindingsIds(issue);
  const verifyAgents = cycle.parseAgents(issue);
  let verifyRunActive = false;
  for (const agent of verifyAgents) {
    // Nothing left for this agent: verdict settled and findings reported.
    if (verdictSettled && reportedFindings.has(agent.agentId)) continue;

    const result = await readAgentRunResult(agent.agentId);
    if (!result) continue;
    if (!result.terminal) verifyRunActive = true;

    const verdict = result.resultText ? parseVerifyVerdict(result.resultText) : null;
    if (!verdictSettled && (verdict === "pass" || (result.terminal && verdict !== "fail"))) {
      const findings = result.resultText?.trim() ?? "Verify agent finished without reporting failures.";
      // The pass comment embeds the run's findings, so it doubles as the
      // findings report for this agent (inline marker keeps it single-shot).
      await postComment(
        issue.id,
        `${cycle.passMarker}
${markers.verifyFindings(agent.agentId)}
**✅ ${capitalize(cycle.label)} passed** — critical acceptance checks passed on production.

${findings}`,
      );
      console.log(`[verify] ${issue.identifier} ${cycle.label} passed`);
      await postSlack(formatVerifyResultsSlack(issue, cycle.label, "pass", findings));
      return;
    }

    if (!verdictSettled && verdict === "fail") {
      const summary = result.resultText?.trim() ?? "Verify agent reported failed checks.";
      await postComment(
        issue.id,
        `${cycle.failMarker}\n${markers.verifyFindings(agent.agentId)}\n**❌ ${capitalize(cycle.label)} failed**\n\n${summary}`,
      );
      console.log(`[verify] ${issue.identifier} ${cycle.label} failed`);
      await postSlack(formatVerifyResultsSlack(issue, cycle.label, "fail", summary));
      // Dispatch remediation only when none was dispatched before: the hotfix
      // cycle's fail must not spawn a second hotfix loop unbounded.
      if (!hasComment(issue, markers.remediated)) {
        await spawnRemediationAgent({
          title: "Verify agent — acceptance checks failed",
          body: summary,
          issue,
        });
      }
      return;
    }

    // Verdict already settled (window fallback or an earlier agent) but this
    // agent's findings were never posted: report them now, exactly once.
    if (shouldReportVerifyFindings({ terminal: result.terminal, alreadyReported: reportedFindings.has(agent.agentId) })) {
      const findings = result.resultText?.trim() ?? "Verify agent finished without reporting findings.";
      await postComment(issue.id, verifyFindingsComment(agent.agentId, findings));
      console.log(`[verify] ${issue.identifier} posted findings for ${agent.agentId}`);
      // The stage verdict already settled (window fallback), so the run's own
      // verdict line only labels the late report; it never re-opens the stage.
      await postSlack(formatVerifyResultsSlack(issue, cycle.label, parseVerifyVerdict(findings), findings));
    }
  }

  if (verdictSettled) return;

  const windowDecision = shouldCloseVerifyWindow({
    hasVerifyAgents: verifyAgents.length > 0,
    windowElapsed: verifyWindowElapsed(issue, Date.now(), observeWindowMs(), cycle),
    remediated: cycle.failureReported(issue),
    verifyRunActive,
  });
  if (windowDecision.close) {
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
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Minimum gap between opportunistic reconciles kicked off by dashboard polls. */
const RECONCILE_TICK_MS = Number(process.env.RECONCILE_TICK_MS ?? 8000);
let lastTickStartedAt = 0;
let tickInFlight: Promise<ReconcileSummary> | null = null;

/**
 * Opportunistic reconcile that keeps the live dashboard moving on its own.
 *
 * Build and remediation completion are only written to Linear by {@link
 * reconcileAll}, which otherwise runs just on the daily cron or a manual loop —
 * so a finished cloud run never reaches the board between those. The dashboard
 * polls every couple of seconds, so we let those polls drive reconciliation:
 * at most one reconcile runs at a time (in-flight guard) and no more often than
 * `RECONCILE_TICK_MS` (throttle), which advances the pipeline without hammering
 * the Cursor API. Returns the reconcile promise to await (new or already
 * running), or `null` when throttled.
 */
export function reconcileTick(): Promise<ReconcileSummary> | null {
  if (tickInFlight) return tickInFlight;
  if (Date.now() - lastTickStartedAt < RECONCILE_TICK_MS) return null;
  lastTickStartedAt = Date.now();
  tickInFlight = reconcileAll()
    .then((summary) => {
      if (summary.agentsCompleted || summary.fleetsCompleted) {
        console.log(
          `[reconcile] dashboard tick advanced ${summary.agentsCompleted} agent(s) and completed ${summary.fleetsCompleted} fleet(s)`,
        );
      }
      return summary;
    })
    .finally(() => {
      tickInFlight = null;
    });
  return tickInFlight;
}
