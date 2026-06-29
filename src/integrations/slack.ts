/**
 * Slack output for conductor. The observability and remediation stages post
 * human-readable status here. Output only: conductor never accepts commands from
 * Slack (agent spawning stays gated behind Linear + signed webhooks).
 *
 * Best-effort by design: a missing webhook URL or a transient Slack error never
 * breaks the pipeline, it just logs and moves on.
 */
import { slackWebhookUrl } from "./config.js";

export interface SlackMessage {
  /** Fallback text and notification summary. */
  text: string;
  /** Optional richer Block Kit payload; falls back to `text` when omitted. */
  blocks?: unknown[];
}

/**
 * Post a message to the configured Slack incoming webhook.
 * Returns true on a 2xx response, false otherwise (never throws).
 */
export async function postSlack(message: SlackMessage): Promise<boolean> {
  const url = slackWebhookUrl();
  if (!url) {
    console.warn("[slack] SLACK_WEBHOOK_URL not set; skipping message:", message.text);
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.blocks ? { text: message.text, blocks: message.blocks } : { text: message.text }),
    });
    if (!res.ok) {
      console.error(`[slack] webhook returned ${res.status}: ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[slack] failed to post message:", err);
    return false;
  }
}

/** Builds a section + context Block Kit message with a bold headline and detail lines. */
export function statusBlocks(headline: string, lines: string[]): SlackMessage {
  const text = `${headline}\n${lines.join("\n")}`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${headline}*` } },
      ...(lines.length
        ? [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }]
        : []),
      { type: "context", elements: [{ type: "mrkdwn", text: "conductor" }] },
    ],
  };
}
