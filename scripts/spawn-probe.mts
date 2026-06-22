/**
 * One-off probe: spawn a single Cursor cloud agent exactly like the bridge does
 * (Agent.create + cloud repos), then read it back from the API as evidence that
 * it actually registered server-side. Read-only prompt, PR creation disabled.
 *
 * Run: set -a && source .env.local && set +a && npx tsx scripts/spawn-probe.mts
 */
import { Agent, CursorAgentError } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY ?? "";
const owner = process.env.GH_OWNER ?? "hsaab";
const model = process.env.BRIDGE_MODEL_ID ?? "composer-2.5";
const repoUrl = `https://github.com/${owner}/compound`;

function keyFingerprint(key: string): string {
  if (!key) return "<empty>";
  return `${key.slice(0, 7)}…${key.slice(-4)} (len ${key.length})`;
}

async function main(): Promise<void> {
  console.log(`[probe] CURSOR_API_KEY: ${keyFingerprint(apiKey)}`);
  console.log(`[probe] model: ${model}`);
  console.log(`[probe] target repo: ${repoUrl}`);
  if (!apiKey) {
    console.error("[probe] no CURSOR_API_KEY in env — aborting");
    process.exit(1);
  }

  try {
    await using agent = await Agent.create({
      apiKey,
      model: { id: model },
      cloud: {
        repos: [{ url: repoUrl }],
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    });

    const run = await agent.send(
      "Reply with the repository name and current git branch. Do not modify any files or open a PR.",
    );
    console.log(`[probe] SPAWNED agentId=${agent.agentId} runId=${run.id}`);

    // Evidence #1: read the agent back from the cloud API by ID.
    const info = await Agent.get(agent.agentId, { apiKey });
    console.log(`[probe] Agent.get → ${JSON.stringify(info, null, 2)}`);

    // Evidence #2: list runs for this agent (what the reconciler uses).
    const runs = await Agent.listRuns(agent.agentId, { runtime: "cloud", apiKey });
    console.log(
      `[probe] Agent.listRuns → ${runs.items.length} run(s): ${runs.items
        .map((r: { id?: string; status?: string }) => `${r.id}:${r.status}`)
        .join(", ")}`,
    );

    console.log(`[probe] DONE — agent ${agent.agentId} is live on the cloud under this key's identity.`);
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(`[probe] CursorAgentError (never started): ${err.message} retryable=${err.isRetryable}`);
      process.exit(2);
    }
    console.error("[probe] unexpected error:", err);
    process.exit(3);
  }
}

void main();
