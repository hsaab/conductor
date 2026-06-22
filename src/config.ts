/**
 * Centralized configuration, constants, and the comment-marker conventions the
 * bridge uses for durable state.
 *
 * Secrets are read through getter functions (not captured at module load) so a
 * single warm serverless instance always sees the latest injected env values.
 */

/** GitHub org/user that owns the target repos. Safe to capture at load. */
export const ghOwner = process.env.GH_OWNER ?? "hsaab";

/** The repo the loop builds, deploys, and observes (short name under {@link ghOwner}). */
export const deployTargetRepo = process.env.DEPLOY_TARGET_REPO ?? "compound";

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

/** Cloud model used for every spawned agent. Override with `BRIDGE_MODEL_ID`. */
export const modelId = process.env.BRIDGE_MODEL_ID ?? "composer-2.5";

/** Cursor model the planner agent uses to read the ticket. Override with `PLANNER_MODEL_ID`. */
export const plannerModelId = process.env.PLANNER_MODEL_ID ?? "composer-2.5";

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
  /** Posted when a deploy of the target repo succeeds (observability stage begins). */
  deployed: "<!-- conductor:deployed -->",
  /** Posted when the observability agent confirms the deploy is healthy. */
  verified: "<!-- conductor:verified -->",
  /** Posted when a stage result has been announced to Slack. */
  announced: "<!-- conductor:announced -->",
  /** Posted when the remediation agent has opened a hotfix PR for a prod alert. */
  remediated: "<!-- conductor:remediated -->",
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
