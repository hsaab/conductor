/**
 * Post-install guard for @cursor/sdk, with self-heal.
 *
 * @cursor/sdk loads its native dependency sqlite3 at import time. If the package
 * manager skipped sqlite3's build script, the import throws "Could not locate the
 * bindings file" and the planner silently degrades to its fallback ("Planner
 * unavailable") at runtime. The build-script allowlist (pnpm-workspace.yaml /
 * package.json `pnpm.onlyBuiltDependencies`) is honored by the local pnpm, but on
 * Vercel's pnpm it was NOT — so sqlite3 never built and this guard failed every
 * deploy.
 *
 * Conductor deploys via @vercel/node with no build/test step, so `pnpm install`
 * (which runs this postinstall) is the one stage Vercel always runs. Rather than
 * only failing loudly, this guard now SELF-HEALS: if the import fails it forces a
 * `pnpm rebuild sqlite3` (an explicit rebuild bypasses the install-time build-script
 * gate) and re-checks. Only a rebuild that still can't produce a working binding
 * fails the install. A healthy install is a fast no-op.
 *
 * The re-check runs in a fresh subprocess because a failed dynamic import is cached
 * within this process, so an in-process retry would keep seeing the stale failure.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const SDK = "@cursor/sdk";

/** Import the SDK in-process (fast path for an already-healthy install). */
async function importsInProcess() {
  try {
    await import(SDK);
    return true;
  } catch {
    return false;
  }
}

/** Import the SDK in a fresh process, so a cached failed import can't mask a fix. */
function importsInFreshProcess() {
  try {
    execSync(`node --input-type=module -e "await import('${SDK}')"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Every installed sqlite3 package dir under the pnpm store (usually exactly one). */
function findSqlite3Dirs() {
  const store = path.join("node_modules", ".pnpm");
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((entry) => entry.startsWith("sqlite3@"))
    .map((entry) => path.join(store, entry, "node_modules", "sqlite3"))
    .filter((dir) => existsSync(path.join(dir, "package.json")));
}

if (await importsInProcess()) {
  console.log("verify-sdk: @cursor/sdk imported OK (sqlite3 build gate intact).");
  process.exit(0);
}

console.warn(
  "verify-sdk: @cursor/sdk failed to import — sqlite3's native binding was not built " +
    "(the install-time build-script gate skipped it). Building it directly...",
);
const sqlite3Dirs = findSqlite3Dirs();
if (sqlite3Dirs.length === 0) {
  console.warn("verify-sdk: could not locate an installed sqlite3 package under node_modules/.pnpm.");
}
for (const dir of sqlite3Dirs) {
  try {
    // Run sqlite3's own install script (prebuild-install -r napi || node-gyp rebuild)
    // via npm. npm does not apply pnpm's onlyBuiltDependencies gate, so this builds
    // the binding even on a host whose pnpm skipped it (e.g. Vercel). `pnpm rebuild`
    // is NOT used here: it honors the same gate and would no-op.
    execSync("npm run install", { cwd: dir, stdio: "inherit" });
  } catch (err) {
    console.warn(`verify-sdk: building sqlite3 in ${dir} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (importsInFreshProcess()) {
  console.log("verify-sdk: recovered — @cursor/sdk imports after building sqlite3.");
  process.exit(0);
}

console.error(
  [
    "",
    "verify-sdk: FAILED to import @cursor/sdk even after rebuilding sqlite3.",
    "Its native dependency sqlite3 could not be built on this platform, so the planner",
    'would fall back to "Planner unavailable" at runtime. Confirm the build host can run',
    "sqlite3's prebuild-install / node-gyp (network access + build toolchain).",
    "",
  ].join("\n"),
);
process.exit(1);
