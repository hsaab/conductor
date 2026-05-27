import crypto from "node:crypto";
import express from "express";
import { waitUntil } from "@vercel/functions";

type AgentRole = "hero" | "chorus";

interface LinearIssuePayload {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  labels?: Array<{ name: string }>;
  state?: { name: string };
}

const ghOwner = process.env.GH_OWNER ?? "hsaab";
const cursorKey = () => process.env.CURSOR_API_KEY ?? "";
const linearKey = () => process.env.LINEAR_API_KEY ?? "";
const webhookSecret = () => process.env.LINEAR_WEBHOOK_SECRET ?? "";
const seenDeliveries = new Set<string>();

function buildPrompt(issue: LinearIssuePayload, role: AgentRole): string {
  const ticket = `# ${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}`;
  if (role === "hero") {
    return `${ticket}\n\n## Role: Hero (compound)\n\nImplement the full ticket in ${ghOwner}/compound:\n- X-Request-ID middleware (read incoming header or generate UUID)\n- AsyncLocalStorage for request-scoped context\n- Structured logger includes requestId on every line\n- Small UI footer showing the current request ID\n- Tests for generated and echoed request IDs\n\nOpen a PR when done.`;
  }
  return `${ticket}\n\n## Role: Chorus (server / Bitwarden)\n\nScoped work in ${ghOwner}/server only:\n- ASP.NET middleware for X-Request-ID (read or generate, echo on response)\n- Serilog enricher via LogContext.PushProperty("RequestId", ...)\n- One xUnit test exercising middleware behavior\n\nNo UI changes. Open a PR when done.`;
}

async function postComment(issueId: string, body: string): Promise<void> {
  const key = linearKey();
  if (!key) return;
  const { LinearClient } = await import("@linear/sdk");
  const linear = new LinearClient({ apiKey: key });
  await linear.createComment({ issueId, body });
}

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = webhookSecret();
  if (!secret || !signature) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(digest, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function shouldSpawn(issue: LinearIssuePayload): boolean {
  const labels = issue.labels?.map((l) => l.name) ?? [];
  return labels.includes("cursor-fleet") && issue.state?.name === "In Progress";
}

async function runAgent(role: AgentRole, issue: LinearIssuePayload): Promise<void> {
  const { Agent, CursorAgentError } = await import("@cursor/sdk");
  const repo = role === "hero" ? "compound" : "server";
  const label = role === "hero" ? "Hero" : "Chorus";
  try {
    await using agent = await Agent.create({
      apiKey: cursorKey(),
      model: { id: "composer-2.5" },
      cloud: {
        repos: [{ url: `https://github.com/${ghOwner}/${repo}` }],
        autoCreatePR: true,
        skipReviewerRequest: true,
      },
    });
    await postComment(
      issue.id,
      `**Cursor ${label} agent spawned**\n\nAgent ID: \`${agent.agentId}\`\nRepo: \`${ghOwner}/${repo}\``,
    );
    console.log(`[${role}] spawned ${agent.agentId} for ${issue.identifier}`);
    const run = await agent.send(buildPrompt(issue, role));
    console.log(`[${role}] run=${run.id}`);
    const result = await run.wait();
    const prUrl = result.git?.branches?.[0]?.prUrl ?? "(no PR URL yet)";
    const status = result.status === "finished" ? "finished" : `**${result.status}**`;
    await postComment(
      issue.id,
      `**Cursor ${label} agent ${status}**\n\nAgent ID: \`${agent.agentId}\`\nPR: ${prUrl}`,
    );
    console.log(`[${role}] done agent=${agent.agentId} pr=${prUrl}`);
    if (result.status === "error") console.error(`[${role}] run error: ${result.id}`);
  } catch (err) {
    const msg = err instanceof CursorAgentError ? `startup failed: ${err.message}` : String(err);
    console.error(`[${role}] ${msg}`);
    await postComment(issue.id, `**Cursor ${label} agent failed**\n\n${msg}`);
  }
}

async function handleWebhook(payload: { action: string; type: string; data: LinearIssuePayload }): Promise<void> {
  if (payload.type !== "Issue" || payload.action !== "update") return;
  const issue = payload.data;
  if (!shouldSpawn(issue)) return;
  console.log(`[webhook] spawning fleet for ${issue.identifier}`);
  await Promise.all([runAgent("hero", issue), runAgent("chorus", issue)]);
}

const app = express();
app.get("/api/health", (_req, res) => res.status(200).json({ ok: true }));

app.post("/webhook/linear", express.raw({ type: "*/*" }), (req, res) => {
  const delivery = req.headers["linear-delivery"] as string | undefined;
  const rawBody = req.body as Buffer;
  if (!verifySignature(rawBody, req.headers["linear-signature"] as string | undefined)) {
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
