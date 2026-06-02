#!/usr/bin/env node
/**
 * Live agent activity feed.
 *
 * Streams a cloud agent's run (`run.stream()` from the Cursor SDK) and turns
 * each SDK message into a short, human-readable line — the assistant's text,
 * the tools it runs (editing / reading / running tests), and so on. This is the
 * "things are happening" log we surface to the terminal and the canvas while an
 * agent works.
 *
 * A run obtained from `Agent.listRuns(...)` is a full Run instance that supports
 * streaming by (agentId, runId), so we can tail runs the bridge launched in
 * another process. Streaming replays history first, then follows live, and ends
 * on its own when the run reaches a terminal state.
 */

/** Friendly verbs for the tool names cloud agents emit most often. */
const TOOL_VERBS = {
  edit_file: "editing",
  search_replace: "editing",
  write: "writing",
  create_file: "creating",
  delete_file: "deleting",
  read_file: "reading",
  list_dir: "listing",
  file_search: "finding",
  grep: "searching",
  grep_search: "searching",
  codebase_search: "searching",
  run_terminal_cmd: "running",
  terminal: "running",
  web_search: "searching the web",
};

/** Collapses whitespace and clips a string to a readable length. */
function snippet(text, max = 90) {
  const collapsed = String(text).replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** First meaningful path/command/query from a (possibly truncated) tool args. */
function describeToolArgs(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["target_file", "path", "file_path", "relative_workspace_path", "command", "query", "search"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return snippet(value, 60);
  }
  return "";
}

function describeToolCall(message) {
  const verb = TOOL_VERBS[message.name] ?? String(message.name ?? "working").replace(/_/g, " ");
  const target = describeToolArgs(message.args);
  const base = target ? `${verb} ${target}` : verb;
  return message.status && message.status !== "completed" ? `${base} (${message.status})` : base;
}

/**
 * Concatenated text from an assistant message. Cloud assistant frames arrive as
 * token-level deltas, so callers must accumulate these across messages rather
 * than treating each as a complete line.
 */
export function assistantText(message) {
  if (message?.type !== "assistant") return "";
  let text = "";
  for (const block of message.message?.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * Turns one discrete SDK message (a tool call or task) into a single activity
 * line, or `null` for messages that are streamed deltas (assistant text) or
 * pure noise (thinking / status). Assistant prose is coalesced separately by
 * {@link ActivityTailer}.
 */
export function formatActivity(message) {
  switch (message?.type) {
    case "tool_call":
      return describeToolCall(message);
    case "task":
      return message.text ? snippet(message.text) : null;
    default:
      return null; // assistant deltas, thinking, status, system.
  }
}

function shortId(agentId) {
  return agentId.length > 13 ? agentId.slice(0, 13) : agentId;
}

/**
 * Tails one stream per agent, keeping a capped ring buffer of recent activity
 * lines and echoing each new line to the provided logger. Idempotent: calling
 * {@link ActivityTailer#ensure} repeatedly for the same agent only starts one
 * stream.
 */
export class ActivityTailer {
  constructor({ apiKey, maxLines = 5, log = () => {} }) {
    this.apiKey = apiKey;
    this.maxLines = maxLines;
    this.log = log;
    this.buffers = new Map();
    this.started = new Set();
    this.sdk = null;
    /** Per-agent accumulator for streamed assistant text deltas. */
    this.pending = new Map();
  }

  getLines(agentId) {
    return this.buffers.get(agentId) ?? [];
  }

  /** Start tailing an agent's run if we have a key and aren't already tailing. */
  ensure(agentId) {
    if (!this.apiKey || this.started.has(agentId)) return;
    this.started.add(agentId);
    this.tail(agentId).catch((err) => {
      this.log(`[activity] ${shortId(agentId)} stream error: ${err instanceof Error ? err.message : String(err)}`);
      this.started.delete(agentId); // allow a retry on the next tick
    });
  }

  push(agentId, line) {
    const lines = this.buffers.get(agentId) ?? [];
    if (lines[lines.length - 1] === line) return; // collapse immediate repeats
    lines.push(line);
    while (lines.length > this.maxLines) lines.shift();
    this.buffers.set(agentId, lines);
    this.log(`[activity] ${shortId(agentId)} ${line}`);
  }

  /** Accumulate streamed assistant text, flushing on sentence/length bounds. */
  appendText(agentId, delta) {
    if (!delta) return;
    const text = (this.pending.get(agentId) ?? "") + delta;
    this.pending.set(agentId, text);
    if (/[.!?:]\s*$/.test(text) || text.trim().length >= 80) this.flushText(agentId);
  }

  /** Emit any buffered assistant prose as one line. */
  flushText(agentId) {
    const text = (this.pending.get(agentId) ?? "").trim();
    this.pending.delete(agentId);
    if (text) this.push(agentId, snippet(text, 120));
  }

  async tail(agentId) {
    this.sdk ??= await import("@cursor/sdk");
    const { Agent } = this.sdk;
    const runs = await Agent.listRuns(agentId, { runtime: "cloud", apiKey: this.apiKey });
    const run = [...(runs.items ?? [])].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    if (!run) {
      this.started.delete(agentId);
      return;
    }
    if (typeof run.supports === "function" && !run.supports("stream")) return;
    for await (const message of run.stream()) {
      if (message?.type === "assistant") {
        this.appendText(agentId, assistantText(message));
        continue;
      }
      // A discrete action (tool call) ends the current sentence: flush, then log it.
      this.flushText(agentId);
      const line = formatActivity(message);
      if (line) this.push(agentId, line);
    }
    this.flushText(agentId); // trailing prose when the run ends
  }
}
