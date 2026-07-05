/**
 * Pipeline cycle descriptors: one object per pass (initial ship vs hotfix loop)
 * that carries every marker, parser, and copy variant the tail stages need.
 */
import { markers } from "../config.js";
import {
  hasComment,
  hasRemediationDone,
  hasVerifyFail,
  hasVerifyPass,
  parseAgentResults,
  parseHotfixVerifyAgents,
  parseRemediationResults,
  parseSpawnedAgents,
  parseVerifyAgents,
} from "../integrations/linear.js";
import type { LinearIssuePayload, SpawnedAgent, StageState } from "../types.js";

export interface PipelineCycle {
  id: "initial" | "hotfix";
  /** Human label used in log lines, Slack copy, and comment headlines. */
  label: "verify" | "hotfix verify";
  deployedMarker: string;
  passMarker: string;
  failMarker: string;
  mergedMarker: string;
  /** Comment substring identifying this cycle's verify-agent spawns (window start). */
  spawnNeedle: string;
  parseAgents: (issue: LinearIssuePayload) => SpawnedAgent[];
  prUrls: (issue: LinearIssuePayload) => string[];
  /**
   * Whether a failure was reported out-of-band (blocks the verify window fallback).
   * Only the initial cycle has such a channel: a Datadog alert dispatching
   * remediation. In the hotfix cycle a re-alert is blocked by the `remediated`
   * marker, so its only failure signal is the fail marker itself.
   */
  failureReported: (issue: LinearIssuePayload) => boolean;
  /** Whether verify stage can settle as done via out-of-band failure (initial only). */
  verifyDoneOnFailureReported: boolean;
  /** Initial pass gates review on all build agents done; hotfix loop does not. */
  requiresBuildDoneForReview: boolean;
  verdictSettled: (issue: LinearIssuePayload) => boolean;
  mergeHeadline: string;
  mergeNoun: (count: number) => string;
  deployedHeadline: (project: string, shortSha?: string) => string;
  deploySlackHeadline: (project: string) => string;
  deploySlackVerifyLine: string;
  verifySpawnHeadline: string;
  verifySpawnMarker: (agentId: string) => string;
}

function buildPrUrls(issue: LinearIssuePayload): string[] {
  const spawned = parseSpawnedAgents(issue);
  const results = parseAgentResults(issue);
  return spawned
    .map((agent) => results.get(agent.agentId)?.prUrl)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
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

export const INITIAL_PIPELINE_CYCLE: PipelineCycle = {
  id: "initial",
  label: "verify",
  deployedMarker: markers.deployed,
  passMarker: markers.verifyPass,
  failMarker: markers.verifyFail,
  mergedMarker: markers.merged,
  spawnNeedle: markers.verifySpawnNeedle,
  parseAgents: parseVerifyAgents,
  prUrls: buildPrUrls,
  failureReported: (issue) => hasComment(issue, markers.remediated),
  verifyDoneOnFailureReported: true,
  requiresBuildDoneForReview: true,
  verdictSettled: (issue) =>
    hasVerifyPass(issue) || hasVerifyFail(issue) || hasComment(issue, markers.remediated),
  mergeHeadline: "🔀 Merged",
  mergeNoun: (count) => (count === 1 ? "pull request" : "pull requests"),
  deployedHeadline: (project, shortSha) =>
    `**🚀 ${project} deployed to production**${shortSha ? ` (\`${shortSha}\`)` : ""}`,
  deploySlackHeadline: (project) => `🚀 ${project} shipped to production`,
  deploySlackVerifyLine: "Verify: 🔍 running test plan against production",
  verifySpawnHeadline: "**🔍 Verify agent dispatched** — running the test plan against the deployed site.",
  verifySpawnMarker: markers.verifySpawned,
};

export const HOTFIX_PIPELINE_CYCLE: PipelineCycle = {
  id: "hotfix",
  label: "hotfix verify",
  deployedMarker: markers.hotfixDeployed,
  passMarker: markers.hotfixVerifyPass,
  failMarker: markers.hotfixVerifyFail,
  mergedMarker: markers.hotfixMerged,
  spawnNeedle: markers.hotfixVerifySpawnNeedle,
  parseAgents: parseHotfixVerifyAgents,
  prUrls: hotfixPrUrls,
  failureReported: () => false,
  verifyDoneOnFailureReported: false,
  requiresBuildDoneForReview: false,
  verdictSettled: (issue) =>
    hasComment(issue, markers.hotfixVerifyPass) || hasComment(issue, markers.hotfixVerifyFail),
  mergeHeadline: "🔀 Hotfix merged",
  mergeNoun: (count) => (count === 1 ? "hotfix pull request" : "hotfix pull requests"),
  deployedHeadline: (_project, shortSha) =>
    `**🛠️ Hotfix deployed to production**${shortSha ? ` (\`${shortSha}\`)` : ""}`,
  deploySlackHeadline: (project) => `🛠️ ${project} hotfix deployed to production`,
  deploySlackVerifyLine: "Verify: 🔍 re-running the test plan against the hotfix",
  verifySpawnHeadline:
    "**🔍 Hotfix verify agent dispatched** — re-running the test plan against the hotfix deploy.",
  verifySpawnMarker: markers.hotfixVerifySpawned,
};

/** Ordered passes: initial ship, then hotfix loop after remediation. */
export const PIPELINE_CYCLES = [INITIAL_PIPELINE_CYCLE, HOTFIX_PIPELINE_CYCLE] as const;

/** @deprecated Use {@link INITIAL_PIPELINE_CYCLE}. Kept for tests during transition. */
export const INITIAL_VERIFY_CYCLE = INITIAL_PIPELINE_CYCLE;

/** @deprecated Use {@link HOTFIX_PIPELINE_CYCLE}. Kept for tests during transition. */
export const HOTFIX_VERIFY_CYCLE = HOTFIX_PIPELINE_CYCLE;

/**
 * Comment body confirming PR(s) merged for one pipeline cycle. Shared by the
 * reconciler and the Vercel deploy webhook, which can each be the first to
 * observe the merge.
 */
export function mergedCommentForCycle(cycle: PipelineCycle, prUrls: string[]): string {
  const count =
    prUrls.length === 1 ? `1 ${cycle.mergeNoun(1)}` : `${prUrls.length} ${cycle.mergeNoun(prUrls.length)}`;
  return `${cycle.mergedMarker}\n**${cycle.mergeHeadline}** — ${count} merged to the default branch.\n${prUrls.join("\n")}`;
}

export interface TailStageContext {
  allBuildDone: boolean;
}

/**
 * Derives review/deploy/verify for one pipeline cycle from its markers.
 * The hotfix pass overrides the initial tail when a hotfix PR is open.
 */
export function deriveTailStages(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
  ctx: TailStageContext,
): Pick<Record<string, StageState>, "review" | "deploy" | "verify"> {
  const deployed = hasComment(issue, cycle.deployedMarker);
  const merged = hasComment(issue, cycle.mergedMarker) || deployed;
  const verifyPass = hasComment(issue, cycle.passMarker);
  const verifyFail = hasComment(issue, cycle.failMarker);

  const review: StageState = cycle.requiresBuildDoneForReview
    ? !ctx.allBuildDone
      ? "pending"
      : merged
        ? "done"
        : "running"
    : merged
      ? "done"
      : "running";

  const deploy: StageState = deployed ? "done" : merged ? "running" : "pending";

  const verify: StageState = !deployed
    ? "pending"
    : verifyPass
      ? "done"
      : verifyFail
        ? "failed"
        : cycle.verifyDoneOnFailureReported && hasComment(issue, markers.remediated)
          ? "done"
          : "running";

  return { review, deploy, verify };
}
