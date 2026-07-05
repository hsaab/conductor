/**
 * Pipeline cycle descriptors: one object per pass (initial ship vs hotfix loop)
 * that carries every marker, parser, and copy variant the tail stages need.
 */
import { markers } from "../config.js";
import {
  hasComment,
  hasRemediationDone,
  parseAgentResults,
  parseDoneAgentIds,
  parseHotfixVerifyAgents,
  parseRemediationResults,
  parseSpawnedAgents,
  parseVerifyAgents,
} from "../integrations/linear.js";
import type { LinearIssuePayload, SpawnedAgent, StageState } from "../types.js";

/** Build-agent bookkeeping the reconciler already computed, so cycles can reuse it. */
export interface MergeContext {
  spawned: SpawnedAgent[];
  done: Set<string>;
}

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
   * Whether a failure was reported outside this cycle's verify markers. Only the
   * initial cycle has such a channel: a Datadog alert dispatching remediation
   * (the `remediated` marker). It both blocks the verify window fallback and
   * settles the verify stage as done — the failure moved to the remediate stage.
   * The hotfix cycle has no out-of-band channel (a re-alert is blocked by the
   * `remediated` marker), so its only failure signal is the fail marker itself.
   */
  outOfBandFailure?: (issue: LinearIssuePayload) => boolean;
  /** Initial pass gates review on all build agents done; hotfix loop does not. */
  requiresBuildDoneForReview: boolean;
  /** Whether this cycle's PR(s) are ready to be checked for a merge on GitHub. */
  mergeReady: (issue: LinearIssuePayload, ctx?: MergeContext) => boolean;
  mergeHeadline: string;
  mergeNoun: (count: number) => string;
  deployedHeadline: (project: string, shortSha?: string) => string;
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

function allBuildAgentsDone(issue: LinearIssuePayload, ctx?: MergeContext): boolean {
  const spawned = ctx?.spawned ?? parseSpawnedAgents(issue);
  const done = ctx?.done ?? parseDoneAgentIds(issue);
  return spawned.length > 0 && spawned.every((agent) => done.has(agent.agentId));
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
 * True once this cycle's verify stage has settled: an explicit pass/fail
 * verdict, or a failure reported through the cycle's out-of-band channel.
 */
export function verdictSettled(issue: LinearIssuePayload, cycle: PipelineCycle): boolean {
  return (
    hasComment(issue, cycle.passMarker) ||
    hasComment(issue, cycle.failMarker) ||
    (cycle.outOfBandFailure?.(issue) ?? false)
  );
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
  outOfBandFailure: (issue) => hasComment(issue, markers.remediated),
  requiresBuildDoneForReview: true,
  mergeReady: allBuildAgentsDone,
  mergeHeadline: "🔀 Merged",
  mergeNoun: (count) => (count === 1 ? "pull request" : "pull requests"),
  deployedHeadline: (project, shortSha) =>
    `**🚀 ${project} deployed to production**${shortSha ? ` (\`${shortSha}\`)` : ""}`,
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
  requiresBuildDoneForReview: false,
  mergeReady: (issue) => hasRemediationDone(issue),
  mergeHeadline: "🔀 Hotfix merged",
  mergeNoun: (count) => (count === 1 ? "hotfix pull request" : "hotfix pull requests"),
  deployedHeadline: (_project, shortSha) =>
    `**🛠️ Hotfix deployed to production**${shortSha ? ` (\`${shortSha}\`)` : ""}`,
  verifySpawnHeadline:
    "**🔍 Hotfix verify agent dispatched** — re-running the test plan against the hotfix deploy.",
  verifySpawnMarker: markers.hotfixVerifySpawned,
};

/** Ordered passes: initial ship, then hotfix loop after remediation. */
export const PIPELINE_CYCLES = [INITIAL_PIPELINE_CYCLE, HOTFIX_PIPELINE_CYCLE] as const;

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

export interface TailStages {
  review: StageState;
  deploy: StageState;
  verify: StageState;
}

/**
 * Derives review/deploy/verify for one pipeline cycle from its markers.
 * The hotfix pass overrides the initial tail when a hotfix PR is open.
 */
export function deriveTailStages(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
  ctx: TailStageContext,
): TailStages {
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
        : cycle.outOfBandFailure?.(issue)
          ? "done"
          : "running";

  return { review, deploy, verify };
}
