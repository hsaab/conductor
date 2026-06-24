# Moving this bridge to internalsphere

A runbook for relocating `cursor-demo-bridge` from the personal Vercel account to
**internalsphere** (`github.com/internalsphere` + the `anysphere-internal` Vercel
team). The internalsphere orchestrator owns all hosting/CI/secrets wiring — you
create a repo and open PRs; the `internalsphere-ranger` bot does the rest.

> **Why this can't be done by the cloud agent.** Creating the org repo, running
> the orchestrator, migrating SOPS secrets, and granting the webhook public-route
> exception all require `internalsphere` org access (SSO/SSH) and are outside a
> cloud-agent sandbox. The steps below are for a human or a local Cursor session
> with internalsphere access.

## 0. The blocker to settle first: the public webhook route

Every internalsphere app is **SSO-protected to Cursor employees by default**.
This bridge depends on a few **unauthenticated, publicly reachable** endpoints:

- `POST /webhook/linear` — Linear delivers events here; we authenticate them
  ourselves via HMAC (`LINEAR_WEBHOOK_SECRET`), not via SSO.
- `POST /webhook/vercel` — Vercel deployment webhooks authenticate with
  `VERCEL_WEBHOOK_SECRET`.
- `POST /webhook/datadog` — Datadog monitor webhooks authenticate with
  `DATADOG_WEBHOOK_SECRET`.

Under default SSO, external webhook deliveries get bounced and nothing triggers. **Ask in
`#proj-internalsphere` for per-route public access** for `/webhook/linear`,
`/webhook/vercel`, `/webhook/datadog`, and `/api/health` before relying on the deploy.

- `/api/reconcile` (cron) is fine: Vercel Cron bypasses deployment protection.
- `/api/trigger` and `/api/reset` are manual backups — leave them SSO-protected.

## 1. Prerequisites

- Be a member of the `internalsphere` GitHub org; SSH key SSO-authorized for it.
- `brew install git gh sops age python pnpm node` and `gh auth login`.

## 2. Create the repo (orchestrator bootstraps Vercel)

1. Create an **empty private** repo `internalsphere/cursor-demo-bridge` with a
   `main` branch.
2. Wait ~1 min for the `internalsphere-ranger` bootstrap PR (it seeds
   `app-manifest.yml`, `.sops.yaml`, `secrets/`, CI, skills, and creates+links the
   Vercel project under `anysphere-internal`). Merge it.

## 3. Bring this code in (via PR — no direct push to `main`)

```bash
git clone git@github.com:internalsphere/cursor-demo-bridge.git
cd cursor-demo-bridge
sh scripts/setup-repo.sh   # one-time, installs git hooks + deps
git checkout -b import-bridge
# copy in: src/, package.json, pnpm-lock.yaml, tsconfig.json, vercel.json,
#          app-manifest.yml, README.md, ARCHITECTURE.md, scripts/
git add . && git commit -m "Import cursor-demo-bridge" && git push -u origin import-bridge
```

Reconcile with the orchestrator's managed files — **don't** hand-edit CI/workflow
files. Our `app-manifest.yml` (no integrations) should merge cleanly with the
seeded baseline; if the orchestrator's differs, keep its managed fields and only
preserve our `version: 1` + (empty) integrations.

## 4. Migrate secrets via SOPS (never `.env`, never the Vercel UI)

Run from the repo. Each prompts for the value (hidden), encrypts it into
`secrets/<scope>/<KEY>.sops.json`; commit + PR + merge → CI syncs to Vercel.

```bash
for KEY in CURSOR_API_KEY LINEAR_API_KEY LINEAR_WEBHOOK_SECRET BRIDGE_TRIGGER_SECRET CRON_SECRET VERCEL_WEBHOOK_SECRET DATADOG_WEBHOOK_SECRET DD_API_KEY DD_APP_KEY DD_SITE SLACK_WEBHOOK_URL GH_OWNER DEPLOY_TARGET_REPO; do
  python3 scripts/secrets.py add --scope production --key "$KEY"
done
# repeat with --scope preview if preview deploys should also function
```

Values to use (pull from the current `.env` / personal Vercel project):

| Key | Notes |
|---|---|
| `CURSOR_API_KEY` | Cursor SDK auth |
| `LINEAR_API_KEY` | fe-cursor workspace key (posts comments back) |
| `LINEAR_WEBHOOK_SECRET` | must equal the secret on the Linear webhook |
| `BRIDGE_TRIGGER_SECRET` | guards `/api/trigger`, `/api/reset` |
| `CRON_SECRET` | Vercel Cron auth for `/api/reconcile` |
| `VERCEL_WEBHOOK_SECRET` | guards `/webhook/vercel` |
| `DATADOG_WEBHOOK_SECRET` | guards `/webhook/datadog` |
| `DD_API_KEY` / `DD_APP_KEY` / `DD_SITE` | optional Datadog post-deploy error scan |
| `SLACK_WEBHOOK_URL` | Slack output for deploy/remediation stages |
| `GH_OWNER` | GitHub owner for target repos |
| `DEPLOY_TARGET_REPO` | repo whose deploys/alerts close the loop |

## 5. Cron cadence

`vercel.json` ships a **daily** cron (`0 9 * * *`) so it stays valid on a Hobby
plan. `anysphere-internal` is a paid team, so on internalsphere bump it to
minute-level for automatic fast reconcile:

```json
"crons": [{ "path": "/api/reconcile", "schedule": "* * * * *" }]
```

## 6. Repoint the Linear webhook to the new URL

After the first production deploy, get the canonical URL from the
`anysphere-internal` Deployments tab, then update the existing fe-cursor webhook
(id `13a10cc0-caa7-468e-b120-0c7647c4ce33`) to it — keep the same signing secret:

```bash
# LINEAR_API_KEY = fe-cursor key
curl -s https://api.linear.app/graphql \
  -H "Content-Type: application/json" -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"mutation($id:String!,$url:String!){webhookUpdate(id:$id,input:{url:$url}){success}}","variables":{"id":"13a10cc0-caa7-468e-b120-0c7647c4ce33","url":"https://<new-internalsphere-url>/webhook/linear"}}'
```

## 7. Verify it works

- `GET  <url>/api/health` → `{"ok":true}`.
- Signed-but-non-fleet webhook → `200`; bad signature → `401`.
- Move the fe-cursor **FE-5** ticket to **In Progress** → ticket reacts 🚀,
  "bridge engaged" + per-subagent "agent spawned" comments appear, PRs open in
  the planned repos, and the reconcile cron posts the PR links back.
- Send signed Vercel and Datadog test payloads to verify `/webhook/vercel` and
  `/webhook/datadog` can bypass SSO and authenticate with their shared secrets.

## 8. Decommission

Once the internalsphere deploy is verified, delete the personal-account
`cursor-demo-bridge` Vercel project so only one bridge is live.
