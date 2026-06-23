/**
 * Fleet orchestration: planning tasks from the ticket, launching agents (without
 * blocking on completion), and reconciling finished runs back into Linear.
 */
import { markers, triggerLabel, triggerState } from "./config.js";
import { checkAgentRun, spawnAgent, type AgentRunStatus } from "./agents.js";
import {
  addIssueReaction,
  commentCreatedAt,
  deleteBridgeComments,
  hasComment,
  hasFailedAgent,
  hasRemediationDone,
  latestBridgeCommentAt,
  listFleetIssues,
  parseAgentResults,
  parseDoneAgentIds,
  parseRemediationAgents,
  parseRemediationDoneIds,
  parseRemediationResults,
  parseSpawnedAgents,
  postComment,
  removeIssueReaction,
} from "./linear.js";
import { planFleet, type PlannedTask } from "./planner.js";
import { postSlack, statusBlocks } from "./slack.js";
import type {
  JobAgent,
  JobSummary,
  JobsReport,
  LinearIssuePayload,
  SpawnedAgent,
  StageState,
  TriggerResult,
} from "./types.js";

/** Best-effort, per-instance guard against double-spawning while a trigger is in flight. */
const activeIssues = new Set<string>();

export function shouldSpawn(issue: LinearIssuePayload): boolean {
  const labels = issue.labels?.map((l) => l.name) ?? [];
  return labels.includes(triggerLabel) && issue.state?.name === triggerState;
}

function repoShortName(repo: string): string {
  return repo.includes("/") ? (repo.split("/").pop() ?? repo) : repo;
}

function planTaskList(tasks: PlannedTask[]): string {
  return tasks.map((task) => `- \`${task.repo}\` (${task.kind})`).join("\n");
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

    const plan = await planFleet(issue);

    await postComment(
      issue.id,
      `${markers.bridge}
**🧭 Planner chose ${plan.length} agent(s)**

Repos:
${planTaskList(plan)}`,
    );

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

/**
 * Re-arms an issue so a fresh drag into "In Progress" launches a new fleet:
 * removes the bridge's reaction and deletes all of its comments (which clears
 * the `fleetStarted` dedupe marker). Used when a ticket leaves "In Progress".
 */
export async function resetIssue(issueId: string): Promise<{ clearedComments: number }> {
  await removeIssueReaction(issueId);
  const clearedComments = await deleteBridgeComments(issueId);
  if (clearedComments > 0) console.log(`[reset] re-armed ${issueId} (cleared ${clearedComments} comment(s))`);
  return { clearedComments };
}

/**
 * Derives each pipeline stage's status purely from the issue's comment markers,
 * so the dashboard stays consistent with the rest of conductor's state store.
 *
 * The marker thread only directly records plan/build/deploy/observe/remediate;
 * review and merge are inferred from their neighbors (a PR exists once the build
 * is done, and a deploy only happens after a human merges).
 */
function deriveStages(issue: LinearIssuePayload, buildAgents: JobAgent[]): Record<string, StageState> {
  const started = hasComment(issue, markers.fleetStarted);
  const spawned = buildAgents.length > 0;
  const allDone = spawned && buildAgents.every((agent) => agent.done);
  const failed = hasFailedAgent(issue);
  const deployed = hasComment(issue, markers.deployed);
  const verified = hasComment(issue, markers.verified);
  const remediated = hasComment(issue, markers.remediated);
  const remediationDone = hasRemediationDone(issue);

  return {
    plan: !started ? "pending" : spawned ? "done" : "running",
    build: failed ? "failed" : !spawned ? "pending" : allDone ? "done" : "running",
    review: !allDone ? "pending" : deployed ? "done" : "running",
    merge: deployed ? "done" : allDone ? "running" : "pending",
    deploy: deployed ? "done" : "pending",
    observe: !deployed ? "pending" : verified ? "done" : "running",
    remediate: remediationDone ? "done" : remediated ? "running" : "pending",
  };
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

  const agents = [...buildAgents, ...remediationAgents];
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
  };
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
    jobs: options.includeComplete ? jobs : inProgress,
  };
}

export async function getJob(identifier: string): Promise<JobSummary | null> {
  const want = identifier.trim().toLowerCase();
  const { jobs } = await listJobs({ includeComplete: true });
  return jobs.find((job) => job.identifier.toLowerCase() === want) ?? null;
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
  const headline = status.status === "finished" ? "finished" : status.status;
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
    if (!status || !status.terminal) continue;
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
      if (!status || !status.terminal) continue;
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

    // Separate track: report any finished remediation agents (hotfix PRs).
    summary.agentsCompleted += await reconcileRemediation(issue);
  }
  return summary;
}
