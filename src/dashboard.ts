/**
 * Mission-control dashboard for conductor. A single self-contained HTML page that
 * polls the public `/api/board` endpoint and renders the live pipeline for every
 * launched fleet. Served at `GET /`.
 *
 * No build step and no framework: the page is plain HTML/CSS/JS so it deploys as
 * one serverless function with the rest of conductor. Cursor brand colors keep it
 * on-brand for the demo.
 *
 * The pipeline is presented as a factory assembly line. Each stage is a numbered
 * station tagged with the kind of worker that runs it, so it is obvious at a
 * glance which steps are autonomous agents, which are human-in-the-loop, which are
 * a hybrid hand-off, and which are plain automation (CI / monitors, not an agent):
 *
 *   - agent  → autonomous Cursor cloud agent (plan, build, remediate)
 *   - hybrid → agent proposes, human decides    (review: Bugbot + human)
 *   - human  → human-in-the-loop                (merge)
 *   - auto   → automation, no agent             (deploy CI, observe monitors)
 */
export const dashboardHtml = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>conductor — mission control</title>
<style>
  :root {
    --bg: #14120b; --fg: #edecec; --muted: rgba(237,236,236,0.6);
    --accent: #f54e00; --card: #1b1913; --card-02: #201e18; --card-03: #26241e;
    --done: #3fb950; --running: #f54e00; --failed: #f85149; --pending: #3a382f;
    /* Worker palette: who actually runs a station. */
    --machine: #5ed1c4; --human: #b083f0; --steel: #9aa4ad;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  header {
    display: flex; align-items: baseline; gap: 16px; padding: 20px 28px;
    border-bottom: 1px solid var(--card-03); position: sticky; top: 0; background: var(--bg); z-index: 3;
  }
  header h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
  header h1 .dot { color: var(--accent); }
  header .sub { color: var(--muted); font-size: 13px; }
  header .live { margin-left: auto; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 7px; }
  header .live .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--done); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

  /* Line-operators legend: a single key for every worker type on the line. */
  .legend {
    display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
    padding: 11px 28px; border-bottom: 1px solid var(--card-03);
    background: var(--card); position: sticky; top: 61px; z-index: 2;
  }
  .legend-title { font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(237,236,236,0.4); }
  .leg { display: inline-flex; align-items: center; gap: 8px; }
  .leg .ic { color: var(--steel); }
  .leg .ic + .ic { margin-left: -4px; }
  .leg-text { display: flex; flex-direction: column; line-height: 1.2; }
  .leg-text b { font-size: 12px; font-weight: 600; color: var(--fg); }
  .leg-text i { font-style: normal; font-size: 10.5px; color: var(--muted); }

  /* Inline icons: stroked, inherit color from their operator context. */
  .ic { width: 13px; height: 13px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .op-agent .ic-machine, .ic-machine.solo { color: var(--machine); }
  .op-human .ic-human, .ic-human.solo { color: var(--human); }
  .op-auto .ic-cog, .ic-cog.solo { color: var(--steel); }
  .op-hybrid .ic-machine { color: var(--machine); }
  .op-hybrid .ic-human { color: var(--human); }

  main { padding: 22px 28px; max-width: 1100px; margin: 0 auto; }
  .job {
    background: var(--card); border: 1px solid var(--card-03); border-radius: 12px;
    padding: 18px 20px; margin-bottom: 16px;
  }
  .job-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .job-head .id { font-weight: 600; font-size: 15px; }
  .job-head .id a { color: var(--fg); text-decoration: none; border-bottom: 1px solid transparent; }
  .job-head .id a:hover { border-bottom-color: var(--accent); }
  .job-head .title { color: var(--muted); font-size: 14px; }
  .badge { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--card-03); color: var(--muted); }
  .badge.in-progress { color: var(--accent); border-color: var(--accent); }
  .badge.complete { color: var(--done); border-color: var(--done); }
  .timer { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; }

  /* The assembly line: a horizontal run of stations joined by conveyor links. */
  .line-label { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); }
  .line-label .rail { flex: 1; height: 1px; background: linear-gradient(90deg, var(--card-03), transparent); }
  .pipeline { display: flex; align-items: stretch; flex-wrap: nowrap; gap: 0; overflow-x: auto; padding-bottom: 6px; }
  .pipeline::-webkit-scrollbar { height: 8px; }
  .pipeline::-webkit-scrollbar-thumb { background: var(--card-03); border-radius: 4px; }

  .stage {
    flex: 1 0 116px; min-width: 116px; background: var(--card-02); border-radius: 8px;
    padding: 9px 12px 11px; border-top: 2px solid var(--pending); transition: border-color 0.3s, background 0.3s;
  }
  .stage-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 9px; min-height: 14px; }
  .station-no { font-size: 10px; letter-spacing: 0.06em; color: rgba(237,236,236,0.32); }
  .op-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .op-chip .ic + .ic { margin-left: -3px; }
  .stage.op-agent .op-chip { color: var(--machine); }
  .stage.op-human .op-chip { color: var(--human); }
  .stage.op-auto .op-chip { color: var(--steel); }
  .stage.op-hybrid .op-chip { color: var(--muted); }
  .stage .name { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; color: var(--fg); }
  .stage .state { font-size: 12px; margin-top: 3px; font-weight: 500; text-transform: capitalize; color: var(--muted); }
  .stage .worker { font-size: 10.5px; line-height: 1.3; color: var(--muted); margin-top: 6px; }
  .stage.done { border-top-color: var(--done); } .stage.done .state { color: var(--done); }
  .stage.running { border-top-color: var(--running); } .stage.running .state { color: var(--accent); }
  .stage.running { animation: glow 1.8s infinite; }
  @keyframes glow { 0%,100% { background: var(--card-02); } 50% { background: var(--card-03); } }
  .stage.failed { border-top-color: var(--failed); } .stage.failed .state { color: var(--failed); }

  /* Belt: the running indicator reads like the station's machinery is turning.
     Agent/auto stations run a moving conveyor; the hybrid review station runs a
     two-tone belt (machine + human); the human station pulses, awaiting a person. */
  .belt { height: 3px; border-radius: 3px; margin-top: 10px; background: var(--pending); overflow: hidden; }
  .stage.done .belt { background: var(--done); }
  .stage.failed .belt { background: var(--failed); }
  .stage.running.op-agent .belt, .stage.running.op-auto .belt {
    background-color: rgba(245,78,0,0.16);
    background-image: repeating-linear-gradient(90deg, var(--accent) 0 9px, transparent 9px 18px);
    background-size: 36px 100%; animation: belt-move 0.8s linear infinite;
  }
  .stage.running.op-hybrid .belt {
    background-image: repeating-linear-gradient(90deg, var(--machine) 0 9px, var(--human) 9px 18px);
    background-size: 36px 100%; animation: belt-move 0.8s linear infinite;
  }
  .stage.running.op-human .belt { background: var(--human); animation: belt-pulse 1.3s ease-in-out infinite; }
  @keyframes belt-move { from { background-position: 0 0; } to { background-position: 36px 0; } }
  @keyframes belt-pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }

  /* Conveyor links: tint and animate the flow once the upstream station clears. */
  .connector { flex: 0 0 26px; display: flex; align-items: center; justify-content: center; color: var(--pending); }
  .connector svg { width: 24px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .connector.done { color: var(--done); }
  .connector.failed { color: var(--failed); }
  .connector.running { color: var(--accent); }
  .connector.running line { stroke-dasharray: 4 5; animation: flow 0.6s linear infinite; }
  @keyframes flow { to { stroke-dashoffset: -9; } }

  .agents { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
  .agent { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
  .agent .repo { color: var(--fg); }
  .agent .aid { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; }
  .agent .pr a { color: var(--accent); text-decoration: none; }
  .agent .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--pending); }
  .agent .status-dot.done { background: var(--done); }
  .agent .status-dot.running { background: var(--accent); }
  .logs-wrap { margin-top: 14px; border-top: 1px solid var(--card-03); padding-top: 12px; }
  .logs-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 8px; }
  .logs { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 9px; padding-right: 6px; }
  .logs::-webkit-scrollbar { width: 8px; }
  .logs::-webkit-scrollbar-thumb { background: var(--card-03); border-radius: 4px; }
  .log-row { display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
  .log-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); align-self: flex-start; margin-top: 5px; }
  .log-dot.plan { background: #8b949e; }
  .log-dot.build { background: var(--accent); }
  .log-dot.review { background: #d29922; }
  .log-dot.merge { background: #a371f7; }
  .log-dot.deploy { background: var(--done); }
  .log-dot.observe { background: #58a6ff; }
  .log-dot.remediate { background: var(--failed); }
  .log-time { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 11px; font-family: ui-monospace, "SF Mono", Menlo, monospace; padding-top: 1px; }
  .log-body { min-width: 0; }
  .log-msg { color: var(--fg); }
  .log-detail { color: var(--muted); font-size: 12px; margin-top: 2px; word-break: break-word; }
  .log-empty { color: var(--muted); font-size: 13px; }
  .empty { color: var(--muted); text-align: center; padding: 60px 0; font-size: 14px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; padding: 24px; }
</style>
</head>
<body>
<header>
  <h1>conductor<span class="dot">.</span></h1>
  <span class="sub">closed-loop agent factory — mission control</span>
  <span class="live"><span class="pulse"></span><span id="updated">connecting…</span></span>
</header>
<div class="legend" id="legend"></div>
<main>
  <div id="board"><div class="empty">Loading fleets…</div></div>
</main>
<footer>Polls <code>/api/board</code> every 2s · pipeline state and activity log derived from the Linear comment thread</footer>
<script>
  const STAGES = ["plan", "build", "review", "merge", "deploy", "observe", "remediate"];

  // Stroked SVG icons. They inherit color from their operator context so the same
  // markup serves the legend, the station chips, and the hybrid two-tone pairing.
  const IC = {
    machine: '<svg class="ic ic-machine" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2.5v2.5M15 2.5v2.5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5"/></svg>',
    human: '<svg class="ic ic-human" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20.5v-.6A5.5 5.5 0 0 1 10.5 14.4h3A5.5 5.5 0 0 1 19 19.9v.6"/></svg>',
    cog: '<svg class="ic ic-cog" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  };

  // Who runs each station, and the concrete worker shown under the stage name.
  const STAGE_META = {
    plan:      { op: "agent",  worker: "Planner agent" },
    build:     { op: "agent",  worker: "Fleet agents" },
    review:    { op: "hybrid", worker: "Bugbot + human" },
    merge:     { op: "human",  worker: "Human merge" },
    deploy:    { op: "auto",   worker: "Vercel CI" },
    observe:   { op: "auto",   worker: "Monitors" },
    remediate: { op: "agent",  worker: "Hotfix agent" },
  };

  const OP_LABEL = { agent: "Agent", hybrid: "Hybrid", human: "Human", auto: "Auto" };

  // Icon glyphs for an operator. Hybrid pairs machine + human to read "half/half".
  function opIcons(op) {
    if (op === "agent") return IC.machine;
    if (op === "human") return IC.human;
    if (op === "auto") return IC.cog;
    if (op === "hybrid") return IC.machine + IC.human;
    return "";
  }

  function elapsed(seconds) {
    if (seconds == null) return "";
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return m + "m " + String(s).padStart(2, "0") + "s";
  }

  function esc(str) {
    return String(str ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function renderStage(stage, state, index) {
    const meta = STAGE_META[stage] || { op: "auto", worker: "" };
    const no = String(index + 1).padStart(2, "0");
    return '<div class="stage ' + state + ' op-' + meta.op + '" title="' + esc(meta.worker) + '">' +
      '<div class="stage-top">' +
        '<span class="station-no mono">' + no + '</span>' +
        '<span class="op-chip">' + opIcons(meta.op) + '<span>' + OP_LABEL[meta.op] + '</span></span>' +
      '</div>' +
      '<div class="name">' + stage + '</div>' +
      '<div class="state">' + state + '</div>' +
      '<div class="worker">' + esc(meta.worker) + '</div>' +
      '<div class="belt"></div>' +
    '</div>';
  }

  // A conveyor link inherits the upstream station's progress: green once cleared,
  // an animated dash while that station is running, otherwise idle grey.
  function renderConnector(leftState) {
    const cls = leftState === "done" ? "done" : leftState === "running" ? "running" : leftState === "failed" ? "failed" : "";
    return '<div class="connector ' + cls + '">' +
      '<svg viewBox="0 0 26 12" aria-hidden="true"><line x1="1" y1="6" x2="19" y2="6"/><path d="M17 2.5 L24 6 L17 9.5"/></svg>' +
    '</div>';
  }

  function renderPipeline(job) {
    const parts = [];
    STAGES.forEach((stage, i) => {
      const state = (job.stages && job.stages[stage]) || "pending";
      parts.push(renderStage(stage, state, i));
      if (i < STAGES.length - 1) parts.push(renderConnector(state));
    });
    return '<div class="line-label"><span>Assembly line</span><span class="rail"></span>' +
      '<span class="mono">' + STAGES.length + ' stations · left → right</span></div>' +
      '<div class="pipeline">' + parts.join("") + '</div>';
  }

  function renderAgent(a) {
    const dot = a.done ? "done" : "running";
    const pr = a.prUrl ? '<span class="pr">· <a href="' + esc(a.prUrl) + '" target="_blank" rel="noreferrer">PR</a></span>' : "";
    return '<div class="agent"><span class="status-dot ' + dot + '"></span>' +
      '<span class="repo">' + esc(a.repo) + '</span>' +
      '<span class="aid">' + esc(a.agentId) + '</span>' + pr + '</div>';
  }

  function logTime(at) {
    if (!at) return "";
    const d = new Date(at);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // Per-fleet activity feed so each step's progress is visible, not silent.
  function renderLog(events) {
    if (!events || !events.length) {
      return '<div class="logs-wrap"><div class="logs-head">Activity</div>' +
        '<div class="log-empty">No activity yet — waiting on the first step…</div></div>';
    }
    const rows = events.map((e) => {
      const detail = e.detail ? '<div class="log-detail">' + esc(e.detail) + '</div>' : "";
      return '<div class="log-row">' +
        '<span class="log-dot ' + esc(e.stage || "") + '"></span>' +
        '<span class="log-time">' + esc(logTime(e.at)) + '</span>' +
        '<div class="log-body"><div class="log-msg">' + esc(e.message) + '</div>' + detail + '</div>' +
      '</div>';
    }).join("");
    return '<div class="logs-wrap"><div class="logs-head">Activity</div>' +
      '<div class="logs">' + rows + '</div></div>';
  }

  function renderJob(job) {
    const agents = (job.agents || []).map(renderAgent).join("") || '<div class="agent">no agents yet</div>';
    const link = job.url ? '<a href="' + esc(job.url) + '" target="_blank" rel="noreferrer">' + esc(job.identifier) + '</a>' : esc(job.identifier);
    const timer = job.status === "in-progress"
      ? '<span class="timer" data-started="' + (job.startedAt || "") + '">' + elapsed(job.runningForSeconds) + '</span>'
      : '<span class="timer">done</span>';
    return '<div class="job">' +
      '<div class="job-head">' +
        '<span class="id">' + link + '</span>' +
        '<span class="title">' + esc(job.title) + '</span>' +
        '<span class="badge ' + job.status + '">' + job.status + '</span>' +
        timer +
      '</div>' +
      renderPipeline(job) +
      '<div class="agents">' + agents + '</div>' +
      renderLog(job.events) +
    '</div>';
  }

  // One key for the whole line, so the worker chips on each station read clearly.
  function renderLegend() {
    const items = [
      ["agent", IC.machine, "Agent", "autonomous Cursor agent"],
      ["hybrid", IC.machine + IC.human, "Hybrid", "agent proposes, human decides"],
      ["human", IC.human, "Human", "human-in-the-loop"],
      ["auto", IC.cog, "Automated", "CI / monitors, no agent"],
    ];
    return '<span class="legend-title mono">Line operators</span>' + items.map((it) =>
      '<span class="leg op-' + it[0] + '">' + it[1] +
      '<span class="leg-text"><b>' + it[2] + '</b><i>' + it[3] + '</i></span></span>'
    ).join("");
  }

  async function refresh() {
    try {
      const res = await fetch("/api/board?all=1", { cache: "no-store" });
      const data = await res.json();
      const jobs = data.jobs || [];
      const board = document.getElementById("board");
      board.innerHTML = jobs.length ? jobs.map(renderJob).join("") : '<div class="empty">No fleets launched yet. Drag a cursor-fleet ticket into In Progress.</div>';
      // Re-render replaces the DOM each tick, so re-pin every feed to its latest entry.
      document.querySelectorAll(".logs").forEach((el) => { el.scrollTop = el.scrollHeight; });
      document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();
    } catch (err) {
      document.getElementById("updated").textContent = "reconnecting…";
    }
  }

  // Tick the in-progress timers locally between polls for a live feel.
  setInterval(() => {
    document.querySelectorAll(".timer[data-started]").forEach((el) => {
      const started = el.getAttribute("data-started");
      if (!started) return;
      const secs = Math.max(0, Math.round((Date.now() - Date.parse(started)) / 1000));
      const m = Math.floor(secs / 60), s = secs % 60;
      el.textContent = m + "m " + String(s).padStart(2, "0") + "s";
    });
  }, 1000);

  document.getElementById("legend").innerHTML = renderLegend();
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
