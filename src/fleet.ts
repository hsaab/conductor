/**
 * Fleet orchestration: deciding when to spawn, launching agents (without
 * blocking on completion), and reconciling finished runs back into Linear.
 */
import { ghOwner, markers, roleLabel, roleRepo, triggerLabel, triggerState } from "./config.js";
import { checkAgentRun, spawnAgent, type AgentRunStatus } from "./agents.js";
import {
  addIssueReaction,
  deleteBridgeComments,
  hasComment,
  listFleetIssues,
  parseDoneAgentIds,
  parseSpawnedAgents,
  postComment,
  removeIssueReaction,
} from "./linear.js";
import type { LinearIssuePayload, SpawnedAgent, TriggerResult } from "./types.js";

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
