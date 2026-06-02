/**
 * Fleet orchestration: deciding when to spawn, launching agents (without
 * blocking on completion), and reconciling finished runs back into Linear.
 */
import { ghOwner, markers, roleLabel, roleRepo, triggerLabel, triggerState } from "./config.js";
import { checkAgentRun, spawnAgent, type AgentRunStatus } from "./agents.js";
import {
  addIssueReaction,
  commentCreatedAt,
  deleteBridgeComments,
  hasComment,
  latestBridgeCommentAt,
  listFleetIssues,
  parseDoneAgentIds,
  parseSpawnedAgents,
  postComment,
  removeIssueReaction,
} from "./linear.js";
import type {
  JobSummary,
  JobsReport,
  LinearIssuePayload,
  SpawnedAgent,
  TriggerResult,
} from "./types.js";

/** Best-effort, per-instance guard against double-spawning while a trigger is in flight. */
const activeIssues = new Set<string>();

export function shouldSpawn(issue: LinearIssuePayload): boolean {
  const labels = issue.labels?.map((l) => l.name) ?? [];
  return labels.includes(triggerLabel) && issue.state?.name === triggerState;
}

/** Markdown bullet list of the `owner/repo` targets for the "fleet accepted" comment. */
function repoList(): string {
  return (Object.values(roleRepo) as string[]).map((repo) => `- \`${ghOwner}/${repo}\``).join("\n");
}

/**
 * Launches the two-agent fleet for an issue. Posts the durable `fleetStarted`
 * marker comment *before* spawning so concurrent or repeated triggers are
 * deduped via {@link hasComment}. Returns once both agents have been started —
 * it does not wait for the runs to finish (see {@link reconcileAll}).
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
    console.log(`[${source}] spawning fleet for ${issue.identifier}`);
    // Instant, visible demo signal: react on the issue and post the engaged
    // comment before the (slower) agent spawns so dragging the ticket "does
    // something" within ~1s.
    await addIssueReaction(issue.id);
    await postComment(
      issue.id,
      `${markers.fleetStarted}
**🚀 Cursor bridge engaged — spawning fleet**

Trigger: \`${source}\`
Issue: ${issue.url ?? issue.identifier}
Repos:
${repoList()}`,
    );
    await Promise.all([spawnAgent("hero", issue), spawnAgent("chorus", issue)]);
    return { queued: true };
  } finally {
    activeIssues.delete(issue.id);
  }
}

/**
 * Re-arms an issue so a fresh drag into "In Progress" launches a new fleet:
 * removes the bridge's reaction and deletes all of its comments (which clears
 * the `fleetStarted` dedupe marker). Used when a ticket leaves "In Progress".
 * The agents' PRs on GitHub are untouched.
 */
export async function resetIssue(issueId: string): Promise<{ clearedComments: number }> {
  await removeIssueReaction(issueId);
  const clearedComments = await deleteBridgeComments(issueId);
  if (clearedComments > 0) console.log(`[reset] re-armed ${issueId} (cleared ${clearedComments} comment(s))`);
  return { clearedComments };
}

/**
 * Builds the read-only summary for one launched fleet from its Linear comments.
 * Pure (no network), so it is unit-testable. `startedAt`/`completedAt` come from
 * the fleet marker comments; `runningForSeconds` is the live age of an
 * in-progress fleet; `updatedAt` is the bridge's last activity on the issue.
 */
export function summarizeJob(issue: LinearIssuePayload, nowMs: number): JobSummary {
  const done = parseDoneAgentIds(issue);
  const agents = parseSpawnedAgents(issue).map((agent) => ({
    ...agent,
    done: done.has(agent.agentId),
  }));
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
  };
}

/**
 * Read-only view of the fleets the bridge has launched, derived entirely from
 * Linear comment markers, with no Cursor SDK calls and no mutation. A "job" is
 * any fleet-labeled issue with the `fleetStarted` marker; it is `in-progress` until
 * the `fleetComplete` marker is posted. Defaults to in-progress jobs only; pass
 * `includeComplete` for finished fleets too. Counts span every launched fleet.
 */
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

/** A single launched fleet by Linear identifier (case-insensitive), or null. */
export async function getJob(identifier: string): Promise<JobSummary | null> {
  const want = identifier.trim().toLowerCase();
  const { jobs } = await listJobs({ includeComplete: true });
  return jobs.find((job) => job.identifier.toLowerCase() === want) ?? null;
}

export interface ReconcileSummary {
  issuesScanned: number;
  agentsPending: number;
  agentsCompleted: number;
  fleetsCompleted: number;
}

function agentDoneComment(agent: SpawnedAgent, status: AgentRunStatus): string {
  const label = roleLabel[agent.role];
  const headline = status.status === "finished" ? "finished" : status.status;
  const prLine = status.prUrl ? `PR: ${status.prUrl}` : "PR: (no PR opened)";
  return `${markers.agentDone(agent.agentId)}
**Cursor ${label} agent ${headline}**

Agent ID: \`${agent.agentId}\`
Repo: \`${agent.repo}\`
${prLine}`;
}

/**
 * Scans fleet issues for agents that finished but were never reported back to
 * Linear, posts their PR URLs, and adds a one-time "fleet complete" summary once
 * every agent on an issue has reported. Safe to run repeatedly and on a schedule
 * (Vercel Cron) — idempotency comes from the per-agent and fleet markers.
 */
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
      console.log(`[reconcile] ${issue.identifier} ${agent.agentId} -> ${status.status} ${status.prUrl ?? ""}`);
    }

    const allDone = spawned.length > 0 && spawned.every((agent) => done.has(agent.agentId));
    if (allDone && !hasComment(issue, markers.fleetComplete)) {
      await postComment(
        issue.id,
        `${markers.fleetComplete}
**Cursor fleet complete** — ${spawned.length}/${spawned.length} agents finished.`,
      );
      summary.fleetsCompleted += 1;
    }
  }
  return summary;
}
