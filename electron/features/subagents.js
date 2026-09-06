"use strict";

/**
 * Sub-agent data source — reports how many subagent sessions the running pi-web
 * instance currently has in flight, plus a short record of the ones that
 * finished during this app session. Feeds the "Sub-agents" chip on the bottom
 * dashboard bar (see preload.js).
 *
 * There are TWO generations of subagents and they leave completely different
 * footprints, so this module reads both and merges them:
 *
 * A. BUILT-IN (pi-web >= 0.9.0, `Agent` / `get_subagent_result` /
 *    `steer_subagent` tools, toggled in pi-web Settings → Agents). Each run is
 *    an IN-PROCESS AgentSession inside the Next.js server — there is NO child
 *    process, so the process table below never sees them (that was the bug
 *    this file was rewritten for, 2026-09-06). What they do leave behind:
 *
 *      - a normal session JSONL under ~/.pi/agent/sessions/ whose header has
 *        `parentSession` = the parent's file, whose SECOND entry is
 *        `{type:"custom", customType:"pi-web:subagent", data:{profile,
 *        description, task, runInBackground, parentSessionId, createdAt, …}}`
 *        (lib/subagents.ts SUBAGENT_META_TYPE), and which gets a final
 *        `customType:"pi-web:subagent-result"` entry ({status: completed |
 *        failed | aborted, completedAt, result?, error?}) when the run ends.
 *        A file with the meta entry but no result entry is either still
 *        running or was cut off by a server restart ("interrupted" — the same
 *        word pi-web's own readSubagentRun uses).
 *      - a live entry in the server's session registry while running:
 *        `GET /api/agent/running` → `{ runningSessionIds: [...] }` reports
 *        every session whose wrapper isRunning(), subagents included. That is
 *        the authoritative "running now" signal; the JSONL scan only tells us
 *        WHICH of those ids are subagents and what they are called.
 *
 *    Stopping one is `POST /api/agent/<id> {type:"abort"}` — pi-web's own Stop
 *    button — which is graceful and gets recorded as `aborted`. The POST is
 *    gated behind `GET /api/agent/<id>` exactly like features/tools.js: POSTing
 *    to a session with no live wrapper would make pi-web START one.
 *
 * B. LEGACY `pi-subagents` npm package — spawns CHILD `pi` PROCESSES. Kept for
 *    users who still have that extension installed. Three sources, in order of
 *    reliability:
 *
 *     1. LIVE PROCESS TREE (authoritative for "running now", covers foreground
 *        AND background). Every running run is a live child executing
 *        `@earendil-works/pi-coding-agent/dist/cli.js`, descended from the
 *        pi-web server pid. Foreground top-level runs write NO status file.
 *     2. ASYNC STATUS FILES (`<tmp>/pi-subagents-<scope>/async-subagent-runs/
 *        <id>/status.json`) — background runs persist state/pid/mode/agents
 *        here. Used to NAME running background runs and as a fallback count.
 *     3. RUN HISTORY (`~/.pi/agent/run-history.jsonl`) — append log of
 *        completed runs ({agent, task, ts, status, duration}).
 *
 *    Stopping one is forced subtree termination: pi-subagents' graceful
 *    interrupt (SIGUSR2/SIGBREAK → "paused") is dead on Windows because
 *    `process.kill(pid, "SIGBREAK")` fails with ENOSYS (verified 2026-07-30).
 *    The package converges afterwards — its stale-run reconciler marks a run
 *    whose pid died as failed, and a foreground parent reports a failed step.
 *
 * The process enumeration for (B) is the only non-trivial cost and is skipped
 * entirely when the legacy package is not installed (see legacyInstalled()).
 *
 * Never throws — always returns a partial result plus an `error` string.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { request } = require("./tools");

// ---------------------------------------------------------------------------
// Temp-dir scoping — mirror pi-subagents' resolveTempScopeId() exactly so the
// paths we read line up with what the package writes (shared/types.ts).
// ---------------------------------------------------------------------------
function sanitizeScopeSegment(value) {
  const sanitized = String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function resolveTempScopeId() {
  // POSIX: uid-based (matches process.getuid()).
  if (typeof process.getuid === "function") {
    try {
      return `uid-${process.getuid()}`;
    } catch {
      /* fall through */
    }
  }
  for (const key of ["USERNAME", "USER", "LOGNAME"]) {
    const v = process.env[key];
    if (v) return `user-${sanitizeScopeSegment(v)}`;
  }
  try {
    const username = os.userInfo().username;
    if (username) return `user-${sanitizeScopeSegment(username)}`;
  } catch {
    /* fall through */
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) return `home-${sanitizeScopeSegment(home)}`;
  return "shared";
}

function tempRootDir() {
  return path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
}

function agentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return os.homedir();
  if (configured && configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return configured || path.join(os.homedir(), ".pi", "agent");
}

// ---------------------------------------------------------------------------
// Process table
// ---------------------------------------------------------------------------
// One subagent session == one live `pi` cli.js process. We identify them by the
// pi-coding-agent CLI entry in the command line; the package + bin path are
// stable across versions ("@earendil-works/pi-coding-agent" → "dist/cli.js"),
// so this match doesn't rot the way an arg-shape match would.
const PI_CLI_RE = /pi-coding-agent[\\/](?:dist[\\/])?cli\.js/i;
// pi-web's own server is `node .../next/dist/bin/next start` — never a subagent.
const NEXT_SERVER_RE = /[\\/]next[\\/]dist[\\/]bin[\\/]next\b/i;
// Foreground runs pass the task via a temp prompt file named "<agent>.md"
// (utils.writePrompt). Recover the agent name from the command line when present.
const PROMPT_FILE_RE = /pi-subagent[s]?-[^"'\s]*[\\/]([A-Za-z0-9_.-]+)\.md/i;

function isSubagentCmd(cmd) {
  if (!cmd) return false;
  if (NEXT_SERVER_RE.test(cmd)) return false;
  return PI_CLI_RE.test(cmd);
}

function agentNameFromCmd(cmd) {
  const m = cmd && cmd.match(PROMPT_FILE_RE);
  return m ? m[1] : undefined;
}

/**
 * Snapshot the process table as [{ pid, ppid, cmd }]. Best-effort and
 * cross-platform; resolves to [] (never rejects) if the query fails or times out.
 */
function listProcesses() {
  return new Promise((resolve) => {
    const done = (list) => resolve(Array.isArray(list) ? list : []);

    if (process.platform === "win32") {
      // PowerShell CIM query → JSON. Only the fields we need, to keep it cheap.
      const ps =
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { timeout: 5000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return done([]);
          try {
            let parsed = JSON.parse(stdout);
            if (!Array.isArray(parsed)) parsed = [parsed];
            done(
              parsed.map((p) => ({
                pid: Number(p.ProcessId),
                ppid: Number(p.ParentProcessId),
                cmd: p.CommandLine || "",
              }))
            );
          } catch {
            done([]);
          }
        }
      );
    } else {
      // ps: pid, ppid, full command. `=` headers suppress the column titles.
      execFile(
        "ps",
        ["-eo", "pid=,ppid=,args="],
        { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return done([]);
          const list = [];
          for (const line of stdout.split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
            if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
          }
          done(list);
        }
      );
    }
  });
}

/**
 * Pids descended from rootPid grouped by depth, deepest first, INCLUDING
 * rootPid itself as the last entry. Used when terminating: killing leaves before
 * their parents keeps a supervisor from noticing a dead child and respawning,
 * and stops the parent from being reaped before we can enumerate under it.
 */
function killOrder(procs, rootPid) {
  const childrenByParent = new Map();
  for (const p of procs) {
    if (!childrenByParent.has(p.ppid)) childrenByParent.set(p.ppid, []);
    childrenByParent.get(p.ppid).push(p);
  }
  const levels = [[rootPid]];
  const seen = new Set([rootPid]);
  while (true) {
    const next = [];
    for (const parent of levels[levels.length - 1]) {
      for (const child of childrenByParent.get(parent) || []) {
        if (seen.has(child.pid)) continue; // pid-reuse cycle guard
        seen.add(child.pid);
        next.push(child.pid);
      }
    }
    if (next.length === 0) break;
    levels.push(next);
  }
  return levels.reverse();
}

/** All pids descended (any depth) from rootPid, via the parent links. */
function descendantPids(procs, rootPid) {
  const childrenByParent = new Map();
  for (const p of procs) {
    if (!childrenByParent.has(p.ppid)) childrenByParent.set(p.ppid, []);
    childrenByParent.get(p.ppid).push(p);
  }
  const out = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of childrenByParent.get(cur) || []) {
      if (out.has(child.pid)) continue; // guard against pid-reuse cycles
      out.add(child.pid);
      stack.push(child.pid);
    }
  }
  return out;
}

/**
 * Live subagent sessions = pi cli.js processes descended from the server. If no
 * serverPid is known (or it's not in the table), fall back to matching every pi
 * cli.js process EXCEPT the obvious unrelated ones — less precise, but better
 * than reporting nothing.
 */
function findRunningSubagents(procs, serverPid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let candidates;
  if (serverPid && byPid.has(serverPid)) {
    const desc = descendantPids(procs, serverPid);
    candidates = procs.filter((p) => desc.has(p.pid));
  } else {
    candidates = procs;
  }
  return candidates
    .filter((p) => isSubagentCmd(p.cmd))
    .map((p) => ({ pid: p.pid, agent: agentNameFromCmd(p.cmd), source: "process" }));
}

// ---------------------------------------------------------------------------
// Async run status files (background runs — rich detail + fallback count)
// ---------------------------------------------------------------------------
const TERMINAL_STATES = new Set(["complete", "failed", "paused"]);

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM ⇒ exists but owned by another user (still alive); ESRCH ⇒ gone.
    return e && e.code === "EPERM";
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Scan async-subagent-runs/. Returns { active, done } where a run is "active"
 * iff its state is non-terminal AND its pid is still alive (mirrors the
 * package's stale-run reconciliation, so a crashed run isn't stuck "running").
 */
function readAsyncRuns() {
  const root = path.join(tempRootDir(), "async-subagent-runs");
  const active = [];
  const done = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { active, done }; // dir absent ⇒ no async runs this machine/session
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const status = readJson(path.join(root, ent.name, "status.json"));
    if (!status) continue;
    const agents = Array.isArray(status.steps)
      ? status.steps.map((s) => s && s.agent).filter(Boolean)
      : [];
    const run = {
      id: status.runId || ent.name,
      state: status.state,
      mode: status.mode,
      pid: typeof status.pid === "number" ? status.pid : undefined,
      agents,
      startedAt: status.startedAt,
      lastUpdate: status.lastUpdate,
    };
    const live = !TERMINAL_STATES.has(status.state) && pidAlive(run.pid);
    if (live) active.push(run);
    else done.push(run);
  }
  return { active, done };
}

// ---------------------------------------------------------------------------
// Run history (completed runs this session)
// ---------------------------------------------------------------------------
/**
 * Tally run-history.jsonl. `sinceMs` (app boot, epoch ms) scopes the ok/failed
 * counts to "this app session"; ts in the file is epoch SECONDS. `recent` is the
 * last few entries regardless of session, newest first, for the popover.
 */
function readRunHistory(sinceMs) {
  const file = path.join(agentDir(), "run-history.jsonl");
  const result = { doneSession: 0, failedSession: 0, recent: [] };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return result;
  }
  const sinceSec = sinceMs ? Math.floor(sinceMs / 1000) : 0;
  const entries = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (!e || typeof e.agent !== "string") continue;
    entries.push(e);
    if (!sinceSec || (typeof e.ts === "number" && e.ts >= sinceSec)) {
      if (e.status === "error") result.failedSession += 1;
      else result.doneSession += 1;
    }
  }
  result.recent = entries
    .slice(-8)
    .reverse()
    .map((e) => ({
      agent: e.agent,
      status: e.status === "error" ? "error" : "ok",
      durationMs: typeof e.duration === "number" ? e.duration : undefined,
      ts: typeof e.ts === "number" ? e.ts : undefined,
    }));
  return result;
}

// ---------------------------------------------------------------------------
// Legacy package presence
// ---------------------------------------------------------------------------
// Process enumeration (a PowerShell CIM query on Windows) only pays for itself
// when the legacy `pi-subagents` package can actually spawn something. Detect it
// the way pi installs it: a `packages` spec in the global or project
// settings.json, or a package dir under ~/.pi/agent/npm/node_modules. Cached
// briefly — the dashboard polls every 3s while runs are active.
const LEGACY_PKG_RE = /(^|[\\/@])pi-subagents(@|$)/i;
const LEGACY_TTL_MS = 30000;
let legacyCache = null; // { ts, cwd, installed }

function legacyInstalled(cwd) {
  const now = Date.now();
  if (legacyCache && legacyCache.cwd === (cwd || "") && now - legacyCache.ts < LEGACY_TTL_MS) {
    return legacyCache.installed;
  }
  let installed = false;
  const settingsFiles = [path.join(agentDir(), "settings.json")];
  if (cwd) settingsFiles.push(path.join(cwd, ".pi", "settings.json"));
  for (const file of settingsFiles) {
    const s = readJson(file);
    const pkgs = s && Array.isArray(s.packages) ? s.packages : [];
    if (pkgs.some((p) => LEGACY_PKG_RE.test(String(typeof p === "string" ? p : (p && p.source) || "")))) {
      installed = true;
      break;
    }
  }
  if (!installed) {
    const nm = path.join(agentDir(), "npm", "node_modules");
    try {
      if (fs.existsSync(path.join(nm, "pi-subagents"))) installed = true;
      else {
        for (const ent of fs.readdirSync(nm, { withFileTypes: true })) {
          if (ent.isDirectory() && ent.name.startsWith("@") && fs.existsSync(path.join(nm, ent.name, "pi-subagents"))) {
            installed = true;
            break;
          }
        }
      }
    } catch {
      /* no npm dir ⇒ nothing installed */
    }
  }
  legacyCache = { ts: now, cwd: cwd || "", installed };
  return installed;
}

// ---------------------------------------------------------------------------
// Built-in subagents (pi-web >= 0.9.0) — session JSONL scan + running snapshot
// ---------------------------------------------------------------------------
const BUILTIN_META_TYPE = "pi-web:subagent";
const BUILTIN_RESULT_TYPE = "pi-web:subagent-result";
// Substring that every subagent session file contains and nothing else does;
// cheap prefilter before JSON-parsing anything.
const BUILTIN_MARKER = `"customType":"${BUILTIN_META_TYPE}"`;
const RUNNING_PROBE_TIMEOUT_MS = 2000; // GET /api/agent/running — a registry walk
const ABORT_TIMEOUT_MS = 8000; // POST abort awaits the SDK's waitForIdle()
// A subagent file with the meta entry but no result entry, not (yet) in the
// running snapshot: pi-web appends the meta entry BEFORE the AgentSession is
// created and the prompt starts, so for the first moments of a run the id is
// not "running" yet. Treat a fresh one as starting rather than interrupted.
const STARTING_GRACE_MS = 15000;
// With no boot timestamp (sinceMs = 0) the scan is bounded to the newest files
// so a large session library never turns the status bar into a disk walk.
const MAX_SCAN_WITHOUT_SINCE = 200;
const TASK_SNIPPET_LEN = 160;

function sessionsDir() {
  return path.join(agentDir(), "sessions");
}

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

function snippet(text) {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TASK_SNIPPET_LEN ? flat.slice(0, TASK_SNIPPET_LEN - 1) + "…" : flat;
}

function parseIsoMs(v) {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Parse one session file IF it is a built-in subagent session. Returns null for
 * ordinary sessions. Only the header line and the two `pi-web:subagent*` custom
 * entries are JSON-parsed; message lines are skipped by substring.
 */
function readBuiltinSessionFile(file, mtimeMs) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (text.indexOf(BUILTIN_MARKER) === -1) return null;

  const lines = text.split("\n");
  let header = null;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!header || header.type !== "session" || typeof header.id !== "string") return null;

  let meta = null;
  let result = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('"customType":"pi-web:subagent') === -1) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
    if (entry.customType === BUILTIN_META_TYPE && !meta) meta = entry.data;
    else if (entry.customType === BUILTIN_RESULT_TYPE) result = entry.data; // last one wins
  }
  if (!meta || typeof meta.parentSessionId !== "string") return null;

  const createdMs = parseIsoMs(meta.createdAt) || parseIsoMs(header.timestamp);
  const completedMs = result ? parseIsoMs(result.completedAt) || mtimeMs : 0;
  return {
    kind: "builtin",
    sessionId: header.id,
    sessionPath: file,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    parentSessionId: meta.parentSessionId,
    profile: typeof meta.profile === "string" ? meta.profile : "general-purpose",
    description: typeof meta.description === "string" ? meta.description : "",
    task: snippet(meta.task),
    runInBackground: meta.runInBackground === true,
    createdMs,
    mtimeMs,
    result: result
      ? {
          status: result.status === "completed" || result.status === "failed" || result.status === "aborted"
            ? result.status
            : "failed",
          completedMs,
          error: typeof result.error === "string" ? snippet(result.error) : undefined,
        }
      : null,
  };
}

/**
 * Every built-in subagent session touched since `sinceMs` (the app boot). A
 * running run's file is rewritten on every message, and the result entry is
 * appended at completion, so mtime >= sinceMs is an exact prefilter for
 * "running now or finished during this app session".
 */
function scanBuiltinSessions(sinceMs) {
  const files = [];
  collectJsonl(sessionsDir(), files, 0);
  const stated = [];
  for (const file of files) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (sinceMs && mtimeMs < sinceMs) continue;
    stated.push({ file, mtimeMs });
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const slice = sinceMs ? stated : stated.slice(0, MAX_SCAN_WITHOUT_SINCE);
  const out = [];
  for (const s of slice) {
    const parsed = readBuiltinSessionFile(s.file, s.mtimeMs);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** `GET /api/agent/running` → Set of running session ids, or null on failure. */
async function fetchRunningIds(serverUrl) {
  if (!serverUrl) return { ids: null, reason: "no-server" };
  const res = await request(serverUrl, "/api/agent/running", { timeoutMs: RUNNING_PROBE_TIMEOUT_MS });
  if (!res.ok || !res.json || !Array.isArray(res.json.runningSessionIds)) {
    return { ids: null, reason: "error", error: res.error || `HTTP ${res.status}` };
  }
  return { ids: new Set(res.json.runningSessionIds.map(String)), reason: "ok" };
}

/**
 * pi-web's global switch: ~/.pi/agent/agents/settings.json `builtInEnabled`,
 * false when absent or unreadable (pi-web fails closed the same way). Surfaced
 * so the popover can say WHY nothing shows up instead of a bare "none".
 */
function builtinEnabled() {
  const s = readJson(path.join(agentDir(), "agents", "settings.json"));
  return !!(s && s.builtInEnabled === true);
}

function resolveBuiltinStatus(entry, runningIds, nowMs) {
  if (runningIds && runningIds.has(entry.sessionId)) return "running";
  if (entry.result) return entry.result.status;
  if (!runningIds) return "unknown"; // server unreachable — can't tell
  return nowMs - entry.mtimeMs < STARTING_GRACE_MS ? "starting" : "interrupted";
}

/**
 * Built-in subagent state: running list + this-session tallies + recent.
 * @param {{ serverUrl?: string|null, sinceMs?: number }} opts
 */
async function readBuiltinSubagents(opts) {
  const sinceMs = opts.sinceMs || 0;
  const out = {
    enabled: builtinEnabled(),
    probe: "ok", // ok | no-server | error
    error: undefined,
    running: [],
    doneSession: 0,
    abortedSession: 0,
    failedSession: 0,
    recent: [],
  };

  let sessions = [];
  try {
    sessions = scanBuiltinSessions(sinceMs);
  } catch (e) {
    out.error = `子代理会话扫描失败: ${(e && e.message) || e}`;
  }

  const probe = await fetchRunningIds(opts.serverUrl);
  out.probe = probe.reason;
  if (probe.reason === "error") out.error = (out.error ? out.error + "; " : "") + `运行状态查询失败: ${probe.error}`;

  const now = Date.now();
  for (const s of sessions) {
    const status = resolveBuiltinStatus(s, probe.ids, now);
    const base = {
      kind: "builtin",
      sessionId: s.sessionId,
      parentSessionId: s.parentSessionId,
      agent: s.profile,
      description: s.description,
      task: s.task,
      mode: s.runInBackground ? "bg" : "fg",
      source: "builtin",
      cwd: s.cwd,
      startedMs: s.createdMs,
    };
    if (status === "running" || status === "starting" || status === "unknown") {
      out.running.push({ ...base, status });
      continue;
    }
    const endMs = s.result ? s.result.completedMs : s.mtimeMs;
    // Tallies are "this app session"; the recent list is not, so a fresh boot
    // still shows what the last runs were.
    if (!sinceMs || endMs >= sinceMs) {
      if (status === "completed") out.doneSession += 1;
      else if (status === "aborted") out.abortedSession += 1;
      else out.failedSession += 1; // failed | interrupted
    }
    out.recent.push({
      ...base,
      status,
      durationMs: s.createdMs && endMs > s.createdMs ? endMs - s.createdMs : undefined,
      ts: Math.floor(endMs / 1000),
      error: s.result ? s.result.error : undefined,
    });
  }
  // Newest first; running list oldest first (matches how they were launched).
  out.running.sort((a, b) => a.startedMs - b.startedMs);
  out.recent.sort((a, b) => b.ts - a.ts);
  return out;
}

// ---------------------------------------------------------------------------
// Legacy package — process table + async status + run history
// ---------------------------------------------------------------------------
async function readLegacySubagents(opts) {
  const out = { running: [], doneSession: 0, failedSession: 0, recent: [], error: undefined };

  let procEnumFailed = false;
  let procs = [];
  try {
    procs = await listProcesses();
    if (procs.length === 0) procEnumFailed = true;
  } catch (e) {
    procEnumFailed = true;
    out.error = `进程枚举失败: ${(e && e.message) || e}`;
  }

  let asyncRuns = { active: [], done: [] };
  try {
    asyncRuns = readAsyncRuns();
  } catch (e) {
    out.error = (out.error ? out.error + "; " : "") + `async 状态读取失败: ${(e && e.message) || e}`;
  }

  // Build the running list. Prefer the live process table (sees foreground +
  // background). Enrich a process with its background run's agent names when its
  // pid matches an async run; otherwise use the prompt-file name if we recovered
  // one. When process enumeration is unavailable, fall back to the async active
  // runs so background runs are still reflected.
  const row = (pid, agent, mode, source) => ({
    kind: "process",
    pid,
    agent,
    mode: mode || (source === "foreground" ? "fg" : "bg"),
    source,
    status: "running",
  });
  if (!procEnumFailed) {
    const running = findRunningSubagents(procs, opts.serverPid);
    const asyncByPid = new Map();
    for (const r of asyncRuns.active) if (r.pid) asyncByPid.set(r.pid, r);
    out.running = running.map((p) => {
      const match = asyncByPid.get(p.pid);
      if (match) return row(p.pid, match.agents.length ? match.agents.join(", ") : p.agent, match.mode, "background");
      return row(p.pid, p.agent, undefined, "foreground");
    });
    // Async runs whose pid never surfaced in the process table (e.g. a detached
    // run we couldn't link) still count — add any not already represented.
    const seenPids = new Set(out.running.map((r) => r.pid));
    for (const r of asyncRuns.active) {
      if (r.pid && seenPids.has(r.pid)) continue;
      out.running.push(row(r.pid, r.agents.length ? r.agents.join(", ") : undefined, r.mode, "background"));
    }
  } else {
    out.running = asyncRuns.active.map((r) =>
      row(r.pid, r.agents.length ? r.agents.join(", ") : undefined, r.mode, "background")
    );
  }

  const history = readRunHistory(opts.sinceMs);
  out.doneSession = history.doneSession;
  out.failedSession = history.failedSession;
  out.recent = history.recent.map((e) => ({
    kind: "process",
    agent: e.agent,
    description: "",
    status: e.status === "error" ? "failed" : "completed",
    durationMs: e.durationMs,
    ts: e.ts,
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------
const RECENT_LIMIT = 8;

/**
 * @param {{ serverUrl?: string|null, serverPid?: number, sinceMs?: number, cwd?: string|null }} [opts]
 *   serverUrl — the embedded pi-web server (running snapshot for built-in runs).
 *   serverPid — pid of the pi-web Next.js server (scopes legacy process counting
 *   to THIS app's children). sinceMs — app boot time, scopes the "done this
 *   session" tallies. cwd — active workspace (project-level settings lookup).
 * @returns {Promise<{
 *   running: number, runningList: Array, doneSession: number,
 *   abortedSession: number, failedSession: number, recent: Array,
 *   builtin: { enabled: boolean, probe: "ok"|"no-server"|"error" },
 *   legacy: { installed: boolean }, error?: string
 * }>}
 *
 * runningList rows are either
 *   { kind:"builtin", sessionId, parentSessionId, agent, description, task,
 *     mode:"bg"|"fg", status:"running"|"starting"|"unknown", startedMs }
 *   { kind:"process", pid, agent, mode, source, status:"running" }
 * recent rows carry kind/agent/description/status/durationMs/ts (+ error).
 */
async function readSubagents(opts) {
  opts = opts || {};
  const out = {
    running: 0,
    runningList: [],
    doneSession: 0,
    abortedSession: 0,
    failedSession: 0,
    recent: [],
    builtin: { enabled: false, probe: "no-server" },
    legacy: { installed: false },
    error: undefined,
  };
  const errors = [];

  try {
    const b = await readBuiltinSubagents({ serverUrl: opts.serverUrl, sinceMs: opts.sinceMs });
    out.builtin = { enabled: b.enabled, probe: b.probe };
    out.runningList.push(...b.running);
    out.doneSession += b.doneSession;
    out.abortedSession += b.abortedSession;
    out.failedSession += b.failedSession;
    out.recent.push(...b.recent);
    if (b.error) errors.push(b.error);
  } catch (e) {
    errors.push(`内置子代理读取失败: ${(e && e.message) || e}`);
  }

  let legacy = false;
  try {
    legacy = legacyInstalled(opts.cwd);
  } catch {
    /* treat as not installed */
  }
  out.legacy.installed = legacy;
  if (legacy) {
    try {
      const l = await readLegacySubagents({ serverPid: opts.serverPid, sinceMs: opts.sinceMs });
      out.runningList.push(...l.running);
      out.doneSession += l.doneSession;
      out.failedSession += l.failedSession;
      out.recent.push(...l.recent);
      if (l.error) errors.push(l.error);
    } catch (e) {
      errors.push(`pi-subagents 读取失败: ${(e && e.message) || e}`);
    }
  }

  out.running = out.runningList.length;
  out.recent.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  out.recent = out.recent.slice(0, RECENT_LIMIT);
  if (errors.length) out.error = errors.join("; ");
  return out;
}

// ---------------------------------------------------------------------------
// Stopping a running sub-agent
// ---------------------------------------------------------------------------
const STOP_GRACE_MS = 2500; // POSIX: SIGTERM → wait → SIGKILL the stragglers

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** taskkill the given pids (Windows). /T also sweeps children spawned after our
 * snapshot; /F because a pi run has no window to close politely. */
function taskkill(pids) {
  return new Promise((resolve) => {
    const args = ["/F", "/T"];
    for (const pid of pids) args.push("/PID", String(pid));
    execFile("taskkill.exe", args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      // taskkill exits non-zero when ANY pid was already gone, which is a normal
      // race here — liveness is re-checked by the caller, so this is only for the
      // diagnostic string.
      resolve(err ? String((stderr || stdout || err.message) || "").trim() : "");
    });
  });
}

async function killTree(procs, rootPid) {
  const levels = killOrder(procs, rootPid);
  const all = levels.flat();
  let detail = "";
  if (process.platform === "win32") {
    detail = await taskkill(all);
  } else {
    for (const level of levels) {
      for (const pid of level) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    await sleep(STOP_GRACE_MS);
    for (const pid of all) {
      if (!pidAlive(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  return { pids: all, detail };
}

/**
 * Legacy runs: kill the process subtree of each requested pid.
 *
 * Safety: a pid is killed ONLY if a FRESH process-table snapshot still shows it
 * as a pi-cli process descended from this app's pi-web server. The dashboard
 * polls at up to 3s intervals, so a pid taken from the rendered list can already
 * be dead — and on Windows pids get recycled fast, so acting on a stale one
 * could kill an unrelated process. If enumeration fails we refuse outright
 * rather than kill blind.
 */
async function stopLegacy(opts, out) {
  let procs = [];
  try {
    procs = await listProcesses();
  } catch (e) {
    out.error = `进程枚举失败: ${(e && e.message) || e}`;
    return;
  }
  if (procs.length === 0) {
    out.error = "进程枚举失败，已放弃终止（不按陈旧 pid 盲杀）";
    return;
  }

  const live = findRunningSubagents(procs, opts.serverPid);
  const livePids = new Set(live.map((r) => r.pid));

  const requested = opts.all
    ? live.map((r) => r.pid)
    : (Array.isArray(opts.pids) ? opts.pids : []).map(Number).filter((n) => Number.isInteger(n) && n > 1);

  for (const pid of requested) {
    if (!livePids.has(pid)) {
      // Either it finished on its own (benign) or it was never one of ours —
      // distinguishable by liveness, and only the latter is worth reporting.
      out.skipped.push(
        pidAlive(pid)
          ? { id: pid, code: "foreign", reason: "不是本应用的子会话进程，已拒绝终止" }
          : { id: pid, code: "gone", reason: "已结束" }
      );
      continue;
    }
    // A nested sub-agent may already have gone down with its parent's subtree.
    if (!pidAlive(pid)) {
      out.skipped.push({ id: pid, code: "gone", reason: "已结束" });
      continue;
    }
    const { detail } = await killTree(procs, pid);
    if (pidAlive(pid)) {
      out.skipped.push({ id: pid, code: "failed", reason: detail ? `终止失败: ${detail}` : "终止失败，进程仍在运行" });
    } else {
      out.stopped.push(pid);
    }
  }
}

/**
 * Built-in runs: pi-web's own graceful abort, `POST /api/agent/<id>
 * {type:"abort"}`. The run ends as `aborted` and its result entry is written by
 * pi-web, so the dashboard converges on the next poll.
 *
 * Safety: an id is accepted ONLY if a fresh JSONL scan still identifies it as a
 * subagent session (so the renderer cannot make us abort the user's main chat),
 * and the POST is gated behind `GET /api/agent/<id>` reporting running — a POST
 * to a session without a live wrapper would make pi-web start one.
 *
 * `abort` awaits the SDK's waitForIdle(), which blocks while a tool call that
 * ignores its AbortSignal is in flight (pi-web #368). We cap the wait and then
 * re-probe: still running ⇒ report "requested, pending" as a failure the user
 * can read, rather than pretending it stopped.
 */
async function stopBuiltin(opts, out) {
  const serverUrl = opts.serverUrl;
  if (!serverUrl) {
    out.error = "内嵌服务未就绪，无法中止内置子代理";
    return;
  }
  let known;
  try {
    known = new Map(scanBuiltinSessions(opts.sinceMs || 0).map((s) => [s.sessionId, s]));
  } catch (e) {
    out.error = `子代理会话扫描失败: ${(e && e.message) || e}`;
    return;
  }

  let requested;
  if (opts.all) {
    const probe = await fetchRunningIds(serverUrl);
    if (!probe.ids) {
      out.error = `运行状态查询失败: ${probe.error || probe.reason}`;
      return;
    }
    requested = [...known.keys()].filter((id) => probe.ids.has(id));
  } else {
    requested = (Array.isArray(opts.sessionIds) ? opts.sessionIds : [])
      .map((s) => String(s || "").trim())
      .filter(Boolean);
  }

  for (const id of requested) {
    if (!known.has(id)) {
      out.skipped.push({ id, code: "foreign", reason: "不是内置子代理会话，已拒绝中止" });
      continue;
    }
    const encoded = encodeURIComponent(id);
    const before = await request(serverUrl, `/api/agent/${encoded}`, { timeoutMs: RUNNING_PROBE_TIMEOUT_MS });
    if (!before.ok) {
      out.skipped.push({ id, code: "failed", reason: `状态查询失败: ${before.error || `HTTP ${before.status}`}` });
      continue;
    }
    if (before.json.running !== true) {
      out.skipped.push({ id, code: "gone", reason: "已结束" });
      continue;
    }
    const res = await request(serverUrl, `/api/agent/${encoded}`, {
      method: "POST",
      body: { type: "abort" },
      timeoutMs: ABORT_TIMEOUT_MS,
    });
    if (res.ok && res.json && res.json.success === true) {
      out.stopped.push(id);
      continue;
    }
    // Timed out or errored — see whether it went down anyway.
    const after = await request(serverUrl, `/api/agent/${encoded}`, { timeoutMs: RUNNING_PROBE_TIMEOUT_MS });
    if (after.ok && after.json.running !== true) {
      out.stopped.push(id);
      continue;
    }
    const why =
      res.error === "timeout"
        ? "已发出中止请求，但当前工具调用仍在执行，子代理会在其结束后停止"
        : `中止失败: ${(res.json && res.json.error) || res.error || `HTTP ${res.status}`}`;
    out.skipped.push({ id, code: "failed", reason: why });
  }
}

/**
 * Stop one or more running sub-agent sessions, of either generation.
 *
 * @param {{ serverUrl?: string|null, serverPid?: number, sinceMs?: number,
 *   all?: boolean, pids?: number[], sessionIds?: string[] }} opts
 *   all — stop everything running (both kinds). Otherwise `pids` name legacy
 *   process runs and `sessionIds` name built-in runs; either may be empty.
 * @returns {Promise<{ ok: boolean, stopped: Array<number|string>,
 *   skipped: Array<{id:number|string, code:"gone"|"foreign"|"failed", reason:string}>,
 *   error?: string }>}
 *   `ok` means every requested run is now gone — either we stopped it or it
 *   finished on its own between the poll and the click ("gone" is benign). A
 *   "foreign" or "failed" skip is a real refusal and must reach the user.
 */
async function stopSubagents(opts) {
  opts = opts || {};
  const out = { ok: false, stopped: [], skipped: [], error: undefined };

  const wantBuiltin = opts.all || (Array.isArray(opts.sessionIds) && opts.sessionIds.length > 0);
  const wantLegacy =
    (opts.all && legacyInstalled(opts.cwd)) || (Array.isArray(opts.pids) && opts.pids.length > 0);

  if (!wantBuiltin && !wantLegacy) {
    out.ok = !!opts.all; // "stop all" with nothing running is a no-op, not a failure
    if (!out.ok) out.error = "没有可中止的子代理";
    return out;
  }

  if (wantBuiltin) await stopBuiltin(opts, out);
  if (wantLegacy) await stopLegacy(opts, out);

  out.ok = !out.error && out.skipped.every((s) => s.code === "gone");
  if (!out.ok && !out.error) {
    out.error = out.skipped
      .filter((s) => s.code !== "gone")
      .map((s) => `${s.id}: ${s.reason}`)
      .join("; ");
  }
  return out;
}

module.exports = { readSubagents, stopSubagents };
