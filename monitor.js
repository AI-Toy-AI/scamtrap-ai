import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.MONITOR_PORT || 10001);
const DATA_DIR = path.join(__dirname, "monitor-data");
const LOG_FILE = path.join(DATA_DIR, "events.jsonl");
const MAX_EVENTS = Number(process.env.MONITOR_MAX_EVENTS || 5000);
const MONITOR_USER = process.env.MONITOR_USER;
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD;

fs.mkdirSync(DATA_DIR, { recursive: true });

const state = {
  startedAt: new Date().toISOString(),
  totalEvents: 0,
  activeCalls: new Map(),
  recentEvents: [],
  counters: { callsStarted: 0, callsCompleted: 0, errors: 0, warnings: 0, apiErrors: 0, streamErrors: 0 }
};

function loadSavedEvents() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean).slice(-MAX_EVENTS);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (!event || !event.type || !event.timestamp) continue;
        state.recentEvents.push(event);
        state.totalEvents += 1;
        if (event.type === "call.started") state.counters.callsStarted += 1;
        if (event.type === "call.completed") state.counters.callsCompleted += 1;
        if (event.type === "error") state.counters.errors += 1;
        if (event.type === "warning") state.counters.warnings += 1;
        if (event.type === "api.error") state.counters.apiErrors += 1;
        if (event.type === "stream.error") state.counters.streamErrors += 1;
      } catch {}
    }
    state.recentEvents = state.recentEvents.slice(-100).reverse();
  } catch (error) {
    console.error("ScamDecoy monitor history load error:", error.message);
  }
}

loadSavedEvents();

function addEvent(type, data = {}) {
  const event = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), type, data };
  state.totalEvents += 1;
  state.recentEvents.unshift(event);
  state.recentEvents = state.recentEvents.slice(0, 100);
  if (type === "call.started") state.counters.callsStarted += 1;
  if (type === "call.completed") state.counters.callsCompleted += 1;
  if (type === "error") state.counters.errors += 1;
  if (type === "warning") state.counters.warnings += 1;
  if (type === "api.error") state.counters.apiErrors += 1;
  if (type === "stream.error") state.counters.streamErrors += 1;
  try { fs.appendFileSync(LOG_FILE, `${JSON.stringify(event)}\n`, "utf8"); } catch (error) { console.error("ScamDecoy monitor log error:", error.message); }
  return event;
}

export function recordEvent(type, data = {}) { return addEvent(type, data); }
export function callStarted(callId, data = {}) {
  if (!callId) return null;
  state.activeCalls.set(String(callId), { callId: String(callId), startedAt: Date.now(), ...data });
  return addEvent("call.started", { callId: String(callId), ...data });
}
export function callCompleted(callId, data = {}) {
  if (!callId) return null;
  const id = String(callId), active = state.activeCalls.get(id);
  const durationMs = active ? Date.now() - active.startedAt : null;
  state.activeCalls.delete(id);
  return addEvent("call.completed", { callId: id, durationMs, durationSeconds: durationMs == null ? null : Math.round(durationMs / 1000), ...data });
}
export function recordError(message, data = {}) { return addEvent("error", { message: String(message || "Unknown error"), ...data }); }
export function recordWarning(message, data = {}) { return addEvent("warning", { message: String(message || "Unknown warning"), ...data }); }
export function recordApiError(message, data = {}) { return addEvent("api.error", { message: String(message || "API error"), ...data }); }
export function recordStreamError(message, data = {}) { return addEvent("stream.error", { message: String(message || "Stream error"), ...data }); }

function health() {
  const memory = process.memoryUsage();
  return { status: "ok", service: "ScamDecoy Monitor", uptimeSeconds: Math.round(process.uptime()), startedAt: state.startedAt, timestamp: new Date().toISOString(), activeCalls: state.activeCalls.size, totalEvents: state.totalEvents, counters: state.counters, memory: { rssMb: Math.round(memory.rss / 1024 / 1024), heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024), heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024) } };
}

function authorized(req) {
  if (!MONITOR_USER || !MONITOR_PASSWORD) return false;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return decoded.slice(0, separator) === MONITOR_USER && decoded.slice(separator + 1) === MONITOR_PASSWORD;
  } catch { return false; }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function sendDashboard(res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScamDecoy Private Monitor</title>
<style>
body{margin:0;background:#07111f;color:#f5f7fa;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1100px;margin:auto;padding:24px 16px 40px}
.top{display:flex;justify-content:space-between;align-items:center;gap:15px;margin-bottom:8px}
.brand{font-size:1.55rem;font-weight:900}.brand span{color:#65e6a0}
.status{padding:7px 12px;border-radius:999px;background:#123522;color:#65e6a0;font-weight:800;font-size:.82rem}
.sub{color:#8290a3;margin:0 0 18px;font-size:.92rem}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 20px}
button{border:1px solid #2a405b;background:#13243a;color:#fff;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer}
button:hover{background:#19304b}
.updated{color:#8290a3;font-size:.82rem;align-self:center}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 22px}
.card{background:#0d1b2d;border:1px solid #1d3047;border-radius:16px;padding:17px}
.label{color:#8290a3;font-size:.72rem;text-transform:uppercase;letter-spacing:1px}
.value{font-size:1.75rem;font-weight:900;margin-top:6px}
.help{font-size:.78rem;color:#8290a3;margin-top:5px;line-height:1.35}
.ok{color:#65e6a0}.err{color:#ff8d8d}.warn{color:#ffd27d}
.panel{background:#0d1b2d;border:1px solid #1d3047;border-radius:16px;padding:16px;margin-bottom:18px}
.panel h2{margin:0 0 5px;font-size:1.15rem}.panel p{color:#8290a3;margin:0 0 14px;font-size:.88rem;line-height:1.45}
.tableWrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:650px}
th,td{text-align:left;padding:11px 9px;border-bottom:1px solid #1d3047;font-size:.86rem;vertical-align:top}
th{color:#8290a3;font-size:.75rem;text-transform:uppercase;letter-spacing:.5px}
.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#172a40;font-weight:800;font-size:.75rem}
.badge.good{background:#123522;color:#65e6a0}.badge.bad{background:#3a171b;color:#ff8d8d}.badge.warn{background:#3b2b12;color:#ffd27d}
.empty{text-align:center;color:#8290a3;padding:24px}
.tip{background:#0b1727;border-left:3px solid #65e6a0;padding:12px 14px;border-radius:8px;color:#c9d3df;font-size:.85rem;line-height:1.5}
@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:520px){.wrap{padding:18px 12px 30px}.top{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr 1fr;gap:8px}.card{padding:13px}.value{font-size:1.45rem}.actions{margin-bottom:14px}.sub{font-size:.86rem}}
</style>
</head>
<body>
<main class="wrap">
  <div class="top">
    <div class="brand">Scam<span>Decoy</span> Monitor</div>
    <div class="status">PRIVATE • LIVE</div>
  </div>
  <p class="sub">Your private owner dashboard. This page refreshes automatically every 5 seconds.</p>

  <div class="actions">
    <button onclick="refresh()">↻ Refresh now</button>
    <div class="updated" id="updated">Updating...</div>
  </div>

  <div class="grid" id="cards"></div>

  <section class="panel">
    <h2>Call history</h2>
    <p>Completed calls from the monitoring history. Duration is measured from the call connection until it ended.</p>
    <div class="tableWrap">
      <table>
        <thead><tr><th>When</th><th>Call</th><th>Duration</th><th>Result</th></tr></thead>
        <tbody id="calls"><tr><td colspan="4" class="empty">Loading...</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <h2>Recent activity</h2>
    <p>This is the technical activity log. You normally only need to look here if something seems wrong.</p>
    <div class="tableWrap">
      <table>
        <thead><tr><th>Time</th><th>What happened</th><th>Details</th></tr></thead>
        <tbody id="events"><tr><td colspan="3" class="empty">Loading...</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <h2>What should I look at?</h2>
    <div class="tip">
      <strong>Active calls</strong> = calls happening right now. &nbsp;
      <strong>Today</strong> = calls that started today. &nbsp;
      <strong>Avg. duration</strong> = average completed-call length. &nbsp;
      <strong>Errors</strong> = problems the system recorded.
      <br><br>
      If a normal test call appears in Call history and has a duration, the monitoring system is working.
    </div>
  </section>
</main>

<script>
function esc(value){
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function formatDuration(seconds){
  if(seconds == null || Number.isNaN(Number(seconds))) return "—";
  const s=Math.max(0,Math.round(Number(seconds)));
  if(s<60) return s+" sec";
  const m=Math.floor(s/60), r=s%60;
  return m+" min"+(r?" "+r+" sec":"");
}
function eventLabel(type){
  const labels={
    "call.started":"Call started",
    "call.completed":"Call ended",
    "error":"System error",
    "warning":"Warning",
    "api.error":"API error",
    "stream.error":"Call connection error",
    "monitor.started":"Monitor started"
  };
  return labels[type] || type;
}
function resultFor(event){
  if(event.type==="call.completed") return '<span class="badge good">Completed</span>';
  if(event.type==="error"||event.type==="api.error"||event.type==="stream.error") return '<span class="badge bad">Problem</span>';
  if(event.type==="warning") return '<span class="badge warn">Warning</span>';
  return '<span class="badge">'+esc(eventLabel(event.type))+'</span>';
}
function detailsFor(event){
  const d=event.data||{};
  if(event.type==="call.completed"){
    return d.reason ? "Ended: "+esc(String(d.reason).replaceAll("_"," ")) : "Call ended normally";
  }
  if(event.type==="call.started") return "A call connected to ScamDecoy.";
  if(d.message) return esc(d.message);
  return "Activity recorded.";
}
function buildCards(stats){
  const c=stats.counters||{};
  const today=new Date().toLocaleDateString();
  const events=stats.events||[];
  const todayStarts=events.filter(e=>e.type==="call.started" && new Date(e.timestamp).toLocaleDateString()===today).length;
  const completed=events.filter(e=>e.type==="call.completed" && typeof e.data?.durationSeconds==="number");
  const avg=completed.length ? Math.round(completed.reduce((sum,e)=>sum+e.data.durationSeconds,0)/completed.length) : null;
  document.getElementById("cards").innerHTML=
    '<div class="card"><div class="label">System</div><div class="value ok">Online</div><div class="help">Monitor is responding</div></div>'+
    '<div class="card"><div class="label">Active calls</div><div class="value">'+esc(stats.activeCalls)+'</div><div class="help">Calls happening now</div></div>'+
    '<div class="card"><div class="label">Today</div><div class="value">'+esc(todayStarts)+'</div><div class="help">Calls started today</div></div>'+
    '<div class="card"><div class="label">Avg. duration</div><div class="value">'+esc(formatDuration(avg))+'</div><div class="help">Completed calls in history</div></div>'+
    '<div class="card"><div class="label">Total calls</div><div class="value">'+esc(c.callsStarted)+'</div><div class="help">All recorded call starts</div></div>'+
    '<div class="card"><div class="label">Completed</div><div class="value">'+esc(c.callsCompleted)+'</div><div class="help">Calls with an end event</div></div>'+
    '<div class="card"><div class="label">Errors</div><div class="value '+(c.errors?'err':'ok')+'">'+esc(c.errors)+'</div><div class="help">Recorded system errors</div></div>'+
    '<div class="card"><div class="label">Warnings</div><div class="value '+(c.warnings?'warn':'ok')+'">'+esc(c.warnings)+'</div><div class="help">Things to keep an eye on</div></div>';
}
function renderCalls(events){
  const completed=events.filter(e=>e.type==="call.completed");
  const starts=events.filter(e=>e.type==="call.started");
  const rows=completed.slice(0,30).map(e=>{
    const d=e.data||{};
    const when=new Date(e.timestamp).toLocaleString();
    const id=d.callId ? String(d.callId).slice(-8) : "—";
    return '<tr><td>'+esc(when)+'</td><td>'+esc(id)+'</td><td>'+esc(formatDuration(d.durationSeconds))+'</td><td>'+resultFor(e)+'</td></tr>';
  });
  document.getElementById("calls").innerHTML=rows.length?rows.join(""):'<tr><td colspan="4" class="empty">No completed calls yet. Make a test call and refresh.</td></tr>';
}
function renderEvents(events){
  const rows=events.slice(0,30).map(e=>{
    const when=new Date(e.timestamp).toLocaleString();
    return '<tr><td>'+esc(when)+'</td><td>'+resultFor(e)+'</td><td>'+detailsFor(e)+'</td></tr>';
  });
  document.getElementById("events").innerHTML=rows.length?rows.join(""):'<tr><td colspan="3" class="empty">No activity yet.</td></tr>';
}
async function refresh(){
  const updated=document.getElementById("updated");
  try{
    const s=await fetch("/monitor/stats",{credentials:"same-origin",cache:"no-store"}).then(r=>{
      if(!r.ok) throw new Error("Monitor request failed");
      return r.json();
    });
    const e=await fetch("/monitor/events?limit=100",{credentials:"same-origin",cache:"no-store"}).then(r=>{
      if(!r.ok) throw new Error("Event request failed");
      return r.json();
    });
    s.events=e.events||[];
    buildCards(s);
    renderCalls(s.events);
    renderEvents(s.events);
    updated.textContent="Last updated "+new Date().toLocaleTimeString();
  }catch(error){
    updated.textContent="Could not refresh right now";
    document.getElementById("events").innerHTML='<tr><td colspan="3" class="empty">The monitor could not refresh. Try the Refresh now button.</td></tr>';
  }
}
refresh();
setInterval(refresh,5000);
</script>
</body>
</html>`);
}

export function monitorRequestHandler(req, res) {
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));

  if (!authorized(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="ScamDecoy Private Monitor"',
      "Cache-Control": "no-store"
    });
    return res.end("Private ScamDecoy monitoring dashboard");
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (url.pathname === "/health") {
    return sendJson(res, 200, health());
  }

  if (url.pathname === "/stats") {
    return sendJson(res, 200, {
      ...health(),
      activeCallIds: [...state.activeCalls.keys()]
    });
  }

  if (url.pathname === "/events") {
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") || 50), 1),
      100
    );
    return sendJson(res, 200, {
      events: state.recentEvents.slice(0, limit)
    });
  }

  if (url.pathname === "/" || url.pathname === "") {
    return sendDashboard(res);
  }

  return sendJson(res, 404, { error: "Not found" });
}

export function startMonitorServer() {
  if (!MONITOR_USER || !MONITOR_PASSWORD) {
    console.warn("ScamDecoy monitor: MONITOR_USER and MONITOR_PASSWORD are required before starting the private dashboard.");
    return null;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (!authorized(req)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="ScamDecoy Private Monitor"' }); return res.end("Private ScamDecoy monitoring dashboard"); }
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
    if (url.pathname === "/health") return sendJson(res, 200, health());
    if (url.pathname === "/stats") return sendJson(res, 200, { ...health(), activeCallIds: [...state.activeCalls.keys()] });
    if (url.pathname === "/events") { const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100); return sendJson(res, 200, { events: state.recentEvents.slice(0, limit) }); }
    if (url.pathname === "/") return sendDashboard(res);
    return sendJson(res, 404, { error: "Not found" });
  });

  server.listen(PORT, () => console.log(`ScamDecoy private monitor listening on port ${PORT}`));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startMonitorServer();
  addEvent("monitor.started", { pid: process.pid, port: PORT, maxEvents: MAX_EVENTS });
}
