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

fs.mkdirSync(DATA_DIR, { recursive: true });

const state = {
  startedAt: new Date().toISOString(),
  totalEvents: 0,
  activeCalls: new Map(),
  recentEvents: [],
  counters: {
    callsStarted: 0,
    callsCompleted: 0,
    errors: 0,
    warnings: 0,
    apiErrors: 0,
    streamErrors: 0
  }
};

function addEvent(type, data = {}) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type,
    data
  };

  state.totalEvents += 1;
  state.recentEvents.unshift(event);
  state.recentEvents = state.recentEvents.slice(0, 100);

  if (type === "call.started") state.counters.callsStarted += 1;
  if (type === "call.completed") state.counters.callsCompleted += 1;
  if (type === "error") state.counters.errors += 1;
  if (type === "warning") state.counters.warnings += 1;
  if (type === "api.error") state.counters.apiErrors += 1;
  if (type === "stream.error") state.counters.streamErrors += 1;

  try {
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    console.error("ScamDecoy monitor: unable to write event log:", error.message);
  }

  return event;
}

export function recordEvent(type, data = {}) {
  return addEvent(type, data);
}

export function callStarted(callId, data = {}) {
  if (!callId) return null;

  state.activeCalls.set(String(callId), {
    callId: String(callId),
    startedAt: Date.now(),
    ...data
  });

  return addEvent("call.started", {
    callId: String(callId),
    ...data
  });
}

export function callCompleted(callId, data = {}) {
  if (!callId) return null;

  const id = String(callId);
  const active = state.activeCalls.get(id);
  const durationMs = active ? Date.now() - active.startedAt : null;

  state.activeCalls.delete(id);

  return addEvent("call.completed", {
    callId: id,
    durationMs,
    durationSeconds: durationMs == null ? null : Math.round(durationMs / 1000),
    ...data
  });
}

export function recordError(message, data = {}) {
  return addEvent("error", {
    message: String(message || "Unknown error"),
    ...data
  });
}

export function recordWarning(message, data = {}) {
  return addEvent("warning", {
    message: String(message || "Unknown warning"),
    ...data
  });
}

export function recordApiError(message, data = {}) {
  return addEvent("api.error", {
    message: String(message || "API error"),
    ...data
  });
}

export function recordStreamError(message, data = {}) {
  return addEvent("stream.error", {
    message: String(message || "Stream error"),
    ...data
  });
}

function health() {
  const memory = process.memoryUsage();

  return {
    status: "ok",
    service: "ScamDecoy Monitor",
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: state.startedAt,
    timestamp: new Date().toISOString(),
    activeCalls: state.activeCalls.size,
    totalEvents: state.totalEvents,
    counters: state.counters,
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024)
    }
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

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

  if (url.pathname === "/") {
    return sendJson(res, 200, {
      service: "ScamDecoy Monitor",
      status: "online",
      endpoints: ["/health", "/stats", "/events"]
    });
  }

  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`ScamDecoy monitor listening on port ${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

addEvent("monitor.started", {
  pid: process.pid,
  port: PORT,
  maxEvents: MAX_EVENTS
});
