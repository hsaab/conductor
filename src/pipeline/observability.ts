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
import { findActiveFleet, mergedComment, summarizeJob } from "./fleet.js";
import { allPullRequestsMerged } from "../integrations/github.js";
import { hasComment, parseTestPlan, parseVerifyAgents, postComment } from "../integrations/linear.js";
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
 * True only for deploys that actually hit production. Vercel sends `target: null`
 * for previews; treating "missing target" as production caused PR preview URLs
 * to announce "shipped to production".
 */
export function isProductionDeployment(dep: DeploymentInfo): boolean {
  const target = dep.target?.toLowerCase();
  if (target && target !== "production") return false;
  if (isPreviewDeployUrl(dep.url)) return false;

  if (target === "production") return true;

  const prodHost = productionDeployHostname();
  if (prodHost && dep.url) return hostnameFromUrl(dep.url) === prodHost;

  // Legacy: null target with a non-preview URL and no canonical prod host configured.
  return !target && Boolean(dep.url);
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

/** Build-agent PR URLs recorded on a fleet issue, used to confirm the merge before deploy. */
function buildPrUrls(issue: LinearIssuePayload): string[] {
  return summarizeJob(issue, Date.now())
    .agents.filter((agent) => agent.role === "build" && agent.prUrl)
    .map((agent) => agent.prUrl as string);
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

  // Advance the dashboard: mark the in-flight fleet (build done, not yet deployed)
  // as deployed. Pass the deploy's commit SHA / URL as a hint so that, when more
  // than one fleet is in flight, an exact match wins over "most recently updated".
  const issue = await findActiveFleet(
    (job) => job.stages.build === "done" && job.stages.deploy !== "done",
    { commitSha: dep.commitSha, url: dep.url },
  );

  // A deploy must follow a real merge. The target app redeploys to production for
  // reasons unrelated to any one ticket (and its prod URL changes every time), so a
  // bare `deployment.succeeded` is NOT proof the in-flight fleet shipped — without
  // this gate, a stray deploy completes merge→deploy→observe for a ticket whose PR
  // is still open. When a GitHub token is configured we confirm the fleet's PR(s)
  // actually merged before advancing; with no token we cannot verify, so we keep the
  // legacy behavior of trusting the deploy as the merge signal.
  if (issue && githubToken() && !hasComment(issue, markers.merged)) {
    const prUrls = buildPrUrls(issue);
    const merged = prUrls.length > 0 ? await allPullRequestsMerged(prUrls) : false;
    if (!merged) {
      return { handled: false, reason: `deploy ignored — ${issue.identifier} PR(s) not merged yet` };
    }
    // The deploy webhook can beat the reconciler's merge check; record the confirmed
    // merge here so the dashboard's review/merge stages advance in lockstep.
    await postComment(issue.id, mergedComment(prUrls));
  }

  const shortSha = dep.commitSha?.slice(0, 7);
  if (issue && !hasComment(issue, markers.deployed)) {
    await postComment(
      issue.id,
      `${markers.deployed}\n**🚀 ${dep.project} deployed to production**${shortSha ? ` (\`${shortSha}\`)` : ""}\n${dep.url ?? ""}`,
    );
  }

  // A fresh deploy has not been observed yet, so do not assert health. Scan only
  // for errors already in production at deploy time; the all-clear verdict is
  // produced later, when the observe window closes (see reconcileObserve).
  const windowMin = Math.round(observeWindowMs() / 60_000);
  const health = await checkServiceHealth(deployTargetRepo);
  const prodHost = productionDeployHostname();
  const { headline, scanLine, observeNote } = buildDeployAnnouncement(dep.project, health, windowMin, {
    matchedTicket: Boolean(issue),
  });
  const lines = [
    issue ? `Ticket: ${issue.identifier} — ${issue.title}` : "Ticket: none — no active fleet matched",
    dep.url ? `Deploy: ${dep.url}` : "",
    prodHost ? `Production: https://${prodHost}` : "",
    shortSha ? `Commit: ${shortSha}${dep.commitMessage ? ` — ${dep.commitMessage.split("\n")[0]}` : ""}` : "",
    scanLine,
    issue ? `Dashboard: ${datadogServiceUrl(deployTargetRepo)}` : "",
  ].filter(Boolean);

  await postSlack(statusBlocks(headline, lines));

  if (issue && parseVerifyAgents(issue).length === 0) {
    const prodHost = productionDeployHostname();
    const prodUrl = dep.url ?? (prodHost ? `https://${prodHost}` : "");
    const testPlan = parseTestPlan(issue);
    if (prodUrl) {
      await spawnVerifyAgent({ issue, prodUrl, testPlan });
    }
  }

  return { handled: true };
}
