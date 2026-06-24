/**
 * Centralized configuration, constants, and the comment-marker conventions the
 * bridge uses for durable state.
 *
 * Secrets are read through getter functions (not captured at module load) so a
 * single warm serverless instance always sees the latest injected env values.
 */

/**
 * Reads a string env var, falling back to `fallback` when it is unset OR blank.
 *
 * Uses `||` on the trimmed value (not `??`) on purpose: `??` only substitutes on
 * `null`/`undefined`, so an env var set to an empty string (e.g. `GH_OWNER=""` in
 * a deployment) would slip through and silently poison config — blanking the
 * owner turns every repo URL into `github.com//repo` and misroutes the planner
 * and fleet. Trimming also guards against accidental whitespace-only values.
 */
function envOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/** GitHub org/user that owns the target repos. Safe to capture at load. */
export const ghOwner = envOr(process.env.GH_OWNER, "hsaab");

/** The repo the loop builds, deploys, and observes (short name under {@link ghOwner}). */
export const deployTargetRepo = envOr(process.env.DEPLOY_TARGET_REPO, "compound");

/**
 * GitHub token used only to read pull-request merge status so the review/merge
 * stages advance on the real merge (target repos are private). Optional: without
 * it, conductor falls back to treating a successful deploy as proof of merge.
 *
 * Named `GH_TOKEN` (with a `GITHUB_TOKEN` fallback) so it does not collide with a
 * developer's `gh`/git credentials when this token is repo-scoped to the target.
 */
export const githubToken = (): string => process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

export const cursorKey = (): string => process.env.CURSOR_API_KEY ?? "";
export const linearKey = (): string => process.env.LINEAR_API_KEY ?? "";
export const webhookSecret = (): string => process.env.LINEAR_WEBHOOK_SECRET ?? "";
export const triggerSecret = (): string => process.env.BRIDGE_TRIGGER_SECRET ?? "";

/** Vercel injects `Authorization: Bearer ${CRON_SECRET}` on cron invocations. */
export const cronSecret = (): string => process.env.CRON_SECRET ?? "";

/** Slack incoming webhook URL for agent output (observability + remediation). */
export const slackWebhookUrl = (): string => process.env.SLACK_WEBHOOK_URL ?? "";

/** Shared secret guarding the Vercel deployment webhook (`/webhook/vercel`). */
export const vercelWebhookSecret = (): string => process.env.VERCEL_WEBHOOK_SECRET ?? "";

/** Shared secret guarding the Datadog monitor webhook (`/webhook/datadog`). */
export const datadogWebhookSecret = (): string => process.env.DATADOG_WEBHOOK_SECRET ?? "";

/** Datadog API key for conductor's own health queries (optional). */
export const datadogApiKey = (): string => process.env.DD_API_KEY ?? "";

/** Datadog application key for conductor's own health queries (optional). */
export const datadogAppKey = (): string => process.env.DD_APP_KEY ?? "";

/** Datadog site (e.g. datadoghq.com, us5.datadoghq.com). Defaults to US1. */
export const datadogSite = (): string => envOr(process.env.DD_SITE, "datadoghq.com");

/**
 * How long the observe stage keeps monitoring for production alerts before
 * closing cleanly (no remediation). Defaults to 2 min to align with Datadog
 * synthetic cadence. Override with `OBSERVE_WINDOW_MS`.
 */
export const observeWindowMs = (): number => Number(process.env.OBSERVE_WINDOW_MS ?? 120_000);

/** Cloud model used for every spawned agent. Override with `BRIDGE_MODEL_ID`. */
export const modelId = envOr(process.env.BRIDGE_MODEL_ID, "composer-2.5");

/** Cursor model the planner agent uses to read the ticket. Override with `PLANNER_MODEL_ID`. */
export const plannerModelId = envOr(process.env.PLANNER_MODEL_ID, "composer-2.5");

/** Upper bound on agents spawned per ticket. */
export const maxAgents = Number(process.env.MAX_AGENTS ?? 6);

/** Trigger filters: an issue only spawns a fleet when it matches all of these. */
export const triggerLabel = "cursor-fleet";
export const triggerState = "In Progress";

/**
 * Hidden HTML-comment markers embedded in Linear comments. They make conductor
 * idempotent across serverless cold starts without any database: the comment
 * thread itself is the state store.
 */
export const markers = {
  /** Generic tag present on EVERY conductor-authored comment, so reset can find and remove them all. */
  bridge: "<!-- conductor -->",
  /** Posted before spawning, so a fleet launches at most once per issue. */
  fleetStarted: "<!-- conductor:fleet-started -->",
  /** Posted once every agent for an issue has reported back. */
  fleetComplete: "<!-- conductor:fleet-complete -->",
  /** Per-agent completion marker; keeps the reconciler from double-reporting. */
  agentDone: (agentId: string): string => `<!-- conductor:agent-done id=${agentId} -->`,
  /** Posted once every build PR has merged to its default branch (merge stage done). */
  merged: "<!-- conductor:merged -->",
  /** Posted when a deploy of the target repo succeeds (observability stage begins). */
  deployed: "<!-- conductor:deployed -->",
  /** Posted when the deploy is recorded and the observe window opens (scanning begins). */
  verified: "<!-- conductor:verified -->",
  /** Posted when the observe window elapsed with no alerts — remediation not needed. */
  observeComplete: "<!-- conductor:observe-complete -->",
  /** Posted when a stage result has been announced to Slack. */
  announced: "<!-- conductor:announced -->",
  /** Posted when a Datadog alert has dispatched a remediation agent (stage begins). */
  remediated: "<!-- conductor:remediated -->",
  /** Marks a dispatched remediation agent. Distinct from build "agent spawned" so it never counts as a build agent. */
  remediationSpawned: (agentId: string): string => `<!-- conductor:remediation-agent id=${agentId} -->`,
  /** Per-remediation-agent completion marker carrying the hotfix PR. */
  remediationDone: (agentId: string): string => `<!-- conductor:remediation-done id=${agentId} -->`,
};

/**
 * The ordered pipeline stages conductor advances each ticket through. The
 * dashboard derives each stage's state from the markers above.
 */
export const pipelineStages = [
  "plan",
  "build",
  "review",
  "merge",
  "deploy",
  "observe",
  "remediate",
] as const;

export type PipelineStage = (typeof pipelineStages)[number];

/** Emoji the bridge reacts with on an issue the instant it engages (demo signal). */
export const reactionEmoji = "🚀";
