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
import { cursorKey, ghOwner, maxAgents, plannerModelId } from "./config.js";
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

function fallbackPlan(issue: LinearIssuePayload): PlannedTask[] {
  const kind = inferKindFromIssue(issue);
  return knownRepos.map((r) => ({
    repo: `${ghOwner}/${r.repo}`,
    instructions: defaultInstructions(issue),
    kind,
  }));
}

/**
 * Host repo the planner agent runs in. A Cursor cloud agent must be attached to
 * a repo to launch (the API resolves its environment from the repo), even though
 * the planner only reads the ticket and emits JSON — it does not edit this repo.
 */
const plannerHostRepo = `https://github.com/${ghOwner}/${knownRepos[0].repo}`;

/** Reads the ticket via a Cursor cloud agent and returns one task per repo it chose. */
export async function planFleet(issue: LinearIssuePayload): Promise<PlannedTask[]> {
  console.log(`[planner] Reading ${issue.identifier} "${issue.title}" with a Cursor agent to decide which repos need work`);
  try {
    const { Agent } = await import("@cursor/sdk");
    const result = await Agent.prompt(buildPlannerPrompt(issue), {
      apiKey: cursorKey(),
      model: { id: plannerModelId },
      cloud: {
        repos: [{ url: plannerHostRepo }],
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    });
    if (result.status === "finished" && result.result) {
      const plan = sanitizePlan(parsePlanText(result.result));
      if (plan.length) {
        console.log(`[planner] Plan: ${plan.length} agent(s) → ${plan.map((t) => `${t.repo} (${t.kind})`).join(", ")}`);
        return plan;
      }
      console.log("[planner] Could not parse a plan from the agent reply, using fallback");
    } else {
      console.log(`[planner] Planner run did not finish (status: ${result.status}), using fallback`);
    }
  } catch (err) {
    console.error("[planner] Planning failed, using fallback:", err);
  }
  const plan = fallbackPlan(issue);
  console.log(`[planner] Fallback plan: ${plan.length} agent(s) → ${plan.map((t) => `${t.repo} (${t.kind})`).join(", ")}`);
  return plan;
}
