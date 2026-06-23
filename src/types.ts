/** Shared domain types for the Linear ↔ Cursor bridge. */

/** Normalized Linear issue shape used throughout the bridge. */
export interface LinearIssuePayload {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  labels?: Array<{ name: string }>;
  state?: { name: string };
  comments?: Array<{ body?: string | null; createdAt?: string }>;
  url?: string;
}

/** A Linear GraphQL field may arrive as a bare array or a `{ nodes }` connection. */
export type LinearConnection<T> = Array<T> | { nodes?: Array<T> };

/** Raw issue shape as returned by Linear before {@link normalizeIssue}. */
export type LinearIssueRecord = Omit<LinearIssuePayload, "labels" | "comments"> & {
  labels?: LinearConnection<{ name: string }>;
  comments?: LinearConnection<{ body?: string | null; createdAt?: string }>;
};

/** Outcome of attempting to launch a fleet for an issue. */
export interface TriggerResult {
  queued: boolean;
  reason?: string;
}

/** A Cursor agent that was spawned for an issue, recovered from Linear comments. */
export interface SpawnedAgent {
  agentId: string;
  repo: string;
}

/** A spawned agent annotated with whether its completion was reported back. */
export interface JobAgent extends SpawnedAgent {
  /** True once a per-agent completion comment exists for this agent. */
  done: boolean;
  /** PR URL parsed from the agent's completion comment, when present. */
  prUrl?: string;
  /** Which pipeline phase spawned this agent. */
  role: "build" | "remediation";
}

/** Status of a single pipeline stage, used by the mission-control dashboard. */
export type StageState = "pending" | "running" | "done" | "failed";

/**
 * One human-readable entry in a fleet's activity log, derived from a single
 * conductor-authored Linear comment so the dashboard can show what each step did.
 */
export interface JobEvent {
  /** ISO-8601 timestamp of the source comment, when available. */
  at?: string;
  /** Headline summary of what happened (the comment's first readable line). */
  message: string;
  /** Optional supporting detail (the comment's remaining readable lines). */
  detail?: string;
  /** Pipeline stage this event belongs to, used to color-code the log line. */
  stage?: string;
}

/** One launched fleet, derived entirely from an issue's Linear comments. */
export interface JobSummary {
  identifier: string;
  title: string;
  url?: string;
  state?: string;
  status: "in-progress" | "complete";
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  runningForSeconds?: number;
  agents: JobAgent[];
  agentsPending: number;
  /** Per-stage status for the mission-control dashboard, keyed by pipeline stage. */
  stages: Record<string, StageState>;
  /** Chronological activity feed for the dashboard's per-fleet logs panel. */
  events: JobEvent[];
}

/** Read-only snapshot returned to the mission-control dashboard. */
export interface JobsReport {
  generatedAt: string;
  inProgress: number;
  complete: number;
  agentsPending: number;
  jobs: JobSummary[];
}
