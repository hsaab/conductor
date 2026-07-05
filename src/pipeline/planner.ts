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
import { cursorKey, deployTargetRepo, ghOwner, maxAgents, plannerModelId } from "../config.js";
import { oneLineError } from "../shared/errors.js";
import type { LinearIssuePayload, TestCase } from "../types.js";

/**
 * The kind of work a task represents. The planner classifies each task so the
 * fleet agent can invoke the matching compound skill and workflow emphasis.
 */
export type TaskKind = "feature" | "bug" | "test";

const TASK_KINDS: readonly TaskKind[] = ["feature", "bug", "test"];

/** Upper bound on test-plan cases (top 3-5 critical checks). */
export const MAX_TEST_CASES = 5;

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
  /** Optional one-line rationale for the kind classification (shown on Linear). */
  reason?: string;
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
    out.push({
      repo,
      instructions: task.instructions.trim(),
      kind: normalizeKind(task.kind),
      ...(task.reason?.trim() ? { reason: task.reason.trim() } : {}),
    });
    if (out.length >= maxAgents) break;
  }
  return out;
}

/** Normalizes and caps a test plan to at most {@link MAX_TEST_CASES} concise cases. */
export function sanitizeTestPlan(cases: TestCase[]): TestCase[] {
  const out: TestCase[] = [];
  for (const entry of cases) {
    const title = entry.title?.trim();
    const steps = entry.steps?.trim();
    if (!title || !steps) continue;
    out.push({ title, steps });
    if (out.length >= MAX_TEST_CASES) break;
  }
  return out;
}

/** Pulls a `{ tasks, testPlan }` object out of the planner agent's free-form reply. */
export function parsePlanText(text: string): { tasks: PlannedTask[]; testPlan: TestCase[] } {
  if (!text) return { tasks: [], testPlan: [] };
  // Prefer a fenced ```json block; otherwise take the first {...} span.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = fenced ?? (start !== -1 && end > start ? text.slice(start, end + 1) : "");
  if (!candidate) return { tasks: [], testPlan: [] };
  try {
    const parsed: unknown = JSON.parse(candidate);
    const root = parsed as { tasks?: unknown; testPlan?: unknown };
    const tasksRaw = root.tasks;
    const testPlanRaw = root.testPlan;
    const tasks = Array.isArray(tasksRaw)
      ? tasksRaw.map((entry) => {
          const obj = (entry ?? {}) as {
            repo?: unknown;
            instructions?: unknown;
            kind?: unknown;
            reason?: unknown;
          };
          return {
            repo: String(obj.repo ?? ""),
            instructions: String(obj.instructions ?? ""),
            kind: normalizeKind(obj.kind),
            ...(String(obj.reason ?? "").trim()
              ? { reason: String(obj.reason).trim() }
              : {}),
          };
        })
      : [];
    const testPlan = Array.isArray(testPlanRaw)
      ? sanitizeTestPlan(
          testPlanRaw.map((entry) => {
            const obj = (entry ?? {}) as { title?: unknown; steps?: unknown };
            return { title: String(obj.title ?? ""), steps: String(obj.steps ?? "") };
          }),
        )
      : [];
    return { tasks, testPlan };
  } catch {
    return { tasks: [], testPlan: [] };
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

Classify each task with a "kind" that drives which child skill the build agent routes to via \`route-task\`:
- "feature": build or extend functionality (the default) → \`build-feature\`.
- "bug": diagnose and fix a defect → \`fix-bug\`; prioritize reading logs/errors and a minimal targeted fix.
- "test": add or migrate tests → \`add-tests\`; prioritize coverage and test infrastructure.
Infer the kind from the ticket: labels like "bug"/"defect" or words like "fix", "broken", "regression", "error" imply "bug"; labels like "test"/"qa" or words like "coverage", "migrate tests" imply "test"; otherwise "feature".
Optionally include a one-line "reason" per task explaining why you chose that kind.

Also produce a focused testPlan following the \`create-test-plan\` skill contract: the **3-5 most critical** acceptance checks a QA engineer would run against the deployed feature. Rank by importance; skip trivial edge cases. Each case is one concise title plus brief steps (what to do and what to expect). Do not exceed 5 cases.

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
{"tasks":[{"repo":"owner/repo","kind":"feature|bug|test","instructions":"concrete implementation steps for this repo only","reason":"optional one-line why this kind"}],"testPlan":[{"title":"short case name","steps":"what to verify and expected outcome"}]}`;
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

/**
 * Deterministic test-plan fallback from acceptance-criteria bullets in the ticket.
 * Takes the first 3-5 checklist items when present; otherwise one case from the title.
 */
export function fallbackTestPlan(issue: LinearIssuePayload): TestCase[] {
  const text = issue.description ?? "";
  const acMatch = text.match(/(?:^|\n)#+\s*acceptance criteria\s*\n([\s\S]*?)(?:\n#+\s|\n*$)/i);
  const scope = acMatch?.[1]?.trim() ? acMatch[1] : text;
  const bullets: string[] = [];
  for (const line of scope.split("\n")) {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/)?.[1] ?? line.match(/^\s*\d+[.)]\s+(.+)$/)?.[1];
    if (bullet) bullets.push(bullet.replace(/[`*]/g, "").trim());
  }
  if (bullets.length === 0) {
    return sanitizeTestPlan([
      {
        title: issue.title,
        steps: `Verify the feature "${issue.title}" meets the ticket's acceptance criteria on the deployed site.`,
      },
    ]);
  }
  return sanitizeTestPlan(
    bullets.slice(0, MAX_TEST_CASES).map((b) => ({
      title: b.length > 72 ? `${b.slice(0, 69)}…` : b,
      steps: b,
    })),
  );
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
  testPlan: TestCase[];
  usedFallback: boolean;
  fallbackReason?: string;
}

function fallbackFleetPlan(issue: LinearIssuePayload, fallbackReason: string): FleetPlan {
  const plan = fallbackPlan(issue);
  const testPlan = fallbackTestPlan(issue);
  console.log(
    `[planner] Fallback plan (${fallbackReason}): ${plan.length} agent(s) → ${plan.map((t) => `${t.repo} (${t.kind})`).join(", ")}; ${testPlan.length} test case(s)`,
  );
  return { tasks: plan, testPlan, usedFallback: true, fallbackReason };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many times to ask the planner agent before giving up to the fallback.
 * A failed cloud run reports back fast (seconds), so one retry typically
 * recovers a transient hiccup without threatening the function's time budget.
 * Override with `PLANNER_MAX_ATTEMPTS` (Pro deploys with a higher `maxDuration`
 * can afford more; keep it at 1 to disable retries on a tight budget).
 */
function plannerMaxAttempts(): number {
  const n = Number(process.env.PLANNER_MAX_ATTEMPTS ?? 2);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

/** Backoff between planner attempts. Override with `PLANNER_RETRY_DELAY_MS`. */
function plannerRetryDelayMs(): number {
  const n = Number(process.env.PLANNER_RETRY_DELAY_MS ?? 500);
  return Number.isFinite(n) && n >= 0 ? n : 500;
}

/** Outcome of a single planner attempt: a usable task list, or why it failed. */
export type PlannerAttempt =
  | { ok: true; tasks: PlannedTask[]; testPlan: TestCase[] }
  | { ok: false; reason: string; transient: boolean };

/**
 * One planner attempt: run the Cursor cloud agent and turn its reply into tasks.
 *
 * The dynamic `import("@cursor/sdk")` lives *inside* the try on purpose. The SDK
 * loads its native `sqlite3` binding at import time; if that binding is missing
 * on the deploy target the import throws, and catching it here surfaces the real
 * error (rather than an opaque "planner unavailable"). `transient` marks failures
 * worth retrying (a thrown error or a non-finished run) versus a clean run that
 * simply produced no parseable plan, which a retry would not improve.
 */
async function runPlannerOnce(issue: LinearIssuePayload, apiKey: string): Promise<PlannerAttempt> {
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
      const parsed = parsePlanText(result.result);
      const plan = withTicketRepos(parsed.tasks, issue);
      const testPlan = parsed.testPlan.length > 0 ? parsed.testPlan : fallbackTestPlan(issue);
      if (plan.length) return { ok: true, tasks: plan, testPlan };
      return { ok: false, reason: "planner returned no parseable plan", transient: false };
    }
    return { ok: false, reason: `planner run ${result.status}`, transient: true };
  } catch (err) {
    return { ok: false, reason: `planner startup failed: ${oneLineError(err, 200)}`, transient: true };
  }
}

/**
 * Drives the planner with a bounded retry: returns the first successful plan,
 * stops early on a non-transient failure (a clean run that just produced nothing
 * parseable won't improve on retry), and otherwise falls back with the most
 * recent failure reason. Attempt + delay are injected so the retry policy is
 * unit-testable without spawning a real cloud agent.
 */
export async function planWithRetries(
  issue: LinearIssuePayload,
  attempt: () => Promise<PlannerAttempt>,
  maxAttempts: number,
  onRetryDelay: () => Promise<void>,
): Promise<FleetPlan> {
  let lastReason = "planner unavailable";
  for (let i = 1; i <= maxAttempts; i++) {
    const outcome = await attempt();
    if (outcome.ok) {
      console.log(
        `[planner] Plan: ${outcome.tasks.length} agent(s) → ${outcome.tasks.map((t) => `${t.repo} (${t.kind})`).join(", ")}; ${outcome.testPlan.length} test case(s)`,
      );
      return { tasks: outcome.tasks, testPlan: outcome.testPlan, usedFallback: false };
    }
    lastReason = outcome.reason;
    const willRetry = outcome.transient && i < maxAttempts;
    console.warn(
      `[planner] attempt ${i}/${maxAttempts} did not yield a plan: ${outcome.reason}${willRetry ? " — retrying" : ""}`,
    );
    if (!outcome.transient) break;
    if (willRetry) await onRetryDelay();
  }
  return fallbackFleetPlan(issue, lastReason);
}

/**
 * Reads the ticket via a Cursor cloud agent and returns one task per repo it
 * chose. Retries a transient failure a bounded number of times before falling
 * back, so a single flaky cloud-run start no longer makes the planner
 * "unavailable" for the whole ticket. The fallback reason carries the real
 * underlying error so a persistent failure is diagnosable from the ticket.
 */
export async function planFleet(issue: LinearIssuePayload): Promise<FleetPlan> {
  console.log(`[planner] Reading ${issue.identifier} "${issue.title}" with a Cursor agent to decide which repos need work`);
  const apiKey = cursorKey().trim();
  if (!apiKey) {
    console.error("[planner] Missing CURSOR_API_KEY; using fallback");
    return fallbackFleetPlan(issue, "missing CURSOR_API_KEY");
  }
  return planWithRetries(
    issue,
    () => runPlannerOnce(issue, apiKey),
    plannerMaxAttempts(),
    () => delay(plannerRetryDelayMs()),
  );
}
