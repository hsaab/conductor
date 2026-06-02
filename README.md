# cursor-demo-bridge

Linear webhook bridge that spawns Cursor cloud agents when a `cursor-fleet` ticket moves to **In Progress**.

## How it works

Spawning and completion are decoupled, because a cloud agent run takes many
minutes — far longer than a serverless function can stay alive.

1. **Trigger** (`/api/trigger` or `/webhook/linear`): validates the issue, then
   gives an instant visible signal. It reacts on the ticket with 🚀 and posts a
   "Cursor bridge engaged" comment that carries the hidden `fleet-started` marker.
   It then spawns the agents **fire-and-forget** (`Agent.create` + `agent.send`,
   no `run.wait`). Returns in seconds.
2. **Reconcile** (`/api/reconcile`): runs out-of-band, finds issues with a
   `fleet-started` marker but no `fleet-complete` marker, recovers each agent's
   run via `Agent.listRuns`, and — once a run is terminal — posts a completion
   comment with the PR URL. It's idempotent (per-agent `agent-done` markers) and
   uses Linear comments as its only state store (no database).
3. **Reset on leave** (poller, or `/api/reset`): when a `cursor-fleet` ticket
   moves back out of **In Progress**, the bridge re-arms it. It removes the 🚀
   reaction and deletes every bridge comment, which clears the `fleet-started`
   marker. The poller then closes the fleet's PRs and leaves one open to show.
   Dragging the ticket back into **In Progress** launches a fresh run.

Reconcile is driven two ways: a daily Vercel Cron (backstop) and the
`watch:linear` poller, which calls it every ~15s for fast, demo-time loop-back.
On a Vercel Pro plan you can lower the cron to `* * * * *` for unattended
minute-level reconcile.

## Prerequisites

- Node 20+
- [pnpm](https://pnpm.io/)
- Cursor API key ([Dashboard → Integrations](https://cursor.com/dashboard/integrations))
- Linear API key ([Settings → API](https://linear.app/settings/api))
- GitHub owner with `compound` and `server` repos
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated, used by the poller to close PRs on reset

## Environment variables

| Variable | Purpose |
|---|---|
| `CURSOR_API_KEY` | Cursor SDK auth |
| `LINEAR_API_KEY` | Post comments back to Linear |
| `LINEAR_WEBHOOK_SECRET` | Verify Linear webhook signatures |
| `BRIDGE_TRIGGER_SECRET` | Secure the `/api/trigger`, `/api/jobs`, `/api/reset`, and manual `/api/reconcile` calls |
| `CRON_SECRET` | Authorize the Vercel Cron call to `/api/reconcile` |
| `GH_OWNER` | GitHub org/user (default: `hsaab`) |
| `BRIDGE_MODEL_ID` | Optional cloud model override (default: `composer-2.5`) |

## Local development

```bash
pnpm install
export CURSOR_API_KEY=...
export LINEAR_API_KEY=...
export LINEAR_WEBHOOK_SECRET=...
export BRIDGE_TRIGGER_SECRET=...
export GH_OWNER=hsaab
pnpm dev
```

Health check: `curl http://localhost:3001/api/health`

## Temporary non-admin trigger

Use this until a Linear admin registers the real webhook. The local watcher polls
Linear with your personal API key and calls the deployed bridge's secured trigger
endpoint. The bridge then uses the same fleet-launching code path as the webhook.

```bash
export LINEAR_API_KEY=...
export BRIDGE_TRIGGER_SECRET=...
export BRIDGE_URL=https://<your-vercel-domain>
pnpm watch:linear
```

Demo flow:

1. Start `pnpm watch:linear` (polls for triggers and drives reconcile).
2. Create or open a Linear issue with label `cursor-fleet`.
3. Move it to **In Progress**.
4. The watcher calls `POST /api/trigger`; agents spawn and comments appear with the accepted trigger and Cursor agent IDs.
5. As each agent finishes, the watcher's reconcile call makes the bridge post a completion comment with the PR URL, then a final `fleet-complete` comment.

The secured endpoints (`/api/trigger`, `/api/reconcile`, `/api/jobs`, `/api/reset`)
all authenticate with `BRIDGE_TRIGGER_SECRET`. Keep that secret (and `BRIDGE_URL`)
in `.env` and load it once, so the curls below stay copy-paste runnable and the
secret never gets retyped or pasted into shell history:

```bash
set -a && source .env && set +a
```

Every example below reads `$BRIDGE_URL` and `$BRIDGE_TRIGGER_SECRET` from that
single source.

Manual backup trigger:

```bash
curl -X POST "$BRIDGE_URL/api/trigger" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $BRIDGE_TRIGGER_SECRET" \
  -d '{"issueId":"ENG-123","source":"manual-demo"}'
```

Manual reconcile (force the bridge to post any pending PR URLs back to Linear):

```bash
curl -X POST "$BRIDGE_URL/api/reconcile" \
  -H "authorization: Bearer $BRIDGE_TRIGGER_SECRET"
```

Manual reset (re-arm an issue by removing the reaction and deleting the bridge's comments):

```bash
curl -X POST "$BRIDGE_URL/api/reset" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $BRIDGE_TRIGGER_SECRET" \
  -d '{"issueId":"ENG-123"}'
```

`/api/reset` only clears the Linear side. PR cleanup lives in the poller (it has
the `gh` credentials), so this endpoint never touches GitHub.

In-progress jobs (read-only; no side effects, no Cursor API key needed):

```bash
curl "$BRIDGE_URL/api/jobs" \
  -H "authorization: Bearer $BRIDGE_TRIGGER_SECRET"
```

Returns the fleets the bridge has launched, reconstructed from Linear comment
markers. Each fleet carries timing derived from the comment timestamps, so you
can see at a glance that a fleet is live and how long it has been running.
Defaults to in-progress fleets only; add `?all=1` to include completed ones.
Example:

```json
{
  "ok": true,
  "generatedAt": "2026-06-02T16:19:46.520Z",
  "inProgress": 1,
  "complete": 3,
  "agentsPending": 1,
  "jobs": [
    {
      "identifier": "ENG-7",
      "title": "Add X-Request-ID middleware",
      "url": "https://linear.app/...",
      "state": "In Progress",
      "status": "in-progress",
      "startedAt": "2026-06-02T16:14:47.878Z",
      "completedAt": null,
      "updatedAt": "2026-06-02T16:17:56.983Z",
      "runningForSeconds": 299,
      "agentsPending": 1,
      "agents": [
        { "role": "hero", "agentId": "bc-...", "repo": "hsaab/compound", "done": true },
        { "role": "chorus", "agentId": "bc-...", "repo": "hsaab/server", "done": false }
      ]
    }
  ]
}
```

The timestamps come straight from the Linear comment thread, the bridge's only
state store. `startedAt` is when the `fleet-started` comment was posted.
`completedAt` is the `fleet-complete` comment, or `null` while a fleet runs.
`updatedAt` is the bridge's most recent comment on the issue. `runningForSeconds`
is present only while a fleet is in-progress and measures its current age.
`done` reflects whether the reconciler has reported that agent back to Linear,
not a live run check, so the endpoint stays cheap and database-free.

Fetch a single fleet by its Linear identifier (case-insensitive). It returns 404
once no fleet has launched for that issue:

```bash
curl "$BRIDGE_URL/api/jobs/ENG-7" \
  -H "authorization: Bearer $BRIDGE_TRIGGER_SECRET"
```

The response is `{ "ok": true, "generatedAt": ..., "job": { ... } }`, where
`job` has the same shape as one entry in the list above.

The bridge writes a hidden Linear comment marker before spawning agents so the
watcher, manual trigger, and future webhook do not intentionally re-run the same
issue.

## Re-running a demo (reset on leave)

To run the demo again on the same ticket, drag it from **In Progress** back to
**Backlog** or **Todo**. With `pnpm watch:linear` running, the poller detects the
move and re-arms the issue:

- Removes the 🚀 reaction and deletes the bridge's comments (via `/api/reset`),
  which clears the `fleet-started` marker.
- Closes the PRs that run opened and keeps one so there is still a result to show.
  The hero (`compound`) PR is kept by default. The rest are closed and their
  branches deleted via `gh`.

Drag the ticket back into **In Progress** to launch a fresh fleet. PR cleanup runs
in the poller, so it needs `gh` authenticated and only happens while the poller is
running. Closing a PR is reversible; reopen it from GitHub if you need it back.

## ngrok (local webhook testing)

```bash
pnpm dev
ngrok http 3001
```

Copy the HTTPS URL (e.g. `https://abc123.ngrok-free.app`).

## Register the Linear webhook

1. Open [Linear → Settings → API → Webhooks](https://linear.app/settings/api).
2. Click **New webhook**.
3. **URL:** `https://<your-host>/webhook/linear` (ngrok URL locally, Vercel URL in prod).
4. **Resource types:** Issues.
5. Copy the signing secret into `LINEAR_WEBHOOK_SECRET`.
6. Save.

## Trigger flow

1. Create a Linear issue with label `cursor-fleet`.
2. Move it from Backlog → **In Progress**.
3. The bridge spawns two cloud agents:
   - **Hero** → `{GH_OWNER}/compound` (full scope)
   - **Chorus** → `{GH_OWNER}/server` (ASP.NET middleware subset)
4. Linear comments appear with `bc-` agent IDs and PR URLs when each agent finishes.

## Deploy to Vercel

```bash
vercel link
vercel env add CURSOR_API_KEY
vercel env add LINEAR_API_KEY
vercel env add LINEAR_WEBHOOK_SECRET
vercel env add BRIDGE_TRIGGER_SECRET
vercel env add CRON_SECRET
vercel env add GH_OWNER
vercel deploy --prod
```

Update the Linear webhook URL to your production domain.

After a Linear admin registers the webhook, stop `pnpm watch:linear`. No code
change is needed; the webhook and temporary trigger both call the same fleet
launcher.
