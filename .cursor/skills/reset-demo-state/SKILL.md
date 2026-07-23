---
name: reset-demo-state
description: >-
  Reset the conductor demo. If the user has not chosen a start beat, ask once —
  from the beginning (feature: tickets in Backlog) or from the hotfix (FE-13 PR
  armed, presenter merges) — then run the matching command. Use when the user
  says rearm, reset the demo, clean slate, start from the ticket, or arm hotfix.
  Compound's reset-demo skill delegates here for its re-arm phase (it also
  wipes the locally built feature first).
---

# Reset demo state

Re-arm the conductor demo. If the user has not chosen a beat, ask once:
from the beginning (feature) or from the hotfix? Then run the matching command.

## Mode → command

| Mode | Command |
|---|---|
| feature (tickets → Backlog, empty board) | `pnpm reset-demo` |
| hotfix (arm FE-13 PR, do not merge) | `pnpm reset-demo:hotfix` |

Print `Arming: feature` or `Arming: hotfix` before running.

## Surfaces

| Surface | feature | hotfix |
|---|---|---|
| Linear | wipe comments; tickets → Backlog | same wipe, then trigger FE-13 fleet |
| Board | empty | FE-13 mid-pipeline with open PR |
| Target app | gate: `/api/market/quotes` fast | same gate, then arm PR (do not merge) |

## Prerequisites

- `BRIDGE_URL`, `BRIDGE_TRIGGER_SECRET`, `LINEAR_API_KEY`
- At least one baseline signal: `GH_TOKEN` and/or `TARGET_APP_URL`
- Optional: `RESPONSE_TIME_MS`, `ALLOW_SLOW_BASELINE=1`, `HOTFIX_ARM_TIMEOUT_MS`

## Workflow

```bash
cd conductor
set -a && source .env && set +a
pnpm reset-demo           # feature
# or
pnpm reset-demo:hotfix    # hotfix
```

Baseline gate fails → `pnpm restore-baseline` then re-run the same command.

## Final sanity

```bash
curl -s "$BRIDGE_URL/api/board" | jq '{inProgress, complete}'
curl -s "$TARGET_APP_URL/api/market/quotes?tickers=AAPL,MSFT" | jq '{resolved, durationMs}'
```

## Does not

- Mutate `main`
- Pause Datadog synthetics
- Fabricate Linear markers (hotfix uses the real fleet)
