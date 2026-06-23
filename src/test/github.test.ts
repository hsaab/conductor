import assert from "node:assert/strict";
import { test } from "node:test";

import { allPullRequestsMerged, fetchPullRequestMergeState, parsePullRequestUrl } from "../github.js";

test("parsePullRequestUrl extracts owner, repo, and number from a PR URL", () => {
  assert.deepEqual(parsePullRequestUrl("https://github.com/hsaab/compound/pull/52"), {
    owner: "hsaab",
    repo: "compound",
    number: 52,
  });
});

test("parsePullRequestUrl returns null for non-PR URLs", () => {
  assert.equal(parsePullRequestUrl("https://github.com/hsaab/compound"), null);
  assert.equal(parsePullRequestUrl("https://example.com/foo/bar/pull/1"), null);
  assert.equal(parsePullRequestUrl("not a url at all"), null);
});

test("merge checks never report a false positive without a token", async () => {
  assert.equal(await fetchPullRequestMergeState("https://github.com/hsaab/compound/pull/1", ""), "unknown");
  assert.equal(await allPullRequestsMerged(["https://github.com/hsaab/compound/pull/1"], ""), false);
});

test("allPullRequestsMerged is false for an empty PR list", async () => {
  assert.equal(await allPullRequestsMerged([], "tok"), false);
});

test("allPullRequestsMerged is true only when every PR is merged", async () => {
  // Stub global fetch so the test is hermetic (no network).
  const realFetch = globalThis.fetch;
  const byUrl: Record<string, unknown> = {
    "https://api.github.com/repos/hsaab/compound/pulls/1": { merged: true },
    "https://api.github.com/repos/hsaab/compound/pulls/2": { merged: false, merged_at: null },
  };
  globalThis.fetch = (async (input: unknown) => ({
    ok: true,
    json: async () => byUrl[String(input)] ?? {},
  })) as unknown as typeof fetch;

  try {
    assert.equal(
      await allPullRequestsMerged(["https://github.com/hsaab/compound/pull/1"], "tok"),
      true,
    );
    assert.equal(
      await allPullRequestsMerged(
        [
          "https://github.com/hsaab/compound/pull/1",
          "https://github.com/hsaab/compound/pull/2",
        ],
        "tok",
      ),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchPullRequestMergeState treats a non-200 response as unknown", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  try {
    assert.equal(
      await fetchPullRequestMergeState("https://github.com/hsaab/compound/pull/9", "tok"),
      "unknown",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
