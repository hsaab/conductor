/**
 * Error/latency-triggered remediation stage. Triggered by a Datadog monitor
 * webhook. Conductor announces the alert to Slack (the "what is wrong" beat),
 * then dispatches a remediation cloud agent that diagnoses the slow path and
 * opens a hotfix PR (the "fixing it" beat). The hotfix PR re-enters the loop at
 * review, closing the circle.
 */
import { spawnRemediationAgent, type RemediationAlert } from "./agents.js";
import { deployTargetRepo, markers } from "./config.js";
import { datadogServiceUrl } from "./datadog.js";
import { findActiveFleet } from "./fleet.js";
import { hasComment } from "./linear.js";
import { postSlack, statusBlocks } from "./slack.js";

/** Datadog recovery/success notifications should not trigger remediation. */
function isRecovery(alertType: string | undefined): boolean {
  const t = (alertType ?? "").toLowerCase();
  return t === "success" || t === "recovery" || t === "no data" || t === "ok";
}

/** Tolerantly extracts the fields conductor needs from a templated Datadog webhook body. */
export function extractAlert(body: any): { alert: RemediationAlert; alertType?: string } {
  const b = body ?? {};
  const title = b.title ?? b.alert_title ?? b.event_title ?? "Datadog monitor alert";
  const message = b.body ?? b.message ?? b.event_msg ?? b.alert_msg ?? undefined;
  const route = b.route ?? b.resource ?? b.endpoint ?? undefined;
  const observedRaw = b.observed_ms ?? b.value ?? b.observed ?? undefined;
  const observedMs = observedRaw != null && !Number.isNaN(Number(observedRaw)) ? Number(observedRaw) : undefined;
  const alertType = b.alert_type ?? b.alertType ?? b.event_type ?? undefined;
  return { alert: { title: String(title), body: message ? String(message) : undefined, route, observedMs }, alertType };
}

export interface RemediationResult {
  handled: boolean;
  reason?: string;
  agentId?: string;
}

/** Handles one Datadog monitor webhook end to end. Idempotent per fleet via the `remediated` marker. */
export async function handleDatadogAlert(body: unknown): Promise<RemediationResult> {
  const { alert, alertType } = extractAlert(body);
  if (isRecovery(alertType)) return { handled: false, reason: `ignoring ${alertType} notification` };

  // Attach to the live fleet that has deployed but not yet been remediated.
  const issue = await findActiveFleet((job) => job.stages.deploy === "done" && job.stages.remediate === "pending");
  if (issue && hasComment(issue, markers.remediated)) {
    return { handled: false, reason: "remediation already dispatched for this fleet" };
  }

  // Beat 1: announce the problem.
  await postSlack(
    statusBlocks(`⚠️ Latency detected on ${deployTargetRepo}`, [
      `Monitor: ${alert.title}`,
      alert.route ? `Slow route: ${alert.route}` : "",
      alert.observedMs ? `Observed: ${alert.observedMs}ms` : "",
      issue ? `Ticket: ${issue.identifier} — ${issue.title}` : "Ticket: (unmatched)",
      `Dispatching a remediation agent to open a hotfix PR…`,
      `Datadog: ${datadogServiceUrl(deployTargetRepo)}`,
    ].filter(Boolean)),
  );

  // Beat 2: dispatch the agent (posts the remediation markers to the issue).
  const agentId = await spawnRemediationAgent({ ...alert, issue: issue ?? undefined });
  if (!agentId) return { handled: false, reason: "failed to spawn remediation agent" };
  return { handled: true, agentId };
}
