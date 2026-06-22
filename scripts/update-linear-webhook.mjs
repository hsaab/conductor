#!/usr/bin/env node
/**
 * Repoint the existing Linear webhook to a new URL (no duplicate created).
 * Reads LINEAR_API_KEY from the environment. Pass the new URL as arg 1, or set
 * WEBHOOK_URL. Updates the first webhook whose URL or label looks like ours.
 *
 * Usage:
 *   LINEAR_API_KEY=... node scripts/update-linear-webhook.mjs https://conductor-factory.vercel.app/webhook/linear
 */
const apiKey = process.env.LINEAR_API_KEY;
const newUrl = process.argv[2] ?? process.env.WEBHOOK_URL;
if (!apiKey) {
  console.error("Set LINEAR_API_KEY");
  process.exit(1);
}
if (!newUrl) {
  console.error("Pass the new webhook URL as the first argument");
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
  const { webhooks } = await gql(
    `query { webhooks { nodes { id url label enabled } } }`,
  );
  console.log("Existing webhooks:");
  for (const w of webhooks.nodes) console.log(`  ${w.id}  ${w.enabled ? "on " : "off"}  ${w.label ?? "(no label)"}  ${w.url}`);

  const target =
    webhooks.nodes.find((w) => /conductor|cursor-demo-bridge/.test(`${w.label ?? ""} ${w.url}`)) ??
    webhooks.nodes[0];
  if (!target) {
    console.error("No webhook found to update. Run register-linear-webhook.mjs to create one.");
    process.exit(1);
  }

  const data = await gql(
    `mutation($id: String!, $input: WebhookUpdateInput!) { webhookUpdate(id: $id, input: $input) { success webhook { id url label enabled } } }`,
    { id: target.id, input: { url: newUrl, label: "conductor", enabled: true } },
  );
  console.log("\nUpdated:");
  console.log(JSON.stringify(data.webhookUpdate, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
