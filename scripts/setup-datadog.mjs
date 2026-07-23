#!/usr/bin/env node
/**
 * One-time Datadog setup for the conductor loop.
 *
 * Creates, idempotently:
 *  1. A webhook integration that POSTs to conductor's /webhook/datadog.
 *  2. A Synthetic API test against compound's /api/market/quotes route with a
 *     response-time assertion (and a body check that quotes resolved).
 *
 *   node --env-file=.env scripts/setup-datadog.mjs
 */

import { quotesProbeUrl, SYNTHETIC_QUOTE_TICKERS } from "./github-baseline.mjs";

const {
  DD_API_KEY,
  DD_APP_KEY,
  DD_BEARER_TOKEN,
  DD_SITE = "datadoghq.com",
  COMPOUND_URL,
  CONDUCTOR_URL,
  DATADOG_WEBHOOK_SECRET,
  RESPONSE_TIME_MS = "1500",
  DELETE_OLD_SYNTHETIC_ID = "crb-5yk-pwm",
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const bearerToken =
  DD_BEARER_TOKEN ||
  [DD_API_KEY, DD_APP_KEY].find((k) => /^dd(pat|sat)_/.test(k ?? ""));

if (!bearerToken) {
  requireEnv("DD_API_KEY", DD_API_KEY);
  requireEnv("DD_APP_KEY", DD_APP_KEY);
}
requireEnv("COMPOUND_URL", COMPOUND_URL);
requireEnv("CONDUCTOR_URL", CONDUCTOR_URL);
requireEnv("DATADOG_WEBHOOK_SECRET", DATADOG_WEBHOOK_SECRET);

const base = `https://api.${DD_SITE}`;
const headers = bearerToken
  ? { "Content-Type": "application/json", Authorization: `Bearer ${bearerToken}` }
  : {
      "Content-Type": "application/json",
      "DD-API-KEY": DD_API_KEY,
      "DD-APPLICATION-KEY": DD_APP_KEY,
    };
console.log(
  `Auth: ${bearerToken ? "access token (Bearer)" : "api+app key"} · Site: ${DD_SITE}\n`,
);

const WEBHOOK_NAME = "conductor_cursor_automation";
const targetUrl = quotesProbeUrl(COMPOUND_URL);
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

async function ensureWebhook() {
  const payload = JSON.stringify({
    title: "$EVENT_TITLE",
    body: "$EVENT_MSG",
    alert_type: "$ALERT_TYPE",
    route: "/api/market/quotes",
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
    console.log(
      update.ok
        ? `✓ Updated existing webhook "${WEBHOOK_NAME}"`
        : `! Webhook update failed: ${update.status} ${JSON.stringify(update.json)}`,
    );
    return;
  }
  console.error(`! Webhook create failed: ${create.status} ${JSON.stringify(create.json)}`);
}

async function deleteOldSynthetic() {
  const id = (DELETE_OLD_SYNTHETIC_ID || "").trim();
  if (!id) return;
  const del = await ddFetch("DELETE", `/api/v1/synthetics/tests/${encodeURIComponent(id)}`);
  if (del.ok || del.status === 404) {
    console.log(`✓ Removed old synthetic ${id} (or already gone).`);
  } else {
    console.warn(
      `! Could not delete old synthetic ${id}: ${del.status} ${JSON.stringify(del.json)}`,
    );
  }
}

async function ensureSyntheticTest() {
  const threshold = Number(RESPONSE_TIME_MS);
  const testName = "compound — market quotes latency";

  const existing = await ddFetch("GET", "/api/v1/synthetics/tests");
  if (existing.ok && Array.isArray(existing.json.tests)) {
    const match = existing.json.tests.find((t) => t.name === testName);
    if (match) {
      console.log(
        `· Synthetic test "${testName}" already exists (public_id ${match.public_id}); updating URL/assertions.`,
      );
      const update = await ddFetch(
        "PUT",
        `/api/v1/synthetics/tests/${encodeURIComponent(match.public_id)}`,
        {
          name: testName,
          type: "api",
          subtype: "http",
          status: "live",
          message:
            `compound /api/market/quotes is slow (response time over ${threshold}ms). ` +
            `Conductor: dispatch the remediation agent. @webhook-${WEBHOOK_NAME}`,
          tags: ["service:compound", "conductor:loop"],
          locations: ["aws:us-east-1"],
          config: {
            request: { method: "GET", url: targetUrl, timeout: 60 },
            assertions: [
              { type: "statusCode", operator: "is", target: 200 },
              { type: "responseTime", operator: "lessThan", target: threshold },
              {
                type: "body",
                operator: "validatesJSONPath",
                target: {
                  jsonPath: "$.resolved",
                  operator: "moreThanOrEqual",
                  targetValue: Math.min(10, SYNTHETIC_QUOTE_TICKERS.length),
                },
              },
            ],
          },
          options: {
            tick_every: 60,
            min_failure_duration: 0,
            min_location_failed: 1,
            retry: { count: 0, interval: 300 },
            monitor_options: { renotify_interval: 0 },
          },
        },
      );
      console.log(
        update.ok
          ? `✓ Updated synthetic ${match.public_id}`
          : `! Synthetic update failed: ${update.status} ${JSON.stringify(update.json)}`,
      );
      return match.public_id;
    }
  }

  const test = {
    name: testName,
    type: "api",
    subtype: "http",
    status: "live",
    message:
      `compound /api/market/quotes is slow (response time over ${threshold}ms). ` +
      `Conductor: dispatch the remediation agent. @webhook-${WEBHOOK_NAME}`,
    tags: ["service:compound", "conductor:loop"],
    locations: ["aws:us-east-1"],
    config: {
      request: { method: "GET", url: targetUrl, timeout: 60 },
      assertions: [
        { type: "statusCode", operator: "is", target: 200 },
        { type: "responseTime", operator: "lessThan", target: threshold },
        {
          type: "body",
          operator: "validatesJSONPath",
          target: {
            jsonPath: "$.resolved",
            operator: "moreThanOrEqual",
            targetValue: Math.min(10, SYNTHETIC_QUOTE_TICKERS.length),
          },
        },
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
    console.log(
      `✓ Created Synthetic API test "${test.name}" (public_id ${create.json.public_id})`,
    );
    console.log(`  Target: ${targetUrl}`);
    console.log(`  Assertion: responseTime < ${threshold}ms, every 60s`);
    return create.json.public_id;
  }
  console.error(`! Synthetic test create failed: ${create.status} ${JSON.stringify(create.json)}`);
  return null;
}

async function main() {
  console.log("Setting up Datadog for the conductor loop…\n");
  await ensureWebhook();
  await deleteOldSynthetic();
  const id = await ensureSyntheticTest();
  console.log(
    "\nDone. Verify in Datadog: Synthetic Monitoring > Tests, and Integrations > Webhooks.",
  );
  if (id) console.log(`New/updated synthetic public_id: ${id}`);
}

main().catch((err) => {
  console.error("setup-datadog failed:", err);
  process.exit(1);
});
