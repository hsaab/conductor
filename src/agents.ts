/**
 * Cursor SDK interactions: spawning cloud agents (fire-and-forget) and
 * recovering a previously-spawned agent's latest run for the reconciler.
 */

import { cursorKey, markers, modelId } from "./config.js";
import { postComment } from "./linear.js";
import type { PlannedTask } from "./planner.js";
import type { LinearIssuePayload } from "./types.js";

/**
 * Maps a task kind to the compound skill and workflow emphasis the fleet agent
 * should use. Keeps the planner's classification meaningful at execution time.
 */
function skillGuidance(kind: PlannedTask["kind"]): string {
  switch (kind) {
    case "bug":
      return [
        "This is a BUG task. Use the `build-feature` skill in fix mode:",
        "reproduce the defect, read relevant logs and errors, and make the smallest",
        "targeted change that resolves it. Add a regression test. Then use `ship-task`.",
      ].join(" ");
    case "test":
      return [
        "This is a TEST task. Prioritize test coverage and test infrastructure:",
        "add or migrate the highest-value tests for the described behavior, keep them",
        "fast (no network or DB), and do not change product behavior. Then use `ship-task`.",
      ].join(" ");
    case "feature":
    default:
      return [
        "This is a FEATURE task. Use the `build-feature` skill: plan if substantial,",
        "implement in vertical slices, add the highest-value tests, then use `ship-task`.",
      ].join(" ");
  }
}

function buildPrompt(issue: LinearIssuePayload, task: PlannedTask): string {
  const ticket = `# ${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}`;
  return `${ticket}\n\n## Repo: ${task.repo}\n\n${skillGuidance(task.kind)}\n\n${task.instructions}\n\nOpen a PR when done.`;
}

function repoShortName(repo: string): string {
  return repo.includes("/") ? (repo.split("/").pop() ?? repo) : repo;
}

/**
 * Spawn one cloud agent, kick off its run, and return immediately.
 *
 * Intentionally does NOT await `run.wait()`: cloud runs take many minutes,
 * well past any serverless function budget. The cloud run continues
 * independently once `send()` resolves (even after this process exits), and the
 * reconciler reports completion + PR URL later. The spawn comment records the
 * agent id so the reconciler can find the run again.
 */
export async function spawnAgent(task: PlannedTask, issue: LinearIssuePayload): Promise<void> {
  const { Agent, CursorAgentError } = await import("@cursor/sdk");
  const name = repoShortName(task.repo);
  console.log(
    `[${name}] Starting a Cursor cloud agent on github.com/${task.repo} (model: ${modelId}) for ${issue.identifier}`,
  );
  try {
    await using agent = await Agent.create({
      apiKey: cursorKey(),
      model: { id: modelId },
      cloud: {
        repos: [{ url: `https://github.com/${task.repo}` }],
        autoCreatePR: true,
        skipReviewerRequest: true,
      },
    });
    const run = await agent.send(buildPrompt(issue, task));
    console.log(
      `[${name}] Launched on ${task.repo} — agent ${agent.agentId}, run ${run.id}. It will open a PR when finished.`,
    );
    await postComment(
      issue.id,
      `${markers.bridge}\n**Cursor agent spawned**\n\nAgent ID: \`${agent.agentId}\`\nRepo: \`${task.repo}\``,
    );
  } catch (err) {
    const msg = err instanceof CursorAgentError ? `startup failed: ${err.message}` : String(err);
    console.error(`[${name}] Failed to start on ${task.repo}: ${msg}`);
    await postComment(issue.id, `${markers.bridge}\n**Cursor agent failed to start**\n\nRepo: \`${task.repo}\`\n\n${msg}`);
  }
}

export interface AgentRunStatus {
  /** True once the run reached a terminal state (finished/error/cancelled). */
  terminal: boolean;
  status: string;
  prUrl?: string;
}

/**
 * Inspect a previously-spawned cloud agent's latest run. Returns `null` when
 * the run can't be read yet (transient error), so the caller can retry on the
 * next reconcile tick.
 */
export async function checkAgentRun(agentId: string): Promise<AgentRunStatus | null> {
  const { Agent } = await import("@cursor/sdk");
  try {
    const runs = await Agent.listRuns(agentId, { runtime: "cloud", apiKey: cursorKey() });
    const run = pickLatestRun(runs.items);
    if (!run) return null;
    const terminal =
      run.status === "finished" || run.status === "error" || run.status === "cancelled";
    const prUrl = run.git?.branches?.find((branch) => branch.prUrl)?.prUrl;
    return { terminal, status: run.status, prUrl };
  } catch (err) {
    console.error(`[reconcile] could not read runs for ${agentId}:`, err);
    return null;
  }
}

function pickLatestRun<T extends { createdAt?: number }>(runs: T[]): T | undefined {
  if (runs.length === 0) return undefined;
  return [...runs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}
