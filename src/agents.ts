/**
 * Cursor SDK interactions: building role-specific prompts, spawning cloud
 * agents (fire-and-forget), and recovering a previously-spawned agent's latest
 * run so the reconciler can report its PR back to Linear.
 */

import { cursorKey, ghOwner, markers, modelId, roleLabel, roleRepo } from "./config.js";
import { postComment } from "./linear.js";
import type { AgentRole, LinearIssuePayload } from "./types.js";

export function buildPrompt(issue: LinearIssuePayload, role: AgentRole): string {
  const ticket = `# ${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}`;
  if (role === "hero") {
    return `${ticket}\n\n## Role: Hero (compound)\n\nImplement the full ticket in ${ghOwner}/compound:\n- X-Request-ID middleware (read incoming header or generate UUID)\n- AsyncLocalStorage for request-scoped context\n- Structured logger includes requestId on every line\n- Small UI footer showing the current request ID\n- Tests for generated and echoed request IDs\n\nOpen a PR when done.`;
  }
  return `${ticket}\n\n## Role: Chorus (server / Bitwarden)\n\nScoped work in ${ghOwner}/server only:\n- ASP.NET middleware for X-Request-ID (read or generate, echo on response)\n- Serilog enricher via LogContext.PushProperty("RequestId", ...)\n- One xUnit test exercising middleware behavior\n\nNo UI changes. Open a PR when done.`;
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
export async function spawnAgent(role: AgentRole, issue: LinearIssuePayload): Promise<void> {
  const { Agent, CursorAgentError } = await import("@cursor/sdk");
  const repo = `${ghOwner}/${roleRepo[role]}`;
  const label = roleLabel[role];
  try {
    await using agent = await Agent.create({
      apiKey: cursorKey(),
      model: { id: modelId },
      cloud: {
        repos: [{ url: `https://github.com/${repo}` }],
        autoCreatePR: true,
        skipReviewerRequest: true,
      },
    });
    const run = await agent.send(buildPrompt(issue, role));
    console.log(`[${role}] spawned agent=${agent.agentId} run=${run.id}`);
    await postComment(
      issue.id,
      `${markers.bridge}\n**Cursor ${label} agent spawned**\n\nAgent ID: \`${agent.agentId}\`\nRepo: \`${repo}\``,
    );
  } catch (err) {
    // A thrown error here means the run never started (auth/config/network),
    // distinct from a run that starts and later fails.
    const msg = err instanceof CursorAgentError ? `startup failed: ${err.message}` : String(err);
    console.error(`[${role}] ${msg}`);
    await postComment(issue.id, `${markers.bridge}\n**Cursor ${label} agent failed to start**\n\n${msg}`);
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
