#!/usr/bin/env node
/**
 * Repoints the compound latency synthetic test's alert message to a given
 * webhook handle (e.g. @webhook-conductor_cursor_automation). One-off helper:
 * Datadog has no partial "message only" edit, so we GET the test, swap the
 * @webhook-... handle, and PUT the editable fields back.
 *
 * Env: DD_BEARER_TOKEN | DD_API_KEY (ddpat_/ddsat_), DD_SITE, WEBHOOK_HANDLE, PUBLIC_ID
 */
const {
  DD_API_KEY,
  DD_BEARER_TOKEN,
  DD_SITE = "us5.datadoghq.com",
  WEBHOOK_HANDLE,
  PUBLIC_ID = "crb-5yk-pwm",
} = process.env;

const token = DD_BEARER_TOKEN || DD_API_KEY;
if (!token) throw new Error("Set DD_API_KEY or DD_BEARER_TOKEN");
if (!WEBHOOK_HANDLE) throw new Error("Set WEBHOOK_HANDLE (e.g. @webhook-conductor_cursor_automation)");

const base = `https://api.${DD_SITE}`;
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

const getRes = await fetch(`${base}/api/v1/synthetics/tests/${PUBLIC_ID}`, { headers });
if (!getRes.ok) throw new Error(`GET failed: ${getRes.status} ${await getRes.text()}`);
const test = await getRes.json();

// Replace any existing @webhook-... handle (or append if none present).
const cleaned = String(test.message ?? "").replace(/@webhook-\S+/g, "").trim();
const message = `${cleaned} ${WEBHOOK_HANDLE}`.trim();

const body = {
  name: test.name,
  type: test.type,
  subtype: test.subtype,
  status: test.status,
  message,
  tags: test.tags ?? [],
  config: test.config,
  locations: test.locations,
  options: test.options,
};

const putRes = await fetch(`${base}/api/v1/synthetics/tests/${PUBLIC_ID}`, {
  method: "PUT",
  headers,
  body: JSON.stringify(body),
});
const text = await putRes.text();
if (!putRes.ok) throw new Error(`PUT failed: ${putRes.status} ${text}`);
console.log(`✓ Repointed ${PUBLIC_ID} alert to ${WEBHOOK_HANDLE}`);
console.log(`  message: ${message}`);
