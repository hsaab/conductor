---
name: reset-demo-state
description: >-
  Reset the conductor closed-loop demo across Linear tickets, the board, and the
  compound /api/market/quotes baseline. Choose start mode from user intent —
  feature (default, full Act 1→2 from tickets) or hotfix (arm FE-13 PR, presenter
  merges). Use when the user says reset the demo, re-arm the demo, clean slate,
  start from the ticket, arm hotfix start, start at the hotfix, or reset for the
  remediation beat. Distinct from compound's reset-demo skill (wipes a built feature).
---

# Reset demo state

Re-arm the conductor demo. Mode comes from the user's words, not an env var.

## Pick the mode first

| User says | Mode | Command |
|---|---|---|
| reset the demo, re-arm, clean slate, start from the ticket / Act 1 | **feature** | `pnpm reset-demo` |
| arm hotfix, start at the hotfix, start at remediation, hotfix beat | **hotfix** | `pnpm reset-demo:hotfix` |

If unclear, ask once: feature (tickets in Backlog) or hotfix (FE-13 PR ready to merge)?

Print the choice before running:

```
Arming: feature
```

or

```
Arming: hotfix
```

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

**feature.** Clear tickets, close stray FE-13/regression PRs, pass baseline gate, empty board.

**hotfix.** After a clean gate: `POST /api/trigger` for FE-13, reconcile until a PR exists, fingerprint the PR head (refuse if no regression), stop before merge. Presenter merges live.

Baseline gate fails → `pnpm restore-baseline` then re-run the same mode command.

## Final sanity

```bash
curl -s "$BRIDGE_URL/api/board" | jq '{inProgress, complete}'
curl -s "$TARGET_APP_URL/api/market/quotes?tickers=AAPL,MSFT" | jq '{resolved, durationMs}'
```

## Does not

- Mutate `main`
- Pause Datadog synthetics
- Fabricate Linear markers (hotfix uses the real fleet)
