/**
 * HTTP surface for the Linear ↔ Cursor bridge.
 *
 * Routes:
 *  - POST /webhook/linear  Linear webhook (signature-verified) — the trigger
 *  - GET  /api/health      liveness probe
 *  - GET  /api/reconcile   cron-driven completion sweep (posts PR URLs to Linear)
 *  - POST /api/trigger     secured manual fallback for the Linear webhook
 *  - POST /api/reset       secured manual re-arm (clears bridge comments + reaction)
 *
 * Moving a labeled ticket into "In Progress" fires the webhook, which spawns the
 * fleet fire-and-forget. Completion is handled out-of-band by the reconciler
 * (Vercel Cron) so no request ever blocks on a multi-minute agent run.
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
import { fetchIssue, hasComment, normalizeIssue } from "./linear.js";
import { reconcileAll, resetIssue, shouldSpawn, triggerFleet } from "./fleet.js";
import { isAuthorizedReconcile, isAuthorizedTrigger, verifyLinearSignature } from "./security.js";
import type { LinearIssuePayload } from "./types.js";

/** Best-effort, per-instance dedupe of webhook redeliveries. */
const seenDeliveries = new Set<string>();

async function handleWebhook(payload: {
  action: string;
  type: string;
  data: LinearIssuePayload;
}): Promise<void> {
  if (payload.type !== "Issue" || payload.action !== "update") return;
  const webhookIssue = normalizeIssue(payload.data);
  const isFleetLabeled = webhookIssue.labels?.some((l) => l.name === triggerLabel) ?? false;
  if (!isFleetLabeled) return;

  // Hydrate from the API so labels/comments/state reflect current truth.
  let issue = webhookIssue;
  try {
    issue = (await fetchIssue(webhookIssue.id)) ?? webhookIssue;
  } catch (err) {
    console.error("[webhook] could not hydrate Linear issue:", err);
  }

  if (shouldSpawn(issue)) {
    const result = await triggerFleet(issue, "linear-webhook");
    if (!result.queued && result.reason) {
      console.log(`[webhook] skipped ${issue.identifier}: ${result.reason}`);
    }
  } else if (hasComment(issue, markers.fleetStarted)) {
    // Ticket left "In Progress" carrying an active fleet record: re-arm it so a
    // future move back into "In Progress" launches a fresh fleet.
    await resetIssue(issue.id);
    console.log(`[webhook] re-armed ${issue.identifier} (left ${triggerState})`);
  }
}

const app = express();

app.get("/api/health", (_req: Req, res: Res) => res.status(200).json({ ok: true }));

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
// back into "In Progress" launches a fresh fleet. Driven by the poller when a
// ticket leaves "In Progress". Authorized like /api/trigger.
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

// GET for Vercel Cron (the daily backstop); POST for the local poller's fast
// driver. Both authenticate via {@link isAuthorizedReconcile}.
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

export default app;

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`cursor-demo-bridge listening on :${port}`));
}
