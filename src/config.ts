/**
 * Centralized configuration, constants, and the comment-marker conventions the
 * bridge uses for durable state.
 *
 * Secrets are read through getter functions (not captured at module load) so a
 * single warm serverless instance always sees the latest injected env values.
 */
import type { AgentRole } from "./types.js";

/** GitHub org/user that owns the target repos. Safe to capture at load. */
export const ghOwner = process.env.GH_OWNER ?? "hsaab";

export const cursorKey = (): string => process.env.CURSOR_API_KEY ?? "";
export const linearKey = (): string => process.env.LINEAR_API_KEY ?? "";
export const webhookSecret = (): string => process.env.LINEAR_WEBHOOK_SECRET ?? "";
export const triggerSecret = (): string => process.env.BRIDGE_TRIGGER_SECRET ?? "";

/** Vercel injects `Authorization: Bearer ${CRON_SECRET}` on cron invocations. */
export const cronSecret = (): string => process.env.CRON_SECRET ?? "";

/** Cloud model used for every spawned agent. Override with `BRIDGE_MODEL_ID`. */
export const modelId = process.env.BRIDGE_MODEL_ID ?? "composer-2.5";

/** Repo (relative to {@link ghOwner}) each role works in. */
export const roleRepo: Record<AgentRole, string> = {
  hero: "compound",
  chorus: "server",
};

/** Human-readable label for each role, used in Linear comments and logs. */
export const roleLabel: Record<AgentRole, string> = {
  hero: "Hero",
  chorus: "Chorus",
};

/** Trigger filters: an issue only spawns a fleet when it matches all of these. */
export const triggerLabel = "cursor-fleet";
export const triggerState = "In Progress";

/**
 * Hidden HTML-comment markers embedded in Linear comments. They make the bridge
 * idempotent across serverless cold starts without any database: the comment
 * thread itself is the state store.
 */
export const markers = {
  /** Generic tag present on EVERY bridge-authored comment, so reset can find and remove them all. */
  bridge: "<!-- cursor-demo-bridge -->",
  /** Posted before spawning, so a fleet launches at most once per issue. */
  fleetStarted: "<!-- cursor-demo-bridge:fleet-started -->",
  /** Posted once every agent for an issue has reported back. */
  fleetComplete: "<!-- cursor-demo-bridge:fleet-complete -->",
  /** Per-agent completion marker; keeps the reconciler from double-reporting. */
  agentDone: (agentId: string): string => `<!-- cursor-demo-bridge:agent-done id=${agentId} -->`,
};

/** Emoji the bridge reacts with on an issue the instant it engages (demo signal). */
export const reactionEmoji = "🚀";
