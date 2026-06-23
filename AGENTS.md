# conductor — agent notes

conductor is a stateless Express orchestration server (TypeScript, run via `tsx`). It has no database — pipeline state lives entirely in Linear comment markers. See `README.md` for the full architecture, HTTP surface, environment-variable table, and demo runbook.

## Cursor Cloud specific instructions

The startup update script only refreshes dependencies (`pnpm install`). Everything else below is durable runtime context.

- **Dev server:** `pnpm dev` (`tsx watch src/index.ts`) listens on port **3001** (override with `PORT`). Liveness check: `curl http://localhost:3001/api/health` → `{"ok":true}`. The mission-control dashboard is served as static HTML at `GET /`.
- **Checks:** `pnpm build` is typecheck-only (`tsc --noEmit`); `pnpm test` runs the node test runner over `src/**/*.test.ts` via `tsx`. There is no separate compiled bundle step.
- **External secrets gate the real loop, not local boot.** With no secrets set, the server still boots, serves the dashboard, answers `/api/health`, and auth-gates protected endpoints (e.g. `POST /api/trigger` returns `401`). Endpoints that call Linear (such as `GET /api/board`, which the dashboard polls every 2s) return `500 "LINEAR_API_KEY is required"` until keys are provided. To exercise the planner/fleet/observability/remediation flow end-to-end you need the secrets from the README env table (`CURSOR_API_KEY`, `LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`, `BRIDGE_TRIGGER_SECRET`, webhook secrets, `SLACK_WEBHOOK_URL`), typically loaded via a gitignored `.env` with `set -a && source .env && set +a` before `pnpm dev`.
- **Module imports use `.js` extensions** on relative paths (ESM, `"type": "module"`) even though the sources are `.ts` — keep that convention when adding files.
