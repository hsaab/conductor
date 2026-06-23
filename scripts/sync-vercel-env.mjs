#!/usr/bin/env node
/**
 * Sync a local .env file into the Vercel project linked in the current working
 * directory. Idempotent: each non-empty variable is removed (if present) and
 * re-added, so re-running after you paste new secrets is safe.
 *
 * Empty values are skipped, so you can run it before every secret is filled in
 * and run it again later to push the rest.
 *
 * Usage (from a linked project dir, e.g. conductor/ or compound/):
 *   node scripts/sync-vercel-env.mjs [envFile] [targets]
 *     envFile  path to the .env file        (default: .env)
 *     targets  comma list of environments   (default: production)
 *              one of/any of: production, preview, development
 *
 * Examples:
 *   node scripts/sync-vercel-env.mjs                      # .env -> production
 *   node scripts/sync-vercel-env.mjs .env production,preview
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const envFile = process.argv[2] ?? ".env";
const targets = (process.argv[3] ?? "production").split(",").map((t) => t.trim()).filter(Boolean);

/** Parse a .env file into ordered [key, value] pairs, ignoring comments/blanks. */
function parseEnv(text) {
  const pairs = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) pairs.push([key, value]);
  }
  return pairs;
}

function run(args, input) {
  return spawnSync("vercel", args, { input, encoding: "utf8" });
}

const pairs = parseEnv(readFileSync(envFile, "utf8"));
let pushed = 0;
let skipped = 0;

for (const [key, value] of pairs) {
  if (value === "") {
    console.log(`· skip   ${key} (empty)`);
    skipped++;
    continue;
  }
  for (const target of targets) {
    // Remove first so add never errors on an existing key. Failure is fine
    // (key may not exist yet); we swallow it.
    run(["env", "rm", key, target, "-y"]);
    const add = run(["env", "add", key, target], value);
    if (add.status !== 0) {
      console.error(`✗ failed ${key} (${target})\n${add.stderr ?? ""}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ set    ${key} (${target})`);
      pushed++;
    }
  }
}

console.log(`\nDone: ${pushed} set, ${skipped} skipped (empty). Targets: ${targets.join(", ")}`);
