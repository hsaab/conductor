/**
 * Post-install guard: confirm @cursor/sdk actually imports.
 *
 * @cursor/sdk loads its native dependency sqlite3 at import time. If the package
 * manager skips sqlite3's build script, the import throws "Could not locate the
 * bindings file" and the planner silently degrades to its fallback ("Planner
 * unavailable") instead of failing loudly. That build gate has regressed several
 * times because each pnpm major configures build scripts differently (the
 * allowlist lives in pnpm-workspace.yaml).
 *
 * Conductor deploys via @vercel/node with no build/test step, so `pnpm install`
 * is the only stage Vercel always runs. Hooking this check to `postinstall`
 * converts a silent, runtime-only degradation into an obvious install failure on
 * every surface — local and Vercel — without needing CI. A healthy install is a
 * fast no-op.
 */
try {
  await import("@cursor/sdk");
  console.log("verify-sdk: @cursor/sdk imported OK (sqlite3 build gate intact).");
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    [
      "",
      "verify-sdk: FAILED to import @cursor/sdk.",
      "Its native dependency sqlite3 was not built, so the planner would silently",
      'fall back to "Planner unavailable" at runtime. This is a build-gate',
      "regression — confirm pnpm-workspace.yaml allow-builds sqlite3 for your pnpm",
      "major (9/10/11), then reinstall.",
      "",
      `Underlying error: ${detail}`,
      "",
    ].join("\n"),
  );
  process.exit(1);
}
