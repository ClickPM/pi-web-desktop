"use strict";

/**
 * Tools data source — the tool registry of the currently LIVE pi session.
 *
 * Unlike the MCP/extension chips (which read static config from ~/.pi), the tool
 * registry only exists INSIDE a running agent process: builtins + every tool the
 * extensions/packages registered + whatever MCP tools the bridge has actually
 * connected. There is no file on disk that lists it. pi-web already exposes it
 * over its own session RPC, so we ask it:
 *
 *   POST /api/agent/<sessionId>  {"type":"get_tools"}
 *     -> { success: true, data: [ { name, description, active } ] }
 *
 * Three consequences worth knowing before touching this file:
 *
 *  1. The list is SESSION-SCOPED, not global. Two sessions can legitimately
 *     report different tools — mcp-bridge loads most MCP servers lazily, so a
 *     server whose tools were never pulled in via `mcp_search_tools` / `/mcp-load`
 *     simply is not in the registry. "No live session" therefore means "no
 *     answer", not "zero tools", and the chip renders — for that.
 *
 *  2. We never START a session to answer. POST'ing get_tools to a session whose
 *     RPC process is not alive makes pi-web spawn one (~10s, connects MCP
 *     servers) — an unacceptable side effect for a status bar. So every fetch is
 *     gated behind GET /api/agent/<id>, which reports `running` straight from the
 *     in-memory registry and never spawns. (Residual race: the session could die
 *     in the millisecond between the GET and the POST, in which case the POST
 *     revives it — same thing that happens when the user clicks that session in
 *     the sidebar, so it is harmless, just not free.)
 *
 *  3. pi's own ToolInfo carries `sourceInfo`, but pi-web drops it and forwards
 *     only name/description/active. Grouping is therefore inferred from the name:
 *     the `mcp__<server>__<tool>` convention for MCP, pi's builtin coding-tool
 *     names for builtins, everything else is extension/package provided.
 *
 * Candidate sessions come from the session JSONL files (newest first, header
 * line carries the id) rather than pi-web's /api/sessions, which returns every
 * session in one ~250KB payload — far too heavy for a polled status bar.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const PROBE_TIMEOUT_MS = 2000; // GET /api/agent/<id> — registry lookup, instant
const FETCH_TIMEOUT_MS = 8000; // POST get_tools — a round trip into the pi process
const TOOLS_TTL_MS = 30000; // a session's registry barely changes; poll cheaply
const SESSION_SCAN_TTL_MS = 5000; // how long the mtime-sorted candidate list keeps
const MAX_CANDIDATES = 8; // newest N sessions probed for a live RPC process

// pi's builtin coding tools (pi-web calls this set CODING_TOOL_NAMES). Anything
// else that is not `mcp__*` came from an extension or an installed package.
const BUILTIN = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

let sessionScanCache = null; // { ts, list: [{ file, id, cwd, mtimeMs }] }
let toolsCache = null; // { sessionId, ts, payload }
let lastLiveId = null; // probe this first — usually still the live one

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

// ---------------------------------------------------------------------------
// Candidate sessions
// ---------------------------------------------------------------------------
function collectJsonl(dir, out, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectJsonl(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
}

/**
 * First line of a session JSONL is its header:
 *   {"type":"session","version":3,"id":"<uuid>","timestamp":…,"cwd":"…"}
 * That `id` is exactly the id pi-web's API routes are keyed by. Falls back to
 * the `<iso>_<uuid>.jsonl` filename convention if the header can't be read.
 */
function readHeader(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString("utf8", 0, n);
    const nl = text.indexOf("\n");
    const header = JSON.parse(nl === -1 ? text : text.slice(0, nl));
    if (header && header.type === "session" && typeof header.id === "string") {
      return { id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "" };
    }
  } catch {
    /* fall through to the filename */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  const m = path.basename(file).match(/_([0-9a-fA-F-]{36})\.jsonl$/);
  return m ? { id: m[1], cwd: "" } : null;
}

function scanSessions() {
  const now = Date.now();
  if (sessionScanCache && now - sessionScanCache.ts < SESSION_SCAN_TTL_MS) {
    return sessionScanCache.list;
  }
  const files = [];
  collectJsonl(path.join(agentDir(), "sessions"), files, 0);

  const stated = [];
  for (const file of files) {
    try {
      stated.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      /* vanished mid-scan */
    }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const list = [];
  for (const s of stated.slice(0, MAX_CANDIDATES)) {
    const header = readHeader(s.file);
    if (header && header.id) list.push({ file: s.file, mtimeMs: s.mtimeMs, id: header.id, cwd: header.cwd });
  }
  sessionScanCache = { ts: now, list };
  return list;
}

// ---------------------------------------------------------------------------
// HTTP to the embedded pi-web server (always 127.0.0.1, never throws)
// ---------------------------------------------------------------------------
function request(serverUrl, urlPath, opts) {
  const { method = "GET", body = null, timeoutMs = PROBE_TIMEOUT_MS } = opts || {};
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlPath, serverUrl);
    } catch {
      resolve({ ok: false, error: "bad server url" });
      return;
    }
    const data = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 4e6) req.destroy(); // registry payloads are ~50KB
        });
        res.on("end", () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(text) });
          } catch {
            resolve({ ok: false, status: res.statusCode, error: "bad json" });
          }
        });
      }
    );
    req.on("error", (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------
function shortDesc(d) {
  if (typeof d !== "string") return "";
  const flat = d.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? flat.slice(0, 199) + "…" : flat;
}

/** builtin → extension/package → MCP servers (alphabetical). */
function groupRank(kind) {
  if (kind === "builtin") return 0;
  if (kind === "extension") return 1;
  return 2;
}

function classify(rawTools) {
  const groups = [];
  const byKey = new Map();
  let active = 0;

  const push = (key, label, kind, tool) => {
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, kind, tools: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.tools.push(tool);
  };

  for (const raw of rawTools) {
    const name = raw && typeof raw.name === "string" ? raw.name : "";
    if (!name) continue;
    const tool = { name, description: shortDesc(raw.description), active: raw.active === true };
    if (tool.active) active += 1;

    if (name.startsWith("mcp__")) {
      // `mcp__<server>__<tool>` — the server segment is what mcp-bridge prefixes
      // its registrations with, so it doubles as the group label.
      const parts = name.split("__");
      const server = parts.length >= 3 && parts[1] ? parts[1] : "unknown";
      push("mcp:" + server, "MCP · " + server, "mcp", tool);
    } else if (BUILTIN.has(name)) {
      push("builtin", "内置工具", "builtin", tool);
    } else {
      push("extension", "扩展 / 包", "extension", tool);
    }
  }

  groups.sort((a, b) => {
    const r = groupRank(a.kind) - groupRank(b.kind);
    return r !== 0 ? r : a.label.localeCompare(b.label);
  });

  return { total: rawTools.length, active, groups };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function unavailable(reason, error) {
  return { available: false, reason, total: 0, active: 0, groups: [], error: error || null };
}

/**
 * @param {{ serverUrl?: string|null, force?: boolean }} opts
 *   force — bypass the TTL cache (used when the user opens the popover).
 * @returns {Promise<object>} never rejects; `available:false` carries a reason.
 */
async function readTools(opts) {
  const serverUrl = opts && opts.serverUrl;
  const force = !!(opts && opts.force);
  if (!serverUrl) return unavailable("no-server");

  const candidates = scanSessions();
  if (candidates.length === 0) return unavailable("no-sessions");

  // Probe the previously live session first: in steady state that is a single
  // cheap request per poll.
  const ordered = candidates.slice();
  const lastIdx = lastLiveId ? ordered.findIndex((c) => c.id === lastLiveId) : -1;
  if (lastIdx > 0) ordered.unshift(ordered.splice(lastIdx, 1)[0]);

  let live = null;
  for (const candidate of ordered) {
    const res = await request(serverUrl, `/api/agent/${encodeURIComponent(candidate.id)}`);
    if (res.ok && res.json && res.json.running === true) {
      live = candidate;
      break;
    }
    // A timeout means the server itself is unhealthy — probing the remaining
    // candidates would just multiply the stall.
    if (res.error === "timeout") return unavailable("error", "pi-web 无响应");
  }

  if (!live) {
    lastLiveId = null;
    return unavailable("no-live-session");
  }
  lastLiveId = live.id;

  if (!force && toolsCache && toolsCache.sessionId === live.id && Date.now() - toolsCache.ts < TOOLS_TTL_MS) {
    return toolsCache.payload;
  }

  const res = await request(serverUrl, `/api/agent/${encodeURIComponent(live.id)}`, {
    method: "POST",
    body: { type: "get_tools" },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok || !res.json || res.json.success !== true || !Array.isArray(res.json.data)) {
    const why = (res.json && res.json.error) || res.error || `HTTP ${res.status}`;
    return unavailable("error", String(why));
  }

  const payload = Object.assign(
    { available: true, reason: null, sessionId: live.id, cwd: live.cwd || "", fetchedMs: Date.now(), error: null },
    classify(res.json.data)
  );
  toolsCache = { sessionId: live.id, ts: Date.now(), payload };
  return payload;
}

// `request` is shared with features/subagents.js, which talks to the same
// embedded server (running-session snapshot + abort) under the same rules.
module.exports = { readTools, request };
