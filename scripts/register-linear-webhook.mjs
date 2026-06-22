#!/usr/bin/env node
/** Register Linear webhook. Usage: LINEAR_API_KEY=... WEBHOOK_URL=... LINEAR_WEBHOOK_SECRET=... node scripts/register-linear-webhook.mjs */
const apiKey = process.env.LINEAR_API_KEY;
const url = process.env.WEBHOOK_URL ?? "https://conductor.vercel.app/webhook/linear";
const secret = process.env.LINEAR_WEBHOOK_SECRET;
if (!apiKey || !secret) {
  console.error("Set LINEAR_API_KEY and LINEAR_WEBHOOK_SECRET");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function main() {
  const { teams } = await gql(`query { teams { nodes { id name } } }`);
  const team = teams.nodes.find((t) => t.name === "DevEx") ?? teams.nodes[0];
  const data = await gql(
    `mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id enabled url } } }`,
    {
      input: {
        teamId: team.id,
        url,
        resourceTypes: ["Issue"],
        label: "conductor",
        secret,
        enabled: true,
      },
    },
  );
  console.log(JSON.stringify(data.webhookCreate, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
