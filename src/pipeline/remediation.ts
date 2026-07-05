/**
 * Error/latency-triggered remediation stage. Triggered by a Datadog monitor
 * webhook. Conductor announces the alert to Slack (the "what is wrong" beat),
 * then dispatches a remediation cloud agent that diagnoses the slow path and
 * opens a hotfix PR (the "fixing it" beat). The hotfix PR re-enters the loop at
 * review, closing the circle.
 */
import { spawnRemediationAgent, type RemediationAlert } from "./agents.js";
import { deployTargetRepo, markers, observeWindowMs } from "../config.js";
import { datadogServiceUrl } from "../integrations/datadog.js";
import { INITIAL_PIPELINE_CYCLE } from "./cycle.js";
import { findActiveFleet } from "./fleet.js";
import { verifyWindowElapsed } from "./verify.js";
import { hasComment } from "../integrations/linear.js";
import { postSlack, statusBlocks } from "../integrations/slack.js";
import type { JobSummary } from "../types.js";

/** Datadog recovery/success notifications should not trigger remediation. */
function isRecovery(alertType: string | undefined): boolean {
  const t = (alertType ?? "").toLowerCase();
  return t === "success" || t === "recovery" || t === "no data" || t === "ok";
}

/** Datadog `alert_type` values that represent a *firing* alert (vs. recovery/info/empty). */
const FIRING_ALERT_TYPES = new Set(["error", "warning", "alert"]);

/**
 * True only when the payload looks like a real, actionable latency alert. Guards
 * against malformed deliveries — e.g. a POST with the right `?secret=` but no/odd
 * `Content-Type` leaves `req.body={}`, which `extractAlert` would otherwise turn
 * into a default-titled "alert" and dispatch a (paid) remediation agent.
 *
 * Recognized when EITHER a known firing `alert_type` is present, OR the title/route
 * matches the latency surface (the quotes-check route). The real Datadog custom
 * payload satisfies both (it carries `alert_type:"error"` and the hardcoded route).
 */
export function isDispatchableAlert(alert: RemediationAlert, alertType: string | undefined): boolean {
  const type = (alertType ?? "").toLowerCase().trim();
  if (FIRING_ALERT_TYPES.has(type)) return true;
  const haystack = `${alert.route ?? ""} ${alert.title ?? ""}`.toLowerCase();
  return haystack.includes("quotes-check") || haystack.includes("/api/market/") || haystack.includes("latency");
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

/**
 * Per-instance guard against two near-simultaneous alerts both passing the
 * read-before-write `remediated` check and double-dispatching. Mirrors the build
 * path's `activeIssues` set in fleet.ts. In-memory, so it covers the concurrent
 * window within one warm instance; the durable `remediated` marker covers repeats
 * across instances/cold starts.
 */
const remediatingIssues = new Set<string>();

/** A pure gate decision for a matched (or unmatched) fleet. */
export type FleetDispatchDecision = { dispatch: true } | { dispatch: false; reason: string };

/**
 * A deployed fleet is eligible for remediation until its hotfix is dispatched,
 * *independent of the functional verify verdict*. The verify agent checks that
 * the feature works; a Datadog latency alert reports that it is slow. Those are
 * orthogonal signals, so a clean functional verify must not close the remediation
 * window — otherwise a genuine performance regression that ships, passes the test
 * plan, and only surfaces under production load could never be remediated. The
 * post-deploy observe window (see {@link handleDatadogAlert}) bounds how long a
 * fleet stays eligible so happy-path tickets stop matching once it elapses.
 */
export function isRemediable(job: JobSummary): boolean {
  return job.stages.deploy === "done" && job.stages.remediate === "pending";
}

/**
 * Decides whether to dispatch a remediation agent given the matched fleet's
 * state. Returns `dispatch:false` when there is no matching fleet — without a
 * fleet there is no issue to carry the `remediated` idempotency marker, so
 * spawning would be unbounded across repeated alerts — when the post-deploy
 * observe window has already elapsed, or when remediation was already dispatched
 * / is already in flight. Pure, so it is unit-tested.
 */
export function shouldDispatchToFleet(input: {
  hasFleet: boolean;
  withinWindow: boolean;
  alreadyRemediated: boolean;
  inFlight: boolean;
}): FleetDispatchDecision {
  if (!input.hasFleet) {
    return { dispatch: false, reason: "no deployed fleet awaiting remediation; not dispatching" };
  }
  if (!input.withinWindow) {
    return { dispatch: false, reason: "post-deploy observe window elapsed; not dispatching" };
  }
  if (input.alreadyRemediated) {
    return { dispatch: false, reason: "remediation already dispatched for this fleet" };
  }
  if (input.inFlight) {
    return { dispatch: false, reason: "remediation already in flight for this fleet" };
  }
  return { dispatch: true };
}

/** Handles one Datadog monitor webhook end to end. Idempotent per fleet via the `remediated` marker. */
export async function handleDatadogAlert(body: unknown): Promise<RemediationResult> {
  const { alert, alertType } = extractAlert(body);
  if (isRecovery(alertType)) return { handled: false, reason: `ignoring ${alertType} notification` };

  // Reject malformed/empty payloads before the (paid) dispatch path. The HTTP
  // layer in index.ts has already replied 202, so an unrecognized body is simply
  // ignored rather than treated as a real latency alert.
  if (!isDispatchableAlert(alert, alertType)) {
    return { handled: false, reason: "ignoring unrecognized or empty Datadog payload" };
  }

  // Attach to the deployed fleet still awaiting remediation, bounded by its
  // post-deploy observe window. This is deliberately decoupled from the verify
  // stage: a latency alert must still remediate even after the functional verify
  // test plan has passed, because the regression is slow, not broken. The observe
  // window (measured from the deploy/verify-agent marker) stops happy-path tickets
  // from matching stray alerts once it elapses.
  const issue = await findActiveFleet(isRemediable);
  const withinWindow =
    !!issue && !verifyWindowElapsed(issue, Date.now(), observeWindowMs(), INITIAL_PIPELINE_CYCLE);
  // The has()→add() check-and-set below is synchronous (no await between them),
  // so concurrent invocations on one instance can't both pass the in-flight gate.
  const decision = shouldDispatchToFleet({
    hasFleet: !!issue,
    withinWindow,
    alreadyRemediated: !!(issue && hasComment(issue, markers.remediated)),
    inFlight: !!(issue && remediatingIssues.has(issue.id)),
  });
  if (!decision.dispatch || !issue) return { handled: false, reason: decision.dispatch ? "no matching fleet" : decision.reason };
  remediatingIssues.add(issue.id);

  try {
    // Beat 1: announce the problem.
    await postSlack(
      statusBlocks(`⚠️ Latency detected on ${deployTargetRepo}`, [
        `Monitor: ${alert.title}`,
        alert.route ? `Slow route: ${alert.route}` : "",
        alert.observedMs ? `Observed: ${alert.observedMs}ms` : "",
        `Ticket: ${issue.identifier} — ${issue.title}`,
        `Dispatching a remediation agent to open a hotfix PR…`,
        `Datadog: ${datadogServiceUrl(deployTargetRepo)}`,
      ].filter(Boolean)),
    );

    // Beat 2: dispatch the agent (posts the remediation markers to the issue).
    const agentId = await spawnRemediationAgent({ ...alert, issue });
    if (!agentId) return { handled: false, reason: "failed to spawn remediation agent" };
    return { handled: true, agentId };
  } finally {
    remediatingIssues.delete(issue.id);
  }
}
