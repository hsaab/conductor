import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fallbackPlan,
  normalizeKind,
  parsePlanText,
  parseTicketRepos,
  planFleet,
  sanitizePlan,
  withTicketRepos,
} from "../planner.js";
import type { LinearIssuePayload } from "../types.js";

/**
 * FE-5's real Linear description, verbatim. The repos are markdown-bolded list
 * items, not a `Repos:` line, and adjacent bold runs mangle the raw bytes into
 * `hsaab/****compound` / `hsaab/****server`. This is the exact artifact the user
 * drags, so the parser must recover both slugs from it.
 */
const FE5_DESCRIPTION = `## Context

Platform Engineering is rolling out org-wide distributed tracing this quarter. Every HTTP service must propagate a shared \`X-Request-ID\` header so logs, metrics, and traces correlate across hops.

This sprint covers two services in the initial wave:

* **hsaab/****compound** — Next.js portfolio app (hero / full stack)
* **hsaab/****server** — Bitwarden [ASP.NET](<http://ASP.NET>) API (chorus / backend subset)

## Acceptance criteria
- Propagate X-Request-ID on every hop and log it.`;

const fe5Issue = {
  identifier: "FE-5",
  title: "Add X-Request-ID middleware for distributed tracing",
  description: FE5_DESCRIPTION,
  labels: [{ name: "cursor-fleet" }],
} as LinearIssuePayload;

test("sanitizePlan normalizes bare repo names to owner/repo", () => {
  const plan = sanitizePlan([{ repo: "compound", instructions: "Add middleware", kind: "feature" }]);
  assert.deepEqual(plan, [{ repo: "hsaab/compound", instructions: "Add middleware", kind: "feature" }]);
});

test("sanitizePlan keeps fully qualified repos from the ticket", () => {
  const plan = sanitizePlan([
    { repo: "acme/web", instructions: "Update footer", kind: "feature" },
    { repo: "compound", instructions: "Add logging", kind: "bug" },
  ]);
  assert.deepEqual(plan, [
    { repo: "acme/web", instructions: "Update footer", kind: "feature" },
    { repo: "hsaab/compound", instructions: "Add logging", kind: "bug" },
  ]);
});

test("sanitizePlan deduplicates by normalized repo", () => {
  const plan = sanitizePlan([
    { repo: "compound", instructions: "First", kind: "feature" },
    { repo: "hsaab/compound", instructions: "Duplicate", kind: "feature" },
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].instructions, "First");
});

test("sanitizePlan drops empty repo or instructions", () => {
  const plan = sanitizePlan([
    { repo: "", instructions: "Nope", kind: "feature" },
    { repo: "compound", instructions: "   ", kind: "feature" },
    { repo: "server", instructions: "Valid", kind: "test" },
  ]);
  assert.deepEqual(plan, [{ repo: "hsaab/server", instructions: "Valid", kind: "test" }]);
});

test("sanitizePlan keeps repos not in the known hints list", () => {
  const plan = sanitizePlan([{ repo: "brand-new-repo", instructions: "Ship it", kind: "feature" }]);
  assert.deepEqual(plan, [{ repo: "hsaab/brand-new-repo", instructions: "Ship it", kind: "feature" }]);
});

test("sanitizePlan defaults an unknown kind to feature", () => {
  const plan = sanitizePlan([
    { repo: "compound", instructions: "Do it", kind: "nonsense" as unknown as "feature" },
  ]);
  assert.equal(plan[0].kind, "feature");
});

test("fallbackPlan targets only the single deploy-target repo, not every known repo", () => {
  // Regression guard: a planner failure must under-spawn (one best-guess agent),
  // never fan out to every known repo — that wrongly launched compound + server
  // for a compound-only ticket.
  const issue = {
    identifier: "FE-13",
    title: "Make holding quotes real-time",
    description: "Portfolio prices look stale in the app.",
    labels: [{ name: "cursor-fleet" }],
  } as LinearIssuePayload;
  const plan = fallbackPlan(issue);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].repo, "hsaab/compound");
});

test("fallbackPlan fans out to every repo the ticket explicitly names (multi-repo)", () => {
  // FE-5 (add X-Request-ID middleware to both the Node app and the C# server) is
  // an inherently multi-repo ticket. When the planner agent is unavailable, the
  // fallback must still honor the repos the ticket names, not collapse to the
  // single deploy target — that is how only `compound` spun up for FE-5.
  const issue = {
    identifier: "FE-5",
    title: "Add X-Request-ID middleware",
    description: "Repos: server, compound\n\nAdd request-id middleware to both repos.",
    labels: [{ name: "cursor-fleet" }],
  } as LinearIssuePayload;
  const repos = fallbackPlan(issue).map((task) => task.repo).sort();
  assert.deepEqual(repos, ["hsaab/compound", "hsaab/server"]);
});

test("fallbackPlan honors a single explicitly named repo without forcing the deploy target", () => {
  const issue = {
    identifier: "FE-9",
    title: "Add Serilog request-id enricher",
    description: "Repo: server\n\nAdd the enricher to the request pipeline.",
  } as LinearIssuePayload;
  assert.deepEqual(
    fallbackPlan(issue).map((task) => task.repo),
    ["hsaab/server"],
  );
});

test("fallbackPlan honors FE-13's repo line and Bug label", () => {
  const issue = {
    identifier: "FE-13",
    title: "Portfolio prices look stale — make holding quotes real-time",
    description: "* Repo: `hsaab/compound`",
    labels: [{ name: "cursor-fleet" }, { name: "Bug" }],
  } as LinearIssuePayload;

  assert.deepEqual(
    fallbackPlan(issue).map(({ repo, kind }) => ({ repo, kind })),
    [{ repo: "hsaab/compound", kind: "bug" }],
  );
});

test("fallbackPlan infers the task kind from the ticket (bug here)", () => {
  const issue = {
    identifier: "FE-13",
    title: "Fix the broken stale price regression",
    description: "",
  } as LinearIssuePayload;
  assert.equal(fallbackPlan(issue)[0].kind, "bug");
});

test("planFleet explains local fallback when CURSOR_API_KEY is missing", async () => {
  const previousKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;

  try {
    const issue = {
      identifier: "FE-13",
      title: "Portfolio prices look stale — make holding quotes real-time",
      description: "Quotes should refresh from live market data.",
      labels: [{ name: "cursor-fleet" }],
    } as LinearIssuePayload;

    const plan = await planFleet(issue);
    assert.equal(plan.usedFallback, true);
    assert.equal(plan.fallbackReason, "missing CURSOR_API_KEY");
    assert.deepEqual(plan.tasks.map((task) => task.repo), ["hsaab/compound"]);
  } finally {
    if (previousKey === undefined) {
      delete process.env.CURSOR_API_KEY;
    } else {
      process.env.CURSOR_API_KEY = previousKey;
    }
  }
});

test("parseTicketRepos reads a comma-separated Repos: line", () => {
  const issue = {
    identifier: "FE-5",
    title: "Add X-Request-ID middleware",
    description: "Repos: server, compound\n\nAdd request-id middleware to both repos.",
  } as LinearIssuePayload;
  assert.deepEqual(parseTicketRepos(issue), ["server", "compound"]);
});

test("parseTicketRepos reads owner/repo slugs joined by 'and' on a bold Repos line", () => {
  const issue = {
    identifier: "FE-5",
    title: "Wire up tracing",
    description: "**Repos:** hsaab/server and hsaab/compound",
  } as LinearIssuePayload;
  assert.deepEqual(parseTicketRepos(issue), ["hsaab/server", "hsaab/compound"]);
});

test("parseTicketRepos recognizes markdown-bolded owner slugs in FE-5 as written", () => {
  // FE-5 names its repos as bolded bullets (no Repos: line), and the bold runs
  // mangle the bytes to `hsaab/****server`. Both slugs must still be recovered.
  assert.deepEqual(parseTicketRepos(fe5Issue).sort(), ["hsaab/compound", "hsaab/server"]);
});

test("fallbackPlan fans FE-5 out to both repos from its bolded slugs (as written)", () => {
  assert.deepEqual(
    fallbackPlan(fe5Issue)
      .map((task) => task.repo)
      .sort(),
    ["hsaab/compound", "hsaab/server"],
  );
});

test("withTicketRepos folds FE-5's bolded slugs into a single-repo planner plan", () => {
  // Even if the planner agent only returned compound, FE-5's explicitly named
  // server must be added back from the description.
  const planned = [{ repo: "hsaab/compound", instructions: "Add middleware", kind: "feature" as const }];
  assert.deepEqual(
    withTicketRepos(planned, fe5Issue)
      .map((task) => task.repo)
      .sort(),
    ["hsaab/compound", "hsaab/server"],
  );
});

test("parseTicketRepos ignores bare repo names mentioned only in prose (no over-spawn)", () => {
  // Regression guard for the original over-spawn bug: a casual mention of a repo
  // word, with no explicit Repos: line and no owner-qualified slug, must not
  // select that repo. An owner-qualified slug is intent; a bare word is not.
  const issue = {
    identifier: "FE-13",
    title: "Server returns stale quotes",
    description: "The server returned 500 and the compound UI showed stale prices.",
  } as LinearIssuePayload;
  assert.deepEqual(parseTicketRepos(issue), []);
});

test("withTicketRepos adds a ticket-named repo the planner agent dropped", () => {
  // Planner returned only compound, but the ticket explicitly names both. The
  // missing repo is appended with default instructions so multi-repo intent
  // holds even if the LLM under-plans; the planner's instructions for compound win.
  const issue = {
    identifier: "FE-5",
    title: "Add X-Request-ID middleware",
    description: "Repos: server, compound",
  } as LinearIssuePayload;
  const planned = [{ repo: "hsaab/compound", instructions: "Add middleware in src/app.ts", kind: "feature" as const }];
  const merged = withTicketRepos(planned, issue);
  const byRepo = new Map(merged.map((task) => [task.repo, task]));
  assert.deepEqual([...byRepo.keys()].sort(), ["hsaab/compound", "hsaab/server"]);
  assert.equal(byRepo.get("hsaab/compound")?.instructions, "Add middleware in src/app.ts");
});

test("withTicketRepos leaves a planner plan untouched when the ticket names no repos", () => {
  const issue = { identifier: "FE-13", title: "Stale quotes", description: "Prices look stale." } as LinearIssuePayload;
  const planned = [{ repo: "compound", instructions: "Cache quotes", kind: "feature" as const }];
  assert.deepEqual(withTicketRepos(planned, issue), [
    { repo: "hsaab/compound", instructions: "Cache quotes", kind: "feature" },
  ]);
});

test("normalizeKind accepts known kinds and falls back to feature", () => {
  assert.equal(normalizeKind("bug"), "bug");
  assert.equal(normalizeKind("TEST"), "test");
  assert.equal(normalizeKind("feature"), "feature");
  assert.equal(normalizeKind(undefined), "feature");
  assert.equal(normalizeKind("weird"), "feature");
});

test("parsePlanText reads a bare JSON object from the agent reply", () => {
  const text = '{"tasks":[{"repo":"acme/web","kind":"bug","instructions":"Update footer"}]}';
  assert.deepEqual(parsePlanText(text), [{ repo: "acme/web", instructions: "Update footer", kind: "bug" }]);
});

test("parsePlanText defaults kind to feature when omitted", () => {
  const text = '{"tasks":[{"repo":"compound","instructions":"Add middleware"}]}';
  assert.deepEqual(parsePlanText(text), [{ repo: "compound", instructions: "Add middleware", kind: "feature" }]);
});

test("parsePlanText reads JSON wrapped in a fenced block and surrounding prose", () => {
  const text = 'Here is the plan:\n```json\n{"tasks":[{"repo":"compound","kind":"test","instructions":"Add middleware"}]}\n```\nDone.';
  assert.deepEqual(parsePlanText(text), [{ repo: "compound", instructions: "Add middleware", kind: "test" }]);
});

test("parsePlanText returns empty on unparseable text", () => {
  assert.deepEqual(parsePlanText("no json here"), []);
  assert.deepEqual(parsePlanText(""), []);
});
