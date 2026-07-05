/**
 * Turns an issue's conductor-authored Linear comments into a chronological
 * activity feed for the mission-control dashboard.
 *
 * The comment thread is already conductor's state store, so the same comments
 * that drive stage state double as a human-readable log of what each step did
 * and when. This module is pure (no network), so it is unit-testable alongside
 * {@link summarizeJob}.
 */
import { isBridgeComment } from "../integrations/linear.js";
import type { JobEvent, LinearIssuePayload } from "../types.js";

/** Matches the hidden HTML-comment markers so only human-readable text remains. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Maps a comment to the pipeline stage it belongs to so the dashboard can
 * color-code each log line. Keyed off the hidden markers (and a couple of text
 * signatures) rather than the visible copy, so it stays stable if wording
 * changes. Order matters: more specific markers are checked first.
 */
function inferStage(body: string): string | undefined {
  // Hotfix-cycle markers map to the looped-back stage they advance, so the log
  // reads as the second pass through review → deploy → verify.
  if (/conductor:hotfix-verify/.test(body)) return "verify";
  if (/conductor:hotfix-deployed/.test(body)) return "deploy";
  if (/conductor:hotfix-merged/.test(body)) return "review";
  if (/conductor:remediation-done|conductor:remediation-agent|conductor:remediated/.test(body)) {
    return "remediate";
  }
  if (/conductor:verify-pass|conductor:verify-fail|conductor:verify-findings|conductor:verify-agent/.test(body)) {
    return "verify";
  }
  if (/conductor:observe-complete/.test(body)) return "verify";
  if (/conductor:verified/.test(body)) return "verify";
  if (/conductor:deployed/.test(body)) return "deploy";
  if (/conductor:merged/.test(body)) return "review";
  if (/conductor:test-plan|Test plan/i.test(body)) return "plan";
  if (/conductor:fleet-complete|conductor:agent-done/.test(body)) return "build";
  if (/agent spawned|agent failed to start/i.test(body)) return "build";
  if (/conductor:fleet-started|Planner chose/i.test(body)) return "plan";
  return undefined;
}

/** Reduces a single markdown line to the plain text shown in the log feed. */
function cleanLine(line: string): string {
  return line
    .replace(/^[-*]\s+/, "") // list bullets
    .replace(/\*\*/g, "") // bold
    .replace(/`/g, "") // inline code
    .trim();
}

/**
 * Strips conductor's hidden markers from a comment body and returns its
 * human-readable lines: the first becomes the headline, the rest the detail.
 */
function readableLines(body: string): string[] {
  return body
    .replace(HTML_COMMENT_RE, "")
    .split("\n")
    .map(cleanLine)
    .filter(Boolean);
}

/**
 * Builds the chronological activity log for one issue from its conductor
 * comments. Non-conductor comments and marker-only comments (no visible text)
 * are skipped. Sorted oldest-first so the dashboard reads top to bottom.
 */
export function parseEvents(issue: LinearIssuePayload): JobEvent[] {
  const events: JobEvent[] = [];
  for (const comment of issue.comments ?? []) {
    const body = comment.body ?? "";
    if (!isBridgeComment(body)) continue;
    const lines = readableLines(body);
    if (lines.length === 0) continue;
    const [message, ...rest] = lines;
    events.push({
      at: comment.createdAt,
      message,
      detail: rest.join(" · ") || undefined,
      stage: inferStage(body),
    });
  }
  return events.sort((a, b) => Date.parse(a.at ?? "0") - Date.parse(b.at ?? "0"));
}
