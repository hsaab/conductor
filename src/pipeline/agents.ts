/**
 * Cursor SDK interactions: spawning cloud agents (fire-and-forget) and
 * recovering a previously-spawned agent's latest run for the reconciler.
 */

import { cursorKey, deployTargetRepo, ghOwner, markers, modelId } from "../config.js";
import { PIPELINE_CYCLES, type PipelineCycle } from "./cycle.js";
import { postComment } from "../integrations/linear.js";
import { oneLineError } from "../shared/errors.js";
import { repoShortName } from "../shared/repo.js";
import type { PlannedTask } from "./planner.js";
import { routeGuidance, skillEntryLine } from "./routing.js";
import type { LinearIssuePayload, TestCase } from "../types.js";

function buildPrompt(issue: LinearIssuePayload, task: PlannedTask): string {
  const ticket = `# ${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}`;
  return `${ticket}\n\n## Repo: ${task.repo}\n\n${routeGuidance(task)}\n\n${task.instructions}\n\nOpen a PR when done.`;
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
  const name = repoShortName(task.repo);
  console.log(
    `[${name}] Starting a Cursor cloud agent on github.com/${task.repo} (model: ${modelId}) for ${issue.identifier}`,
  );
  try {
    // Import inside the try: @cursor/sdk loads native sqlite3 at import time, so
    // a missing binding on the deploy target throws here. Keeping it inside the
    // try turns that into a visible "failed to start" comment instead of an
    // unhandled rejection that drops the agent with no trace on the ticket.
    const { Agent } = await import("@cursor/sdk");
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
    const msg = oneLineError(err);
    console.error(`[${name}] Failed to start on ${task.repo}: ${msg}`);
    await postComment(issue.id, `${markers.bridge}\n**Cursor agent failed to start**\n\nRepo: \`${task.repo}\`\n\n${msg}`);
  }
}

export interface VerifyRunInput {
  issue: LinearIssuePayload;
  prodUrl: string;
  testPlan: TestCase[];
  /** Which pipeline pass this verify run belongs to. */
  cycle?: PipelineCycle["id"];
}

const PIPELINE_CYCLE_BY_ID = Object.fromEntries(
  PIPELINE_CYCLES.map((cycle) => [cycle.id, cycle]),
) as Record<PipelineCycle["id"], PipelineCycle>;

function verifyPrompt(input: VerifyRunInput): string {
  const cases = input.testPlan
    .map((c, i) => `${i + 1}. **${c.title}**\n   Steps: ${c.steps}`)
    .join("\n\n");
  return `${skillEntryLine("verify-test-plan")}

You are the post-deploy verify agent for ticket ${input.issue.identifier}.

## Deployed site
${input.prodUrl}

## Test plan (run each case against the live site)
${cases || "Verify the ticket acceptance criteria on the deployed site."}

## Ticket context
# ${input.issue.identifier}: ${input.issue.title}

${input.issue.description ?? ""}

## Your job
1. Exercise each test-plan case against ${input.prodUrl} (browser/API as appropriate).
2. Note pass/fail per case with brief evidence.
3. End your reply with exactly one machine-readable line:
   VERIFY_RESULT: PASS — <one-line summary>
   or
   VERIFY_RESULT: FAIL — <one-line summary>

Do NOT open a PR or modify any repository. Verification only.`;
}

/**
 * Spawn a verify cloud agent that runs the test plan against the deployed site.
 * Returns the agent id, or null on failure.
 */
export async function spawnVerifyAgent(input: VerifyRunInput): Promise<string | null> {
  const repo = `${ghOwner}/${deployTargetRepo}`;
  const cycle = PIPELINE_CYCLE_BY_ID[input.cycle ?? "initial"];
  console.log(
    `[verify] Starting a Cursor cloud agent on github.com/${repo} for ${input.issue.identifier} → ${input.prodUrl}`,
  );
  try {
    const { Agent } = await import("@cursor/sdk");
    await using agent = await Agent.create({
      apiKey: cursorKey(),
      model: { id: modelId },
      cloud: {
        repos: [{ url: `https://github.com/${repo}` }],
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    });
    const run = await agent.send(verifyPrompt(input));
    console.log(`[verify] Launched on ${repo} — agent ${agent.agentId}, run ${run.id}.`);
    await postComment(
      input.issue.id,
      `${cycle.verifySpawnMarker(agent.agentId)}
${markers.bridge}
${cycle.verifySpawnHeadline}

Agent ID: \`${agent.agentId}\`
Site: ${input.prodUrl}
Repo: \`${repo}\``,
    );
    return agent.agentId;
  } catch (err) {
    const msg = oneLineError(err);
    console.error(`[verify] Failed to start on ${repo}: ${msg}`);
    await postComment(
      input.issue.id,
      `${markers.bridge}\n**Verify agent failed to start**\n\n${msg}`,
    );
    return null;
  }
}

/** Parses PASS/FAIL from the verify agent's machine-readable verdict line. */
export function parseVerifyVerdict(text: string): "pass" | "fail" | null {
  const match = text.match(/VERIFY_RESULT:\s*(PASS|FAIL)/i);
  if (!match) return null;
  return match[1].toUpperCase() === "PASS" ? "pass" : "fail";
}

export interface AgentRunResult {
  terminal: boolean;
  status: string;
  resultText?: string;
}

/** A single assistant message step inside a cloud run conversation. */
interface AssistantMessageStep {
  type?: string;
  message?: { text?: string };
}

/** One turn in the SDK conversation list (shape varies by API version). */
interface ConversationTurn {
  turn?: { steps?: AssistantMessageStep[] };
}

/** Run object that may expose a conversation() reader. */
interface RunWithConversation {
  conversation?: () => Promise<ConversationTurn[] | { messages?: ConversationTurn[]; items?: ConversationTurn[] }>;
}

/**
 * Recovers the final assistant message from a run's conversation. Finished cloud
 * runs frequently expose no `result`/`output` via `listRuns`, so the agent's
 * last reply is the only readable report. Tolerant of varying SDK shapes.
 */
export async function finalAssistantText(run: unknown): Promise<string | undefined> {
  const r = run as RunWithConversation;
  if (typeof r?.conversation !== "function") return undefined;
  try {
    const convo = await r.conversation();
    const entries = Array.isArray(convo) ? convo : convo?.messages ?? convo?.items ?? [];
    const steps = entries.flatMap((entry) => entry?.turn?.steps ?? []);
    const texts = steps
      .filter((step) => step?.type === "assistantMessage")
      .map((step) => step?.message?.text)
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
    return texts.at(-1);
  } catch {
    return undefined;
  }
}

/**
 * Reads a cloud agent's latest run output text (for verify verdict parsing and
 * findings reporting). Falls back to the conversation's final assistant message
 * when a terminal run carries no result text. Returns null when the run cannot
 * be read yet.
 */
export async function readAgentRunResult(agentId: string): Promise<AgentRunResult | null> {
  const { Agent } = await import("@cursor/sdk");
  try {
    const runs = await Agent.listRuns(agentId, { runtime: "cloud", apiKey: cursorKey() });
    const run = pickLatestRun(runs.items) as
      | { status?: string; result?: string; output?: string }
      | undefined;
    if (!run?.status) return null;
    const terminal = run.status === "finished" || run.status === "error" || run.status === "cancelled";
    let resultText = run.result ?? run.output;
    if (terminal && !resultText) resultText = await finalAssistantText(run);
    return { terminal, status: run.status, resultText };
  } catch (err) {
    console.error(`[verify] could not read runs for ${agentId}:`, err);
    return null;
  }
}

export interface RemediationAlert {
  title: string;
  body?: string;
  route?: string;
  observedMs?: number;
  /** Optional Linear issue this remediation should be attached to (for the dashboard). */
  issue?: LinearIssuePayload;
}

function remediationPrompt(alert: RemediationAlert): string {
  const repo = `${ghOwner}/${deployTargetRepo}`;
  return `${skillEntryLine("hotfix-regression")}

A production monitor for \`service:${deployTargetRepo}\` just alerted.

## Alert
- Monitor: ${alert.title}
- ${alert.route ? `Slow route: ${alert.route}` : "Route: (see alert body)"}
- ${alert.observedMs ? `Observed response time: ${alert.observedMs}ms` : "Observed: latency above threshold"}
${alert.body ? `\nDetails:\n${alert.body}` : ""}

## Your job (repo: ${repo})
1. Diagnose the slow path. Use the Datadog MCP if available to inspect the latency breakdown and slowest spans for \`service:${deployTargetRepo}\`.
2. The most recent change introduced a performance regression that passes code review but is slow under production data volume — typically an N+1 query (fetching quotes per holding in a loop instead of batching) or a dropped cache (e.g. the memoization in \`src/lib/market-data/cached.ts\` was removed).
3. Open a HOTFIX PR that reverses exactly that regression: restore batching/caching so latency returns to normal. Keep the change minimal and add a regression test if practical.
4. Open the PR against \`main\`. Title it clearly as a hotfix and reference the latency alert.

This PR re-enters conductor's loop at review, closing the remediation circle. Open the PR when done.`;
}

/**
 * Spawn a remediation cloud agent on the target repo, seeded with a Datadog
 * alert. Posts a remediation-specific marker (never counted as a build agent) so
 * the reconciler can report its hotfix PR later. Returns the agent id, or null
 * on failure.
 */
export async function spawnRemediationAgent(alert: RemediationAlert): Promise<string | null> {
  const repo = `${ghOwner}/${deployTargetRepo}`;
  console.log(`[remediation] Starting a Cursor cloud agent on github.com/${repo} for "${alert.title}"`);
  try {
    // See spawnAgent: import inside the try so a missing native sqlite3 binding
    // surfaces as a "failed to start" comment rather than an unhandled throw.
    const { Agent } = await import("@cursor/sdk");
    await using agent = await Agent.create({
      apiKey: cursorKey(),
      model: { id: modelId },
      cloud: {
        repos: [{ url: `https://github.com/${repo}` }],
        autoCreatePR: true,
        skipReviewerRequest: true,
      },
    });
    const run = await agent.send(remediationPrompt(alert));
    console.log(`[remediation] Launched on ${repo} — agent ${agent.agentId}, run ${run.id}.`);
    if (alert.issue) {
      await postComment(
        alert.issue.id,
        `${markers.remediationSpawned(agent.agentId)}\n${markers.remediated}\n**🛠️ Remediation agent dispatched** — diagnosing the latency alert and preparing a hotfix PR.\n\nAgent ID: \`${agent.agentId}\`\nRepo: \`${repo}\``,
      );
    }
    return agent.agentId;
  } catch (err) {
    const msg = oneLineError(err);
    console.error(`[remediation] Failed to start on ${repo}: ${msg}`);
    if (alert.issue) {
      await postComment(alert.issue.id, `${markers.bridge}\n**Remediation agent failed to start**\n\n${msg}`);
    }
    return null;
  }
}

export interface AgentRunStatus {
  /** True once the run reached a terminal state (finished/error/cancelled). */
  terminal: boolean;
  status: string;
  prUrl?: string;
}

/**
 * Whether a spawned agent's run should be reported complete back to Linear.
 *
 * An open PR is the build's (and hotfix's) deliverable, so a published PR counts
 * as done even while the cloud run is still "running": cloud runs commonly keep
 * running after opening their PR, and waiting for a terminal status leaves the
 * dashboard's build stage stuck on "running" despite an already-published PR.
 * A terminal run with no PR is also reportable (nothing more is coming); a
 * still-running run with no PR is not yet done.
 */
export function isRunReportable(status: AgentRunStatus): boolean {
  return status.terminal || Boolean(status.prUrl);
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
