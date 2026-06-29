import assert from "node:assert/strict";
import { test } from "node:test";

import { createBoardCache } from "../http/boardCache.js";
import type { JobsReport } from "../types.js";

const emptyReport = (): JobsReport => ({
  generatedAt: "t",
  inProgress: 0,
  complete: 0,
  agentsPending: 0,
  needsReconcile: false,
  jobs: [],
});

test("board cache returns cached report within TTL", async () => {
  let nowMs = 0;
  let fetchCalls = 0;
  const cache = createBoardCache(
    async () => {
      fetchCalls++;
      return emptyReport();
    },
    5000,
    () => nowMs,
  );

  const first = await cache.get(true);
  const second = await cache.get(true);

  assert.equal(fetchCalls, 1);
  assert.equal(first, second);
});

test("board cache refetches after TTL expires", async () => {
  let nowMs = 0;
  let fetchCalls = 0;
  const cache = createBoardCache(
    async () => {
      fetchCalls++;
      return emptyReport();
    },
    1000,
    () => nowMs,
  );

  await cache.get(true);
  nowMs = 1001;
  await cache.get(true);

  assert.equal(fetchCalls, 2);
});

test("board cache dedupes concurrent in-flight fetches", async () => {
  let nowMs = 0;
  let fetchCalls = 0;
  let resolveFetch!: (report: JobsReport) => void;
  const cache = createBoardCache(
    () => {
      fetchCalls++;
      return new Promise<JobsReport>((resolve) => {
        resolveFetch = resolve;
      });
    },
    5000,
    () => nowMs,
  );

  const firstPromise = cache.get(true);
  const secondPromise = cache.get(true);
  assert.equal(fetchCalls, 1);

  const report = emptyReport();
  resolveFetch(report);
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first, report);
  assert.equal(second, report);
});

test("board cache keeps separate slots per includeComplete key", async () => {
  let nowMs = 0;
  let fetchCalls = 0;
  const cache = createBoardCache(
    async ({ includeComplete }) => {
      fetchCalls++;
      return { ...emptyReport(), generatedAt: includeComplete ? "all" : "active" };
    },
    5000,
    () => nowMs,
  );

  const all = await cache.get(true);
  const active = await cache.get(false);

  assert.equal(fetchCalls, 2);
  assert.equal(all.generatedAt, "all");
  assert.equal(active.generatedAt, "active");
});
