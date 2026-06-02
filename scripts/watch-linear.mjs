#!/usr/bin/env node
/**
 * Temporary non-admin trigger for the demo.
 *
 * Watches Linear for issues labeled `cursor-fleet` in `In Progress`, then calls
 * the deployed bridge's secured /api/trigger endpoint. Once a real Linear
 * webhook is registered, stop running this script; the bridge code path is the
 * same after the issue is normalized.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fleetPrUrlRe = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

const linearKey = process.env.LINEAR_API_KEY;
const bridgeUrl = (process.env.BRIDGE_URL ?? "http://localhost:3001").replace(/\/$/, "");
const triggerSecret = process.env.BRIDGE_TRIGGER_SECRET;
const labelName = process.env.LINEAR_TRIGGER_LABEL ?? "cursor-fleet";
const stateName = process.env.LINEAR_TRIGGER_STATE ?? "In Progress";
const intervalMs = Number(process.env.LINEAR_POLL_INTERVAL_MS ?? 3000);
// How often to ask the bridge to reconcile finished agents -> PR URLs. Decoupled
// from the poll interval so we don't hammer the Cursor API every few seconds.
const reconcileIntervalMs = Number(process.env.LINEAR_RECONCILE_INTERVAL_MS ?? 15000);
const marker = "<!-- cursor-demo-bridge:fleet-started -->";
const triggeredIssueIds = new Set();
let lastReconcileAt = 0;

if (!linearKey || !triggerSecret) {
  console.error("Set LINEAR_API_KEY and BRIDGE_TRIGGER_SECRET");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: linearKey },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    const message = json.errors?.map((err) => err.message).join("; ") || res.statusText;
    throw new Error(`Linear GraphQL failed: ${message}`);
  }
  return json.data;
}

function hasMarker(issue) {
  return issue.comments.nodes.some((comment) => comment.body?.includes(marker));
}

async function findCandidates() {
  const data = await gql(
    `query CursorFleetCandidates($label: String!, $state: String!) {
      issues(
        first: 20
        filter: {
          state: { name: { eq: $state } }
          labels: { some: { name: { eq: $label } } }
        }
      ) {
        nodes {
          id
          identifier
          title
          url
          state { name }
          labels { nodes { name } }
          comments(first: 50) { nodes { body } }
        }
      }
    }`,
    { label: labelName, state: stateName },
  );
  return data.issues.nodes.filter((issue) => !hasMarker(issue) && !triggeredIssueIds.has(issue.id));
}

async function triggerIssue(issue) {
  const res = await fetch(`${bridgeUrl}/api/trigger`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${triggerSecret}`,
    },
    body: JSON.stringify({ issueId: issue.id, source: "linear-poller" }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${JSON.stringify(json)}`);
  triggeredIssueIds.add(issue.id);
  console.log(
    `[watch-linear] ${issue.identifier}: ${json.queued ? "queued Cursor fleet" : `skipped (${json.reason})`}`,
  );
}

async function pollOnce() {
  const candidates = await findCandidates();
  for (const issue of candidates) {
    console.log(`[watch-linear] triggering ${issue.identifier}: ${issue.title}`);
    await triggerIssue(issue);
  }
}

// Fleet-labeled issues that already have the marker but have left "In Progress".
// Dragging a ticket out is the signal to re-arm it for a fresh demo run.
async function findStaleFleets() {
  const data = await gql(
    `query StaleFleets($label: String!) {
      issues(first: 25, filter: { labels: { some: { name: { eq: $label } } } }) {
        nodes { id identifier state { name } comments(first: 50) { nodes { body } } }
      }
    }`,
    { label: labelName },
  );
  return data.issues.nodes.filter((issue) => hasMarker(issue) && issue.state?.name !== stateName);
}

function parseFleetPrs(issue) {
  const seen = new Set();
  const prs = [];
  for (const comment of issue.comments.nodes) {
    const body = comment.body ?? "";
    if (!body.includes("agent finished")) continue;
    const match = body.match(fleetPrUrlRe);
    if (!match) continue;
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    prs.push({
      owner: match[1],
      repo: match[2],
      number: Number(match[3]),
      role: /hero/i.test(body) ? "hero" : "chorus",
      url,
    });
  }
  return prs;
}

async function closeFleetPrs(identifier, prs) {
  if (prs.length < 2) return;
  const keep = prs.find((pr) => pr.role === "hero") ?? prs[0];
  let closed = 0;
  for (const pr of prs) {
    if (pr.url === keep.url) continue;
    try {
      await execFileAsync("gh", [
        "pr",
        "close",
        String(pr.number),
        "--repo",
        `${pr.owner}/${pr.repo}`,
        "--delete-branch",
      ]);
      closed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `[watch-linear] could not close ${pr.owner}/${pr.repo}#${pr.number}: ${message}`,
      );
    }
  }
  console.log(
    `[watch-linear] ${identifier}: closed ${closed} PR(s), kept ${keep.owner}/${keep.repo}#${keep.number}`,
  );
}

async function resetStaleOnce() {
  const stale = await findStaleFleets();
  for (const issue of stale) {
    await closeFleetPrs(issue.identifier, parseFleetPrs(issue));
    const res = await fetch(`${bridgeUrl}/api/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${triggerSecret}` },
      body: JSON.stringify({ issueId: issue.id }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${JSON.stringify(json)}`);
    triggeredIssueIds.delete(issue.id);
    console.log(
      `[watch-linear] re-armed ${issue.identifier} (now "${issue.state?.name}") — cleared ${json.clearedComments ?? 0} comment(s)`,
    );
  }
}

// Ask the bridge to report finished agents (PR URLs) back to Linear. The bridge
// can't block on agent completion inside a serverless request, so completion is
// reconciled out-of-band; on Hobby plans this poller is the fast driver.
async function reconcileOnce() {
  const res = await fetch(`${bridgeUrl}/api/reconcile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${triggerSecret}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${JSON.stringify(json)}`);
  if (json.agentsCompleted || json.fleetsCompleted) {
    console.log(
      `[watch-linear] reconcile: ${json.agentsCompleted} agent(s) finished, ${json.fleetsCompleted} fleet(s) complete`,
    );
  }
}

async function main() {
  console.log(
    `[watch-linear] watching Linear label="${labelName}" state="${stateName}" -> ${bridgeUrl}/api/trigger`,
  );
  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      console.error("[watch-linear]", err);
    }
    try {
      await resetStaleOnce();
    } catch (err) {
      console.error("[watch-linear] reset", err);
    }
    if (Date.now() - lastReconcileAt >= reconcileIntervalMs) {
      lastReconcileAt = Date.now();
      try {
        await reconcileOnce();
      } catch (err) {
        console.error("[watch-linear] reconcile", err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main();
