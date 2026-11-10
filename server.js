/**
 * Smart AquaFeed / AquaGuard — Universal IoT Backend
 *
 * A single Node.js server that any ESP32 device can post data to.
 * Each device registers once, then logs its own type of data
 * (feeding events, water readings, or both).
 *
 * ZERO EXTERNAL DEPENDENCIES — uses only Node.js built-in modules.
 * Database: JSON files (one per table), with atomic writes.
 *}
 * When you deploy this to a real server later and can install npm packages,
 * you can swap to Express + SQLite for better performance.  For now this
 * handles hundreds of devices and thousands of rows without breaking a sweat.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── Load .env file ───────────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const [key, ...val] = line.split("=");
    if (key && val.length) process.env[key.trim()] = val.join("=").trim();
  });
}
console.log("API_KEY loaded:", process.env.API_KEY);
// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "my-secret-farm-key-nov-11";
const DATA_DIR = path.join(__dirname, "data");

// ─── JSON "Database" ──────────────────────────────────────────────────────────
// Each "table" is a JSON file: devices.json, feeds.json, water.json, telemetry.json
// Simple, portable, zero dependencies.  Good enough for dozens of devices.

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
  fs.renameSync(tmp, dbPath(name));     // atomic on the same filesystem
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function match(method, urlPath, pattern) {
  if (method && method !== "ANY" && method !== urlPath) return null;
  // pattern like "/api/devices/:id/feeds"
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

// Health check — no auth needed
GET("/api/health", (req, res) => {
  send(res, 200, { status: "ok", time: now(), uptime: process.uptime() | 0 });
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
    type,                              // "aquafeed", "aquaguard", etc.
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

// List all devices (with latest telemetry attached)
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
    type: body.type || "scheduled",        // "scheduled" or "manual"
    grams: body.grams || 0,
    success: body.success !== undefined ? !!body.success : true,
    reason: body.reason || null,           // jam reason if failed
  };
  dbAppend("feeds", feed);

  // Also update device last_seen
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
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  // Parse URL (strip query string for route matching)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Health check is public
  if (pathname === "/api/health" && req.method === "GET") {
    return routes.find(r => r.pattern === "/api/health").handler(req, res, {});
  }

  // All other routes require API key
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== API_KEY) {
    return send(res, 401, { error: "Invalid or missing API key" });
  }

  // Find matching route
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
  Smart AquaFeed Backend
  ──────────────────────
  Running on http://localhost:${PORT}
  Data folder: ${DATA_DIR}
  API key required: yes

  Endpoints:
    POST /api/devices/register       Register a device
    GET  /api/devices                List all devices
    GET  /api/devices/:id            Get one device
    POST /api/devices/:id/heartbeat  Device says "I'm alive"
    POST /api/devices/:id/feeds      Log a feeding event
    GET  /api/devices/:id/feeds      Get feed history
    POST /api/devices/:id/water      Log water reading
    GET  /api/devices/:id/water      Get water history
    POST /api/devices/:id/telemetry  Log battery/solar/signal
    GET  /api/health                 Health check (no auth)
  `);
});
