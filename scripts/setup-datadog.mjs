#!/usr/bin/env node
/**
 * One-time Datadog setup for the conductor loop.
 *
 * Creates, idempotently:
 *  1. A webhook integration ("conductor-datadog") that POSTs to conductor's
 *     /webhook/datadog endpoint with the shared secret.
 *  2. A Synthetic API test against compound's /api/market/quotes-check route with
 *     a response-time assertion. When the planted regression ships, the route is
 *     slow, the assertion fails every run, and the test's monitor notifies the
 *     conductor webhook deterministically (no percentile lottery).
 *
 * Usage (all via env):
 *   DD_API_KEY=...            Datadog API key
 *   DD_APP_KEY=...            Datadog application key
 *   DD_SITE=datadoghq.com     Datadog site (default datadoghq.com)
 *   COMPOUND_URL=...          Deployed compound base URL (e.g. https://compound.vercel.app)
 *   CONDUCTOR_URL=...         Deployed conductor base URL (e.g. https://conductor.vercel.app)
 *   DATADOG_WEBHOOK_SECRET=...Shared secret guarding /webhook/datadog
 *   RESPONSE_TIME_MS=1500     Optional assertion threshold (default 1500)
 *
 *   node scripts/setup-datadog.mjs
 */

const {
  DD_API_KEY,
  DD_APP_KEY,
  DD_SITE = "datadoghq.com",
  COMPOUND_URL,
  CONDUCTOR_URL,
  DATADOG_WEBHOOK_SECRET,
  RESPONSE_TIME_MS = "1500",
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

requireEnv("DD_API_KEY", DD_API_KEY);
requireEnv("DD_APP_KEY", DD_APP_KEY);
requireEnv("COMPOUND_URL", COMPOUND_URL);
requireEnv("CONDUCTOR_URL", CONDUCTOR_URL);
requireEnv("DATADOG_WEBHOOK_SECRET", DATADOG_WEBHOOK_SECRET);

const base = `https://api.${DD_SITE}`;
const headers = {
  "Content-Type": "application/json",
  "DD-API-KEY": DD_API_KEY,
  "DD-APPLICATION-KEY": DD_APP_KEY,
};

const WEBHOOK_NAME = "conductor-datadog";
const targetUrl = `${COMPOUND_URL.replace(/\/$/, "")}/api/market/quotes-check`;
const conductorWebhookUrl = `${CONDUCTOR_URL.replace(/\/$/, "")}/webhook/datadog?secret=${encodeURIComponent(DATADOG_WEBHOOK_SECRET)}`;

async function ddFetch(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

/** Create the webhook integration that conductor's /webhook/datadog receives. */
async function ensureWebhook() {
  // Datadog forwards this JSON template; conductor parses it tolerantly.
  const payload = JSON.stringify({
    title: "$EVENT_TITLE",
    body: "$EVENT_MSG",
    alert_type: "$ALERT_TYPE",
    route: "/api/market/quotes-check",
    monitor_id: "$ID",
  });

  const create = await ddFetch("POST", "/api/v1/integration/webhooks/configuration", {
    name: WEBHOOK_NAME,
    url: conductorWebhookUrl,
    encode_as: "json",
    payload,
  });

  if (create.ok) {
    console.log(`✓ Created webhook "${WEBHOOK_NAME}" -> ${CONDUCTOR_URL}/webhook/datadog`);
    return;
  }
  if (create.status === 409 || /already exists/i.test(JSON.stringify(create.json))) {
    const update = await ddFetch(
      "PUT",
      `/api/v1/integration/webhooks/configuration/${encodeURIComponent(WEBHOOK_NAME)}`,
      { url: conductorWebhookUrl, encode_as: "json", payload },
    );
    console.log(update.ok ? `✓ Updated existing webhook "${WEBHOOK_NAME}"` : `! Webhook update failed: ${update.status} ${JSON.stringify(update.json)}`);
    return;
  }
  console.error(`! Webhook create failed: ${create.status} ${JSON.stringify(create.json)}`);
}

/** Create the Synthetic API test with a response-time assertion. */
async function ensureSyntheticTest() {
  const threshold = Number(RESPONSE_TIME_MS);
  const test = {
    name: "compound — quotes-check latency",
    type: "api",
    subtype: "http",
    status: "live",
    message:
      `compound /api/market/quotes-check is slow (response time over ${threshold}ms). ` +
      `Conductor: dispatch the remediation agent. @webhook-${WEBHOOK_NAME}`,
    tags: ["service:compound", "conductor:loop"],
    locations: ["aws:us-east-1"],
    config: {
      request: { method: "GET", url: targetUrl, timeout: 30 },
      assertions: [
        { type: "statusCode", operator: "is", target: 200 },
        { type: "responseTime", operator: "lessThan", target: threshold },
      ],
    },
    options: {
      tick_every: 60,
      min_failure_duration: 0,
      min_location_failed: 1,
      retry: { count: 0, interval: 300 },
      monitor_options: { renotify_interval: 0 },
    },
  };

  const create = await ddFetch("POST", "/api/v1/synthetics/tests", test);
  if (create.ok) {
    console.log(`✓ Created Synthetic API test "${test.name}" (public_id ${create.json.public_id})`);
    console.log(`  Target: ${targetUrl}`);
    console.log(`  Assertion: responseTime < ${threshold}ms, every 60s`);
    return;
  }
  console.error(`! Synthetic test create failed: ${create.status} ${JSON.stringify(create.json)}`);
  console.error("  If a test with this name already exists, delete it in Datadog or rename, then re-run.");
}

async function main() {
  console.log("Setting up Datadog for the conductor loop…\n");
  await ensureWebhook();
  await ensureSyntheticTest();
  console.log("\nDone. Verify in Datadog: Synthetic Monitoring > Tests, and Integrations > Webhooks.");
  console.log("Backup monitors (optional): add a logs monitor on `service:compound status:error` notifying @webhook-" + WEBHOOK_NAME + ".");
}

main().catch((err) => {
  console.error("setup-datadog failed:", err);
  process.exit(1);
});
