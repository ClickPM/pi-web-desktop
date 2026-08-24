"use strict";

/**
 * DeepSeek Harness (dsh) — the shell's SECOND embedded runtime, started ON
 * DEMAND.
 *
 * Shape-wise dsh is the same animal as pi-web: `dsh web --host 127.0.0.1
 * --port <n>` binds a loopback HTTP server and prints
 * `dsh web: http://127.0.0.1:<port>`, so it reuses this shell's existing
 * machinery wholesale — bundled node, npm-installed runtime seed copied to a
 * writable dir, runtime-guard's staging+swap update path, a free port, an HTTP
 * readiness probe, a BrowserWindow.
 *
 * Four things are deliberately NOT shared with pi:
 *
 *  1. NO PRELOAD. preload.js gates its injections on
 *     `location.protocol === "http:"` only, so on a dsh page (also
 *     http://127.0.0.1) it would mount pi's dashboard and Tools chip — panels
 *     whose IPC reads ~/.pi and would report numbers that have nothing to do
 *     with what the window is showing. A window with no preload is the whole
 *     fix; there is nothing dsh needs from the shell (its directory picker
 *     opens a native Windows IFileOpenDialog from its own host process).
 *
 *  2. NO nativeTheme WRITES. `nativeTheme.themeSource` is app-global, so a
 *     second window driving it would repaint the pi window's title bar too.
 *     The pi window stays the sole authority (features/native-theme.js).
 *
 *  3. ITS OWN LOCK. dsh's runtime dir is separate from pi's, so its update and
 *     self-heal serialize against each other but never block a pi operation.
 *
 *  4. LIFECYCLE = THE WINDOW. Closing the dsh window stops its server. dsh
 *     boots a large plugin tree; keeping it resident for a feature the user
 *     may open once a week is not worth the RAM.
 *
 * NODE FLOOR: dsh needs node >= 22.19 (it imports `createZstdDecompress` from
 * node:zlib and `stripTypeScriptTypes` from node:module). vendor/node is
 * provisioned by scripts/seed-node.ps1, which enforces that floor — do not
 * downgrade it.
 */

const { BrowserWindow, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const updater = require("../updater");
const runtimeGuard = require("../runtime-guard");
const piModelImport = require("./pi-model-import");

const PKG = "@deepseek-ai/dsh";
const SEED_DIRNAME = "runtime-seed-dsh";
const isWindows = process.platform === "win32";

/** Injected by main.js — see configure(). */
let ctx = null;

let serverProc = null;
let serverUrl = null;
let serverLog = "";
let win = null;
let starting = null;
let stoppingIntentionally = false;
let _runtimeDirCache = null;
let lock = Promise.resolve();

function dbg(msg) {
  if (ctx && ctx.dbg) ctx.dbg(`[dsh] ${msg}`);
}

/**
 * Serialize everything that touches the dsh runtime dir (update, self-heal),
 * mirroring main.js's withRuntimeLock for pi. Separate chain: a dsh update must
 * not wait behind a pi one, and vice versa.
 */
function withLock(label, fn) {
  const run = lock.then(async () => {
    dbg(`lock acquire: ${label}`);
    try {
      return await fn();
    } finally {
      dbg(`lock release: ${label}`);
    }
  });
  lock = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function seedDir() {
  return path.join(ctx.resourcesBase(), SEED_DIRNAME);
}

/** Prefer running in place from a writable install dir; otherwise copy out. */
function runtimeDir() {
  if (_runtimeDirCache) return _runtimeDirCache;
  const seed = seedDir();
  if (fs.existsSync(seed) && ctx.isWritable(seed)) {
    _runtimeDirCache = seed;
    dbg(`runtimeDir = seed (in-place, writable): ${seed}`);
  } else {
    _runtimeDirCache = path.join(ctx.userDataDir(), "dsh-runtime");
    dbg(`runtimeDir = userData (seed read-only): ${_runtimeDirCache}`);
  }
  return _runtimeDirCache;
}

function binPath() {
  return path.join(runtimeDir(), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}

/**
 * $DSH_HOME. Defaults to dsh's own `~/.dsh` rather than a shell-private dir so
 * the desktop shares sessions and settings with a `dsh` the user runs from a
 * terminal. The cost is cosmetic: each launch re-points the junctions in
 * `$DSH_HOME/profiles/node_modules` at whichever installation started last,
 * which dsh does idempotently at boot (healProfilesModuleFallback) and which
 * therefore never leaves either installation broken.
 */
function dshHome() {
  return process.env.PI_DESKTOP_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function importStatePath() {
  return path.join(ctx.userDataDir(), "dsh-model-import.json");
}

/** Persisted import state — provider ids and env-var NAMES only, never keys. */
function readImportState() {
  try {
    return JSON.parse(fs.readFileSync(importStatePath(), "utf8").replace(/^﻿/, ""));
  } catch {
    return { credentials: [] };
  }
}

function requireFromRuntime(pkg) {
  return require(path.join(runtimeDir(), "node_modules", pkg));
}

// ---------------------------------------------------------------------------
// Runtime provisioning
// ---------------------------------------------------------------------------
function updaterCtx() {
  return {
    bundledNode: ctx.bundledNodeExe(),
    npmCli: ctx.bundledNpmCli(),
    nodeDir: ctx.bundledNodeDir(),
    runtimeDir: runtimeDir(),
    registry: ctx.registry,
  };
}

function guardCtx(overrides = {}) {
  return {
    ...updaterCtx(),
    dbg,
    requiredFiles: runtimeGuard.DSH_REQUIRED_FILES,
    installInto: (dir, spec, onProgress) => updater.installInto(updaterCtx(), dir, spec, onProgress),
    ...overrides,
  };
}

function installedVersion() {
  return updater.getInstalledVersion(runtimeDir(), PKG);
}

/** Copy the shipped seed into the writable runtime dir on first use. */
async function ensureRuntime() {
  const rt = runtimeDir();
  const seed = seedDir();
  if (path.resolve(rt) === path.resolve(seed)) {
    const v = installedVersion();
    if (!v) throw new Error(`dsh 运行时不完整：${rt}`);
    return v;
  }
  const marker = path.join(rt, ".seeded");
  if (fs.existsSync(marker)) {
    const v = installedVersion();
    if (v) return v;
  }
  if (!fs.existsSync(path.join(seed, "node_modules", "@deepseek-ai", "dsh"))) {
    throw new Error(`dsh 运行时种子缺失或不完整：${seed}`);
  }
  await fs.promises.mkdir(rt, { recursive: true });
  dbg(`seeding runtime: ${seed} -> ${rt}`);
  await ctx.copyRuntime(seed, rt);
  const v = installedVersion();
  if (!v) throw new Error(`dsh 种子复制不完整：${rt}`);
  fs.writeFileSync(marker, v);
  return v;
}

/**
 * Boot preflight — the same native-module probe pi's runtime gets. dsh ships
 * four prebuilt addons (node-pty ×3, sharp, koffi, node-addon-require-builtin);
 * a torn download of any of them would otherwise surface as an opaque boot
 * failure minutes later.
 */
async function ensureRuntimeHealthy() {
  const rt = runtimeDir();
  const check = await runtimeGuard.verifyRuntime(guardCtx(), rt);
  if (check.ok) return;
  const summary = runtimeGuard.describeFailures(check.failures);
  dbg(`preflight failed: ${summary} (healable=${check.healable})`);
  if (!check.healable) throw new Error(`dsh 运行时校验失败且无法自动修复：${summary}`);
  await withLock("self-heal", () =>
    runtimeGuard.provisionRuntime(guardCtx(), {
      reason: "self-heal",
      spec: null, // reinstall what the lockfile pins — repair, never a silent upgrade
      stopServer: stop,
    })
  );
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
/** Environment for the dsh child: bundled runtimes on PATH + imported keys. */
function serverEnv() {
  const credentialEnv = piModelImport.buildCredentialEnv(readImportState().credentials);
  const names = Object.keys(credentialEnv);
  if (names.length) dbg(`injecting ${names.length} imported provider credential(s): ${names.join(", ")}`);
  return {
    ...process.env,
    DSH_HOME: dshHome(),
    // Bundled node first so dsh's own tooling and any node/npx a tool spawns
    // resolve to the runtime we ship; bundled python for the same reason.
    PATH: [ctx.bundledNodeDir(), ...ctx.bundledPythonPathDirs(), process.env.PATH || ""]
      .filter(Boolean)
      .join(path.delimiter),
    ...credentialEnv,
  };
}

function startServer(port) {
  const bin = binPath();
  dbg(`startServer node=${ctx.bundledNodeExe()} bin=${bin} exists=${fs.existsSync(bin)} port=${port} home=${dshHome()}`);
  if (!fs.existsSync(bin)) throw new Error(`dsh 入口缺失：${bin}`);

  serverProc = spawn(
    ctx.bundledNodeExe(),
    [bin, "web", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: runtimeDir(),
      env: serverEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !isWindows,
    }
  );

  const capture = (chunk) => {
    const text = chunk.toString();
    serverLog += text;
    if (serverLog.length > 20000) serverLog = serverLog.slice(-20000);
    dbg(`[server] ${text.replace(/\s+$/, "")}`);
    process.stdout.write(`[dsh] ${text}`);
  };
  serverProc.stdout.on("data", capture);
  serverProc.stderr.on("data", capture);
  serverProc.on("error", (e) => dbg(`spawn ERROR ${(e && e.message) || e}`));
  serverProc.on("exit", (code, signal) => {
    dbg(`server exit code=${code} signal=${signal}`);
    serverProc = null;
    if (stoppingIntentionally) return;
    // An unexpected exit while the window is open is worth surfacing; the tail
    // of the log is where a rejected settings.yaml route shows up.
    if (win && !win.isDestroyed()) {
      dialog.showErrorBox(
        "DeepSeek Harness 服务已停止",
        `内嵌服务意外退出 (code=${code}, signal=${signal})。\n\n最近输出:\n${serverLog.slice(-2000)}`
      );
    }
  });
}

function stop() {
  if (!serverProc || serverProc.killed) {
    serverProc = null;
    serverUrl = null;
    return;
  }
  stoppingIntentionally = true;
  const pid = serverProc.pid;
  try {
    if (isWindows) {
      // /t: dsh spawns node-pty children and subagent processes; the tree goes too.
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    /* ignore */
  }
  serverProc = null;
  serverUrl = null;
  setTimeout(() => {
    stoppingIntentionally = false;
  }, 1000);
}

/** Start the server if it isn't up; concurrent callers share one attempt. */
function ensureServer() {
  if (serverUrl && serverProc) return Promise.resolve(serverUrl);
  if (starting) return starting;
  const attempt = (async () => {
    await ensureRuntime();
    await ensureRuntimeHealthy();
    stoppingIntentionally = false;
    const port = await ctx.getFreePort();
    startServer(port);
    const url = `http://127.0.0.1:${port}`;
    // dsh's first boot in a fresh $DSH_HOME writes the profile and ~250
    // junctions before it listens, so the probe needs real headroom.
    await ctx.waitForServer(`${url}/`, 120000);
    serverUrl = url;
    dbg(`server up at ${url}`);
    return url;
  })();
  // Clear the in-flight marker either way: a failed start must not wedge every
  // later attempt on a rejected promise.
  starting = attempt;
  const clear = () => {
    if (starting === attempt) starting = null;
  };
  attempt.then(clear, clear);
  return attempt;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0A0A0A",
    autoHideMenuBar: true,
    title: "DeepSeek Harness",
    icon: path.join(__dirname, "..", "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // No preload — see the module header (point 1).
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "dsh-loading.html"));
  win.on("page-title-updated", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    win = null;
    dbg("window closed — stopping the embedded dsh server");
    stop();
  });
  return win;
}

/** Menu entry: open (or focus) the dsh window, starting the server on demand. */
async function open() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    createWindow();
  }
  try {
    const url = await ensureServer();
    if (!win || win.isDestroyed()) {
      // Closed while the server was still booting: the window's own "closed"
      // handler fired before there was a process to kill, so stop it here or it
      // outlives its only reason to exist.
      dbg("window closed before the server finished starting — stopping it");
      stop();
      return;
    }
    // Re-navigate only when the window isn't already on this server — a focus
    // click must not reload a session mid-turn.
    if (!win.webContents.getURL().startsWith(url)) win.loadURL(url);
  } catch (e) {
    dbg(`open failed: ${(e && e.stack) || e}`);
    if (win && !win.isDestroyed()) {
      await win.loadFile(path.join(__dirname, "..", "error.html")).catch(() => {});
      win.webContents
        .executeJavaScript(
          `window.__setError(${JSON.stringify(String((e && e.message) || e))}, ${JSON.stringify(serverLog.slice(-3000))})`
        )
        .catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
/**
 * Check npm for a newer dsh and install it through the same staging+swap path
 * pi uses.
 *
 * Note this only works because updater.isNewer understands prereleases: every
 * dsh release so far is an `-rc.N` prerelease (`0.1.0-rc.7`, `0.1.1-rc.2`, …),
 * which the old truncate-at-"-" comparison would have reported as "already
 * up to date" forever.
 */
async function checkUpdate(interactive) {
  try {
    await ensureRuntime();
    const installed = installedVersion();
    const latest = await updater.getLatestVersion(updaterCtx(), PKG);
    dbg(`update check installed=${installed} latest=${latest}`);
    if (!updater.isNewer(latest, installed)) {
      if (interactive) {
        dialog.showMessageBox({
          type: "info",
          title: "DeepSeek Harness",
          message: `已是最新版本 (${installed || "未知"})`,
        });
      }
      return { updated: false, installed, latest };
    }
    if (interactive) {
      const { response } = await dialog.showMessageBox({
        type: "question",
        buttons: ["更新", "取消"],
        defaultId: 0,
        cancelId: 1,
        title: "DeepSeek Harness",
        message: `发现新版本 ${latest}（当前 ${installed || "未安装"}）`,
        detail:
          "dsh 仍处于 developer preview，其 README 明确说明 rc 之间可能有不兼容变更。更新会重新下载约 330MB 的运行时。",
      });
      if (response !== 0) return { updated: false, installed, latest };
    } else {
      // Silent path never upgrades a preview package behind the user's back.
      return { updated: false, installed, latest, available: true };
    }
    await withLock("update", () =>
      runtimeGuard.provisionRuntime(guardCtx(), {
        reason: "update",
        spec: `${PKG}@latest`,
        stopServer: stop,
      })
    );
    if (win && !win.isDestroyed() && serverUrl === null) await open();
    dialog.showMessageBox({
      type: "info",
      title: "DeepSeek Harness",
      message: `已更新到 ${latest}`,
      detail: "下次打开 DeepSeek Harness 窗口时生效。",
    });
    return { updated: true, installed, latest };
  } catch (e) {
    dbg(`update failed: ${(e && e.stack) || e}`);
    if (interactive) dialog.showErrorBox("DeepSeek Harness 更新失败", String((e && e.message) || e));
    return { updated: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Model import
// ---------------------------------------------------------------------------
/** Menu entry: restate pi's custom providers as dsh routes. */
async function importPiModels() {
  try {
    await ensureRuntime();
    const piConfig = piModelImport.readPiConfig();
    const mapped = piModelImport.mapProviders(piConfig);
    const ids = Object.keys(mapped.providers);
    if (!ids.length) {
      dialog.showMessageBox({
        type: "info",
        title: "从 Pi 导入模型配置",
        message: "没有找到可导入的自建提供方",
        detail:
          `已检查 ${piModelImport.piAgentDir()}。\n` +
          (mapped.skipped.length ? `跳过：\n- ${mapped.skipped.join("\n- ")}` : "pi 的 models.json 里没有带 baseUrl 的提供方。"),
      });
      return { imported: 0 };
    }

    const settingsPath = path.join(dshHome(), "settings.yaml");
    const detail = [
      `将写入 ${settingsPath} 的 llm-pi-ai.providers：`,
      ...ids.map((id) => `  · ${id}（${mapped.providers[id].models.length} 个模型）`),
      "",
      "API Key 不会被复制：settings 里只写环境变量名，密钥在每次启动 dsh 时从 pi 的配置读出并通过子进程环境注入。",
      mapped.skipped.length ? `\n未导入：\n- ${mapped.skipped.join("\n- ")}` : "",
      mapped.warnings.length ? `\n注意（${mapped.warnings.length} 条）：\n- ${mapped.warnings.slice(0, 8).join("\n- ")}` : "",
      mapped.warnings.length > 8 ? `  …另有 ${mapped.warnings.length - 8} 条，见 ${ctx.debugLogPath()}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["导入", "取消"],
      defaultId: 0,
      cancelId: 1,
      title: "从 Pi 导入模型配置",
      message: `导入 ${ids.length} 个提供方到 DeepSeek Harness？`,
      detail,
    });
    if (response !== 0) return { imported: 0, cancelled: true };

    for (const w of mapped.warnings) dbg(`import warning: ${w}`);
    const { backup } = piModelImport.mergeIntoSettings(settingsPath, mapped.providers, requireFromRuntime);
    fs.writeFileSync(
      importStatePath(),
      JSON.stringify({ importedAt: new Date().toISOString(), providers: ids, credentials: mapped.credentials }, null, 2)
    );
    dbg(`imported ${ids.length} provider(s); backup=${backup || "(none)"}`);

    const restart = serverProc !== null;
    if (restart) {
      stop();
      await open();
    }
    dialog.showMessageBox({
      type: "info",
      title: "从 Pi 导入模型配置",
      message: `已导入 ${ids.length} 个提供方`,
      detail:
        (backup ? `原 settings.yaml 已备份为 ${path.basename(backup)}。\n` : "") +
        (restart ? "dsh 服务已重启。" : "下次打开 DeepSeek Harness 时生效。") +
        "\n若 dsh 因配置被拒而起不来，恢复该备份即可。",
    });
    return { imported: ids.length };
  } catch (e) {
    dbg(`import failed: ${(e && e.stack) || e}`);
    dialog.showErrorBox("从 Pi 导入模型配置失败", String((e && e.message) || e));
    return { imported: 0, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
function configure(injected) {
  ctx = injected;
}

module.exports = {
  PKG,
  configure,
  open,
  stop,
  checkUpdate,
  importPiModels,
  // exported for diagnostics/tests
  runtimeDir,
  binPath,
  dshHome,
  installedVersion,
  isRunning: () => serverProc !== null,
};
