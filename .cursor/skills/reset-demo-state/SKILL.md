---
name: reset-demo-state
description: Reset the conductor closed-loop demo back to a clean, armed starting state across all three surfaces — Linear tickets (delete ALL comments + reaction, move back to Backlog), conductor (verify the board is empty), and the target app (verify the fast quotes-check baseline). Use when the user says reset the demo, reset demo state, re-arm the demo, clean slate for the conductor loop, reset the tickets, or start the demo from scratch. This is distinct from the target-app repo's own reset-demo skill, which wipes a just-built feature.
---

# Reset demo state

Re-arm the conductor "software factory" demo so a fresh `cursor-fleet` ticket drag
relaunches the loop cleanly. The demo's state lives in three places; this skill
resets the two that are safe to automate and verifies the third.

| Surface | What "reset" means | How |
|---|---|---|
| **Linear tickets** (state store) | delete ALL comments + reaction; move each ticket back to its armed state (Backlog) | `scripts/reset-demo.mjs` -> `POST /api/reset` + `issueUpdate` |
| **Conductor** (stateless) | nothing to delete — its state *is* the Linear comments above; just confirm the board is empty | `scripts/reset-demo.mjs` -> `GET /api/board?all=1` |
| **Target app** (`DEPLOY_TARGET_REPO`) | restore the fast `quotes-check` baseline on `main` | **human merge** (see step 3) — the script only measures + warns |

## Prerequisites

Env (a gitignored `.env` or injected secrets):

- `BRIDGE_URL`, `BRIDGE_TRIGGER_SECRET`, `LINEAR_API_KEY` — required.
- `TARGET_APP_URL` — optional; enables the baseline latency check.
- `RESET_TICKETS` (default `FE-5,FE-7,FE-13`), `RESET_TARGET_STATE` (default
  `Backlog`), `RESPONSE_TIME_MS` (default `1500`) — optional overrides.

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

### 3. Restore the target-app baseline (human merge — cannot be automated here)

`quotes-check` must return `durationMs < 1500` for a healthy Act 1 and a green
Datadog synthetic. If the script warns the baseline is SLOW, `main` still carries
the per-symbol regression:

1. Merge the revert/hotfix PR that restores the batched `getQuotes()` path (or
   `git revert` the regression commit).
2. Let Vercel redeploy the target app.
3. Re-run `pnpm reset-demo` (or just re-curl `quotes-check`) and confirm
   `durationMs < 1500` and the synthetic recovering.

This step needs a human merge by design — do not push directly to `main`.

### 4. Final sanity (pre-flight)

Confirm the armed starting state before the demo:

```bash
curl -s "$BRIDGE_URL/api/board" | jq '{inProgress, complete}'   # both 0
# all cursor-fleet tickets in Backlog/Todo, none In Progress
```

Then DEMO_FLOW section 1 (pre-flight invariants) should pass except where it
depends on step 3 having landed.

## What this skill does NOT do

- Does not merge PRs, push to `main`, or revert the regression — that is a human
  step (see step 3).
- Does not delete or close PRs/branches, and does not touch the Datadog synthetic
  (pause/resume that separately per DEMO_FLOW section 8).
- Does not spawn or cancel cloud agents.
