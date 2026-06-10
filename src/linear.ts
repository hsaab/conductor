/**
 * Linear API access plus the comment-parsing helpers that back the reconciler.
 *
 * The bridge stores no state of its own: the Linear comment thread is the source
 * of truth for "fleet started", "agent done", and "fleet complete". These pure
 * parsers turn a fetched issue's comments back into structured agent records.
 */
import crypto from "node:crypto";
import { ghOwner, linearKey, reactionEmoji, roleRepo } from "./config.js";
import type {
  AgentRole,
  LinearConnection,
  LinearIssuePayload,
  LinearIssueRecord,
  SpawnedAgent,
} from "./types.js";

const AGENT_ID_RE = /Agent ID:\s*`(bc-[0-9a-zA-Z_-]+)`/;
const REPO_RE = /Repo:\s*`([^`]+)`/;
const DONE_MARKER_RE = /cursor-demo-bridge:agent-done id=(bc-[0-9a-zA-Z_-]+)/g;

export async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const key = linearKey();
  if (!key) throw new Error("LINEAR_API_KEY is required");
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok || json.errors?.length) {
    const message = json.errors?.map((err) => err.message).join("; ") || res.statusText;
    throw new Error(`Linear GraphQL failed: ${message}`);
  }
  if (!json.data) throw new Error("Linear GraphQL returned no data");
  return json.data;
}

/** Flattens a Linear field that may be a bare array or a `{ nodes }` connection. */
export function connectionNodes<T>(connection: LinearConnection<T> | undefined): Array<T> {
  return Array.isArray(connection) ? connection : connection?.nodes ?? [];
}

export function normalizeIssue(issue: LinearIssueRecord): LinearIssuePayload {
  return {
    ...issue,
    labels: connectionNodes(issue.labels),
    comments: connectionNodes(issue.comments),
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  state { name }
  labels { nodes { name } }
  comments(first: 100) { nodes { body createdAt } }
`;

export async function fetchIssue(issueId: string): Promise<LinearIssuePayload | null> {
  try {
    const data = await linearGraphql<{ issue: LinearIssueRecord | null }>(
      `query DemoIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: issueId },
    );
    return data.issue ? normalizeIssue(data.issue) : null;
  } catch (err) {
    if (String(err).includes("Entity not found: Issue")) return null;
    throw err;
  }
}

/** Fetches the candidate issues the reconciler should inspect (label-filtered). */
export async function listFleetIssues(label: string): Promise<LinearIssuePayload[]> {
  const data = await linearGraphql<{ issues: { nodes: LinearIssueRecord[] } }>(
    `query FleetIssues($label: String!) {
      issues(first: 25, filter: { labels: { some: { name: { eq: $label } } } }) {
        nodes { ${ISSUE_FIELDS} }
      }
    }`,
    { label },
  );
  return data.issues.nodes.map(normalizeIssue);
}

export async function postComment(issueId: string, body: string): Promise<void> {
  const key = linearKey();
  if (!key) return;
  const { LinearClient } = await import("@linear/sdk");
  const linear = new LinearClient({ apiKey: key });
  await linear.createComment({ issueId, body });
}

/** True when any comment on the issue contains the given marker. */
export function hasComment(issue: LinearIssuePayload, marker: string): boolean {
  return issue.comments?.some((comment) => comment.body?.includes(marker)) ?? false;
}

/**
 * Recovers the agents spawned for an issue by parsing its "agent spawned"
 * comments. Reading the human-readable comment (rather than a side channel)
 * means even agents spawned by older bridge versions remain reconcilable.
 * Duplicate agent ids are collapsed.
 */
export function parseSpawnedAgents(issue: LinearIssuePayload): SpawnedAgent[] {
  const seen = new Set<string>();
  const agents: SpawnedAgent[] = [];
  for (const comment of issue.comments ?? []) {
    const body = comment.body ?? "";
    if (!/agent spawned/i.test(body)) continue;
    const agentId = body.match(AGENT_ID_RE)?.[1];
    if (!agentId || seen.has(agentId)) continue;
    const role: AgentRole = /Hero/i.test(body) ? "hero" : "chorus";
    const repo = body.match(REPO_RE)?.[1] ?? `${ghOwner}/${roleRepo[role]}`;
    seen.add(agentId);
    agents.push({ role, agentId, repo });
  }
  return agents;
}

/** Agent ids that already have a completion comment (keeps reconcile idempotent). */
export function parseDoneAgentIds(issue: LinearIssuePayload): Set<string> {
  const ids = new Set<string>();
  for (const comment of issue.comments ?? []) {
    for (const match of (comment.body ?? "").matchAll(DONE_MARKER_RE)) ids.add(match[1]);
  }
  return ids;
}

/**
 * True for any comment the bridge authored. Newer comments carry a hidden
 * `cursor-demo-bridge` marker, but we also match by content signature so reset
 * cleanly removes comments from older bridge versions (e.g. untagged "agent
 * spawned" notices) — otherwise the reconciler would keep re-reporting them.
 */
const BRIDGE_SIGNATURES = [
  /cursor-demo-bridge/,
  /Cursor (Hero|Chorus) agent (spawned|finished|failed)/i,
  /Cursor (fleet|bridge) (accepted|complete|engaged)/i,
];

export function isBridgeComment(body: string | null | undefined): boolean {
  const text = body ?? "";
  return BRIDGE_SIGNATURES.some((re) => re.test(text));
}

/**
 * Deterministic reaction id for an issue's bridge reaction. Using a stable id
 * (rather than a server-generated one) lets reset delete the exact reaction
 * without having to look it up.
 */
export function bridgeReactionId(issueId: string): string {
  const h = crypto.createHash("sha256").update(`cursor-demo-bridge:reaction:${issueId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Adds the bridge's "engaged" reaction to an issue. Best-effort; never throws. */
export async function addIssueReaction(issueId: string): Promise<void> {
  if (!linearKey()) return;
  try {
    await linearGraphql(
      `mutation($emoji: String!, $issueId: String!, $id: String!) {
        reactionCreate(input: { emoji: $emoji, issueId: $issueId, id: $id }) { success }
      }`,
      { emoji: reactionEmoji, issueId, id: bridgeReactionId(issueId) },
    );
  } catch (err) {
    // A duplicate reaction (re-trigger) is expected and harmless.
    console.warn(`[linear] reaction skipped for ${issueId}:`, String(err));
  }
}

/** Removes the bridge's reaction from an issue. Best-effort; never throws. */
export async function removeIssueReaction(issueId: string): Promise<void> {
  if (!linearKey()) return;
  try {
    await linearGraphql(`mutation($id: String!) { reactionDelete(id: $id) { success } }`, {
      id: bridgeReactionId(issueId),
    });
  } catch {
    // Reaction may not exist; nothing to clean up.
  }
}

/**
 * Deletes every bridge-authored comment on an issue, re-arming it so a fresh
 * drag into "In Progress" launches a new fleet. Returns the number removed.
 */
export async function deleteBridgeComments(issueId: string): Promise<number> {
  if (!linearKey()) return 0;
  const data = await linearGraphql<{ issue: { comments: { nodes: Array<{ id: string; body?: string | null }> } } | null }>(
    `query($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id body } } } }`,
    { id: issueId },
  );
  const bridgeComments = (data.issue?.comments.nodes ?? []).filter((c) => isBridgeComment(c.body));
  for (const comment of bridgeComments) {
    await linearGraphql(`mutation($id: String!) { commentDelete(id: $id) { success } }`, { id: comment.id });
  }
  return bridgeComments.length;
}
