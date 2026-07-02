---
name: reset-demo-state
description: Reset the conductor closed-loop demo back to a clean, armed starting state across all three surfaces — Linear tickets (delete ALL comments + reaction, move back to Backlog), conductor (verify the board is empty), and the target app (gate on the fast quotes-check baseline, and restore it on demand with restore-baseline). Use when the user says reset the demo, reset demo state, re-arm the demo, clean slate for the conductor loop, reset the tickets, or start the demo from scratch. This is distinct from the target-app repo's own reset-demo skill, which wipes a just-built feature.
---

# Reset demo state

Re-arm the conductor "software factory" demo so a fresh `cursor-fleet` ticket drag
relaunches the loop cleanly. The demo's state lives in three places; this skill
resets the two that are safe to automate and **gates** on the third.

| Surface | What "reset" means | How |
|---|---|---|
| **Linear tickets** (state store) | delete ALL comments + reaction; move each ticket back to its armed state (Backlog) | `scripts/reset-demo.mjs` -> `POST /api/reset` + `issueUpdate` |
| **Conductor** (stateless) | nothing to delete — its state *is* the Linear comments above; just confirm the board is empty | `scripts/reset-demo.mjs` -> `GET /api/board?all=1` |
| **Target app** (`DEPLOY_TARGET_REPO`) | verify `main` is on the fast `quotes-check` baseline; **block** the reset if it still carries the regression | `scripts/reset-demo.mjs` (gate) — restore with `scripts/restore-baseline.mjs` |

`reset-demo` is a **gate**: it never mutates `main`. When the baseline is
regressed it fails loud (non-zero exit) and points you at `restore-baseline`,
the explicit opt-in fixer that opens+merges the revert PR.

## Prerequisites

Env (a gitignored `.env` or injected secrets):

- `BRIDGE_URL`, `BRIDGE_TRIGGER_SECRET`, `LINEAR_API_KEY` — required.
- Baseline gate signals (at least one so the baseline can be verified):
  - `GH_TOKEN` (or `GITHUB_TOKEN`) — source-of-truth diff of `main` vs the
    `demo-baseline` tag (deploy-independent; catches a regression the moment it
    merges). `restore-baseline` **requires** this (repo write).
  - `TARGET_APP_URL` — live `quotes-check` latency (catches deploy lag).
- `GH_OWNER` (default `hsaab`), `DEPLOY_TARGET_REPO` (default `compound`),
  `BASELINE_TAG` (default `demo-baseline`) — target-repo pointers.
- `RESET_TICKETS` (default `FE-5,FE-7,FE-13`), `RESET_TARGET_STATE` (default
  `Backlog`), `RESPONSE_TIME_MS` (default `1500`) — optional overrides.
- `ALLOW_SLOW_BASELINE=1` — downgrade the baseline gate to a warning (for an
  intentional mid-Act-2 state where `main` *should* still be regressed).

## Workflow

### 1. Reset tickets + conductor markers (automated)

```bash
cd conductor
set -a && source .env && set +a   # or rely on injected secrets
pnpm reset-demo
```

For each ticket the script: resolves it to its canonical UUID, deletes **all**
comments + reaction via `POST /api/reset` (passing the **UUID**, so the reaction
is removed regardless of the deployed conductor version), and moves it to the
target state. It is **idempotent** — re-running clears 0 comments and skips
tickets already armed.

Expected output (clean run):

```
ok FE-13: cleared N comment(s); moved "In Progress" -> "Backlog".
ok FE-7:  cleared 0 comment(s); already in "Backlog".
ok Board is clean - no fleets in flight.
```

### 2. Verify conductor is re-armed

The script asserts `GET /api/board?all=1` returns no jobs. If a fleet still
shows, a ticket retains a `conductor:fleet-started` marker — re-run, or inspect
that ticket's comments. (Explicit `/api/reset` wipes every comment; dragging a
ticket out of "In Progress" only clears conductor-authored comments.)

### 3. Baseline gate + restore (blocking, with an opt-in fixer)

`quotes-check` must return `durationMs < 1500` for a healthy Act 1 and a green
Datadog synthetic. Step 3 of `reset-demo` **gates** on this using two independent
signals and **blocks the reset** (non-zero exit) if either shows a regression:

- **Source of truth** (`GH_TOKEN`): fingerprints `main` for the FE-13 regression
  *behavior* — marker content (`QUOTE_PACE_MS`, `getQuotesLiveSequential`) and the
  regression-only file `constants.ts` — in a fixed set of exact files. It is a
  *functionality* check, **not** byte-equality against a frozen tag, so features
  built on top of `main` (new files, unrelated edits) never trip it.
  Deploy-independent, so it catches a regression the instant FE-13 merges — before
  any redeploy.
- **Live latency** (`TARGET_APP_URL`): the deployed route's `durationMs`.

If neither signal can run, the baseline is **UNVERIFIED** and also blocks, so a
silently-regressed `main` can never slip into a demo run.

When the gate fails, restore the baseline with the opt-in fixer:

```bash
cd conductor
pnpm restore-baseline    # opens + squash-merges a PR reverting main to demo-baseline
```

`restore-baseline` is deterministic, safe, and auditable:

- **No-ops unless the regression is actually present.** It first fingerprints
  `main`; if there are no FE-13 markers it does nothing, so it can't clobber
  unrelated work when there's nothing to fix.
- **Touches an exact file list, never a directory sweep.** It reverts only the
  known surface files to `demo-baseline` and **deletes** regression-only files
  (`constants.ts`). A later feature's new file under `src/lib/market-data/` (or
  any file outside the surface) is left completely untouched.
- Lands via an **auto-merged PR** — never a force-push. With `TARGET_APP_URL` set
  it then polls the route until the redeploy serves `durationMs < 1500`.

Re-arm loop:

```bash
pnpm reset-demo          # gate fails -> "run pnpm restore-baseline"
pnpm restore-baseline    # merges the revert PR, waits for redeploy
pnpm reset-demo          # gate passes -> demo armed
```

Deliberately keeping `main` regressed (mid-Act-2)? Pass `ALLOW_SLOW_BASELINE=1`
to turn the gate into a warning instead of a hard block.

> Baseline pointer: `demo-baseline` is a git tag in the target repo marking the
> last known fast state (currently the PR #77 hotfix commit). If a *new* fast
> baseline is intentionally established, re-point it:
> `git tag -f demo-baseline <sha> && git push -f origin demo-baseline`.

### 4. Final sanity (pre-flight)

Confirm the armed starting state before the demo:

```bash
curl -s "$BRIDGE_URL/api/board" | jq '{inProgress, complete}'   # both 0
# all cursor-fleet tickets in Backlog/Todo, none In Progress
```

Then DEMO_FLOW section 1 (pre-flight invariants) should pass except where it
depends on step 3 having landed.

## What this skill does NOT do

- `reset-demo` never mutates `main`: it does not merge PRs, push, or revert the
  regression — it only gates and reports. Restoring the baseline is the explicit,
  opt-in `restore-baseline` step (which *does* open+merge a PR, by design).
- Does not delete or close unrelated PRs/branches, and does not touch the Datadog
  synthetic (pause/resume that separately per DEMO_FLOW section 8).
- Does not spawn or cancel cloud agents.
- `restore-baseline` does not `git revert` by commit or rewrite history — it
  re-materializes the exact regression-surface files from the `demo-baseline` tag
  in a fresh auto-merged PR, and touches nothing outside that surface. It also
  does nothing at all unless `main` actually shows the regression fingerprint, so
  features built on top of `main` are never reverted or deleted.
