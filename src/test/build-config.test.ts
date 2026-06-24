/**
 * Guards the pnpm build-script gating that keeps @cursor/sdk importable.
 *
 * sqlite3 is a native dependency @cursor/sdk loads at import time. If its build
 * script is gated off, `import("@cursor/sdk")` throws "Could not locate the
 * bindings file" and the planner/fleet silently fall back ("Planner
 * unavailable"). This config has regressed repeatedly because each pnpm major
 * gates builds differently, so these tests assert the cross-major contract
 * instead of trusting a comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

/** Indented body lines beneath a bare `key:` header, with blanks and comments dropped. */
function yamlBlockBody(yaml: string, key: string): string[] {
  const lines = yaml.split("\n");
  const headerIndex = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (headerIndex === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) break;
    body.push(line.trim());
  }
  return body;
}

/** Parses an `allowBuilds:` map (`name: true|false`) into a record. */
function parseAllowBuilds(yaml: string): Record<string, string> {
  const entries = yamlBlockBody(yaml, "allowBuilds").map((line) => {
    const [name, value] = line.split(":").map((part) => part.trim());
    return [name, value] as const;
  });
  return Object.fromEntries(entries);
}

const workspaceYaml = readRepoFile("pnpm-workspace.yaml");
const packageJson = JSON.parse(readRepoFile("package.json")) as Record<string, unknown>;

test("pnpm-workspace.yaml declares a packages key so pnpm 9 accepts the file", () => {
  assert.ok(
    yamlBlockBody(workspaceYaml, "packages").length > 0,
    "pnpm 9 aborts install on a workspace file with no `packages` field",
  );
});

test("allowBuilds permits sqlite3 (pnpm 11 build gate)", () => {
  const allowBuilds = parseAllowBuilds(workspaceYaml);
  assert.equal(allowBuilds.sqlite3, "true");
});

test("allowBuilds declares esbuild so pnpm 11 strictDepBuilds does not error", () => {
  const allowBuilds = parseAllowBuilds(workspaceYaml);
  assert.ok(
    "esbuild" in allowBuilds,
    "pnpm 11 errors on any build-script package missing from allowBuilds",
  );
});

test("onlyBuiltDependencies permits sqlite3 (pnpm 9/10 build gate)", () => {
  assert.ok(yamlBlockBody(workspaceYaml, "onlyBuiltDependencies").includes("- sqlite3"));
});

test("package.json carries no pnpm field (pnpm 11 ignores it)", () => {
  assert.ok(
    !("pnpm" in packageJson),
    "build settings belong in pnpm-workspace.yaml; package.json#pnpm is dead under pnpm 11",
  );
});

test("Cursor SDK imports after pnpm install", async () => {
  await import("@cursor/sdk");
});
