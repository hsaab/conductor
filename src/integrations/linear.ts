/**
 * Linear API access plus the comment-parsing helpers that back the reconciler.
 *
 * The bridge stores no state of its own: the Linear comment thread is the source
 * of truth for "fleet started", "agent done", and "fleet complete". These pure
 * parsers turn a fetched issue's comments back into structured agent records.
 */
import crypto from "node:crypto";
import { linearKey, markers, reactionEmoji } from "../config.js";
import type {
  LinearConnection,
  LinearIssuePayload,
  LinearIssueRecord,
  SpawnedAgent,
  TestCase,
} from "../types.js";

const AGENT_ID_RE = /Agent ID:\s*`(bc-[0-9a-zA-Z_-]+)`/;
const REPO_RE = /Repo:\s*`([^`]+)`/;
const DONE_MARKER_RE = /conductor:agent-done id=(bc-[0-9a-zA-Z_-]+)/g;

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
 * Extracts an issue reference (a Linear UUID or a human identifier like `FE-7`)
 * from a request body, accepting any of `issueId`, `identifier`, or `id`. Used by
 * the manual operator endpoints so `/api/trigger` and `/api/reset` accept the
 * same keys — DEMO_FLOW §7's reset loop sends `identifier`. Returns the trimmed
 * reference, or `undefined` when none is present.
 */
export function issueRefFromBody(body: unknown): string | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const ref = b.issueId ?? b.identifier ?? b.id;
  return typeof ref === "string" && ref.trim().length > 0 ? ref.trim() : undefined;
}

const PR_URL_RE = /PR:\s*(https?:\/\/[^\s)]+)/i;
const DONE_ID_RE = /conductor:agent-done id=(bc-[0-9a-zA-Z_-]+)/;

/**
 * Scans an issue's comments for spawned-agent records, recovering each agent's id
 * via `extractId` and its repo from the shared `Repo:` line; duplicate ids are
 * collapsed. The three agent tracks (build, verify, remediation) differ only in
 * how the id is recovered from a comment, so they share this loop. Reading the
 * human-readable comments (not a side channel) keeps even agents spawned by older
 * bridge versions reconcilable.
 */
function parseAgentsBy(
  issue: LinearIssuePayload,
  extractId: (body: string) => string | undefined,
): SpawnedAgent[] {
  const seen = new Set<string>();
  const agents: SpawnedAgent[] = [];
  for (const comment of issue.comments ?? []) {
    const body = comment.body ?? "";
    const agentId = extractId(body);
    const repo = body.match(REPO_RE)?.[1];
    if (!agentId || !repo || seen.has(agentId)) continue;
    seen.add(agentId);
    agents.push({ agentId, repo });
  }
  return agents;
}

/** Collects every agent id captured by a global `done`-marker regex across an issue's comments. */
function parseDoneIds(issue: LinearIssuePayload, doneRe: RegExp): Set<string> {
  const ids = new Set<string>();
  for (const comment of issue.comments ?? []) {
    for (const match of (comment.body ?? "").matchAll(doneRe)) ids.add(match[1]);
  }
  return ids;
}

/** Maps each completed agent id (captured by `idRe`) to the PR URL in its completion comment. */
function parseResults(issue: LinearIssuePayload, idRe: RegExp): Map<string, { prUrl?: string }> {
  const results = new Map<string, { prUrl?: string }>();
  for (const comment of issue.comments ?? []) {
    const body = comment.body ?? "";
    const id = body.match(idRe)?.[1];
    if (!id) continue;
    results.set(id, { prUrl: body.match(PR_URL_RE)?.[1] });
  }
  return results;
}

/**
 * Recovers the build agents spawned for an issue from its "agent spawned"
 * comments. Build spawns carry no hidden id marker, so the id is read from the
 * visible `Agent ID:` line, gated on the "agent spawned" headline so completion
 * and remediation/verify comments (which also carry an `Agent ID:` line) are
 * never mistaken for build spawns.
 */
export function parseSpawnedAgents(issue: LinearIssuePayload): SpawnedAgent[] {
  return parseAgentsBy(issue, (body) =>
    /agent spawned/i.test(body) ? body.match(AGENT_ID_RE)?.[1] : undefined,
  );
}

/** Agent ids that already have a completion comment (keeps reconcile idempotent). */
export function parseDoneAgentIds(issue: LinearIssuePayload): Set<string> {
  return parseDoneIds(issue, DONE_MARKER_RE);
}

/** Maps each completed build agent id to the PR URL parsed from its completion comment. */
export function parseAgentResults(issue: LinearIssuePayload): Map<string, { prUrl?: string }> {
  return parseResults(issue, DONE_ID_RE);
}

/**
 * True when a build agent never launched (a genuine startup failure).
 *
 * Deliberately scoped to startup failures only. A run's *terminal* status is not
 * a reliable failure signal: a Cursor cloud run can report `cancelled` (or
 * `error`) yet still have opened its PR, and the PR is the build's deliverable.
 * Build success is therefore derived from the build agents' state in fleet.ts,
 * not from scanning completion comments for status words.
 */
export function hasStartupFailure(issue: LinearIssuePayload): boolean {
  return issue.comments?.some((c) => /failed to start/i.test(c.body ?? "")) ?? false;
}

const REMEDIATION_SPAWN_RE = /conductor:remediation-agent id=(bc-[0-9a-zA-Z_-]+)/;
const REMEDIATION_DONE_RE = /conductor:remediation-done id=(bc-[0-9a-zA-Z_-]+)/g;
const REMEDIATION_DONE_ID_RE = /conductor:remediation-done id=(bc-[0-9a-zA-Z_-]+)/;

/** Remediation agents dispatched for an issue (tracked separately from build agents). */
export function parseRemediationAgents(issue: LinearIssuePayload): SpawnedAgent[] {
  return parseAgentsBy(issue, (body) => body.match(REMEDIATION_SPAWN_RE)?.[1]);
}

/** Remediation agent ids that already reported a hotfix PR. */
export function parseRemediationDoneIds(issue: LinearIssuePayload): Set<string> {
  return parseDoneIds(issue, REMEDIATION_DONE_RE);
}

/** Maps each completed remediation agent id to its hotfix PR URL. */
export function parseRemediationResults(issue: LinearIssuePayload): Map<string, { prUrl?: string }> {
  return parseResults(issue, REMEDIATION_DONE_ID_RE);
}

/** True when any remediation agent has reported a hotfix PR. */
export function hasRemediationDone(issue: LinearIssuePayload): boolean {
  return issue.comments?.some((c) => /conductor:remediation-done/.test(c.body ?? "")) ?? false;
}

const VERIFY_SPAWN_RE = /conductor:verify-agent id=(bc-[0-9a-zA-Z_-]+)/;

/** Verify agents dispatched for an issue (tracked separately from build/remediation). */
export function parseVerifyAgents(issue: LinearIssuePayload): SpawnedAgent[] {
  return parseAgentsBy(issue, (body) => body.match(VERIFY_SPAWN_RE)?.[1]);
}

/** Parses the test plan JSON embedded in a test-plan comment (fenced block). */
export function parseTestPlan(issue: LinearIssuePayload): TestCase[] {
  for (const comment of issue.comments ?? []) {
    const body = comment.body ?? "";
    if (!body.includes(markers.testPlan)) continue;
    const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (!fenced) continue;
    try {
      const parsed = JSON.parse(fenced) as { cases?: unknown };
      if (!Array.isArray(parsed.cases)) continue;
      return parsed.cases
        .map((entry) => {
          const obj = (entry ?? {}) as { title?: unknown; steps?: unknown };
          return { title: String(obj.title ?? "").trim(), steps: String(obj.steps ?? "").trim() };
        })
        .filter((c) => c.title && c.steps)
        .slice(0, 5);
    } catch {
      continue;
    }
  }
  return [];
}

export function hasVerifyPass(issue: LinearIssuePayload): boolean {
  return hasComment(issue, markers.verifyPass);
}

export function hasVerifyFail(issue: LinearIssuePayload): boolean {
  return hasComment(issue, markers.verifyFail);
}

/**
 * True for any comment the bridge authored. Newer comments carry a hidden
 * `cursor-demo-bridge` marker, but we also match by content signature so reset
 * cleanly removes comments from older bridge versions (e.g. untagged "agent
 * spawned" notices) — otherwise the reconciler would keep re-reporting them.
 */
const BRIDGE_SIGNATURES = [
  /conductor/,
  /cursor-demo-bridge/, // legacy marker, so reset still cleans comments from older deploys
  /Cursor .*agent (spawned|finished|failed)/i,
  /Cursor (fleet|bridge|conductor) (accepted|complete|engaged)/i,
  /Test plan/i,
  /Verify agent/i,
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
  const h = crypto.createHash("sha256").update(`conductor:reaction:${issueId}`).digest("hex");
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

type IssueCommentsPage = {
  issue: {
    comments: {
      nodes: Array<{ id: string; body?: string | null }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
};

const ISSUE_COMMENTS_PAGE = `query($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      nodes { id body }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Fetches one page of comments for an issue. */
async function fetchIssueCommentsPage(issueId: string, after?: string | null): Promise<IssueCommentsPage> {
  return linearGraphql<IssueCommentsPage>(ISSUE_COMMENTS_PAGE, { id: issueId, after: after ?? null });
}

/**
 * Deletes every bridge-authored comment on an issue, re-arming it so a fresh
 * drag into "In Progress" launches a new fleet. Returns the number removed.
 */
export async function deleteBridgeComments(issueId: string): Promise<number> {
  if (!linearKey()) return 0;
  let cleared = 0;
  let after: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await fetchIssueCommentsPage(issueId, after);
    const page = data.issue?.comments;
    const bridgeComments = (page?.nodes ?? []).filter((c) => isBridgeComment(c.body));
    for (const comment of bridgeComments) {
      await linearGraphql(`mutation($id: String!) { commentDelete(id: $id) { success } }`, { id: comment.id });
      cleared += 1;
    }
    hasNextPage = page?.pageInfo.hasNextPage ?? false;
    after = page?.pageInfo.endCursor ?? null;
  }
  return cleared;
}

/**
 * Deletes every comment on an issue (demo reset). Paginates so tickets with
 * more than 100 comments are fully cleared. Returns the number removed.
 */
export async function deleteAllComments(issueId: string): Promise<number> {
  if (!linearKey()) return 0;
  let cleared = 0;
  let after: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await fetchIssueCommentsPage(issueId, after);
    const page = data.issue?.comments;
    for (const comment of page?.nodes ?? []) {
      await linearGraphql(`mutation($id: String!) { commentDelete(id: $id) { success } }`, { id: comment.id });
      cleared += 1;
    }
    hasNextPage = page?.pageInfo.hasNextPage ?? false;
    after = page?.pageInfo.endCursor ?? null;
  }
  return cleared;
}
