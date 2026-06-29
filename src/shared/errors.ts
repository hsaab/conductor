/** Error-formatting helpers shared across the pipeline. */

/**
 * Condensed, single-line error text safe to surface in a Linear comment or log.
 *
 * Works whether the error is an `Error` (prefers its message, then its name) or
 * a raw throw — notably an `@cursor/sdk` import failure when its native `sqlite3`
 * binding is missing on the deploy target. Collapses whitespace and truncates to
 * `maxLength` with an ellipsis so a giant stack never floods a Linear comment.
 */
export function oneLineError(err: unknown, maxLength = 300): string {
  const raw = err instanceof Error ? err.message || err.name : String(err);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 3)}…` : oneLine;
}
