---
name: reset-demo-state
description: >-
  Reset the conductor demo when the start mode is already known (feature or
  hotfix). Prefer the rearm-demo skill when the user says rearm / reset the demo
  without choosing a beat — that skill asks beginning vs hotfix. Use this skill
  when the user already said start from the ticket, arm hotfix, or names a mode
  explicitly. Distinct from compound's reset-demo skill (wipes a built feature).
---

# Reset demo state

Re-arm when mode is already known. If the user has not chosen a beat, stop and
use [rearm-demo](../rearm-demo/SKILL.md) instead (it asks).

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
- Ask which mode — that is `rearm-demo`
