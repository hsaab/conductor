# Conductor — Demo Flow Spec

Canonical, **agent-checkable** description of the 2K demo. The goal: a closed-loop
software factory where a Linear ticket goes in and a reviewed, deployed, verified,
and (when needed) self-remediated change comes out — visible live on the dashboard
and in Slack.

**How to use this doc (for a verifying agent):** every check below has an explicit
command and an expected result. Run the pre-flight section top to bottom; all must
pass before the demo. During the demo, each beat lists what the presenter does, what
must become observable, how to verify it, and the fallback if it stalls. Treat any
mismatch as a blocker and report it with the failing check number.

All commands assume:

```bash
cd conductor && set -a && source .env && set +a   # loads secrets; never hardcode them
```

Secrets live only in `.env` (gitignored). This doc references them as env vars.

---

## 0. Fixed facts

| Thing | Value |
|---|---|
| Conductor (orchestrator + dashboard) | `https://conductor-factory.vercel.app` |
| Compound (target app) | `https://compound-kappa-one.vercel.app` |
| Latency surface route | `GET /api/market/quotes?tickers=<20-ticker basket>` |
| Trigger label / state | `cursor-fleet` / `In Progress` |
| Target repo | `hsaab/compound` (`GH_OWNER=hsaab`, `DEPLOY_TARGET_REPO=compound`) |
| Conductor repo | `hsaab/conductor` |
| Cloud agent model | `composer-2.5` |
| Datadog site | `us5.datadoghq.com` (PAT is US5-scoped; Bearer auth) |
| Synthetic test | `44p-j68-jai` — "compound — market quotes latency", `responseTime < 1500ms` + resolved≥10, every 60s |
| Datadog webhook | `conductor_cursor_automation` → `/webhook/datadog?secret=$DATADOG_WEBHOOK_SECRET` |
| Synthetic alert handle | `@webhook-conductor_cursor_automation` |
| Act 1 ticket (feature) | **FE-7** — "Build AI advisor chat for portfolio guidance" |
| Act 2 ticket (regression) | **FE-13** — "Portfolio prices look stale — make quotes real-time" (TTL bypass + paced per-symbol lookups) |

---

## 1. Pre-flight invariants (all must pass)

### 1.1 Conductor is live
```bash
curl -s -o /dev/null -w "%{http_code}\n" "$BRIDGE_URL/api/health"      # expect 200
curl -s "$BRIDGE_URL/api/health"                                       # expect {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" "$BRIDGE_URL/"                # expect 200 (dashboard HTML)
curl -s -o /dev/null -w "%{http_code}\n" "$BRIDGE_URL/api/board"       # expect 200
```

### 1.2 Compound is live and FAST (baseline, pre-regression)
```bash
curl -s "https://compound-kappa-one.vercel.app/api/market/quotes?tickers=AAPL,MSFT,GOOGL,AMZN,NVDA,META,TSLA,BRK.B,JPM,V,JNJ,WMT,PG,MA,HD,CVX,ABBV,KO,PEP,COST" \
  | jq '{resolved, durationMs, degraded}'
```
Expect `resolved: 20`, `durationMs` well under `1500`, `degraded: false`. This is the
healthy baseline the synthetic passes against.

### 1.3 Datadog synthetic exists, is live, and asserts the right thing
```bash
curl -s "https://api.us5.datadoghq.com/api/v1/synthetics/tests/44p-j68-jai" \
  -H "Authorization: Bearer $DD_API_KEY" \
  | jq '{status, url: .config.request.url, assertions: .config.assertions, message}'
```
Expect `status: "live"`, url contains `/api/market/quotes?tickers=`, an assertion
`responseTime lessThan 1500`, a body assertion on `$.resolved`, and `message`
containing `@webhook-conductor_cursor_automation`.

> Note: the webhook integration's custom `route` field may still say
> `/api/market/quotes-check` if the Datadog PAT cannot write webhooks (API 404).
> Dispatch still works — `isDispatchableAlert` matches `/api/market/` and
> "latency" in the synthetic title. Prefer updating the webhook payload in the
> Datadog UI to `route: "/api/market/quotes"` when you have write access.

### 1.4 Datadog webhook points at conductor with the correct secret
```bash
curl -s "https://api.us5.datadoghq.com/api/v1/integration/webhooks" \
  -H "Authorization: Bearer $DD_API_KEY" \
  | jq '.hooks[] | select(.name=="conductor_cursor_automation") | {name, url, encode_as_form, use_custom_payload}'
```
Expect `url` = `$BRIDGE_URL/webhook/datadog?secret=$DATADOG_WEBHOOK_SECRET`,
`encode_as_form: "false"`, `use_custom_payload: "true"`.

### 1.5 Conductor webhooks authenticate correctly
```bash
# Datadog: wrong secret rejected, recovery payload accepted but NOT dispatched
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BRIDGE_URL/webhook/datadog?secret=WRONG" \
  -H 'Content-Type: application/json' -d '{"alert_type":"success"}'            # expect 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BRIDGE_URL/webhook/datadog?secret=$DATADOG_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' -d '{"alert_type":"success"}'            # expect 202

# Vercel: wrong secret rejected
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BRIDGE_URL/webhook/vercel?secret=WRONG" \
  -H 'Content-Type: application/json' -d '{"type":"deployment.succeeded"}'     # expect 401
```

### 1.6 Integrations registered (verify in each UI — not curl-able)
- **Linear webhook** → `$BRIDGE_URL/webhook/linear`, resource type **Issues**, signing
  secret in `LINEAR_WEBHOOK_SECRET`. (Linear → Settings → API → Webhooks.)
- **Vercel deploy webhook** on the **compound** project for `deployment.succeeded`
  → `$BRIDGE_URL/webhook/vercel?secret=$VERCEL_WEBHOOK_SECRET`.
- **Bugbot** enabled on `hsaab/compound` so PRs are auto-reviewed.
- **Conductor Vercel env** has `DD_API_KEY` (PAT), `DD_SITE=us5.datadoghq.com`,
  `GH_TOKEN` (so review/merge advance on the real PR merge, not the deploy), and
  all `*_SECRET`s set for Production.

### 1.7 Tickets are armed and in the right starting state
```bash
curl -s -X POST https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { issues(filter:{labels:{name:{eq:\"cursor-fleet\"}}},first:30){nodes{identifier state{name}}}}"}' \
  | jq -r '.data.issues.nodes[] | "\(.identifier) [\(.state.name)]"'
```
Expect **FE-7** and **FE-13** in `Backlog`/`Todo` (NOT yet `In Progress`). If **FE-5**
or anything else is `In Progress`, reset it (section 7) so the board starts clean.

---

## 2. Stage ↔ marker model (how to read the board)

Conductor has no database; all state is Linear comment markers. The dashboard
(`GET /api/board`) derives each stage from them. An agent verifying live state should
poll `GET $BRIDGE_URL/api/board` and read `jobs[].stages`.

| Stage | Becomes `done` when… | Marker(s) | Driven by |
|---|---|---|---|
| plan | a fleet was planned + agents spawned (+ test plan posted) | `fleet-started`, `test-plan`, `agent spawned` | `/webhook/linear` → planner |
| build | every build agent run is terminal | `agent-done id=…` | `/api/reconcile` reads cloud runs |
| review | build done → the PR(s) merged | `merged` (or `deployed`) | Bugbot on GitHub + human merge |
| deploy | Vercel `deployment.succeeded` arrived | `deployed` | `/webhook/vercel` |
| verify | verify agent reports pass, or remediate ends the window | `verify-pass` (or `remediated`) | verify agent + `/api/reconcile`; Datadog alert during window |
| remediate | hotfix merged + redeployed + re-verified | `remediated` (running) → `remediation-done` (loops review/deploy/verify back) → `hotfix-verify-pass` (done) | `/webhook/datadog` or verify fail + `/api/reconcile` + `/webhook/vercel` |

**Critical operational note:** `build`, the PR URLs, `review`, and the `verify`
window close only advance after a `/api/reconcile` pass. That pass reads finished
cloud runs, checks PR merge status on GitHub (needs `GH_TOKEN`), and closes the
verify window once the agent reports or the window elapses. Only `deploy` advances
on its own via the Vercel webhook (which also spawns the verify agent). Run reconcile
on a cadence during the demo (section 5.1).

---

## 3. Act 1 — happy path (FE-7, "AI advisor chat")

**Narrative:** drag a ticket; a planner reads it (and posts a test plan for SQA), a cloud agent builds it and opens a
PR, Bugbot reviews, you merge, Vercel deploys, and conductor spawns a verify agent that runs the test plan on prod —
then posts pass/fail to Slack. The dashboard tracks it all live.

### Beat A1 — Engage
- **Action:** in Linear, move **FE-7** to **In Progress**.
- **Expected (≤10s):** a 🚀 reaction + "Cursor bridge engaged — planning the fleet"
  comment on FE-7; on the dashboard FE-7 appears with `plan: running`.
- **Verify:**
  ```bash
  curl -s "$BRIDGE_URL/api/board" | jq '.jobs[] | select(.identifier=="FE-7") | {stages, agents: [.agents[].repo]}'
  ```
- **Fallback:** if nothing within ~20s, fire the manual trigger (section 5.2).

### Beat A2 — Plan → Build
- **Expected (≤60s):** planner posts "chose N agent(s)" and a **test plan** (top 3–5 critical checks); one "Cursor agent spawned"
  comment per task; `plan: done`, `build: running`.
- **Verify:** `agents[]` for FE-7 is non-empty with `role: "build"`; stages show
  `plan: done`.

### Beat A3 — PR opens + Bugbot reviews
- **Expected (minutes):** the cloud agent opens a PR on `hsaab/compound`
  (`autoCreatePR`); Bugbot posts a review.
- **Verify:**
  ```bash
  # surface the PR URL into Linear/board
  curl -s -X POST "$BRIDGE_URL/api/reconcile" -H "Authorization: Bearer $BRIDGE_TRIGGER_SECRET" | jq
  curl -s "$BRIDGE_URL/api/board" | jq '.jobs[] | select(.identifier=="FE-7") | .agents[] | {repo, done, prUrl}'
  ```
  Expect `done: true` and a `prUrl` once the run is terminal; `build: done`.

### Beat A4 — Merge → Deploy → Verify
- **Action:** merge the PR to `main` on GitHub.
- **Expected (≤2–3 min):** Vercel auto-deploys compound; `/webhook/vercel` fires;
  conductor posts `deployed`, spawns the verify agent, and Slack shows **"🚀 compound shipped to
  production"** with a "now verifying" line; dashboard `review/deploy: done`,
  `verify: running`.
- **Then (after verify agent finishes or the window elapses):** a reconcile
  pass posts `verify-pass` and Slack shows **"✅ FE-7 — verify passed"**;
  `verify: done`.
- **Verify:**
  ```bash
  curl -s "$BRIDGE_URL/api/board" | jq '.jobs[] | select(.identifier=="FE-7") | .stages'
  ```
  Expect `deploy: done`, `verify: running` right after the deploy, flipping to
  `verify: done` once the agent reports (keep the reconcile loop in 5.1 running).
  Confirm both Slack messages arrived.
- **Fallback:** if the Vercel webhook is missed, replay it (section 5.3).

Act 1 ends with FE-7 shipped and verify passing (Slack posts the green verdict).

---

## 4. Act 2 — regression + self-remediation (FE-13, the money shot)

**Narrative:** a plausible ticket ("prices look stale — make them real-time") ships a
change that **disables the quote TTL** and adds **paced per-symbol GLOBAL_QUOTE**
lookups (≥250ms apart, unconditional). The Datadog synthetic on `/api/market/quotes`
catches the latency, fires the webhook, and conductor dispatches a remediation agent
that opens a hotfix PR restoring a sane TTL (~30s) **and** the concurrent fan-out
(both required — the 60s synthetic tick always outlives a 30s TTL).

### Beat B1 — Ship the regression
- **Action:** move **FE-13** to **In Progress**; let it build, then merge its PR to
  `main` (same as Beats A1–A4 for FE-13).
- **Expected:** FE-13 deploys; Slack posts that it shipped and is now scanning.
  Conductor's deploy-time scan only counts error logs, so it will not flag the
  latency; the Datadog synthetic is the latency detector.
- **Verify regression is real (do this in rehearsal):**
  ```bash
  curl -s "https://compound-kappa-one.vercel.app/api/market/quotes?tickers=AAPL,MSFT,GOOGL,AMZN,NVDA,META,TSLA,BRK.B,JPM,V,JNJ,WMT,PG,MA,HD,CVX,ABBV,KO,PEP,COST" | jq '.durationMs'
  ```
  Must be **> 1500** reliably. If it isn't, the regression didn't bite — see section 8.

### Beat B2 — Datadog detects latency
- **Expected (≤2 min):** synthetic `44p-j68-jai` run fails the `responseTime < 1500ms`
  assertion; its monitor alerts and notifies `@webhook-conductor_cursor_automation`.
- **Verify:**
  ```bash
  curl -s -G "https://api.us5.datadoghq.com/api/v1/synthetics/tests/44p-j68-jai/results" \
    -H "Authorization: Bearer $DD_API_KEY" | jq '.results[0] | {passed: .result.passed, responseTime: .result.timings.total}'
  ```
  Expect a recent `passed: false`.

### Beat B3 — Conductor dispatches remediation
- **Expected:** Slack posts **"⚠️ Latency detected on compound … dispatching a
  remediation agent"**; FE-13 gets `remediated` + remediation-agent markers; dashboard
  `remediate: running`.
- **Verify:**
  ```bash
  curl -s "$BRIDGE_URL/api/board?all=1" | jq '.jobs[] | select(.identifier=="FE-13") | {stages, rem: [.agents[]|select(.role=="remediation")]}'
  ```
- **Fallback:** if Datadog is slow to fire, replay the alert manually (section 5.4).

### Beat B4 — Hotfix PR opens, loop closes
- **Expected (minutes):** remediation agent opens a hotfix PR on `hsaab/compound`
  restoring the cache/batching; Bugbot reviews it.
- **Verify:**
  ```bash
  curl -s -X POST "$BRIDGE_URL/api/reconcile" -H "Authorization: Bearer $BRIDGE_TRIGGER_SECRET" | jq
  curl -s "$BRIDGE_URL/api/board?all=1" | jq '.jobs[] | select(.identifier=="FE-13") | .agents[] | select(.role=="remediation") | {done, prUrl}'
  ```
  Expect a hotfix `prUrl`; Slack posts **"🛠️ Hotfix PR opened by remediation agent"**;
  the pipeline loops back to review: `review: running`, `deploy/verify: pending`,
  `remediate: running`.
- **Close:** merge the hotfix. The next production deploy stamps `hotfix-merged` +
  `hotfix-deployed`, a fresh verify agent re-runs the test plan, and
  `hotfix-verify-pass` finally flips `remediate: done`. Confirm `market quotes`
  `durationMs` drops back under 1500 and the synthetic recovers. Recovery
  notifications are ignored by conductor (no re-trigger).

---

## 5. Operator controls & fallbacks

### 5.1 Reconcile cadence (advances build/PR/remediation on the board)
```bash
while true; do
  curl -s -X POST "$BRIDGE_URL/api/reconcile" -H "Authorization: Bearer $BRIDGE_TRIGGER_SECRET" \
    | jq -c '{scanned:.issuesScanned, done:.agentsCompleted, pend:.agentsPending}'
  sleep 30
done
```

### 5.2 Manual fleet trigger (if the Linear webhook misses)
```bash
curl -s -X POST "$BRIDGE_URL/api/trigger" -H "Authorization: Bearer $BRIDGE_TRIGGER_SECRET" \
  -H 'Content-Type: application/json' -d '{"identifier":"FE-7"}' | jq
```

### 5.3 Replay a Vercel deploy (if `/webhook/vercel` is missed)
```bash
curl -s -X POST "$BRIDGE_URL/webhook/vercel?secret=$VERCEL_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"type":"deployment.succeeded","payload":{"project":{"name":"compound"},"target":"production","url":"compound-kappa-one.vercel.app"}}' | jq
```

### 5.4 Replay a Datadog latency alert (if the synthetic is slow)
```bash
curl -s -X POST "$BRIDGE_URL/webhook/datadog?secret=$DATADOG_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"title":"compound — market quotes latency","body":"responseTime 4200ms > 1500ms","alert_type":"error","route":"/api/market/quotes","monitor_id":"manual"}' | jq
```
This dispatches a real remediation agent against the most recent deployed-but-not-yet-
remediated fleet. Only use after FE-13 has deployed.

---

## 6. Timing budget (pre-warm to stay inside it)

| Phase | Cold | Pre-warmed (recommended) |
|---|---|---|
| Engage → plan → build spawned | ~60s | ~15s |
| Build agent → PR opened | 3–8 min | pre-run before the call |
| Merge → Vercel deploy → Slack shipped | 2–3 min | unchanged |
| Regression deploy → synthetic fails | up to 2 min (60s tick) | unchanged |
| Alert → remediation PR opened | 3–8 min | pre-run before the call |

**De-risk:** run FE-7 and FE-13 fleets once shortly before the demo so the PRs already
exist; during the live demo you re-drag/merge and narrate, while the dashboard + Slack
provide real, recent artifacts. Keep the reconcile loop (5.1) running throughout.

---

## 7. Reset / re-arm between rehearsals

Two start modes (chosen by the `reset-demo-state` skill from user intent, not an env var):

- **feature** (`pnpm reset-demo`): tickets to Backlog, board empty, baseline must be fast.
- **hotfix** (`pnpm reset-demo:hotfix`): after reset, triggers a real FE-13 fleet, waits for
  its PR (does **not** merge), fingerprints the PR head, and leaves FE-13 mid-pipeline
  for the presenter to merge live as the opening beat.

Re-arming via `/api/reset` wipes **all** comments + the 🚀 reaction so a fresh
drag relaunches a fleet. (Dragging a ticket out of "In Progress" only clears
conductor-authored comments.)
```bash
for T in FE-5 FE-7 FE-13; do
  curl -s -X POST "$BRIDGE_URL/api/reset" -H "Authorization: Bearer $BRIDGE_TRIGGER_SECRET" \
    -H 'Content-Type: application/json' -d "{\"identifier\":\"$T\"}" | jq -c
done
```
Then move each ticket back to `Backlog`/`Todo` in Linear. Close/merge or revert any
rehearsal PRs so `main` is back to the fast baseline before the real run.

---

## 8. Known risks & mitigations

- **Deploy/alert attribution — keep one ticket in flight.** Vercel and Datadog
  payloads carry no Linear id, so conductor attributes a deploy/alert to a fleet by
  `findActiveFleet`. It now prefers an **exact match** when the payload carries an
  identifier that appears in a fleet's comments — the Vercel webhook passes the
  commit SHA + deploy URL as a hint. But production deploys share one URL, the
  commit SHA is only recorded once conductor writes the `deployed` marker, and
  **Datadog alerts carry no hint at all**, so the general fallback is "most recently
  updated matching fleet." With two concurrent `cursor-fleet` tickets mid-pipeline,
  a deploy or latency alert can therefore be misattributed. **Constraint: run only
  one `cursor-fleet` ticket through deploy/verify/remediate at a time.** Let FE-7
  fully ship (or reach `verify: done`) before moving FE-13 to In Progress; during
  Act 2, no other fleet should be in the deploy/remediate stages.
- **Regression must exceed 1500ms — guaranteed by the ticket, not luck.** FE-13's
  acceptance criteria force the slow path on `/api/market/quotes` only (SSR
  snapshot path in `portfolio.ts` is out of scope):
  1. **Unconditional** quote-cache bypass (not market-open scoped — weekends /
     status errors would otherwise leave the 15-minute closed TTL intact).
  2. Per-symbol `GLOBAL_QUOTE` lookups paced **≥250ms apart**, including on
     per-symbol failures/throttles (so snapshot fallback cannot collapse latency).
  With the 20-ticker basket that is 19 gaps × 250ms ≈ **4,750ms** floor before
  network time (~6–15s realistic). The hotfix must restore a sane TTL (~30s)
  **and** concurrent fan-out — a TTL-only fix never clears the alert because the
  60s synthetic tick always outlives a 30s TTL. Confirm Beat B1 `durationMs >
  1500` in rehearsal (including once outside US market hours). Pre-warmed PRs
  and the §5.4 alert replay remain backstops.
- **Cloud agent latency.** Pre-warm (section 6). Never block the narrative on a live
  multi-minute run.
- **Webhook misses.** Every webhook has a manual replay (sections 5.2–5.4).
- **Stale board.** `build` + PR URLs need a reconcile pass; keep the loop running.
- **Secret hygiene.** The Datadog webhook URL embeds `DATADOG_WEBHOOK_SECRET` in
  plaintext (visible to Datadog admins in the shared org). Acceptable for the demo; to
  tighten, switch conductor to read `x-conductor-secret` as a header instead.
- **Shared Datadog org.** The synthetic + webhook live in Cursor's company US5 org and
  run every 60s. Pause the synthetic after the demo if you don't want it polling.
```bash
# pause the synthetic when done
curl -s -X PATCH "https://api.us5.datadoghq.com/api/v1/synthetics/tests/44p-j68-jai/status" \
  -H "Authorization: Bearer $DD_API_KEY" -H 'Content-Type: application/json' \
  -d '{"new_status":"paused"}' | jq -c
```
