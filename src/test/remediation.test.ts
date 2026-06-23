/**
 * Unit tests for the Datadog remediation webhook's pure decision helpers.
 * No network: these exercise payload parsing and the dispatch gate only.
 *
 * Run with: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractAlert, isDispatchableAlert } from "../remediation.js";

/** Mirrors the custom payload Datadog sends (scripts/setup-datadog.mjs). */
const realDatadogPayload = {
  title: "compound — quotes-check latency",
  body: "responseTime 4200ms > 1500ms",
  alert_type: "error",
  route: "/api/market/quotes-check",
  monitor_id: "12345",
};

test("isDispatchableAlert rejects an empty body (wrong/no Content-Type leaves req.body={})", () => {
  const { alert, alertType } = extractAlert({});
  // extractAlert defaults the title but leaves alert_type/route undefined.
  assert.equal(alertType, undefined);
  assert.equal(isDispatchableAlert(alert, alertType), false);
});

test("isDispatchableAlert rejects a payload with only an unknown alert_type and no latency markers", () => {
  const { alert, alertType } = extractAlert({ alert_type: "info", title: "Datadog daily digest" });
  assert.equal(isDispatchableAlert(alert, alertType), false);
});

test("isDispatchableAlert accepts the real Datadog custom payload (firing type + route)", () => {
  const { alert, alertType } = extractAlert(realDatadogPayload);
  assert.equal(isDispatchableAlert(alert, alertType), true);
});

test("isDispatchableAlert accepts a firing alert_type even without a route", () => {
  const { alert, alertType } = extractAlert({ alert_type: "error", title: "Monitor triggered" });
  assert.equal(isDispatchableAlert(alert, alertType), true);
});

test("isDispatchableAlert accepts a latency-route match even when alert_type is absent", () => {
  const { alert, alertType } = extractAlert({ route: "/api/market/quotes-check", title: "latency" });
  assert.equal(alertType, undefined);
  assert.equal(isDispatchableAlert(alert, alertType), true);
});
