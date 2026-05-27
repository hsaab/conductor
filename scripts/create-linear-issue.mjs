#!/usr/bin/env node
/**
 * Creates the demo Linear issue via GraphQL.
 * Usage: LINEAR_API_KEY=lin_api_... node scripts/create-linear-issue.mjs
 */
const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error("Set LINEAR_API_KEY");
  process.exit(1);
}

const query = `
mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $labelIds: [String!], $assigneeId: String!, $stateId: String!) {
  issueCreate(input: {
    teamId: $teamId
    title: $title
    description: $description
    labelIds: $labelIds
    assigneeId: $assigneeId
    stateId: $stateId
  }) {
    success
    issue { id identifier url }
  }
}`;

async function gql(queryStr, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query: queryStr, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const description = `## Context

Platform Engineering is rolling out org-wide distributed tracing this quarter. Every HTTP service must propagate a shared \`X-Request-ID\` header so logs, metrics, and traces correlate across hops.

This sprint covers two services in the initial wave:

- **compound** — Next.js portfolio app (hero / full stack)
- **server** — Bitwarden ASP.NET API (chorus / backend subset)

## Acceptance criteria

- [ ] Middleware reads an incoming \`X-Request-ID\` header or generates a new UUID when absent
- [ ] Response echoes the request ID in the \`X-Request-ID\` header
- [ ] Structured logs include the request ID on every line for the request lifecycle
- [ ] Tests pass (compound: integration/runtime; server: xUnit middleware test)

## Notes

Label \`cursor-fleet\` triggers the Cursor SDK bridge when this ticket moves to **In Progress**.`;

async function main() {
  const viewer = await gql(`query { viewer { id name teams { nodes { id name issueLabels { nodes { id name } } states { nodes { id name type } } } } } }`);
  const team = viewer.viewer.teams.nodes.find((t) => t.name === "DevEx") ?? viewer.viewer.teams.nodes[0];
  let label = team.issueLabels.nodes.find((l) => l.name === "cursor-fleet");
  if (!label) {
    const created = await gql(
      `mutation($name: String!, $teamId: String!) { issueLabelCreate(input: { name: $name, teamId: $teamId, color: "#f54e00" }) { success issueLabel { id name } } }`,
      { name: "cursor-fleet", teamId: team.id },
    );
    label = created.issueLabelCreate.issueLabel;
    console.log("Created label cursor-fleet");
  }
  const backlog = team.states.nodes.find((s) => s.name === "Backlog");
  const data = await gql(query, {
    teamId: team.id,
    title: "Add X-Request-ID middleware for distributed tracing",
    description,
    labelIds: [label.id],
    assigneeId: viewer.viewer.id,
    stateId: backlog.id,
  });
  const issue = data.issueCreate.issue;
  console.log(JSON.stringify(issue, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
