import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDeployAnnouncement,
  extractDeployment,
  isPreviewDeployUrl,
  isProductionDeployment,
} from "../pipeline/observability.js";
import type { ServiceHealth } from "../integrations/datadog.js";

const unknown: ServiceHealth = { errors: null, unknown: true };

test("a fresh deploy announces shipped + verifying, never healthy", () => {
  const a = buildDeployAnnouncement("compound", unknown, 2);
  assert.equal(a.headline, "🚀 compound shipped to production");
  assert.match(a.scanLine, /running test plan against production/);
  assert.equal(a.observeNote, "");
  assert.doesNotMatch(a.headline, /healthy|no errors/i);
  assert.doesNotMatch(a.scanLine, /healthy|no errors/i);
});

test("unmatched production deploy uses neutral copy, not shipped", () => {
  const a = buildDeployAnnouncement("compound", unknown, 2, { matchedTicket: false });
  assert.equal(a.headline, "📦 compound production deploy detected");
  assert.match(a.scanLine, /no active fleet ticket matched/);
});

test("no Datadog signal is treated as nothing-to-warn, not healthy", () => {
  const a = buildDeployAnnouncement("compound", { errors: 0, unknown: false }, 5);
  assert.equal(a.headline, "🚀 compound shipped to production");
  assert.equal(a.observeNote, "");
});

test("errors already present surface as a warning, not a verdict", () => {
  const a = buildDeployAnnouncement("compound", { errors: 3, unknown: false }, 2);
  assert.equal(a.headline, "⚠️ compound shipped with errors already in production");
  assert.match(a.scanLine, /3 error logs already in logs/);
  assert.match(a.observeNote, /3 error logs already present\. $/);
});

test("a single already-present error is singular", () => {
  const a = buildDeployAnnouncement("compound", { errors: 1, unknown: false }, 2);
  assert.match(a.scanLine, /1 error log already in logs/);
  assert.doesNotMatch(a.scanLine, /1 error logs/);
});

test("preview deployment URLs are recognized", () => {
  assert.equal(
    isPreviewDeployUrl("https://compound-gluqvc8vg-hassansaab-9511s-projects.vercel.app"),
    true,
  );
  assert.equal(isPreviewDeployUrl("https://compound-kappa-one.vercel.app"), false);
  assert.equal(isPreviewDeployUrl("https://compound-git-fe-13-hassansaab.vercel.app"), true);
});

test("null target + preview URL is not production", () => {
  assert.equal(
    isProductionDeployment({
      project: "compound",
      url: "https://compound-gluqvc8vg-hassansaab-9511s-projects.vercel.app",
    }),
    false,
  );
});

test("explicit production target passes even without canonical hostname env", () => {
  assert.equal(
    isProductionDeployment({
      project: "compound",
      target: "production",
      url: "https://compound-gluqvc8vg-hassansaab-9511s-projects.vercel.app",
    }),
    true,
  );
});

// FE-13 regression: on this Vercel team account the immutable per-deploy URL has
// the same shape as a preview URL, so the URL heuristic must not override an
// explicit `target: "production"`. This exact payload previously returned false
// and froze the pipeline at deploy="running".
test("production target with a preview-shaped immutable URL is production", () => {
  assert.equal(
    isProductionDeployment({
      project: "compound",
      target: "production",
      url: "https://compound-qgu3i27aq-hassansaab-9511s-projects.vercel.app",
    }),
    true,
  );
});

test("preview target is rejected", () => {
  assert.equal(
    isProductionDeployment({
      project: "compound",
      target: "preview",
      url: "https://compound-kappa-one.vercel.app",
    }),
    false,
  );
});

test("extractDeployment reads target from deployment object and branch metadata", () => {
  const dep = extractDeployment({
    type: "deployment.succeeded",
    payload: {
      project: { name: "compound" },
      deployment: {
        url: "compound-gluqvc8vg-hassansaab-9511s-projects.vercel.app",
        target: "preview",
        meta: {
          githubCommitSha: "a2bd84c1234567890",
          githubCommitMessage: "fix(FE-13): fallback to snapshot",
          githubCommitRef: "fix/fe-13",
        },
      },
    },
  });
  assert.equal(dep?.project, "compound");
  assert.equal(dep?.target, "preview");
  assert.equal(dep?.gitBranch, "fix/fe-13");
  assert.equal(dep?.commitSha, "a2bd84c1234567890");
  assert.match(dep?.url ?? "", /compound-gluqvc8vg/);
});
