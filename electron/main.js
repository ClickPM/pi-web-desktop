"use strict";

/**
 * pi-web-desktop — Electron main process (v2: bundled Node + self-updating runtime).
 *
 * Architecture:
 *  - A Node.js runtime is BUNDLED in the app (resources/node), so the target
 *    machine needs nothing pre-installed.
 *  - pi-web (the npm package @agegr/pi-web, which ships a prebuilt .next plus its
 *    @earendil-works/pi-coding-agent dependency) lives in a WRITABLE per-user
 *    runtime dir. A seed copy is shipped in the app and copied out on first run
 *    (so first launch works offline).
 *  - "Check for updates" installs `@agegr/pi-web@latest` with the bundled npm —
 *    updating pi-web + the agent SDK without a rebuild and without republishing
 *    this desktop app. The install goes into a STAGING dir and is swapped into
 *    place by a directory rename only after it passes verification, so an
 *    interrupted update can no longer damage the runtime that currently works
 *    (see runtime-guard.js — this replaced an in-place install that had
 *    corrupted the runtime twice).
 *  - Every boot verifies the runtime's native modules actually load before
 *    starting the server, and repairs a torn install through that same atomic
 *    path. Both entry points share one lock, so a self-heal and an update check
 *    can never run at the same time.
 *  - The Next.js server is launched hidden (no console window) on a random
 *    127.0.0.1 port and shown in a native window.
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, protocol } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const updater = require("./updater");
const runtimeGuard = require("./runtime-guard");
const directoryPicker = require("./features/directory-picker");
const nativeThemeSync = require("./features/native-theme");
const { DesktopHostProcess } = require("./host-process");

const SCHEME = "pi-app";

// Register pi-app as privileged scheme BEFORE app ready (same as DeepSeek Harness dsh-app)
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      codeCache: true,
    },
  },
]);

const isWindows = process.platform === "win32";
const REGISTRY = process.env.PI_WEB_REGISTRY || "https://registry.npmmirror.com";
const AUTO_CHECK = process.env.PI_WEB_AUTO_UPDATE_CHECK !== "0";
// The pi CLI package name, as pi-subagents spells it when validating a package
// root handed to it via this env var (its shared/utils.ts + runs/shared/pi-spawn.ts).
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

const os = require("os");
const DEBUG_LOG = path.join(os.tmpdir(), "pi-web-desktop-debug.log");
function dbg(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function resourcesBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
}
function bundledNodeDir() {
  // packaged: resources/node ; dev: vendor/node
  return app.isPackaged
    ? path.join(process.resourcesPath, "node")
    : path.join(__dirname, "..", "vendor", "node");
}
function bundledNodeExe() {
  return path.join(bundledNodeDir(), isWindows ? "node.exe" : "bin/node");
}
function bundledNpmCli() {
  return path.join(bundledNodeDir(), "node_modules", "npm", "bin", "npm-cli.js");
}
// Bundled relocatable Python (python-build-standalone, ppt-master deps
// pre-installed). packaged: resources/python ; dev: vendor/python.
function bundledPythonDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "python")
    : path.join(__dirname, "..", "vendor", "python");
}
function bundledPythonExe() {
  // install_only Windows build keeps python.exe at the dir root.
  return path.join(bundledPythonDir(), isWindows ? "python.exe" : "bin/python3");
}
// PATH dirs to prepend so the bundled python + its console scripts resolve.
// Empty when the bundled Python is absent (dev before `npm run seed:python`).
function bundledPythonPathDirs() {
  const exe = bundledPythonExe();
  if (!fs.existsSync(exe)) return [];
  const pyDir = bundledPythonDir();
  return [pyDir, path.join(pyDir, isWindows ? "Scripts" : "bin")];
}
// Env vars that wire the bundled Python into the pi server's environment so the
// python-workdir-guard extension can (a) create project .venvs FROM it (zero
// system-Python dependency) and (b) allowlist it for app-bundled skills like
// ppt-master — while still forcing the user's own project code through .venv.
// Returns {} when the bundled Python is absent so the guard cleanly falls back
// to a system Python.
function bundledPythonGuardEnv() {
  const exe = bundledPythonExe();
  if (!fs.existsSync(exe)) return {};
  return {
    // Read by ppt-master's SKILL.md to invoke its scripts on the bundled python.
    PI_BUNDLED_PYTHON: exe,
    // python-workdir-guard: interpreter to create project .venv from.
    PI_PY_GUARD_PYTHON: exe,
    // python-workdir-guard: extra interpreter treated as venv-compliant.
    PI_PY_GUARD_BUNDLED_PYTHON: exe,
  };
}
function seedDir() {
  return path.join(resourcesBase(), app.isPackaged ? "runtime-seed" : "runtime-seed");
}
let _runtimeDirCache = null;
function isWritable(dir) {
  try {
    const probe = path.join(dir, `.wtest-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
function runtimeDir() {
  if (_runtimeDirCache) return _runtimeDirCache;
  const seed = seedDir();
  // Preferred: run pi-web IN PLACE from the (writable) install dir — instant, no
  // first-run copy. Per-user installs (%LOCALAPPDATA%\Programs) and the unpacked
  // build are writable. Fallback (read-only install, e.g. Program Files): copy to
  // a writable user dir.
  if (fs.existsSync(seed) && isWritable(seed)) {
    _runtimeDirCache = seed;
    dbg(`runtimeDir = seed (in-place, writable): ${seed}`);
  } else {
    _runtimeDirCache = path.join(app.getPath("userData"), "runtime");
    dbg(`runtimeDir = userData (seed read-only): ${_runtimeDirCache}`);
  }
  return _runtimeDirCache;
}
function piWebPkgDir() {
  return path.join(runtimeDir(), "node_modules", "@agegr", "pi-web");
}
function nextBinPath() {
  return path.join(runtimeDir(), "node_modules", "next", "dist", "bin", "next");
}
// The pi CLI package inside our runtime — i.e. what `pi` actually IS in this app.
function bundledPiAgentDir() {
  return path.join(runtimeDir(), "node_modules", "@earendil-works", "pi-coding-agent");
}
// Tell `pi-subagents` which pi to spawn subagents with.
//
// Left alone it probes process.argv[1] — which for our server is next's bin,
// nowhere near pi-coding-agent — and then import.meta.resolve() from its own
// install under ~/.pi/agent/npm, where @earendil-works is EMPTY because the
// desktop never npm-installs the agent there. Both miss, and getPiSpawnCommand()
// falls back to a bare "pi" on PATH: a separately installed, independently
// versioned global CLI, or nothing at all. Handing it the bundled root makes
// every subagent run the SAME pi as its parent on the SAME bundled node (the
// package spawns process.execPath + <root>/dist/cli.js) and inherit this
// process's config/auth env — no global pi, node or npm required. Correct
// whether the runtime runs in place or was copied to userData, since
// runtimeDir() has already settled that.
//
// Validated the way pi-subagents validates it (resolveExplicitPiPackageRoot):
// a root whose package.json name doesn't match is silently ignored there, so
// check here too and say so in the log rather than exporting an env var that
// quietly does nothing. Returns {} on any failure — the PATH fallback still
// applies, exactly as before.
function bundledPiAgentEnv() {
  const root = bundledPiAgentDir();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (pkg.name !== PI_CODING_AGENT_PACKAGE) {
      dbg(`bundled pi package root is "${pkg.name}", expected ${PI_CODING_AGENT_PACKAGE} — subagents fall back to PATH`);
      return {};
    }
  } catch (e) {
    dbg(`bundled pi package root unusable at ${root} (${(e && e.message) || e}) — subagents fall back to PATH`);
    return {};
  }
  return { [PI_CODING_AGENT_PACKAGE_ROOT_ENV]: root };
}
function updaterCtx() {
  return {
    bundledNode: bundledNodeExe(),
    npmCli: bundledNpmCli(),
    nodeDir: bundledNodeDir(),
    runtimeDir: runtimeDir(),
    registry: REGISTRY,
  };
}

/**
 * Context for runtime-guard.js — the updater context plus the two things the
 * guard needs but must not import itself: a logger, and an install function
 * bound to the bundled npm. Keeping `installInto` injected here means the guard
 * has no opinion about HOW packages arrive, only about verifying the result and
 * swapping it in atomically.
 */
function guardCtx(overrides = {}) {
  const base = updaterCtx();
  return {
    ...base,
    dbg,
    installInto: (dir, spec, onProgress) => updater.installInto(base, dir, spec, onProgress),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Runtime write lock
// ---------------------------------------------------------------------------
// EVERY path that mutates the runtime tree — the boot-time self-heal, the
// automatic update check, and the manual "更新并重启" — goes through this gate.
// Two of them running at once would race on the same staging dir and the same
// swap journal, so overlapping requests are dropped rather than queued: the
// loser has nothing useful to do by the time the winner finishes.
let runtimeBusy = false;
// When the runtime was last (re)provisioned. The boot auto-check consults this
// to avoid immediately re-installing over a self-heal that just finished.
let lastProvisionMs = 0;

async function withRuntimeLock(label, fn) {
  if (runtimeBusy) {
    dbg(`runtime lock held — skipping ${label}`);
    return { skipped: true };
  }
  runtimeBusy = true;
  dbg(`runtime lock acquired by ${label}`);
  try {
    return await fn();
  } finally {
    runtimeBusy = false;
    lastProvisionMs = Date.now();
    dbg(`runtime lock released by ${label}`);
  }
}

/**
 * Stop the embedded server so its file handles release, letting the directory
 * rename in the swap succeed. Passed to provisionRuntime, which calls it only
 * after staging has passed verification — the download itself runs with the old
 * server still up.
 */
async function stopServerForSwap() {
  stoppingForUpdate = true; // deliberate kill — suppress the crash popup
  killServer();
  await new Promise((r) => setTimeout(r, 600)); // let Windows release handles
}

// ---------------------------------------------------------------------------
// Runtime seeding (first run copies the bundled seed to a writable dir)
// ---------------------------------------------------------------------------
/**
 * Robustly copy the seed dir CONTENTS into dst.
 * fs.cp aborts partway on huge node_modules trees on Windows (long paths),
 * so we use robocopy on Windows (battle-tested, long-path safe) and cp -a else.
 */
function copyRuntime(src, dst) {
  return new Promise((resolve, reject) => {
    if (isWindows) {
      const p = spawn(
        "robocopy",
        [src, dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"],
        { windowsHide: true }
      );
      p.on("error", reject);
      p.on("exit", (code) => {
        // robocopy: exit code < 8 == success (0=no change, 1=copied, etc.)
        if (code != null && code >= 8) reject(new Error(`robocopy failed (code ${code})`));
        else resolve();
      });
    } else {
      const p = spawn("cp", ["-a", `${src}/.`, dst]);
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cp failed (code ${code})`))));
    }
  });
}

async function ensureRuntime() {
  const rt = runtimeDir();
  const seed = seedDir();
  const inPlace = path.resolve(rt) === path.resolve(seed);

  if (inPlace) {
    // Running directly from the writable install dir — no copy needed.
    const v = updater.getInstalledVersion(rt);
    const reactOk = fs.existsSync(path.join(rt, "node_modules", "react", "package.json"));
    dbg(`ensureRuntime in-place v=${v} reactOk=${reactOk}`);
    if (!v || !reactOk) throw new Error(`in-place runtime incomplete at ${rt}`);
    return v;
  }

  // Fallback (read-only install): copy seed -> writable user dir.
  const marker = path.join(rt, ".seeded");
  if (fs.existsSync(marker)) {
    const v = updater.getInstalledVersion(rt);
    if (v) return v;
  }
  if (!fs.existsSync(path.join(seed, "node_modules", "@agegr", "pi-web", ".next"))) {
    throw new Error(`runtime seed not found or incomplete at ${seed}`);
  }
  await fs.promises.mkdir(rt, { recursive: true });
  dbg(`seeding runtime via robust copy: ${seed} -> ${rt}`);
  await copyRuntime(seed, rt);

  const v = updater.getInstalledVersion(rt);
  const reactOk = fs.existsSync(path.join(rt, "node_modules", "react", "package.json"));
  dbg(`seed copy done: version=${v} reactOk=${reactOk}`);
  if (!v || !reactOk) {
    throw new Error(`seed copy incomplete (version=${v}, react=${reactOk})`);
  }
  fs.writeFileSync(marker, v);
  return v;
}

// ---------------------------------------------------------------------------
// Runtime integrity: crash recovery + boot preflight + self-heal
// ---------------------------------------------------------------------------
/**
 * Reconcile an interrupted swap BEFORE anything else looks at the runtime.
 *
 * This deliberately runs against both possible runtime locations instead of
 * asking runtimeDir() where the runtime is, because runtimeDir()'s answer is
 * not trustworthy yet: it picks the seed dir only `if (fs.existsSync(seed) &&
 * isWritable(seed))`. A crash between the swap's two renames leaves the seed
 * dir temporarily absent, so calling runtimeDir() first would silently latch
 * onto the userData fallback — and then fail to seed from a directory that is
 * sitting right there in `.runtime-seed.trash`. Recovering first, and caching
 * nothing until it is done, keeps that from happening.
 */
async function recoverRuntimeCandidates() {
  const ctx = { dbg };
  const candidates = [seedDir(), path.join(app.getPath("userData"), "runtime")];
  for (const dir of candidates) {
    try {
      const r = await runtimeGuard.recoverInterruptedSwap(ctx, dir);
      if (r && r.recovered) dbg(`recoverInterruptedSwap(${dir}) -> ${r.action}`);
    } catch (e) {
      dbg(`recoverInterruptedSwap(${dir}) failed (non-fatal): ${(e && e.message) || e}`);
    }
  }
}

/**
 * Boot preflight. Verifies the runtime actually loads and, when it does not,
 * repairs it through the same atomic path an update uses.
 *
 * The self-heal reinstalls the CURRENT version (spec = null, i.e. straight from
 * the lockfile) rather than jumping to latest: a damaged install is not a
 * reason to also change versions, and staying put keeps the failure domain
 * small. If a newer version does exist, the ordinary auto-check picks it up a
 * few seconds later — through this same lock, so the two never overlap.
 *
 * Returns true when the runtime is usable (either it was fine, or it was
 * repaired). False means the caller should surface a real error.
 */
async function ensureRuntimeHealthy() {
  const ctx = guardCtx();
  const check = await runtimeGuard.verifyRuntime(ctx, runtimeDir());
  if (check.ok) {
    dbg("preflight: runtime verified");
    return true;
  }

  const summary = runtimeGuard.describeFailures(check.failures);
  dbg(`preflight FAILED: ${summary} (healable=${check.healable})`);

  if (!check.healable) {
    // Broken in a way reinstalling cannot fix (bad ABI, missing system library).
    // Reinstalling in a loop would waste minutes and still fail, so report it.
    throw new Error(
      `运行时组件无法加载：${summary}\n\n` +
        `这通常不是安装损坏，而是运行环境问题（缺少系统依赖或架构不匹配）。`
    );
  }

  // Tell the user why the first launch is slow — a silent multi-minute stall
  // looks identical to a hang. Its own page rather than updating.html, so a
  // repair never reads as "you are being upgraded".
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "healing.html")).catch(() => {});
  }

  const result = await withRuntimeLock("self-heal", () =>
    runtimeGuard.provisionRuntime(ctx, {
      spec: null, // reinstall the pinned version, don't sneak in an upgrade
      reason: "self-heal",
      stopServer: stopServerForSwap,
    })
  );
  if (result && result.skipped) {
    // An update is already provisioning a fresh tree; its swap supersedes ours.
    dbg("preflight: heal skipped, another runtime operation is in flight");
    return true;
  }

  stoppingForUpdate = false;
  notifyUpdate({
    status: "updated",
    title: "运行时已修复",
    message: "检测到安装文件不完整，已自动重新安装",
    detail: summary,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Server process management (FD 3/4 Framed Byte Stream)
// ---------------------------------------------------------------------------
let hostProcess = null;
let win = null;
let serverLog = "";

// Canonical application URL using the custom privileged scheme
const APPLICATION_URL = `${SCHEME}://app/`;

// Register custom protocol handler to route all pi-app:// requests to FD 3/4
protocol.handle(SCHEME, async (request) => {
  if (!hostProcess) {
    return new Response("Host bridge unavailable", { status: 503 });
  }
  try {
    return await hostProcess.fetch(request);
  } catch (err) {
    dbg(`protocol fetch error: ${err.message}`);
    return new Response(`Pipeline Error: ${err.message}`, { status: 502 });
  }
});

function startServer() {
  const pkgDir = piWebPkgDir();
  const piAgentEnv = bundledPiAgentEnv();
  const bridgeScript = path.join(__dirname, "host-bridge.js");

  dbg(
    `startServer node=${bundledNodeExe()} nodeExists=${fs.existsSync(bundledNodeExe())} ` +
      `bridgeScript=${bridgeScript} pkgDir=${pkgDir} ` +
      `nextDirExists=${fs.existsSync(path.join(pkgDir, ".next"))} ` +
      `piPackageRoot=${piAgentEnv[PI_CODING_AGENT_PACKAGE_ROOT_ENV] || "(unresolved)"}`
  );
  if (!fs.existsSync(path.join(pkgDir, ".next"))) {
    throw new Error(`pi-web .next not found in runtime: ${pkgDir}`);
  }

  const nodeExe = fs.existsSync(bundledNodeExe()) ? bundledNodeExe() : process.execPath;

  hostProcess = new DesktopHostProcess(nodeExe, bridgeScript, pkgDir, {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PATH: [bundledNodeDir(), ...bundledPythonPathDirs(), process.env.PATH || ""]
        .filter(Boolean)
        .join(path.delimiter),
      ...bundledPythonGuardEnv(),
      ...piAgentEnv,
    },
    dbg,
  });

  return hostProcess.start();
}

function killServer() {
  if (!hostProcess) return;
  try {
    hostProcess.stop();
  } catch {
    /* ignore */
  }
  hostProcess = null;
}

let restarting = false;
let stoppingForUpdate = false;
async function startOrRestartServer() {
  restarting = true;
  killServer();
  await new Promise((r) => setTimeout(r, 400));
  await startServer();
  restarting = false;
  if (win) win.loadURL(APPLICATION_URL);
  console.log(`[pi-web-desktop] server up via FD 3/4 framed pipe at ${APPLICATION_URL}`);
}

// ---------------------------------------------------------------------------
// Update-result CTA (in-page, top-right corner)
// ---------------------------------------------------------------------------
// Because pi-web is not forked, the desktop shell surfaces the outcome of every
// update check as an overlay injected by preload.js. The main process only has
// to hand the renderer a small notice object; delivery is timing-aware because
// a successful update reloads the embedded server (and thus the page) before we
// can report it.
let pendingNotice = null;

/** Send the queued CTA to the renderer once a pi-web page is present. */
function flushUpdateNotice() {
  if (!pendingNotice || !win || win.isDestroyed()) return;
  try {
    win.webContents.send("pi-web-desktop:update-notice", pendingNotice);
    pendingNotice = null;
  } catch {
    /* not ready yet — did-finish-load will retry */
  }
}

/**
 * Queue an update-result CTA. Delivered immediately if the page is idle; if a
 * navigation is in flight (e.g. the post-update reload) it is held until the
 * did-finish-load handler flushes it.
 */
function notifyUpdate(notice) {
  pendingNotice = notice;
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) flushUpdateNotice();
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
// Serialization now lives in the single `runtimeBusy` gate (see "Runtime write
// lock" above) so the boot self-heal and an update check share one guard rather
// than each keeping their own flag.
let lastKnownLatest = null;

async function checkForUpdates(interactive) {
  if (runtimeBusy) return;
  const ctx = updaterCtx();
  const installed = updater.getInstalledVersion(runtimeDir());

  let latest;
  try {
    latest = await updater.getLatestVersion(ctx);
  } catch (e) {
    if (interactive) {
      dialog.showErrorBox("检查更新失败", String((e && e.stderr) || (e && e.message) || e).slice(-1500));
    }
    notifyUpdate({
      status: "error",
      title: "检查更新失败",
      message: "无法获取最新版本信息",
      detail: "请检查网络连接后重试。",
    });
    return;
  }
  lastKnownLatest = latest;

  if (!updater.isNewer(latest, installed)) {
    const agentV = updater.getInstalledAgentVersion(runtimeDir());
    notifyUpdate({
      status: "latest",
      title: "已是最新版本",
      message: `pi-web ${installed || "未知"}`,
      detail: agentV ? `pi-coding-agent ${agentV} · 无需更新` : "无需更新",
    });
    return;
  }

  // A newer version exists. The boot-time auto check updates silently; a manual
  // "检查更新…" asks first so the user controls the restart.
  if (interactive) {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["更新并重启", "以后再说"],
      defaultId: 0,
      cancelId: 1,
      title: "发现新版本",
      message: `发现 pi-web 新版本 ${latest}`,
      detail: `当前 ${installed || "未知"} → 最新 ${latest}\n\n将下载并自动重启内嵌服务（含 pi-coding-agent）。`,
    });
    if (choice !== 0) {
      // Deferred — leave an actionable CTA the user can trigger later.
      notifyUpdate({
        status: "available",
        title: "发现新版本",
        message: `pi-web ${latest} 可更新`,
        detail: `当前 ${installed || "未知"} → ${latest}`,
        action: { id: "apply-update", label: "更新并重启" },
      });
      return;
    }
  }

  await applyUpdate(ctx, installed, latest, interactive);
}

async function applyUpdate(ctx, installed, latest, interactive) {
  if (runtimeBusy) return;
  try {
    if (win) await win.loadFile(path.join(__dirname, "updating.html")).catch(() => {});
    // The download now happens into a staging dir with the OLD server still
    // running, and the swap only occurs once the new tree passes the very same
    // verification the boot preflight applies. A failed or interrupted update
    // therefore cannot damage the runtime that is currently working.
    const result = await withRuntimeLock("update", () =>
      runtimeGuard.provisionRuntime(guardCtx(), {
        spec: `${updater.PKG}@latest`,
        reason: "update",
        stopServer: stopServerForSwap,
      })
    );
    if (result && result.skipped) return;
    // Swap committed; the new server comes up via startOrRestartServer, whose
    // own `restarting` guard covers its lifecycle from here on.
    stoppingForUpdate = false;
    await startOrRestartServer();
    const v = updater.getInstalledVersion(runtimeDir());
    const agentV = updater.getInstalledAgentVersion(runtimeDir());
    notifyUpdate({
      status: "updated",
      title: "更新完成",
      message: `pi-web 已更新到 ${v || latest}`,
      detail: `${installed || "未知"} → ${v || latest}${agentV ? ` · pi-coding-agent ${agentV}` : ""}`,
    });
  } catch (e) {
    if (interactive) {
      dialog.showErrorBox("更新失败", String((e && e.stderr) || (e && e.message) || e).slice(-2000));
    }
    // The old runtime is untouched by a failed staging install, so recovery is
    // just getting a server back in front of the user. Most failures now happen
    // during download, with the old server still running — in that case only the
    // page needs to go back, not the whole process.
    try {
      if (!serverProc || serverProc.killed) await startOrRestartServer();
      else if (win && serverUrl) await win.loadURL(serverUrl);
    } catch {
      /* ignore */
    }
    notifyUpdate({
      status: "error",
      title: "更新失败",
      message: "自动更新未完成，当前版本未受影响",
      detail: "可稍后通过菜单「检查更新…」重试。",
    });
  } finally {
    stoppingForUpdate = false;
  }
}

// CTA action: user clicked "更新并重启" on a deferred-update notice.
ipcMain.on("pi-web-desktop:apply-update", () => {
  if (runtimeBusy) return;
  const ctx = updaterCtx();
  const installed = updater.getInstalledVersion(runtimeDir());
  applyUpdate(ctx, installed, lastKnownLatest, true).catch(() => {});
});

// Backend for the dashboard bar's reload button. Same effect as the file
// menu's 重新加载 (Ctrl+R), reachable without unhiding the menu bar. The
// reload is driven from the main process (rather than location.reload() in
// the page) so it ignores the HTTP cache — after an embedded-server restart
// the page must not come back from a stale cache. e.sender is the webContents
// that asked, so this stays correct for any window the bar is injected into.
ipcMain.handle("pi-web-desktop:reload-page", (e) => {
  try {
    e.sender.reloadIgnoringCache();
    return { ok: true };
  } catch (err) {
    dbg(`reload-page error ${(err && err.message) || err}`);
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---------------------------------------------------------------------------
// Native directory picker (window.piDesktop.selectDirectory)
// ---------------------------------------------------------------------------
// Backend for the desktop bridge pi-web's session sidebar probes for (see
// features/directory-picker.js). Parented to the invoking window so the dialog
// is modal over the app rather than floating free.
ipcMain.handle("pi-web-desktop:select-directory", (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender) || win;
  return directoryPicker.selectDirectory(parent);
});

// ---------------------------------------------------------------------------
// Theme sync (pi-web's light/dark toggle → native window frame)
// ---------------------------------------------------------------------------
// preload.js reports the page's theme on load and on every toggle; this repaints
// the OS-drawn title bar to match (see features/native-theme.js). Fire-and-forget
// from the renderer — nothing in the page depends on the result.
ipcMain.on("pi-web-desktop:theme-changed", (event, theme) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  // Only the main pi-web window speaks for the app theme; the shell's own
  // windows render a fixed dark page and must not flip the frame.
  if (sender !== win) return;
  const applied = nativeThemeSync.set(theme, { userDataDir: app.getPath("userData"), win });
  dbg(`theme-changed: page reported ${JSON.stringify(theme)} -> ${applied || "ignored"}`);
});

// ---------------------------------------------------------------------------
// Window + lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  // Paint the native frame in the theme pi-web last reported, BEFORE the window
  // exists — otherwise a light-themed pi-web on a dark Windows (or the reverse)
  // shows the wrong title bar for the seconds it takes the page to load and
  // report in. No record yet (first run) leaves themeSource at "system".
  const restored = nativeThemeSync.restore(app.getPath("userData"));
  dbg(`native theme restored: ${restored || "none recorded (following the OS)"}`);

  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0A0A0A", // pi-web Metro dark canvas (--bg) — avoids a pre-paint flash
    autoHideMenuBar: true,
    title: "Pi",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, "loading.html"));

  // Keep the native window/taskbar title as the app name. The embedded pi-web
  // page sets its own <title> ("Pi Agent Web"); we don't let that propagate to
  // the OS window so the shell consistently presents as "Pi".
  win.on("page-title-updated", (e) => e.preventDefault());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${SCHEME}:`) || url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-finish-load", () => {
    const cur = win && win.webContents.getURL();
    if (cur && cur.startsWith(APPLICATION_URL)) {
      console.log("[pi-web-desktop] window did-finish-load: pi-web UI rendered via FD 3/4 pipeline");
      // Deliver any update-result CTA queued while the page was (re)loading —
      // e.g. the "更新完成" notice set right after an update reloads the server.
      flushUpdateNotice();
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

async function showError(err) {
  if (!win) return;
  await win.loadFile(path.join(__dirname, "error.html")).catch(() => {});
  win.webContents
    .executeJavaScript(
      `window.__setError(${JSON.stringify(String((err && err.message) || err))}, ${JSON.stringify(serverLog.slice(-3000))})`
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// User data migration across product renames
// ---------------------------------------------------------------------------
/**
 * One-time state carry-over across product renames.
 *
 * Electron derives userData from productName ("Pi"), so previous builds
 * ("Pi Agent", "Pi Dsh", "Pi&Dsh") stored userData in a different folder.
 *
 * Runs once; the marker is what stops it from resurrecting files the user has
 * since deleted on purpose.
 */
function migrateLegacyUserData() {
  const LEGACY_USER_DATA_DIRS = ["Pi Agent", "Pi Dsh", "Pi&Dsh"];
  const STATE_FILES = [
    "theme-state.json",
  ];
  try {
    const now = app.getPath("userData");
    const marker = path.join(now, ".migrated-user-data");
    if (fs.existsSync(marker)) return;

    const parent = path.dirname(now);
    const sources = LEGACY_USER_DATA_DIRS.map((name) => path.join(parent, name)).filter(
      (dir) => path.resolve(dir) !== path.resolve(now) && fs.existsSync(dir)
    );
    if (!sources.length) return;

    fs.mkdirSync(now, { recursive: true });
    const carried = [];
    for (const name of STATE_FILES) {
      const to = path.join(now, name);
      // Never overwrite: a file already here was written by the current build
      // and is newer than anything a legacy directory holds.
      if (fs.existsSync(to)) continue;
      const from = sources.map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
      if (!from) continue;
      fs.copyFileSync(from, to);
      carried.push(`${name} <- ${path.basename(path.dirname(from))}`);
    }
    fs.writeFileSync(
      marker,
      [
        `${new Date().toISOString()}`,
        `searched: ${sources.map((d) => path.basename(d)).join(", ")}`,
        `carried: ${carried.join("; ") || "(nothing)"}`,
        "",
      ].join(require("os").EOL)
    );
    dbg(`userData migration: carried ${carried.length} file(s) [${carried.join("; ")}]`);
  } catch (e) {
    // Never block startup on this: the worst case is the old defaults are gone.
    dbg(`userData migration skipped: ${(e && e.message) || e}`);
  }
}

/** AppUserModelID for the Windows taskbar and shortcuts. */
const PI_APP_USER_MODEL_ID = "com.agegr.piwebdesktop";

async function boot() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  dbg(`boot start; isPackaged=${app.isPackaged} userData=${app.getPath("userData")}`);
  // Must precede createWindow(): the association is resolved when the window
  // first appears on the taskbar, not when the id is set.
  if (process.platform === "win32") app.setAppUserModelId(PI_APP_USER_MODEL_ID);
  createWindow();
  try {
    // Order matters. Recovery runs before ANY call to runtimeDir(), because an
    // interrupted swap can leave the seed dir momentarily missing and that
    // would poison runtimeDir()'s cached choice for the rest of the session.
    await recoverRuntimeCandidates();
    dbg(`ensureRuntime; seedDir=${seedDir()} runtimeDir=${runtimeDir()}`);
    const v = await ensureRuntime();
    dbg(`runtime ready v=${v}`);
    console.log(`[pi-web-desktop] runtime ready, pi-web ${v}`);
    // Preflight: the runtime EXISTS (ensureRuntime) — but does it actually
    // load? Repairs itself if not, so a torn install no longer surfaces as an
    // opaque "server not ready in time" sixty seconds later.
    await ensureRuntimeHealthy();
    await startOrRestartServer();
    dbg("startOrRestartServer returned ok");
    if (AUTO_CHECK) {
      setTimeout(() => {
        // Skip when a self-heal just reinstalled the runtime: the user has
        // already waited through one install, and an upgrade can wait for the
        // next launch. (The lock would serialize them anyway — this is about
        // not making them sit through two in a row.)
        if (lastProvisionMs && Date.now() - lastProvisionMs < 120000) {
          dbg("auto update check skipped — runtime was just provisioned");
          return;
        }
        checkForUpdates(false).catch(() => {});
      }, 5000);
    }
  } catch (err) {
    dbg(`BOOT ERROR ${(err && err.stack) || err}`);
    await showError(err);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    migrateLegacyUserData();
    Menu.setApplicationMenu(buildMenu());
    boot();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) boot();
    });
  });
}

function killAllServers() {
  killServer();
}

app.on("window-all-closed", () => {
  app.isQuitting = true;
  killAllServers();
  app.quit();
});
app.on("before-quit", () => {
  app.isQuitting = true;
  killAllServers();
});
process.on("exit", killAllServers);

function buildMenu() {
  const template = [
    {
      label: "App",
      submenu: [
        {
          label: "检查更新…",
          click: () => checkForUpdates(true),
        },
        { type: "separator" },
        {
          label: "重新加载",
          accelerator: "CmdOrCtrl+R",
          click: () => win && win.webContents.reloadIgnoringCache(),
        },
        {
          label: "重启内嵌服务",
          click: () => startOrRestartServer().catch((e) => dialog.showErrorBox("重启失败", String(e))),
        },
        {
          label: "开发者工具",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => win && win.webContents.toggleDevTools(),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
