#!/usr/bin/env node
/**
 * Live demo follower.
 *
 * Turns the silent gap between "fleet queued" and "PR opened" into visible
 * motion. It discovers the agents the bridge launched (from `/api/jobs`), reads
 * each cloud run's live status through the Cursor SDK, prints status
 * transitions to the terminal, and rewrites the data block of the fleet-status
 * canvas so the dashboard animates through queued -> running -> finished.
 *
 * This intentionally lives in the local poller process, not the serverless
 * bridge: a long-running Node process can observe runs continuously, which a
 * serverless function (capped at a few minutes) cannot. The bridge stays
 * fire-and-forget; observability for the demo lives here.
 */
import { readFile, writeFile } from "node:fs/promises";
import { ActivityTailer } from "./agent-activity.mjs";

/** Run statuses that mean the agent is done (mirrors the bridge reconciler). */
const TERMINAL_STATUSES = new Set(["finished", "error", "cancelled", "failed"]);

/** Region in the canvas source that the follower owns and rewrites. */
const CANVAS_DATA_RE = /\/\* fleet-data:start \*\/[\s\S]*?\/\* fleet-data:end \*\//;

/** Newest run wins, so a re-run's status replaces a stale one. */
function pickLatestRun(runs) {
  if (!runs || runs.length === 0) return undefined;
  return [...runs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status).toLowerCase());
}

/** Normalizes a run's `createdAt` (epoch seconds, epoch ms, or ISO) to ms. */
function toMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return value < 1e12 ? Math.round(value * 1000) : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Observes one fleet trigger end-to-end and renders it to terminal + canvas.
 * Construct once and call {@link FleetFollower#refresh} on each poll tick.
 */
export class FleetFollower {
  /**
   * @param {object} opts
   * @param {string} opts.bridgeUrl       Deployed bridge base URL.
   * @param {string} opts.triggerSecret   Bearer secret for the secured endpoints.
   * @param {string} [opts.cursorApiKey]  Cursor SDK key; enables live run status.
   * @param {string} [opts.canvasPath]    Absolute path to the fleet-status canvas.
   * @param {number} [opts.maxFleets]     How many recent fleets to surface.
   * @param {(line: string) => void} [opts.log]
   */
  constructor({ bridgeUrl, triggerSecret, cursorApiKey, canvasPath, maxFleets = 3, log = console.log }) {
    this.bridgeUrl = bridgeUrl.replace(/\/$/, "");
    this.triggerSecret = triggerSecret;
    this.cursorApiKey = cursorApiKey;
    this.canvasPath = canvasPath;
    this.maxFleets = maxFleets;
    this.log = log;
    /** Last known status per agent id, so we only log/poll on change. */
    this.agentState = new Map();
    /** Lazily-imported Cursor SDK module. */
    this.sdk = null;
    this.warnedNoKey = false;
    /** Streams each agent's run for the live "what it's doing" activity feed. */
    this.tailer = new ActivityTailer({ apiKey: cursorApiKey, log });
  }

  /** Pulls every launched fleet the bridge knows about (Linear-derived). */
  async fetchFleets() {
    const res = await fetch(`${this.bridgeUrl}/api/jobs?all=1`, {
      headers: { Authorization: `Bearer ${this.triggerSecret}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();
    return Array.isArray(json.jobs) ? json.jobs : [];
  }

  /**
   * Reads an agent's latest cloud run status via the SDK. Returns `null` when
   * no Cursor key is configured, so the caller can fall back to the bridge's
   * coarser (Linear-derived) `done` flag.
   */
  async readLiveStatus(agentId) {
    if (!this.cursorApiKey) {
      if (!this.warnedNoKey) {
        this.log("[follow] CURSOR_API_KEY not set — using bridge done flags (no live running state)");
        this.warnedNoKey = true;
      }
      return null;
    }
    try {
      this.sdk ??= await import("@cursor/sdk");
      const { Agent } = this.sdk;
      const runs = await Agent.listRuns(agentId, { runtime: "cloud", apiKey: this.cursorApiKey });
      const run = pickLatestRun(runs.items);
      if (!run) return { status: "queued", terminal: false, prUrl: null, startedAtMs: null };
      const prUrl = run.git?.branches?.find((b) => b.prUrl)?.prUrl ?? null;
      return {
        status: run.status,
        terminal: isTerminal(run.status),
        prUrl,
        startedAtMs: toMs(run.createdAt),
      };
    } catch (err) {
      this.log(`[follow] could not read runs for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Coarse fallback derived purely from the bridge's `done` flag. */
  static fallbackStatus(agent) {
    return agent.done
      ? { status: "finished", terminal: true, prUrl: null, startedAtMs: null }
      : { status: "working", terminal: false, prUrl: null, startedAtMs: null };
  }

  /** Resolves an agent's current status, reusing a cached terminal result. */
  async resolveAgent(agent) {
    const cached = this.agentState.get(agent.agentId);
    if (cached?.terminal) return cached; // done is done — stop polling it.
    return (await this.readLiveStatus(agent.agentId)) ?? FleetFollower.fallbackStatus(agent);
  }

  /** Logs a single status change to the terminal. */
  logTransition(fleet, agent, prev, next) {
    const from = prev?.status ?? "·";
    const where = `${fleet.identifier} ${agent.role}/${agent.repo}`;
    const pr = next.prUrl ? `   PR ${next.prUrl}` : "";
    this.log(`[follow] ${where.padEnd(34)} ${from} -> ${next.status}${pr}`);
  }

  /**
   * One observation pass: resolve every agent, log changes, and re-render the
   * canvas if anything moved. Returns the list of transitions this tick.
   */
  async refresh() {
    let fleets;
    try {
      fleets = await this.fetchFleets();
    } catch (err) {
      this.log(`[follow] bridge /api/jobs unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    const recent = fleets
      .filter((f) => Array.isArray(f.agents) && f.agents.length > 0)
      .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")))
      .slice(0, this.maxFleets);

    const transitions = [];
    const fleetViews = [];
    for (const fleet of recent) {
      const agentViews = [];
      for (const agent of fleet.agents) {
        const next = await this.resolveAgent(agent);
        const prev = this.agentState.get(agent.agentId);
        if (!prev || prev.status !== next.status) {
          this.logTransition(fleet, agent, prev, next);
          transitions.push({ identifier: fleet.identifier, role: agent.role, ...next });
        }
        this.agentState.set(agent.agentId, next);
        // Stream the agent's work for the live activity feed (idempotent).
        this.tailer.ensure(agent.agentId);
        agentViews.push({
          role: agent.role,
          repo: agent.repo,
          agentId: agent.agentId,
          status: next.status,
          terminal: next.terminal,
          prUrl: next.prUrl,
          startedAtMs: next.startedAtMs ?? null,
          activity: this.tailer.getLines(agent.agentId),
        });
      }
      fleetViews.push({
        identifier: fleet.identifier,
        title: fleet.title ?? fleet.identifier,
        url: fleet.url ?? null,
        state: fleet.state ?? null,
        status: fleet.status ?? "in-progress",
        startedAt: fleet.startedAt ?? null,
        agents: agentViews,
      });
    }

    if (this.canvasPath) await this.renderCanvas(fleetViews);
    return transitions;
  }

  /** Rewrites only the canvas data block; the IDE hot-reloads the result. */
  async renderCanvas(fleetViews) {
    const agents = fleetViews.flatMap((f) => f.agents);
    const snapshot = {
      generatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary: {
        fleetsInProgress: fleetViews.filter((f) => f.status !== "complete").length,
        agentsRunning: agents.filter((a) => !a.terminal).length,
        agentsFinished: agents.filter((a) => a.terminal).length,
        prsOpened: agents.filter((a) => a.prUrl).length,
      },
      fleets: fleetViews,
    };

    let src;
    try {
      src = await readFile(this.canvasPath, "utf8");
    } catch {
      return; // Canvas file not present yet; terminal output still works.
    }
    if (!CANVAS_DATA_RE.test(src)) return;
    const block = `/* fleet-data:start */\nconst SNAPSHOT: Snapshot = ${JSON.stringify(snapshot, null, 2)};\n/* fleet-data:end */`;
    const next = src.replace(CANVAS_DATA_RE, block);
    if (next !== src) await writeFile(this.canvasPath, next, "utf8");
  }
}
