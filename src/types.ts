/** Shared domain types for the Linear ↔ Cursor bridge. */

export type AgentRole = "hero" | "chorus";

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
  role: AgentRole;
  agentId: string;
  repo: string;
}

/** A spawned agent annotated with whether its completion was reported back. */
export interface JobAgent extends SpawnedAgent {
  /** True once a per-agent completion comment exists for this agent. */
  done: boolean;
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
}

/** Read-only snapshot returned by the `/api/jobs` endpoint. */
export interface JobsReport {
  generatedAt: string;
  inProgress: number;
  complete: number;
  agentsPending: number;
  jobs: JobSummary[];
}
