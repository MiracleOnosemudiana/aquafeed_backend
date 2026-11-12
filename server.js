/**
 * Smart AquaFeed / AquaGuard — Universal IoT Backend  v2
 *
 * Now includes:
 *   - Command queue: website POSTs commands, ESP32 GETs and executes them
 *   - Schedule storage: website sets schedule, ESP32 reads it
 *   - NTP time endpoint: ESP32 syncs its RTC on boot
 *   - Feed logging with gate_seconds field
 *
 * ZERO EXTERNAL DEPENDENCIES — uses only Node.js built-in modules.
 * Database: JSON files (one per table), with atomic writes.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── Load .env file (built-in, no dotenv package needed) ─────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    line = line.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq < 1) return;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  });
}

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";
const DATA_DIR = path.join(__dirname, "data");

// ─── JSON "Database" ──────────────────────────────────────────────────────────

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dbPath(name) { return path.join(DATA_DIR, name + ".json"); }

function dbRead(name) {
  const p = dbPath(name);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return []; }
}

function dbWrite(name, rows) {
  const tmp = dbPath(name) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, dbPath(name));
}

function dbAppend(name, row) {
  const rows = dbRead(name);
  rows.push(row);
  dbWrite(name, rows);
  return row;
}

function now() { return new Date().toISOString(); }
let _id = Date.now();
function uid() { return (_id++).toString(36); }

// ─── Request Helpers ──────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1e6) { req.destroy(); reject(new Error("Payload too large")); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(body);
}

function match(method, urlPath, pattern) {
  if (method && method !== "ANY" && method !== urlPath) return null;
  const patParts = pattern.split("/");
  const urlParts = urlPath.split("/");
  if (patParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(":")) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

const routes = [];

function GET(pattern, handler)  { routes.push({ method: "GET",  pattern, handler }); }
function POST(pattern, handler) { routes.push({ method: "POST", pattern, handler }); }
function PUT(pattern, handler)  { routes.push({ method: "PUT",  pattern, handler }); }

// Health check — no auth needed
GET("/api/health", (req, res) => {
  send(res, 200, { status: "ok", time: now(), uptime: process.uptime() | 0 });
});

// ─── TIME ENDPOINT — ESP32 syncs its RTC from this ─────────────────────────
// No auth needed so the ESP32 can sync even before registration
GET("/api/time", (req, res) => {
  const d = new Date();
  send(res, 200, {
    iso: d.toISOString(),
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    unix: Math.floor(d.getTime() / 1000),
  });
});

// ── Device Registration ─────────────────────────────────────────────────────

POST("/api/devices/register", async (req, res) => {
  const body = await parseBody(req);
  const { device_id, type, name, location } = body;
  if (!device_id || !type) return send(res, 400, { error: "device_id and type are required" });

  const devices = dbRead("devices");
  const existing = devices.findIndex(d => d.device_id === device_id);

  const device = {
    device_id,
    type,
    name: name || device_id,
    location: location || null,
    registered: existing >= 0 ? devices[existing].registered : now(),
    last_seen: now(),
    online: true,
  };

  if (existing >= 0) {
    devices[existing] = { ...devices[existing], ...device };
  } else {
    devices.push(device);
  }
  dbWrite("devices", devices);
  send(res, 201, { message: "Device registered", device_id });
});

// List all devices
GET("/api/devices", (req, res) => {
  const devices = dbRead("devices");
  const telemetry = dbRead("telemetry");

  const result = devices.map(d => {
    const latest = telemetry
      .filter(t => t.device_id === d.device_id)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] || null;
    return { ...d, telemetry: latest };
  });

  send(res, 200, result);
});

// Get single device
GET("/api/devices/:id", (req, res, params) => {
  const devices = dbRead("devices");
  const device = devices.find(d => d.device_id === params.id);
  if (!device) return send(res, 404, { error: "Device not found" });

  const telemetry = dbRead("telemetry");
  const latest = telemetry
    .filter(t => t.device_id === params.id)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] || null;

  send(res, 200, { ...device, telemetry: latest });
});

// Device heartbeat
POST("/api/devices/:id/heartbeat", async (req, res, params) => {
  const devices = dbRead("devices");
  const idx = devices.findIndex(d => d.device_id === params.id);
  if (idx < 0) return send(res, 404, { error: "Device not found" });

  devices[idx].last_seen = now();
  devices[idx].online = true;
  dbWrite("devices", devices);
  send(res, 200, { message: "ok" });
});

// ── COMMAND QUEUE — website sends commands, ESP32 picks them up ────────────

// POST a new command (from website)
POST("/api/devices/:id/commands", async (req, res, params) => {
  const devices = dbRead("devices");
  if (!devices.find(d => d.device_id === params.id)) {
    return send(res, 404, { error: "Device not found" });
  }

  const body = await parseBody(req);
  if (!body.action) return send(res, 400, { error: "action is required" });

  const cmd = {
    id: uid(),
    device_id: params.id,
    action: body.action,               // "feed", "reset_jam", "set_gate_seconds"
    params: body.params || {},          // e.g. { gate_seconds: 15 }
    status: "pending",                  // pending → picked → done / failed
    created: now(),
    picked: null,
    completed: null,
    result: null,
  };
  dbAppend("commands", cmd);
  send(res, 201, { message: "Command queued", id: cmd.id, action: cmd.action });
});

// GET pending commands (ESP32 polls this)
GET("/api/devices/:id/commands", (req, res, params) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const statusFilter = url.searchParams.get("status") || "pending";

  const commands = dbRead("commands")
    .filter(c => c.device_id === params.id && c.status === statusFilter)
    .sort((a, b) => a.created.localeCompare(b.created));

  send(res, 200, commands);
});

// POST command result (ESP32 reports back)
POST("/api/devices/:id/commands/:cmdId/result", async (req, res, params) => {
  const commands = dbRead("commands");
  const idx = commands.findIndex(c => c.id === params.cmdId && c.device_id === params.id);
  if (idx < 0) return send(res, 404, { error: "Command not found" });

  const body = await parseBody(req);
  commands[idx].status = body.success ? "done" : "failed";
  commands[idx].completed = now();
  commands[idx].result = body.result || null;
  dbWrite("commands", commands);

  send(res, 200, { message: "Command updated", id: params.cmdId });
});

// Mark command as picked (ESP32 acknowledges it)
POST("/api/devices/:id/commands/:cmdId/pick", async (req, res, params) => {
  const commands = dbRead("commands");
  const idx = commands.findIndex(c => c.id === params.cmdId && c.device_id === params.id);
  if (idx < 0) return send(res, 404, { error: "Command not found" });

  commands[idx].status = "picked";
  commands[idx].picked = now();
  dbWrite("commands", commands);

  send(res, 200, { message: "Command picked", id: params.cmdId });
});

// ── SCHEDULE — stored on backend, ESP32 reads it, website writes it ────────

// GET schedule for a device
GET("/api/devices/:id/schedule", (req, res, params) => {
  const schedules = dbRead("schedules");
  const items = schedules
    .filter(s => s.device_id === params.id)
    .sort((a, b) => a.time.localeCompare(b.time));
  send(res, 200, items);
});

// PUT (replace) entire schedule for a device
PUT("/api/devices/:id/schedule", async (req, res, params) => {
  const devices = dbRead("devices");
  if (!devices.find(d => d.device_id === params.id)) {
    return send(res, 404, { error: "Device not found" });
  }

  const body = await parseBody(req);
  if (!Array.isArray(body.schedule)) {
    return send(res, 400, { error: "schedule must be an array" });
  }

  // Validate each entry
  const entries = body.schedule.map(s => ({
    id: s.id || uid(),
    device_id: params.id,
    time: s.time,                       // "08:00"
    gate_seconds: s.gate_seconds || 10, // how long gate stays open
    enabled: s.enabled !== false,
    updated: now(),
  }));

  // Replace all schedule entries for this device
  const schedules = dbRead("schedules").filter(s => s.device_id !== params.id);
  schedules.push(...entries);
  dbWrite("schedules", schedules);

  // Also queue a "sync_schedule" command so ESP32 picks up the change
  const cmd = {
    id: uid(),
    device_id: params.id,
    action: "sync_schedule",
    params: { schedule: entries },
    status: "pending",
    created: now(),
    picked: null,
    completed: null,
    result: null,
  };
  dbAppend("commands", cmd);

  send(res, 200, { message: "Schedule updated", count: entries.length });
});

// ── Feed Logging (AquaFeed devices) ─────────────────────────────────────────

POST("/api/devices/:id/feeds", async (req, res, params) => {
  const devices = dbRead("devices");
  if (!devices.find(d => d.device_id === params.id)) {
    return send(res, 404, { error: "Device not found" });
  }

  const body = await parseBody(req);
  const feed = {
    id: uid(),
    device_id: params.id,
    timestamp: now(),
    type: body.type || "scheduled",
    grams: body.grams || 0,
    gate_seconds: body.gate_seconds || 0,
    success: body.success !== undefined ? !!body.success : true,
    reason: body.reason || null,
  };
  dbAppend("feeds", feed);

  const idx = devices.findIndex(d => d.device_id === params.id);
  if (idx >= 0) { devices[idx].last_seen = now(); dbWrite("devices", devices); }

  send(res, 201, { message: "Feed logged", id: feed.id });
});

GET("/api/devices/:id/feeds", (req, res, params) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = Math.min(parseInt(url.searchParams.get("limit")) || 50, 500);

  const feeds = dbRead("feeds")
    .filter(f => f.device_id === params.id)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);

  send(res, 200, feeds);
});

// ── Water Readings (AquaGuard devices) ──────────────────────────────────────

POST("/api/devices/:id/water", async (req, res, params) => {
  const devices = dbRead("devices");
  if (!devices.find(d => d.device_id === params.id)) {
    return send(res, 404, { error: "Device not found" });
  }

  const body = await parseBody(req);
  const reading = {
    id: uid(),
    device_id: params.id,
    timestamp: now(),
    temperature: body.temperature ?? null,
    ph: body.ph ?? null,
    turbidity: body.turbidity ?? null,
    depth: body.depth ?? null,
  };
  dbAppend("water", reading);

  const idx = devices.findIndex(d => d.device_id === params.id);
  if (idx >= 0) { devices[idx].last_seen = now(); dbWrite("devices", devices); }

  send(res, 201, { message: "Water reading logged", id: reading.id });
});

GET("/api/devices/:id/water", (req, res, params) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = Math.min(parseInt(url.searchParams.get("limit")) || 50, 500);

  const readings = dbRead("water")
    .filter(r => r.device_id === params.id)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);

  send(res, 200, readings);
});

// ── Telemetry (any device — battery, solar, signal) ─────────────────────────

POST("/api/devices/:id/telemetry", async (req, res, params) => {
  const devices = dbRead("devices");
  if (!devices.find(d => d.device_id === params.id)) {
    return send(res, 404, { error: "Device not found" });
  }

  const body = await parseBody(req);
  const entry = {
    id: uid(),
    device_id: params.id,
    timestamp: now(),
    battery_v: body.battery_v ?? null,
    solar: body.solar || null,
    signal_str: body.signal_str ?? null,
  };
  dbAppend("telemetry", entry);

  const idx = devices.findIndex(d => d.device_id === params.id);
  if (idx >= 0) { devices[idx].last_seen = now(); dbWrite("devices", devices); }

  send(res, 201, { message: "Telemetry logged", id: entry.id });
});

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Public routes (no auth)
  if ((pathname === "/api/health" || pathname === "/api/time") && req.method === "GET") {
    const r = routes.find(r => r.pattern === pathname && r.method === "GET");
    if (r) return r.handler(req, res, {});
  }

  // All other routes require API key
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== API_KEY) {
    return send(res, 401, { error: "Invalid or missing API key" });
  }

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const params = match(null, pathname, route.pattern);
    if (params !== null) {
      try {
        return await route.handler(req, res, params);
      } catch (err) {
        console.error(`Error handling ${req.method} ${pathname}:`, err.message);
        return send(res, err.message === "Invalid JSON" ? 400 : 500, { error: err.message });
      }
    }
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`
  Smart AquaFeed Backend v2
  ─────────────────────────
  Running on http://localhost:${PORT}
  Data folder: ${DATA_DIR}

  Endpoints:
    GET  /api/health                       Health check (no auth)
    GET  /api/time                         UTC time for RTC sync (no auth)
    POST /api/devices/register             Register a device
    GET  /api/devices                      List all devices
    GET  /api/devices/:id                  Get one device
    POST /api/devices/:id/heartbeat        Heartbeat
    POST /api/devices/:id/commands         Queue a command (from website)
    GET  /api/devices/:id/commands?status=  Get commands (ESP32 polls pending)
    POST /api/devices/:id/commands/:cmdId/pick    Mark command picked
    POST /api/devices/:id/commands/:cmdId/result  Report command result
    GET  /api/devices/:id/schedule         Get feed schedule
    PUT  /api/devices/:id/schedule         Set feed schedule (from website)
    POST /api/devices/:id/feeds            Log a feeding event
    GET  /api/devices/:id/feeds            Get feed history
    POST /api/devices/:id/water            Log water reading
    GET  /api/devices/:id/water            Get water history
    POST /api/devices/:id/telemetry        Log battery/solar/signal
  `);
});
