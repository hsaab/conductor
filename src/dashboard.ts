/**
 * Mission-control dashboard for conductor. A single self-contained HTML page that
 * polls the public `/api/board` endpoint and renders the live pipeline for every
 * launched fleet. Served at `GET /`.
 *
 * No build step and no framework: the page is plain HTML/CSS/JS so it deploys as
 * one serverless function with the rest of conductor. Cursor brand colors keep it
 * on-brand for the demo.
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
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: baseline; gap: 16px; padding: 20px 28px;
    border-bottom: 1px solid var(--card-03); position: sticky; top: 0; background: var(--bg); z-index: 2;
  }
  header h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
  header h1 .dot { color: var(--accent); }
  header .sub { color: var(--muted); font-size: 13px; }
  header .live { margin-left: auto; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 7px; }
  header .live .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--done); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
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
  .pipeline { display: flex; gap: 8px; flex-wrap: wrap; }
  .stage {
    flex: 1 1 0; min-width: 96px; background: var(--card-02); border-radius: 8px; padding: 10px 12px;
    border-left: 3px solid var(--pending); transition: border-color 0.3s;
  }
  .stage .name { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .stage .state { font-size: 13px; margin-top: 4px; font-weight: 500; text-transform: capitalize; }
  .stage.done { border-left-color: var(--done); } .stage.done .state { color: var(--done); }
  .stage.running { border-left-color: var(--running); } .stage.running .state { color: var(--accent); }
  .stage.running { animation: glow 1.6s infinite; }
  @keyframes glow { 0%,100% { background: var(--card-02); } 50% { background: var(--card-03); } }
  .stage.failed { border-left-color: var(--failed); } .stage.failed .state { color: var(--failed); }
  .agents { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
  .agent { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
  .agent .repo { color: var(--fg); }
  .agent .aid { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; }
  .agent .pr a { color: var(--accent); text-decoration: none; }
  .agent .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--pending); }
  .agent .status-dot.done { background: var(--done); }
  .agent .status-dot.running { background: var(--accent); }
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
<main>
  <div id="board"><div class="empty">Loading fleets…</div></div>
</main>
<footer>Polls <code>/api/board</code> every 2s · state derived from Linear comment markers</footer>
<script>
  const STAGES = ["plan", "build", "review", "merge", "deploy", "observe", "remediate"];

  function elapsed(seconds) {
    if (seconds == null) return "";
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return m + "m " + String(s).padStart(2, "0") + "s";
  }

  function esc(str) {
    return String(str ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function renderStage(stage, state) {
    return '<div class="stage ' + state + '"><div class="name">' + stage + '</div><div class="state">' + state + '</div></div>';
  }

  function renderAgent(a) {
    const dot = a.done ? "done" : "running";
    const pr = a.prUrl ? '<span class="pr">· <a href="' + esc(a.prUrl) + '" target="_blank" rel="noreferrer">PR</a></span>' : "";
    return '<div class="agent"><span class="status-dot ' + dot + '"></span>' +
      '<span class="repo">' + esc(a.repo) + '</span>' +
      '<span class="aid">' + esc(a.agentId) + '</span>' + pr + '</div>';
  }

  function renderJob(job) {
    const stages = STAGES.map((s) => renderStage(s, (job.stages && job.stages[s]) || "pending")).join("");
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
      '<div class="pipeline">' + stages + '</div>' +
      '<div class="agents">' + agents + '</div>' +
    '</div>';
  }

  async function refresh() {
    try {
      const res = await fetch("/api/board?all=1", { cache: "no-store" });
      const data = await res.json();
      const jobs = data.jobs || [];
      const board = document.getElementById("board");
      board.innerHTML = jobs.length ? jobs.map(renderJob).join("") : '<div class="empty">No fleets launched yet. Drag a cursor-fleet ticket into In Progress.</div>';
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

  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
