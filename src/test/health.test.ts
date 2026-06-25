import { test } from "node:test";
import assert from "node:assert/strict";

import { resetSdkHealthCache, sdkHealth } from "../health.js";

test("sdkHealth reports ok when @cursor/sdk imports (the build gate held)", async () => {
  resetSdkHealthCache();
  const health = await sdkHealth();
  assert.equal(health.status, "ok");
  assert.equal(health.error, undefined);
});

test("sdkHealth memoizes the probe so the hot path stays cheap", async () => {
  resetSdkHealthCache();
  const first = await sdkHealth();
  const second = await sdkHealth();
  assert.equal(first, second, "expected the cached probe result to be reused");
});
