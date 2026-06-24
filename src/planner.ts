/**
 * Front planner agent: a Cursor cloud agent reads the full Linear ticket and
 * decides how many cloud agents to spawn and which repo each one targets.
 * Ticket in, task list out. Uses the same CURSOR_API_KEY as the fleet, so no
 * extra model provider or key is needed.
 *
 * Note: a cloud agent run takes ~1-2 min, and Vercel buffers a function's logs
 * per invocation — so during planning the live customer-facing progression is on
 * the Linear ticket (the bridge posts comments as it goes), not `vercel logs`.
 */
import { cursorKey, deployTargetRepo, ghOwner, maxAgents, plannerModelId } from "./config.js";
import type { LinearIssuePayload } from "./types.js";

/**
 * The kind of work a task represents. The planner classifies each task so the
 * fleet agent can invoke the matching compound skill and workflow emphasis.
 */
export type TaskKind = "feature" | "bug" | "test";

const TASK_KINDS: readonly TaskKind[] = ["feature", "bug", "test"];

/** Normalizes any free-form kind string to a known {@link TaskKind}. */
export function normalizeKind(value: unknown): TaskKind {
  const kind = String(value ?? "").trim().toLowerCase();
  return (TASK_KINDS as readonly string[]).includes(kind) ? (kind as TaskKind) : "feature";
}

export interface PlannedTask {
  repo: string;
  instructions: string;
  /** Workflow class for this task; drives skill selection in the fleet agent. */
  kind: TaskKind;
}

/** Optional hints for the planner + a safe fallback when planning fails. */
const knownRepos = [
  {
    repo: "compound",
    description: "Node/TypeScript app: middleware, AsyncLocalStorage, logging, small UI.",
  },
  {
    repo: "server",
    description: "ASP.NET / C# server: middleware, Serilog enrichers, xUnit tests.",
  },
];

/** Normalize owner, dedupe by repo, drop empties, cap at {@link maxAgents}. */
export function sanitizePlan(tasks: PlannedTask[]): PlannedTask[] {
  const seen = new Set<string>();
  const out: PlannedTask[] = [];
  for (const task of tasks) {
    const name = task.repo?.trim();
    if (!name || !task.instructions?.trim()) continue;
    const repo = name.includes("/") ? name : `${ghOwner}/${name}`;
    if (seen.has(repo)) continue;
    seen.add(repo);
    out.push({ repo, instructions: task.instructions.trim(), kind: normalizeKind(task.kind) });
    if (out.length >= maxAgents) break;
  }
  return out;
}

/** Pulls a `{ tasks: [...] }` object out of the planner agent's free-form reply. */
export function parsePlanText(text: string): PlannedTask[] {
  if (!text) return [];
  // Prefer a fenced ```json block; otherwise take the first {...} span.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = fenced ?? (start !== -1 && end > start ? text.slice(start, end + 1) : "");
  if (!candidate) return [];
  try {
    const parsed: unknown = JSON.parse(candidate);
    const tasksRaw = (parsed as { tasks?: unknown }).tasks;
    if (!Array.isArray(tasksRaw)) return [];
    return tasksRaw.map((entry) => {
      const obj = (entry ?? {}) as { repo?: unknown; instructions?: unknown; kind?: unknown };
      return {
        repo: String(obj.repo ?? ""),
        instructions: String(obj.instructions ?? ""),
        kind: normalizeKind(obj.kind),
      };
    });
  } catch {
    return [];
  }
}

/** Escapes a string for literal use inside a RegExp (ghOwner is env-sourced). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Repos a ticket *explicitly* names, so an inherently multi-repo ticket fans out
 * to one agent per repo even when the LLM planner is unavailable or under-plans.
 *
 * Two explicit signals, both unambiguous intent:
 *   1. A structured `Repos:`/`Repo:` line, e.g. `Repos: server, compound` or
 *      `Repos: hsaab/server, hsaab/compound` (comma/space/`and`-separated).
 *   2. An owner-qualified slug `${ghOwner}/<repo>` appearing ANYWHERE in the
 *      title/description, e.g. FE-5's bulleted `hsaab/compound` + `hsaab/server`.
 *
 * Markdown emphasis can mangle a slug. FE-5 lists `**hsaab/****compound**`, whose
 * raw bytes are `hsaab/****compound` (adjacent bold runs collapse into `****`).
 * `*` and backticks are never valid in a GitHub owner or repo name, so removing
 * them first repairs the slug while leaving valid characters (`_`, `-`, `.`)
 * intact; wrapping `_`/`.` left by italic emphasis is trimmed off each slug.
 *
 * The over-spawn guard is structural, not a convention. Bare prose words are
 * never matched: "the server returned 500" has no `Repos:` line and no
 * `hsaab/server` slug, so it selects nothing. That over-spawn is the exact
 * failure the single-repo fallback was first introduced to stop. A cross-org
 * slug (`acme/web`) must be declared on a `Repos:` line, never inferred from prose.
 *
 * Returns raw names (bare or `owner/repo`); {@link sanitizePlan} owner-qualifies
 * and de-duplicates them.
 */
export function parseTicketRepos(issue: LinearIssuePayload): string[] {
  // Neutralize emphasis/code formatting that can split a slug (e.g. `hsaab/****server`).
  const text = `${issue.title ?? ""}\n${issue.description ?? ""}`.replace(/[`*]/g, "");
  const names = new Set<string>();

  // 1. Structured `Repos:`/`Repo:` line: bare names or slugs, any separator.
  for (const line of text.matchAll(/^[ \t>_-]*repos?\s*:\s*(.+)$/gim)) {
    for (const token of line[1].split(/[,\s]+/)) {
      const name = token.replace(/^[_<]+|[_>.,;]+$/g, "").trim();
      if (name && name.toLowerCase() !== "and") names.add(name);
    }
  }

  // 2. Owner-qualified slugs anywhere. Owner-qualified ONLY, so a bare word in
  //    prose never selects a repo — that is the over-spawn guard.
  const slugRe = new RegExp(`(?<![\\w./-])${escapeRegExp(ghOwner)}/([A-Za-z0-9._-]+)`, "gi");
  for (const match of text.matchAll(slugRe)) {
    const repo = match[1].replace(/^[_.]+|[_.]+$/g, "");
    if (repo) names.add(`${ghOwner}/${repo}`);
  }

  return [...names];
}

function buildPlannerPrompt(issue: LinearIssuePayload): string {
  const labels = issue.labels?.map((l) => l.name).join(", ") || "(none)";
  const hints = knownRepos.map((r) => `- ${ghOwner}/${r.repo}: ${r.description}`).join("\n");
  return `You are the planning agent for a Cursor cloud-agent fleet.

Read the Linear ticket below and decide which GitHub repos need work. Return one task per repo that should change. The number of tasks is up to you — match what the ticket actually needs (1 repo means 1 task, 3 repos means 3 tasks).

Extract repo names from the ticket text when present (e.g. a "Repos:" line or repos mentioned in the description). You may also pick repos from the known hints if the ticket implies them but does not name them explicitly.

Classify each task with a "kind" that drives which workflow the build agent runs:
- "feature": build or extend functionality (the default).
- "bug": diagnose and fix a defect; prioritize reading logs/errors and a minimal targeted fix.
- "test": add or migrate tests; prioritize coverage and test infrastructure.
Infer the kind from the ticket: labels like "bug"/"defect" or words like "fix", "broken", "regression", "error" imply "bug"; labels like "test"/"qa" or words like "coverage", "migrate tests" imply "test"; otherwise "feature".

Ticket:
- ID: ${issue.identifier}
- Title: ${issue.title}
- Labels: ${labels}
- URL: ${issue.url ?? "(none)"}

Description:
${issue.description ?? "(empty)"}

Known repos (hints only — you may target any repo under ${ghOwner}/):
${hints}

You are ONLY planning. Do not modify files, run commands, or open a pull request — just answer.

Respond with ONLY a JSON object, no prose and no markdown fences, in exactly this shape:
{"tasks":[{"repo":"owner/repo","kind":"feature|bug|test","instructions":"concrete implementation steps for this repo only"}]}`;
}

function defaultInstructions(issue: LinearIssuePayload): string {
  return `Implement the ticket scope in this repo.\n\n# ${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}\n\nOpen a PR when done.`;
}

/** Heuristic classification used by the fallback plan when the planner agent is unavailable. */
function inferKindFromIssue(issue: LinearIssuePayload): TaskKind {
  const haystack = `${issue.title} ${issue.description ?? ""} ${issue.labels?.map((l) => l.name).join(" ") ?? ""}`.toLowerCase();
  if (/\b(bug|defect|fix|broken|regression|error|crash|incident|hotfix)\b/.test(haystack)) return "bug";
  if (/\b(test|tests|qa|coverage|spec|e2e)\b/.test(haystack)) return "test";
  return "feature";
}

/** A default-instruction task for each repo the ticket explicitly names. */
function namedRepoTasks(issue: LinearIssuePayload): PlannedTask[] {
  const kind = inferKindFromIssue(issue);
  return parseTicketRepos(issue).map((repo) => ({ repo, instructions: defaultInstructions(issue), kind }));
}

/**
 * Folds the repos a ticket explicitly names into a planned task list, so an
 * inherently multi-repo ticket always fans out to one agent per repo even if the
 * planner agent omitted one. The planner's own tasks come first, so its
 * repo-specific instructions win for any repo it did plan; a named repo it
 * skipped is appended with default instructions. {@link sanitizePlan}
 * owner-qualifies, de-duplicates, and caps the result.
 */
export function withTicketRepos(tasks: PlannedTask[], issue: LinearIssuePayload): PlannedTask[] {
  return sanitizePlan([...tasks, ...namedRepoTasks(issue)]);
}

/**
 * Fallback when the planner agent can't produce a plan. It still honors the
 * repos the ticket explicitly names (one agent per repo) so an inherently
 * multi-repo ticket like FE-5 — add X-Request-ID middleware to both `compound`
 * and `server` — fans out correctly without the planner agent. Only when the
 * ticket names no repos does it conservatively target the single deploy target.
 *
 * This threads the needle between the two ways the fallback has been wrong: it
 * must not blast an agent at every known repo (a single-repo ticket wrongly got
 * both `compound` and `server`), and it must not collapse every ticket to the
 * deploy target (a multi-repo ticket wrongly got only `compound`). Named repos
 * are precise intent; an unnamed ticket gets the conservative single agent.
 * The caller surfaces that this is a fallback.
 */
export function fallbackPlan(issue: LinearIssuePayload): PlannedTask[] {
  const named = namedRepoTasks(issue);
  const tasks =
    named.length > 0
      ? named
      : [{ repo: deployTargetRepo, instructions: defaultInstructions(issue), kind: inferKindFromIssue(issue) }];
  return sanitizePlan(tasks);
}

/**
 * Host repo the planner agent runs in. A Cursor cloud agent must be attached to
 * a repo to launch (the API resolves its environment from the repo), even though
 * the planner only reads the ticket and emits JSON — it does not edit this repo.
 */
const plannerHostRepo = `https://github.com/${ghOwner}/${knownRepos[0].repo}`;

/**
 * The outcome of planning a ticket: the task list plus whether it came from the
 * planner agent or the conservative fallback. `usedFallback` lets the caller be
 * honest on the ticket — a fallback is not a deliberate multi-repo decision.
 */
export interface FleetPlan {
  tasks: PlannedTask[];
  usedFallback: boolean;
  fallbackReason?: string;
}

function fallbackFleetPlan(issue: LinearIssuePayload, fallbackReason: string): FleetPlan {
  const plan = fallbackPlan(issue);
  console.log(
    `[planner] Fallback plan (${fallbackReason}): ${plan.length} agent(s) → ${plan.map((t) => `${t.repo} (${t.kind})`).join(", ")}`,
  );
  return { tasks: plan, usedFallback: true, fallbackReason };
}

/** Reads the ticket via a Cursor cloud agent and returns one task per repo it chose. */
export async function planFleet(issue: LinearIssuePayload): Promise<FleetPlan> {
  console.log(`[planner] Reading ${issue.identifier} "${issue.title}" with a Cursor agent to decide which repos need work`);
  const apiKey = cursorKey().trim();
  if (!apiKey) {
    console.error("[planner] Missing CURSOR_API_KEY; using fallback");
    return fallbackFleetPlan(issue, "missing CURSOR_API_KEY");
  }

  try {
    const { Agent } = await import("@cursor/sdk");
    const result = await Agent.prompt(buildPlannerPrompt(issue), {
      apiKey,
      model: { id: plannerModelId },
      cloud: {
        repos: [{ url: plannerHostRepo }],
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    });
    if (result.status === "finished" && result.result) {
      // Union in any repo the ticket explicitly names but the agent omitted, so
      // an explicitly multi-repo ticket never silently drops a repo to the LLM.
      const plan = withTicketRepos(parsePlanText(result.result), issue);
      if (plan.length) {
        console.log(`[planner] Plan: ${plan.length} agent(s) → ${plan.map((t) => `${t.repo} (${t.kind})`).join(", ")}`);
        return { tasks: plan, usedFallback: false };
      }
      console.log("[planner] Could not parse a plan from the agent reply, using fallback");
      return fallbackFleetPlan(issue, "planner returned no parseable plan");
    } else {
      console.log(`[planner] Planner run did not finish (status: ${result.status}), using fallback`);
      return fallbackFleetPlan(issue, `planner run ${result.status}`);
    }
  } catch (err) {
    console.error("[planner] Planning failed, using fallback:", err);
    return fallbackFleetPlan(issue, "planner startup failed");
  }
}
