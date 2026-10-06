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
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ScamDecoy Monitor</title><style>body{margin:0;background:#07111f;color:#f5f7fa;font-family:system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1100px;margin:auto;padding:30px 18px}.top{display:flex;justify-content:space-between;align-items:center;gap:15px}.brand{font-size:1.6rem;font-weight:900}.brand span{color:#65e6a0}.status{padding:8px 13px;border-radius:999px;background:#123522;color:#65e6a0;font-weight:800}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0}.card{background:#0d1b2d;border:1px solid #1d3047;border-radius:16px;padding:20px}.label{color:#8290a3;font-size:.78rem;text-transform:uppercase;letter-spacing:1px}.value{font-size:2rem;font-weight:900;margin-top:7px}table{width:100%;border-collapse:collapse;background:#0d1b2d;border:1px solid #1d3047;border-radius:16px;overflow:hidden}th,td{text-align:left;padding:12px;border-bottom:1px solid #1d3047;font-size:.9rem}th{color:#8290a3}.ok{color:#65e6a0}.err{color:#ff8d8d}@media(max-width:750px){.grid{grid-template-columns:repeat(2,1fr)}.top{align-items:flex-start;flex-direction:column}}</style></head><body><main class="wrap"><div class="top"><div class="brand">Scam<span>Decoy</span> Monitor</div><div class="status">PRIVATE • LIVE</div></div><div class="grid" id="cards"></div><h2>Recent activity</h2><table><thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead><tbody id="events"><tr><td colspan="3">Loading...</td></tr></tbody></table></main><script>async function refresh(){try{const s=await fetch('/stats',{credentials:'same-origin'}).then(r=>r.json());document.getElementById('cards').innerHTML='<div class="card"><div class="label">System</div><div class="value ok">'+s.status+'</div></div><div class="card"><div class="label">Active calls</div><div class="value">'+s.activeCalls+'</div></div><div class="card"><div class="label">Calls started</div><div class="value">'+s.counters.callsStarted+'</div></div><div class="card"><div class="label">Errors</div><div class="value '+(s.counters.errors?'err':'')+'">'+s.counters.errors+'</div></div>';const e=await fetch('/events?limit=30',{credentials:'same-origin'}).then(r=>r.json());document.getElementById('events').innerHTML=e.events.length?e.events.map(x=>'<tr><td>'+new Date(x.timestamp).toLocaleString()+'</td><td>'+x.type+'</td><td>'+JSON.stringify(x.data).replace(/</g,'&lt;')+'</td></tr>').join(''):'<tr><td colspan="3">No events yet.</td></tr>';}catch(e){console.error(e)}}refresh();setInterval(refresh,5000);</script></body></html>`);
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
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
addEvent("monitor.started", { pid: process.pid, port: PORT, maxEvents: MAX_EVENTS });
