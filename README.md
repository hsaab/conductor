# cursor-demo-bridge

Linear webhook bridge that spawns Cursor cloud agents when a `cursor-fleet` ticket moves to **In Progress**.

## Prerequisites

- Node 20+
- [pnpm](https://pnpm.io/)
- Cursor API key ([Dashboard → Integrations](https://cursor.com/dashboard/integrations))
- Linear API key ([Settings → API](https://linear.app/settings/api))
- GitHub owner with `compound` and `server` repos

## Environment variables

| Variable | Purpose |
|---|---|
| `CURSOR_API_KEY` | Cursor SDK auth |
| `LINEAR_API_KEY` | Post comments back to Linear |
| `LINEAR_WEBHOOK_SECRET` | Verify Linear webhook signatures |
| `GH_OWNER` | GitHub org/user (default: `hsaab`) |

## Local development

```bash
pnpm install
export CURSOR_API_KEY=...
export LINEAR_API_KEY=...
export LINEAR_WEBHOOK_SECRET=...
export GH_OWNER=hsaab
pnpm dev
```

Health check: `curl http://localhost:3001/api/health`

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
vercel env add GH_OWNER
vercel deploy --prod
```

Update the Linear webhook URL to your production domain.
