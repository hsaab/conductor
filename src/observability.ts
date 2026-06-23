/**
 * Post-deploy observability stage. Triggered by Vercel's `deployment.succeeded`
 * webhook for the target project. Conductor verifies the deploy is healthy (via
 * Datadog when configured), advances the matching fleet on the dashboard, and
 * announces the result to Slack.
 *
 * This stage is intentionally conductor-side rather than a spawned cloud agent:
 * a deploy-health check is read-only and must be fast for the live demo, so we
 * keep it deterministic. The remediation stage, which writes code, is a real
 * cloud agent (see remediation.ts).
 */
import { deployTargetRepo, markers } from "./config.js";
import { checkServiceHealth, datadogServiceUrl } from "./datadog.js";
import { findActiveFleet } from "./fleet.js";
import { hasComment, postComment } from "./linear.js";
import { postSlack, statusBlocks } from "./slack.js";

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
  healthy?: boolean;
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
  const shortSha = dep.commitSha?.slice(0, 7);
  if (issue && !hasComment(issue, markers.deployed)) {
    await postComment(
      issue.id,
      `${markers.deployed}\n**🚀 ${dep.project} deployed to production**${shortSha ? ` (\`${shortSha}\`)` : ""}\n${dep.url ?? ""}`,
    );
  }

  // Verify health (best-effort; assumes healthy when Datadog is not configured).
  const health = await checkServiceHealth(deployTargetRepo);
  const healthy = health.unknown || (health.errors ?? 0) === 0;
  const healthLine = health.unknown
    ? "Health: assumed healthy (Datadog not configured)"
    : healthy
      ? "Health: ✅ no errors in the last 10 min"
      : `Health: ⚠️ ${health.errors} error logs in the last 10 min`;

  const headline = healthy
    ? `✅ ${dep.project} shipped and healthy`
    : `⚠️ ${dep.project} shipped with errors`;
  const lines = [
    issue ? `Ticket: ${issue.identifier} — ${issue.title}` : "Ticket: (unmatched)",
    dep.url ? `Deploy: ${dep.url}` : "",
    shortSha ? `Commit: ${shortSha}${dep.commitMessage ? ` — ${dep.commitMessage.split("\n")[0]}` : ""}` : "",
    healthLine,
    `Dashboard: ${datadogServiceUrl(deployTargetRepo)}`,
  ].filter(Boolean);

  await postSlack(statusBlocks(headline, lines));

  if (issue && !hasComment(issue, markers.verified)) {
    await postComment(
      issue.id,
      `${markers.verified}\n${markers.announced}\n**🔭 Observability:** ${healthLine}. Announced to Slack.`,
    );
  }

  return { handled: true, healthy };
}
