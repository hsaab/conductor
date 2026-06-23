/**
 * HTTP surface for the Linear ↔ Cursor bridge.
 *
 * Routes:
 *  - GET  /              mission-control dashboard (public, read-only)
 *  - GET  /api/health     liveness probe
 *  - GET  /api/board      public read-only fleet status for the dashboard
 *  - GET  /api/jobs       secured read-only view of in-progress fleets
 *  - GET  /api/jobs/:id   single launched fleet by Linear identifier
 *  - POST /api/trigger    secured manual fallback for the Linear webhook
 *  - POST /api/reset      secured re-arm (clears bridge comments + reaction)
 *  - GET  /api/reconcile   cron-driven completion sweep (posts PR URLs to Linear)
 *  - POST /webhook/linear  Linear webhook (signature-verified)
 *  - POST /webhook/vercel  Vercel deployment webhook -> observability agent
 *  - POST /webhook/datadog Datadog monitor webhook -> remediation agent
 *
 * Spawning is fast and synchronous-ish; completion is handled out-of-band by the
 * reconciler so no request ever blocks on a multi-minute agent run.
 */
import express from "express";
import { waitUntil } from "@vercel/functions";

// Express's Request/Response types resolve inconsistently inside the
// @vercel/node builder (it reports `.status`/`.get` as missing even though they
// exist), so route handlers use loose aliases — matching the original bridge —
// to keep the production build clean. Runtime behavior is unaffected.
type Req = any;
type Res = any;
import { markers, triggerLabel, triggerState } from "./config.js";
import { dashboardHtml } from "./dashboard.js";
import { fetchIssue, hasComment, normalizeIssue } from "./linear.js";
import { getJob, listJobs, reconcileAll, reconcileTick, resetIssue, shouldSpawn, triggerFleet } from "./fleet.js";
import { handleVercelDeployment } from "./observability.js";
import { handleDatadogAlert } from "./remediation.js";
import {
  isAuthorizedDatadog,
  isAuthorizedReconcile,
  isAuthorizedTrigger,
  isAuthorizedVercel,
  verifyLinearSignature,
} from "./security.js";
import type { LinearIssuePayload } from "./types.js";

/** Best-effort, per-instance dedupe of webhook redeliveries. */
const seenDeliveries = new Set<string>();

async function handleWebhook(payload: {
  action: string;
  type: string;
  data: LinearIssuePayload;
}): Promise<void> {
  const identifier = payload.data?.identifier ?? payload.data?.id ?? "unknown";
  console.log(`[webhook] Linear delivered a ${payload.type}.${payload.action} event for ${identifier}`);

  if (payload.type !== "Issue" || payload.action !== "update") {
    console.log(`[webhook] Ignoring ${identifier}: only Issue updates can start a fleet (got ${payload.type}.${payload.action})`);
    return;
  }

  const webhookIssue = normalizeIssue(payload.data);
  const incomingState = webhookIssue.state?.name ?? "unknown";
  console.log(
    `[webhook] Ticket ${webhookIssue.identifier} "${webhookIssue.title}" was updated (state is now "${incomingState}")`,
  );

  const isFleetLabeled = webhookIssue.labels?.some((l) => l.name === triggerLabel) ?? false;
  if (!isFleetLabeled) {
    console.log(
      `[webhook] Ignoring ${webhookIssue.identifier}: ticket is not labeled "${triggerLabel}", so the bridge stays out of it`,
    );
    return;
  }
  console.log(`[webhook] ${webhookIssue.identifier} is labeled "${triggerLabel}" — this ticket is ours to handle`);

  // Hydrate from the API so labels/comments/state reflect current truth.
  let issue = webhookIssue;
  try {
    issue = (await fetchIssue(webhookIssue.id)) ?? webhookIssue;
  } catch (err) {
    console.error("[webhook] could not hydrate Linear issue:", err);
  }

  const stateName = issue.state?.name ?? "unknown";
  if (shouldSpawn(issue)) {
    console.log(
      `[webhook] ${issue.identifier} is in "${triggerState}" — handing off to the fleet launcher`,
    );
    const result = await triggerFleet(issue, "linear-webhook");
    if (!result.queued && result.reason) {
      console.log(`[webhook] No fleet launched for ${issue.identifier}: ${result.reason}`);
    }
    return;
  }

  if (hasComment(issue, markers.fleetStarted)) {
    // Ticket left "In Progress" carrying an active fleet record: re-arm it so a
    // future move back into "In Progress" launches a fresh fleet.
    console.log(
      `[webhook] ${issue.identifier} left "${triggerState}" (now "${stateName}") — re-arming it for a fresh run next time`,
    );
    await resetIssue(issue.id);
    console.log(`[webhook] ${issue.identifier} re-armed: cleared the 🚀 reaction and bridge comments`);
    return;
  }

  console.log(
    `[webhook] Nothing to do for ${issue.identifier}: it is in "${stateName}", not "${triggerState}"`,
  );
}

const app = express();

// Mission-control dashboard (public, read-only). Screen-shared during the demo
// so the wait for cloud agents becomes part of the show.
app.get("/", (_req: Req, res: Res) => {
  res.status(200).set("Content-Type", "text/html; charset=utf-8").send(dashboardHtml);
});

app.get("/api/health", (_req: Req, res: Res) => res.status(200).json({ ok: true }));

// Public, read-only data source for the dashboard. Same Linear-derived shape as
// /api/jobs but unauthenticated so the page can poll it without exposing a secret
// in the browser. Returns only non-sensitive pipeline state (no keys/tokens).
app.get("/api/board", async (req: Req, res: Res) => {
  try {
    const includeComplete = req.query.all === "1" || req.query.all === "true";
    const report = await listJobs({ includeComplete });
    res.status(200).set("Cache-Control", "no-store").json({ ok: true, ...report });

    // Let the dashboard's own polling advance the pipeline: opportunistically
    // reconcile finished cloud runs (build/remediation completion) so the board
    // moves through the stages without a manual reconcile loop. Throttled and
    // deduped in reconcileTick, and run after the response so the board stays fast.
    const tick = reconcileTick();
    if (tick) {
      waitUntil(tick.catch((err) => console.error("[board] reconcile tick failed:", err)));
    }
  } catch (err) {
    console.error("[board] failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// Read-only snapshot of launched fleets, reconstructed from Linear comments
// (no Cursor SDK calls, no mutation). In-progress only by default; pass
// `?all=1` to include completed fleets. Authorized like /api/trigger.
app.get("/api/jobs", async (req: Req, res: Res) => {
  if (!isAuthorizedTrigger(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const includeComplete = req.query.all === "1" || req.query.all === "true";
    const report = await listJobs({ includeComplete });
    return res.status(200).json({ ok: true, ...report });
  } catch (err) {
    console.error("[jobs] failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// Single launched fleet by Linear identifier (e.g. /api/jobs/ENG-7). Same auth
// and Linear-derived shape as /api/jobs; 404 when no fleet has launched for it.
app.get("/api/jobs/:identifier", async (req: Req, res: Res) => {
  if (!isAuthorizedTrigger(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const job = await getJob(req.params.identifier);
    if (!job) return res.status(404).json({ error: `no launched fleet for ${req.params.identifier}` });
    return res.status(200).json({ ok: true, generatedAt: new Date().toISOString(), job });
  } catch (err) {
    console.error("[jobs] failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.post("/api/trigger", express.json(), async (req: Req, res: Res) => {
  if (!isAuthorizedTrigger(req)) return res.status(401).json({ error: "unauthorized" });

  const issueId = req.body?.issueId ?? req.body?.identifier ?? req.body?.id;
  if (typeof issueId !== "string" || issueId.trim().length === 0) {
    return res.status(400).json({ error: "issueId, identifier, or id is required" });
  }

  const source = typeof req.body?.source === "string" ? req.body.source : "manual-trigger";
  try {
    const issue = await fetchIssue(issueId.trim());
    if (!issue) return res.status(404).json({ error: `Linear issue not found: ${issueId}` });
    if (!shouldSpawn(issue)) {
      return res.status(202).json({ ok: true, queued: false, reason: "issue does not match trigger filters" });
    }
    if (hasComment(issue, markers.fleetStarted)) {
      return res.status(202).json({ ok: true, queued: false, reason: "fleet already started for this issue" });
    }

    res.status(202).json({ ok: true, queued: true, issue: issue.identifier });
    waitUntil(
      triggerFleet(issue, source).catch((err) => console.error("[trigger] handler error:", err)),
    );
  } catch (err) {
    console.error("[trigger] failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// Re-arms an issue (clears the bridge's comments + reaction) so dragging it
// back into "In Progress" launches a fresh fleet. Authorized like /api/trigger.
app.post("/api/reset", express.json(), async (req: Req, res: Res) => {
  if (!isAuthorizedTrigger(req)) return res.status(401).json({ error: "unauthorized" });
  const issueId = req.body?.issueId ?? req.body?.id;
  if (typeof issueId !== "string" || issueId.trim().length === 0) {
    return res.status(400).json({ error: "issueId or id is required" });
  }
  try {
    const result = await resetIssue(issueId.trim());
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[reset] failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// GET for Vercel Cron (daily backstop); POST for manual demo reconcile.
// Both authenticate via {@link isAuthorizedReconcile}.
app.all("/api/reconcile", async (req: Req, res: Res) => {
  if (!isAuthorizedReconcile(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const summary = await reconcileAll();
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error("[reconcile] failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.post("/webhook/linear", express.raw({ type: "*/*" }), (req: Req, res: Res) => {
  const delivery = req.headers["linear-delivery"] as string | undefined;
  const rawBody = req.body as Buffer;
  if (!verifyLinearSignature(rawBody, req.headers["linear-signature"] as string | undefined)) {
    console.error("[webhook] signature verification failed");
    return res.status(401).json({ error: "invalid signature" });
  }
  if (delivery && seenDeliveries.has(delivery)) {
    return res.status(200).json({ ok: true, deduped: true });
  }
  if (delivery) seenDeliveries.add(delivery);
  console.log("[webhook] signature verified");
  res.status(200).json({ ok: true });
  waitUntil(
    handleWebhook(JSON.parse(rawBody.toString())).catch((err) =>
      console.error("[webhook] handler error:", err),
    ),
  );
});

// Vercel deployment webhook. On a successful production deploy of the target
// project, conductor verifies health and announces to Slack (observability stage).
app.post("/webhook/vercel", express.json({ limit: "1mb" }), (req: Req, res: Res) => {
  if (!isAuthorizedVercel(req)) return res.status(401).json({ error: "unauthorized" });
  const type = req.body?.type ?? "(none)";
  if (type !== "deployment.succeeded") {
    return res.status(200).json({ ok: true, ignored: `event ${type}` });
  }
  res.status(202).json({ ok: true });
  waitUntil(
    handleVercelDeployment(req.body)
      .then((r) => console.log(`[webhook/vercel] ${r.handled ? "handled" : "skipped"}${r.reason ? `: ${r.reason}` : ""}`))
      .catch((err) => console.error("[webhook/vercel] handler error:", err)),
  );
});

// Datadog monitor webhook. On a production alert (latency/errors), conductor
// spawns the remediation agent to diagnose and open a hotfix PR.
app.post("/webhook/datadog", express.json({ limit: "1mb" }), (req: Req, res: Res) => {
  if (!isAuthorizedDatadog(req)) return res.status(401).json({ error: "unauthorized" });
  res.status(202).json({ ok: true });
  waitUntil(
    handleDatadogAlert(req.body)
      .then((r) => console.log(`[webhook/datadog] ${r.handled ? "handled" : "skipped"}${r.reason ? `: ${r.reason}` : ""}`))
      .catch((err) => console.error("[webhook/datadog] handler error:", err)),
  );
});

export default app;

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`conductor listening on :${port}`));
}
