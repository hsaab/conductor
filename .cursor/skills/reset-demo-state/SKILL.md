---
name: reset-demo-state
description: Reset the conductor closed-loop demo back to a clean, armed starting state across all three surfaces — Linear tickets (delete ALL comments + reaction, move back to Backlog), conductor (mode-aware board check), and the target app (gate on the fast /api/market/quotes baseline, restore with restore-baseline). Supports DEMO_START_MODE=feature|hotfix. Use when the user says reset the demo, reset demo state, re-arm the demo, clean slate for the conductor loop, reset the tickets, or start the demo from scratch. This is distinct from the target-app repo's own reset-demo skill, which wipes a just-built feature.
---

# Reset demo state

Re-arm the conductor "software factory" demo so a fresh `cursor-fleet` ticket drag
relaunches the loop cleanly. The demo's state lives in three places; this skill
resets the two that are safe to automate and **gates** on the third.

| Surface | What "reset" means | How |
|---|---|---|
| **Linear tickets** (state store) | delete ALL comments + reaction; move each ticket back to Backlog (feature) or arm FE-13 mid-pipeline (hotfix) | `scripts/reset-demo.mjs` |
| **Conductor** (stateless) | mode-aware board check | `GET /api/board?all=1` |
| **Target app** (`DEPLOY_TARGET_REPO`) | verify `main` is on the fast `/api/market/quotes` baseline; **block** if still regressed | gate in `reset-demo.mjs`; fix with `restore-baseline.mjs` |

## Prerequisites

Env (a gitignored `.env` or injected secrets):

- `BRIDGE_URL`, `BRIDGE_TRIGGER_SECRET`, `LINEAR_API_KEY` — required.
- Baseline gate signals (at least one):
  - `GH_TOKEN` — fingerprint `main` for the FE-13 TTL/paced-quotes regression.
  - `TARGET_APP_URL` — live `/api/market/quotes?tickers=<basket>` latency (primary gate).
- `DEMO_START_MODE=feature|hotfix` (default `feature`).
- `HOTFIX_TICKET` (default `FE-13`), `HOTFIX_ARM_TIMEOUT_MS` (default `900000`) for hotfix mode.
- `RESPONSE_TIME_MS` (default `1500`), `ALLOW_SLOW_BASELINE=1` optional override.

## Workflow

### 1. Reset tickets + close stray regression PRs

```bash
cd conductor
set -a && source .env && set +a
pnpm reset-demo
# or: DEMO_START_MODE=hotfix pnpm reset-demo
```

Feature mode clears tickets to Backlog and closes open FE-13/regression PRs
(cleanup is owned by reset, not restore — restore no-ops when `main` is clean).

### 2. Baseline gate

Live latency on `/api/market/quotes` is the primary signal. The fingerprint is
best-effort for the value-shaped TTL regression. On failure:

```bash
pnpm restore-baseline
pnpm reset-demo
```

### 3. Hotfix start mode

When `DEMO_START_MODE=hotfix`:

1. After a clean baseline gate, trigger a **real** FE-13 fleet via `POST /api/trigger`.
2. Reconcile until the build agent opens a PR.
3. Fingerprint the PR **head** — refuse to arm if the regression is missing.
4. **Do not merge.** Presenter's opening beat is merging that PR live.

Board check expects FE-13 mid-pipeline (not empty).

### 4. Final sanity

```bash
curl -s "$BRIDGE_URL/api/board" | jq '{inProgress, complete}'
curl -s "$TARGET_APP_URL/api/market/quotes?tickers=AAPL,MSFT" | jq '{resolved, durationMs}'
```

## What this skill does NOT do

- `reset-demo` never mutates `main`.
- Does not pause/resume Datadog synthetics (see DEMO_FLOW).
- Does not fabricate Linear markers — hotfix mode uses the real fleet pipeline.
