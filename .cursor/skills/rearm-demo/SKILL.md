---
name: rearm-demo
description: >-
  Interactively re-arm the conductor closed-loop demo. Always asks whether to
  start from the beginning (feature: tickets in Backlog) or from the hotfix
  (FE-13 PR armed, presenter merges). Use when the user says rearm, re-arm,
  rearm the demo, reset the demo, clean slate for the demo, or prepare the demo
  without specifying which beat to start on.
---

# Rearm demo

Interactive entry for re-arming the conductor demo. Always ask which start beat.
Do not guess from vague wording.

## 1. Ask

Use AskQuestion (or equivalent) with exactly these two options:

1. **From the beginning** — tickets in Backlog, empty board, ready for Act 1 → Act 2 (feature)
2. **From the hotfix** — arm FE-13 with an open regression PR; presenter merges as the opening beat

Wait for the answer. Do not run reset until they pick.

## 2. Run

```bash
cd conductor
set -a && source .env && set +a
```

| Choice | Print | Command |
|---|---|---|
| From the beginning | `Arming: feature` | `pnpm reset-demo` |
| From the hotfix | `Arming: hotfix` | `pnpm reset-demo:hotfix` |

Needs `BRIDGE_URL`, `BRIDGE_TRIGGER_SECRET`, `LINEAR_API_KEY`, and at least one of `GH_TOKEN` / `TARGET_APP_URL`.

## 3. If the baseline gate fails

```bash
pnpm restore-baseline
```

Then re-run the **same** command from step 2.

## 4. Confirm

```bash
curl -s "$BRIDGE_URL/api/board" | jq '{inProgress, complete}'
curl -s "$TARGET_APP_URL/api/market/quotes?tickers=AAPL,MSFT" | jq '{resolved, durationMs}'
```

- **feature:** board empty (or both counts 0); `durationMs` well under 1500.
- **hotfix:** FE-13 mid-pipeline with an open PR; baseline still fast until they merge.

Tell them the next presenter beat in one line (drag FE-7, or merge the armed FE-13 PR).

## Notes

- Implementation details live in `scripts/reset-demo.mjs`. This skill only chooses mode and runs it.
- Distinct from compound's `reset-demo` skill (wipes a just-built feature in the app repo).
- Does not mutate `main`, pause Datadog, or merge the hotfix PR.
