#!/usr/bin/env node
/**
 * One-time setup for a Linear workspace that drives the bridge via webhook.
 *
 * Idempotently ensures three things exist in the target team:
 *   1. the `cursor-fleet` trigger label,
 *   2. the "Add X-Request-ID middleware" demo ticket (in Backlog), and
 *   3. an Issue webhook pointing at the deployed bridge, signed with
 *      LINEAR_WEBHOOK_SECRET so the bridge can verify deliveries.
 *
 * Usage: node --env-file=.env scripts/setup-new-workspace.mjs
 * Env:   LINEAR_API_KEY, LINEAR_WEBHOOK_SECRET (required)
 *        WEBHOOK_URL  (default: https://cursor-demo-bridge.vercel.app/webhook/linear)
 *        LINEAR_TEAM  (default: FE-Cursor)
 */
const apiKey = process.env.LINEAR_API_KEY;
const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
const webhookUrl = process.env.WEBHOOK_URL ?? "https://cursor-demo-bridge.vercel.app/webhook/linear";
const teamName = process.env.LINEAR_TEAM ?? "FE-Cursor";
const triggerLabel = "cursor-fleet";
const issueTitle = "Add X-Request-ID middleware for distributed tracing";

if (!apiKey || !webhookSecret) {
  console.error("Set LINEAR_API_KEY and LINEAR_WEBHOOK_SECRET (load them from .env).");
  process.exit(1);
}

// Mirrors the canonical demo ticket so the fleet prompt has the same context.
const issueDescription = `## Context

Platform Engineering is rolling out org-wide distributed tracing this quarter. Every HTTP service must propagate a shared \`X-Request-ID\` header so logs, metrics, and traces correlate across hops.

This sprint covers two services in the initial wave:

- **compound** — Next.js portfolio app
- **server** — Bitwarden ASP.NET API

## Acceptance criteria

- [ ] Middleware reads an incoming \`X-Request-ID\` header or generates a new UUID when absent
- [ ] Response echoes the request ID in the \`X-Request-ID\` header
- [ ] Structured logs include the request ID on every line for the request lifecycle
- [ ] Tests pass (compound: integration/runtime; server: xUnit middleware test)

## Notes

Label \`cursor-fleet\` triggers the Cursor SDK bridge when this ticket moves to **In Progress**.`;

async function gql(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    throw new Error(json.errors ? JSON.stringify(json.errors) : res.statusText);
  }
  return json.data;
}

/** Resolves the target team plus the data needed to create the label and issue. */
async function resolveTeam() {
  const { viewer, teams } = await gql(`query {
    viewer { id name }
    teams { nodes { id name labels { nodes { id name } } states { nodes { id name type } } } }
  }`);
  const team = teams.nodes.find((t) => t.name === teamName) ?? teams.nodes[0];
  if (!team) throw new Error("No teams found for this API key");
  return { viewer, team };
}

/** Returns the `cursor-fleet` label id, creating it if the team lacks one. */
async function ensureLabel(team) {
  const existing = team.labels.nodes.find((l) => l.name === triggerLabel);
  if (existing) return existing.id;
  const data = await gql(
    `mutation($name: String!, $teamId: String!) {
      issueLabelCreate(input: { name: $name, teamId: $teamId, color: "#f54e00" }) {
        issueLabel { id name }
      }
    }`,
    { name: triggerLabel, teamId: team.id },
  );
  console.log(`Created label ${triggerLabel}`);
  return data.issueLabelCreate.issueLabel.id;
}

async function createIssue(viewer, team, labelId) {
  const backlog = team.states.nodes.find((s) => s.type === "backlog") ?? team.states.nodes[0];
  const data = await gql(
    `mutation($teamId: String!, $title: String!, $description: String!, $labelIds: [String!], $assigneeId: String!, $stateId: String!) {
      issueCreate(input: {
        teamId: $teamId, title: $title, description: $description,
        labelIds: $labelIds, assigneeId: $assigneeId, stateId: $stateId
      }) { issue { id identifier url } }
    }`,
    {
      teamId: team.id,
      title: issueTitle,
      description: issueDescription,
      labelIds: [labelId],
      assigneeId: viewer.id,
      stateId: backlog.id,
    },
  );
  return data.issueCreate.issue;
}

/** Registers the Issue webhook, skipping creation if one already targets the URL. */
async function ensureWebhook(team) {
  const { webhooks } = await gql(`query { webhooks { nodes { id url enabled } } }`);
  const existing = webhooks.nodes.find((w) => w.url === webhookUrl);
  if (existing) {
    console.log(`Webhook already targets ${webhookUrl} (id ${existing.id}) — leaving it in place`);
    return existing;
  }
  const data = await gql(
    `mutation($input: WebhookCreateInput!) {
      webhookCreate(input: $input) { webhook { id url enabled } }
    }`,
    {
      input: {
        teamId: team.id,
        url: webhookUrl,
        resourceTypes: ["Issue"],
        label: "cursor-demo-bridge",
        secret: webhookSecret,
        enabled: true,
      },
    },
  );
  console.log(`Created webhook -> ${webhookUrl}`);
  return data.webhookCreate.webhook;
}

async function main() {
  const { viewer, team } = await resolveTeam();
  console.log(`Workspace user: ${viewer.name} · team: ${team.name}`);
  const labelId = await ensureLabel(team);
  const issue = await createIssue(viewer, team, labelId);
  console.log(`Created issue ${issue.identifier}: ${issue.url}`);
  const webhook = await ensureWebhook(team);
  console.log("\nDone. Summary:");
  console.log(JSON.stringify({ issue, webhook, webhookUrl }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
