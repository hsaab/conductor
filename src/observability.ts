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
import { deployTargetRepo, githubToken, markers, observeWindowMs } from "./config.js";
import { checkServiceHealth, datadogServiceUrl, type ServiceHealth } from "./datadog.js";
import { findActiveFleet, summarizeJob } from "./fleet.js";
import { allPullRequestsMerged } from "./github.js";
import { hasComment, postComment } from "./linear.js";
import { postSlack, statusBlocks } from "./slack.js";
import type { LinearIssuePayload } from "./types.js";

export interface DeploymentInfo {
  project: string;
  url?: string;
  target?: string;
  commitSha?: string;
  commitMessage?: string;
}

/** Tolerantly extracts deployment fields from the varied Vercel webhook shapes. */
export function extractDeployment(body: any): DeploymentInfo | null {
  const p = body?.payload ?? body ?? {};
  const deployment = p.deployment ?? {};
  const project = p.project?.name ?? p.name ?? deployment.name ?? deployment.meta?.githubRepo;
  if (!project) return null;
  const meta = deployment.meta ?? p.meta ?? {};
  const rawUrl = p.url ?? deployment.url;
  return {
    project: String(project),
    url: rawUrl ? (String(rawUrl).startsWith("http") ? String(rawUrl) : `https://${rawUrl}`) : undefined,
    target: p.target ?? deployment.target ?? undefined,
    commitSha: meta.githubCommitSha ?? meta.gitCommitSha ?? undefined,
    commitMessage: meta.githubCommitMessage ?? meta.gitCommitMessage ?? undefined,
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

export function buildDeployAnnouncement(
  project: string,
  health: ServiceHealth,
  windowMin: number,
): DeployAnnouncement {
  const errors = health.unknown ? 0 : health.errors ?? 0;
  if (errors > 0) {
    const count = `${errors} error log${errors === 1 ? "" : "s"}`;
    return {
      headline: `⚠️ ${project} shipped with errors already in production`,
      scanLine: `Scanning: ⚠️ ${count} already in production (last 10 min)`,
      observeNote: `⚠️ ${count} already present. `,
    };
  }
  return {
    headline: `🚀 ${project} shipped to production`,
    scanLine: `Scanning: 🔭 watching production logs and errors for ${windowMin} min`,
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
  if (dep.target && dep.target !== "production") {
    return { handled: false, reason: `ignoring ${dep.target} deploy` };
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
    const count = prUrls.length === 1 ? "1 pull request" : `${prUrls.length} pull requests`;
    await postComment(
      issue.id,
      `${markers.merged}\n**🔀 Merged** — ${count} merged to the default branch.\n${prUrls.join("\n")}`,
    );
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
  const { headline, scanLine, observeNote } = buildDeployAnnouncement(dep.project, health, windowMin);
  const lines = [
    issue ? `Ticket: ${issue.identifier} — ${issue.title}` : "Ticket: (unmatched)",
    dep.url ? `Deploy: ${dep.url}` : "",
    shortSha ? `Commit: ${shortSha}${dep.commitMessage ? ` — ${dep.commitMessage.split("\n")[0]}` : ""}` : "",
    scanLine,
    `Dashboard: ${datadogServiceUrl(deployTargetRepo)}`,
  ].filter(Boolean);

  await postSlack(statusBlocks(headline, lines));

  if (issue && !hasComment(issue, markers.verified)) {
    await postComment(
      issue.id,
      `${markers.verified}\n${markers.announced}\n**🔭 Observability:** ${observeNote}scanning production logs and errors for ${windowMin} min before closing the observe window.`,
    );
  }

  return { handled: true };
}
