/**
 * Fleet orchestration: planning tasks from the ticket, launching agents (without
 * blocking on completion), and reconciling finished runs back into Linear.
 */
import { markers, triggerLabel, triggerState } from "../config.js";
import {
  checkAgentRun,
  isRunReportable,
  spawnAgent,
  type AgentRunStatus,
} from "./agents.js";
import {
  deriveTailStages,
  hotfixPrOpened,
  HOTFIX_PIPELINE_CYCLE,
  INITIAL_PIPELINE_CYCLE,
  mergedCommentForCycle,
  PIPELINE_CYCLES,
  type PipelineCycle,
} from "./cycle.js";
import { parseEvents } from "./events.js";
import { reconcileAllVerifyCycles } from "./verify.js";
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
  parseRemediationAgents,
  parseRemediationDoneIds,
  parseRemediationResults,
  parseSpawnedAgents,
  parseVerifyFindingsIds,
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
  const remediated = hasComment(issue, markers.remediated);
  const remediationDone = hasRemediationDone(issue);
  const tailCtx = { allBuildDone: allDone };
  const initialTail = deriveTailStages(issue, INITIAL_PIPELINE_CYCLE, tailCtx);

  const stages: Record<string, StageState> = {
    plan: !started ? "pending" : spawned ? "done" : "running",
    build: startupFailed ? "failed" : !spawned ? "pending" : allDone ? "done" : "running",
    ...initialTail,
    remediate: remediationDone ? "done" : remediated ? "running" : "pending",
  };

  if (hotfixPrOpened(issue)) {
    const hotfixTail = deriveTailStages(issue, HOTFIX_PIPELINE_CYCLE, tailCtx);
    stages.review = hotfixTail.review;
    stages.deploy = hotfixTail.deploy;
    stages.verify = hotfixTail.verify;
    stages.remediate = hasComment(issue, markers.hotfixVerifyPass) ? "done" : "running";
  }

  return stages;
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
  const verifyFindingsIds = parseVerifyFindingsIds(issue);
  const verifyAgents: JobAgent[] = PIPELINE_CYCLES.flatMap((cycle) =>
    cycle.parseAgents(issue).map((agent) => ({
      ...agent,
      role: "verify" as const,
      done: cycle.verdictSettled(issue) && verifyFindingsIds.has(agent.agentId),
    })),
  );

  const agents = [...buildAgents, ...verifyAgents, ...remediationAgents];
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
  return mergedCommentForCycle(INITIAL_PIPELINE_CYCLE, prUrls);
}

/** @deprecated Use {@link mergedCommentForCycle} with {@link HOTFIX_PIPELINE_CYCLE}. */
export function hotfixMergedComment(prUrls: string[]): string {
  return mergedCommentForCycle(HOTFIX_PIPELINE_CYCLE, prUrls);
}

export { hotfixPrOpened, hotfixPrUrls } from "./cycle.js";

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

    for (const cycle of PIPELINE_CYCLES) {
      await reconcileMergeForCycle(
        issue,
        cycle,
        cycle.requiresBuildDoneForReview ? { spawned, done } : undefined,
      );
    }

    // Separate track: report any finished remediation agents (hotfix PRs).
    summary.agentsCompleted += await reconcileRemediation(issue);

    await reconcileAllVerifyCycles(issue);
  }
  return summary;
}

/**
 * Advances one pipeline cycle's merge stage by confirming its PR(s) merged on
 * GitHub. No-ops without a `GH_TOKEN` (the deploy then acts as the merge
 * signal). Idempotent via each cycle's merged marker.
 */
async function reconcileMergeForCycle(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
  ctx?: { spawned: SpawnedAgent[]; done: Set<string> },
): Promise<void> {
  if (hasComment(issue, cycle.mergedMarker)) return;

  if (cycle.requiresBuildDoneForReview) {
    const spawned = ctx?.spawned ?? parseSpawnedAgents(issue);
    const done = ctx?.done ?? parseDoneAgentIds(issue);
    const allDone = spawned.length > 0 && spawned.every((agent) => done.has(agent.agentId));
    if (!allDone) return;
  } else if (!hasRemediationDone(issue)) {
    return;
  }

  const prUrls = cycle.prUrls(issue);
  if (prUrls.length === 0) return;

  let merged = false;
  try {
    merged = await allPullRequestsMerged(prUrls);
  } catch (err) {
    console.error(`[merge] ${cycle.id} PR merge check failed for ${issue.identifier}:`, err);
    return;
  }
  if (!merged) return;

  await postComment(issue.id, mergedCommentForCycle(cycle, prUrls));
  console.log(`[merge] ${issue.identifier} ${cycle.id} PR(s) merged → review complete`);
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
