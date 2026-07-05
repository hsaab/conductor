/**
 * Post-deploy observability stage. Triggered by Vercel's `deployment.succeeded`
 * webhook for the target project. A fresh deploy has not been observed yet, so
 * conductor does not assert health here. It advances the matching fleet on the
 * dashboard, announces that the project shipped and that scanning has begun, and
 * runs a light error-presence scan only to surface errors that are already in
 * production. The all-clear verdict comes later, at observe-window close.
 *
 * This stage is intentionally conductor-side rather than a spawned cloud agent:
 * the error scan is read-only and must be fast for the live demo, so we keep it
 * deterministic. The remediation stage, which writes code, is a real cloud agent
 * (see remediation.ts).
 */
import { deployTargetRepo, githubToken, markers, observeWindowMs, productionDeployHostname } from "../config.js";
import { checkServiceHealth, datadogServiceUrl, type ServiceHealth } from "../integrations/datadog.js";
import { spawnVerifyAgent } from "./agents.js";
import {
  HOTFIX_PIPELINE_CYCLE,
  INITIAL_PIPELINE_CYCLE,
  hotfixPrOpened,
  mergedCommentForCycle,
  type PipelineCycle,
} from "./cycle.js";
import { findActiveFleet } from "./fleet.js";
import { allPullRequestsMerged } from "../integrations/github.js";
import { hasComment, parseTestPlan, postComment } from "../integrations/linear.js";
import { postSlack, statusBlocks } from "../integrations/slack.js";
import type { LinearIssuePayload } from "../types.js";

export interface DeploymentInfo {
  project: string;
  url?: string;
  target?: string;
  commitSha?: string;
  commitMessage?: string;
  /** Git branch from deployment metadata, when present (preview deploys). */
  gitBranch?: string;
}

function hostnameFromUrl(url: string): string {
  const normalized = url.startsWith("http") ? url : `https://${url}`;
  return new URL(normalized).hostname.toLowerCase();
}

/**
 * Vercel preview deployments use hashed deployment URLs or branch aliases —
 * never the stable production alias.
 */
export function isPreviewDeployUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const host = hostnameFromUrl(url);
    if (/-[a-z0-9]+-[a-z0-9-]+-projects\.vercel\.app$/i.test(host)) return true;
    if (/-git-[a-z0-9-]+\.vercel\.app$/i.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * True only for deploys that actually hit production. An explicit `target` is
 * authoritative and wins over any URL heuristic. `target: "production"` is
 * production regardless of URL shape, because Vercel's immutable per-deploy URL
 * can share the preview URL shape on team accounts; any other explicit target is
 * not production. Only when `target` is absent (Vercel sends `target: null` for
 * previews) do we fall back to URL heuristics, so that a missing target is not
 * mistaken for production.
 */
export function isProductionDeployment(dep: DeploymentInfo): boolean {
  const target = dep.target?.toLowerCase();
  if (target) return target === "production";

  if (isPreviewDeployUrl(dep.url)) return false;

  const prodHost = productionDeployHostname();
  if (prodHost && dep.url) return hostnameFromUrl(dep.url) === prodHost;

  return Boolean(dep.url);
}

/** Tolerantly extracts deployment fields from the varied Vercel webhook shapes. */
export function extractDeployment(body: any): DeploymentInfo | null {
  const p = body?.payload ?? body ?? {};
  const deployment = p.deployment ?? {};
  const project = p.project?.name ?? p.name ?? deployment.name ?? deployment.meta?.githubRepo;
  if (!project) return null;
  const meta = deployment.meta ?? p.meta ?? {};
  const rawUrl = p.url ?? deployment.url;
  const rawTarget = p.target ?? deployment.target;
  return {
    project: String(project),
    url: rawUrl ? (String(rawUrl).startsWith("http") ? String(rawUrl) : `https://${rawUrl}`) : undefined,
    target: rawTarget == null ? undefined : String(rawTarget),
    commitSha: meta.githubCommitSha ?? meta.gitCommitSha ?? undefined,
    commitMessage: meta.githubCommitMessage ?? meta.gitCommitMessage ?? undefined,
    gitBranch: meta.githubCommitRef ?? meta.gitCommitRef ?? undefined,
  };
}

function matchesTarget(project: string): boolean {
  const target = deployTargetRepo.toLowerCase();
  return project.toLowerCase() === target || project.toLowerCase().includes(target);
}

export interface ObservabilityResult {
  handled: boolean;
  reason?: string;
}

/**
 * Deploy-time announcement copy. A fresh deploy has not been observed yet, so
 * this never claims health. It announces that the project shipped and that
 * conductor is now scanning; when errors are already present it surfaces that as
 * a warning. The positive verdict is produced later, at observe-window close.
 */
export interface DeployAnnouncement {
  headline: string;
  scanLine: string;
  /** Prefix for the observe comment, non-empty only when errors are already present. */
  observeNote: string;
}

export interface DeployAnnouncementOptions {
  /** When false, copy reflects an unmatched production deploy, not a fleet ship. */
  matchedTicket?: boolean;
}

export function buildDeployAnnouncement(
  project: string,
  health: ServiceHealth,
  windowMin: number,
  options: DeployAnnouncementOptions = {},
): DeployAnnouncement {
  const matchedTicket = options.matchedTicket !== false;
  const errors = health.unknown ? 0 : health.errors ?? 0;
  const shipped = matchedTicket ? "shipped to production" : "production deploy detected";
  if (errors > 0) {
    const count = `${errors} error log${errors === 1 ? "" : "s"}`;
    return {
      headline: matchedTicket
        ? `⚠️ ${project} shipped with errors already in production`
        : `⚠️ ${project} production deploy — ${count} already in logs`,
      scanLine: matchedTicket
        ? `Verify: 🔍 running test plan (${count} already in logs, ${windowMin} min window)`
        : `Note: no active fleet ticket matched this deploy`,
      observeNote: `⚠️ ${count} already present. `,
    };
  }
  return {
    headline: matchedTicket ? `🚀 ${project} shipped to production` : `📦 ${project} ${shipped}`,
    scanLine: matchedTicket
      ? `Verify: 🔍 running test plan against production (${windowMin} min window)`
      : `Note: no active fleet ticket matched this deploy`,
    observeNote: "",
  };
}

/**
 * When a GitHub token is configured, confirms the cycle's PR(s) merged before
 * advancing deploy. Returns a blocking result when merge is not yet confirmed.
 */
async function confirmMergeBeforeDeploy(
  issue: LinearIssuePayload,
  cycle: PipelineCycle,
): Promise<ObservabilityResult | null> {
  if (!githubToken() || hasComment(issue, cycle.mergedMarker)) return null;

  const prUrls = cycle.prUrls(issue);
  const merged = prUrls.length > 0 ? await allPullRequestsMerged(prUrls) : false;
  if (!merged) {
    const label = cycle.id === "hotfix" ? "hotfix PR(s)" : "PR(s)";
    return { handled: false, reason: `deploy ignored — ${issue.identifier} ${label} not merged yet` };
  }

  await postComment(issue.id, mergedCommentForCycle(cycle, prUrls));
  return null;
}

async function stampDeployedMarker(
  issue: LinearIssuePayload,
  dep: DeploymentInfo,
  cycle: PipelineCycle,
): Promise<void> {
  if (hasComment(issue, cycle.deployedMarker)) return;
  const shortSha = dep.commitSha?.slice(0, 7);
  await postComment(
    issue.id,
    `${cycle.deployedMarker}\n${cycle.deployedHeadline(dep.project, shortSha)}\n${dep.url ?? ""}`,
  );
}

async function spawnVerifyIfNeeded(
  issue: LinearIssuePayload,
  dep: DeploymentInfo,
  cycle: PipelineCycle,
): Promise<void> {
  if (cycle.parseAgents(issue).length > 0) return;
  const prodHost = productionDeployHostname();
  const prodUrl = dep.url ?? (prodHost ? `https://${prodHost}` : "");
  if (prodUrl) {
    await spawnVerifyAgent({ issue, prodUrl, testPlan: parseTestPlan(issue), cycle: cycle.id });
  }
}

/**
 * Shared deploy path for one pipeline cycle: merge gate, deployed marker,
 * Slack announcement, and verify-agent dispatch.
 */
async function handleCycleDeployment(
  issue: LinearIssuePayload,
  dep: DeploymentInfo,
  cycle: PipelineCycle,
): Promise<ObservabilityResult> {
  const mergeBlock = await confirmMergeBeforeDeploy(issue, cycle);
  if (mergeBlock) return mergeBlock;

  await stampDeployedMarker(issue, dep, cycle);

  const shortSha = dep.commitSha?.slice(0, 7);
  await postSlack(
    statusBlocks(cycle.deploySlackHeadline(dep.project), [
      `Ticket: ${issue.identifier} — ${issue.title}`,
      dep.url ? `Deploy: ${dep.url}` : "",
      shortSha ? `Commit: ${shortSha}${dep.commitMessage ? ` — ${dep.commitMessage.split("\n")[0]}` : ""}` : "",
      cycle.deploySlackVerifyLine,
    ].filter(Boolean)),
  );

  await spawnVerifyIfNeeded(issue, dep, cycle);
  return { handled: true };
}

/**
 * Handles one Vercel deployment webhook end to end. Idempotent per fleet via the
 * `deployed` marker, so redelivered webhooks do not double-post.
 */
export async function handleVercelDeployment(body: unknown): Promise<ObservabilityResult> {
  const dep = extractDeployment(body);
  if (!dep) return { handled: false, reason: "could not parse deployment payload" };
  if (!matchesTarget(dep.project)) return { handled: false, reason: `ignoring project ${dep.project}` };
  if (!isProductionDeployment(dep)) {
    const kind = dep.target ?? (isPreviewDeployUrl(dep.url) ? "preview" : "non-production");
    return { handled: false, reason: `ignoring ${kind} deploy` };
  }

  const issue = await findActiveFleet(
    (job) => job.stages.build === "done" && job.stages.deploy !== "done",
    { commitSha: dep.commitSha, url: dep.url },
  );

  if (issue && hotfixPrOpened(issue) && hasComment(issue, markers.deployed)) {
    return handleCycleDeployment(issue, dep, HOTFIX_PIPELINE_CYCLE);
  }

  if (issue) {
    const mergeBlock = await confirmMergeBeforeDeploy(issue, INITIAL_PIPELINE_CYCLE);
    if (mergeBlock) return mergeBlock;
    await stampDeployedMarker(issue, dep, INITIAL_PIPELINE_CYCLE);
  }

  const windowMin = Math.round(observeWindowMs() / 60_000);
  const health = await checkServiceHealth(deployTargetRepo);
  const prodHost = productionDeployHostname();
  const { headline, scanLine } = buildDeployAnnouncement(dep.project, health, windowMin, {
    matchedTicket: Boolean(issue),
  });
  const shortSha = dep.commitSha?.slice(0, 7);
  const lines = [
    issue ? `Ticket: ${issue.identifier} — ${issue.title}` : "Ticket: none — no active fleet matched",
    dep.url ? `Deploy: ${dep.url}` : "",
    prodHost ? `Production: https://${prodHost}` : "",
    shortSha ? `Commit: ${shortSha}${dep.commitMessage ? ` — ${dep.commitMessage.split("\n")[0]}` : ""}` : "",
    scanLine,
    issue ? `Dashboard: ${datadogServiceUrl(deployTargetRepo)}` : "",
  ].filter(Boolean);

  await postSlack(statusBlocks(headline, lines));

  if (issue) {
    await spawnVerifyIfNeeded(issue, dep, INITIAL_PIPELINE_CYCLE);
  }

  return { handled: true };
}
