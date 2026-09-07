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
 *  - A SECOND runtime — @deepseek-ai/dsh — ships the same way but starts only
 *    when the user opens it (App → DeepSeek Harness). Everything about it
 *    lives in features/dsh.js, which borrows the helpers below rather than
 *    duplicating them; this file only injects that context and adds the menu
 *    entries. See that module's header for why its window gets no preload.
 *  - Because there are now two of them, a launch STARTS with a chooser
 *    (launcher.html) unless a default is remembered. That has to come before
 *    any runtime work: a launch destined for dsh must not first seed, verify
 *    and start pi-web. bootPi() therefore holds what used to be boot()'s body,
 *    and boot() only decides.
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const updater = require("./updater");
const runtimeGuard = require("./runtime-guard");
const dashboard = require("./features/dashboard");
const subagents = require("./features/subagents");
const toolsFeature = require("./features/tools");
const directoryPicker = require("./features/directory-picker");
const extensionsManager = require("./features/extensions-manager");
const nativeThemeSync = require("./features/native-theme");
const dsh = require("./features/dsh");

const isWindows = process.platform === "win32";
const REGISTRY = process.env.PI_WEB_REGISTRY || "https://registry.npmmirror.com";
const AUTO_CHECK = process.env.PI_WEB_AUTO_UPDATE_CHECK !== "0";
// The pi CLI package name, as pi-subagents spells it when validating a package
// root handed to it via this env var (its shared/utils.ts + runs/shared/pi-spawn.ts).
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
// When this app launch began (epoch ms). Captured at main-process load so it
// survives embedded-server restarts; the dashboard counts token usage from
// session turns at/after this moment ("since this pi-agent was opened").
const APP_BOOT_MS = Date.now();

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
// Bundled extensions (selective install, user edits win)
// ---------------------------------------------------------------------------
// The app ships a catalogue of pi extensions in `extensions-seed/`
// (extensions-seed/manifest.json is the single source of truth for the managed
// set). The user picks which ones to install on first run — and can revisit the
// choice any time via App → 扩展管理…
//
// IMPORTANT — this used to overwrite every managed file on every launch ("the
// repo always wins"), which silently ate edits made in ~/.pi. It no longer
// does: features/extensions-manager.js remembers the hash of what it wrote and
// only ever refreshes a file that is still byte-identical to it. See that
// module's header for the full policy; everything below is just wiring.
//
// Any failure here is logged and swallowed so it can never block boot.
function extensionsSeedDir() {
  return path.join(resourcesBase(), "extensions-seed");
}

function piAgentDir() {
  // Same resolution the running agent (and features/dashboard.js) uses.
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function extensionsCtx() {
  return {
    seedDir: extensionsSeedDir(),
    destDir: path.join(piAgentDir(), "extensions"),
    stateFile: path.join(app.getPath("userData"), "extensions-state.json"),
    copyDir: copyRuntime,
    dbg,
  };
}

/**
 * Launch-time sync. Returns true when the user has never chosen (first run or a
 * wiped state file), in which case the caller shows the picker instead.
 */
async function ensureBundledExtensions() {
  const result = await extensionsManager.syncOnLaunch(extensionsCtx());
  return Boolean(result && result.needsPicker);
}

// ---------------------------------------------------------------------------
// Bundled skills sync (repo skills-seed/ is the source of truth)
// ---------------------------------------------------------------------------
// The OKF knowledge skills ship with the app so a fresh install has them active
// out of the box in ~/.pi/agent/skills/ (pi auto-discovers skills there, so they
// work in EVERY workspace). The repo's `skills-seed/` is their CANONICAL SOURCE —
// developed there, never hand-edited in the data dir. On every launch we sync each
// managed skill DIRECTORY into ~/.pi/agent/skills/<name>/: any file whose content
// differs from the bundle is (over)written, which is what makes the "edit in the
// repo -> reinstall (or re-run) loop" deploy changes. These skills are pure
// stdlib Python (no node_modules, no pip deps).
//
// Only these managed skill names are touched (any other skill in the dir is left
// alone). Files under __pycache__/ and *.pyc are never deployed. Any failure here
// is logged and swallowed so it can never block boot.
const DEFAULT_SKILLS = [
  "wiki-init",
  "wiki-compile",
  "wiki-query",
  "wiki-lint",
  "okf-visualizer",
  "ppt-master",
];

function skillsSeedDir() {
  return path.join(resourcesBase(), "skills-seed");
}

// Cheap content signature of a bundled skill tree: hash of (relpath|size|mtime)
// over all files — STAT ONLY, no file-body reads. Used to skip the deep per-file
// sync when the bundle is unchanged (critical for ppt-master's ~12k icon files,
// where deep-diffing every launch would be far too slow). Bundle mtimes change
// on reinstall/app-update and on a dev edit, so a real change always re-syncs.
function skillBundleSignature(dir) {
  const crypto = require("crypto");
  const parts = [];
  const walk = (d, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === "__pycache__") continue;
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, r);
      } else if (e.isFile()) {
        if (e.name.endsWith(".pyc")) continue;
        try {
          const st = fs.statSync(full);
          parts.push(`${r}|${st.size}|${Math.floor(st.mtimeMs)}`);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir, "");
  return crypto.createHash("md5").update(parts.join("\n")).digest("hex");
}

async function ensureBundledSkills() {
  const seed = skillsSeedDir();
  if (!fs.existsSync(seed)) {
    dbg(`skills seed missing at ${seed} — skipping skill sync`);
    return;
  }
  const dest = path.join(piAgentDir(), "skills");
  await fs.promises.mkdir(dest, { recursive: true });

  let synced = 0;
  let skipped = 0;
  for (const name of DEFAULT_SKILLS) {
    const s = path.join(seed, name);
    if (!fs.existsSync(s)) continue;
    const skillDest = path.join(dest, name);
    // Fast path: skip the deep per-file diff when the bundle signature matches
    // the one recorded at last deploy (.seed-version).
    const sig = skillBundleSignature(s);
    const stampFile = path.join(skillDest, ".seed-version");
    let deployedSig = null;
    try {
      deployedSig = fs.readFileSync(stampFile, "utf8").trim();
    } catch {
      /* not deployed yet */
    }
    if (deployedSig === sig) {
      skipped++;
      continue;
    }
    // Copy via robocopy/cp (a SPAWNED process) rather than a synchronous
    // fs.copyFileSync loop: a large skill like ppt-master (~12k files) would
    // otherwise block the main thread for tens of seconds and freeze the window
    // ("not responding") on first deploy. `await` here yields to the event loop
    // while the child process runs, so the window stays responsive.
    try {
      await copyRuntime(s, skillDest);
      synced++;
      fs.writeFileSync(stampFile, sig);
      dbg(`synced skill ${name} (full copy)`);
    } catch (e) {
      dbg(`failed to sync skill ${name}: ${(e && e.message) || e}`);
    }
  }
  dbg(`ensureBundledSkills done; synced ${synced} skill(s), ${skipped} up-to-date, to ${dest}`);
}

// ---------------------------------------------------------------------------
// Server process management
// ---------------------------------------------------------------------------
let serverProc = null;
let win = null;
let serverUrl = null;
let serverLog = "";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("server not ready in time"));
        else setTimeout(tryOnce, 300);
      });
      req.setTimeout(2500, () => req.destroy());
    };
    tryOnce();
  });
}

function startServer(port) {
  const nextBin = nextBinPath();
  const pkgDir = piWebPkgDir();
  const piAgentEnv = bundledPiAgentEnv();
  dbg(
    `startServer node=${bundledNodeExe()} nodeExists=${fs.existsSync(bundledNodeExe())} ` +
      `nextBin=${nextBin} nextExists=${fs.existsSync(nextBin)} pkgDir=${pkgDir} ` +
      `nextDirExists=${fs.existsSync(path.join(pkgDir, ".next"))} port=${port} ` +
      `piPackageRoot=${piAgentEnv[PI_CODING_AGENT_PACKAGE_ROOT_ENV] || "(unresolved)"}`
  );
  if (!fs.existsSync(path.join(pkgDir, ".next"))) {
    throw new Error(`pi-web .next not found in runtime: ${pkgDir}`);
  }
  serverProc = spawn(
    bundledNodeExe(),
    [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: pkgDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        // Prepend bundled node + bundled python dirs so agent tool subprocesses
        // (node/npx, and python for the guard / ppt-master) resolve to the
        // bundled runtimes. PI_* python hints are added when vendor/python ships.
        PATH: [bundledNodeDir(), ...bundledPythonPathDirs(), process.env.PATH || ""]
          .filter(Boolean)
          .join(path.delimiter),
        ...bundledPythonGuardEnv(),
        // Subagents spawn the bundled pi, not whatever `pi` PATH happens to hold.
        ...piAgentEnv,
      },
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
    process.stdout.write(`[pi-web] ${text}`);
  };
  serverProc.stdout.on("data", capture);
  serverProc.stderr.on("data", capture);
  serverProc.on("error", (e) => dbg(`server spawn ERROR ${e && e.message}`));
  serverProc.on("exit", (code, signal) => {
    dbg(`server exit code=${code} signal=${signal}`);
    // Suppress the error popup for INTENTIONAL stops: app quit, a restart, or an
    // update that kills the old server before reinstalling. Only a genuinely
    // unexpected crash should alarm the user.
    if (!app.isQuitting && !restarting && !stoppingForUpdate) {
      dialog.showErrorBox(
        "Pi Agent 服务已停止",
        `内嵌服务意外退出 (code=${code}, signal=${signal})。\n\n最近输出:\n${serverLog.slice(-2000)}`
      );
    }
  });
}

function killServer() {
  if (!serverProc || serverProc.killed) return;
  const pid = serverProc.pid;
  try {
    if (isWindows) {
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
}

let restarting = false;
// True while applyUpdate has intentionally stopped the server to reinstall, so
// the server-exit handler doesn't mistake the deliberate kill for a crash.
let stoppingForUpdate = false;
async function startOrRestartServer() {
  restarting = true;
  killServer();
  await new Promise((r) => setTimeout(r, 400)); // let file handles release
  const port = await getFreePort();
  serverUrl = `http://127.0.0.1:${port}`;
  startServer(port);
  await waitForServer(`${serverUrl}/`);
  restarting = false;
  if (win) win.loadURL(serverUrl);
  console.log(`[pi-web-desktop] server up at ${serverUrl}`);
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

// Dashboard action: user clicked "打开知识图谱" in the wiki popover. Generate the
// OKF graph for the ACTIVE workspace with the bundled Python (the okf-visualizer
// skill's build_visualizer.py), then open the self-contained HTML in a standalone
// in-app window (reused across opens). Non-fatal; logs and returns on any miss.
let okfGraphWin = null;
ipcMain.on("pi-web-desktop:open-okf-graph", async () => {
  try {
    const cwd = dashboard.activeCwd();
    if (!cwd) {
      dbg("open-okf-graph: no active workspace cwd");
      return;
    }
    let bundleDir = "wiki";
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(cwd, "okf.config.json"), "utf8"));
      if (cfg && typeof cfg.bundle_dir === "string" && cfg.bundle_dir.trim()) bundleDir = cfg.bundle_dir;
    } catch {
      /* no config — default bundle dir */
    }
    const py = bundledPythonExe();
    const script = path.join(piAgentDir(), "skills", "okf-visualizer", "scripts", "build_visualizer.py");
    if (!fs.existsSync(py) || !fs.existsSync(script)) {
      dbg(`open-okf-graph: missing py=${fs.existsSync(py)} script=${fs.existsSync(script)}`);
      return;
    }
    await new Promise((resolve) => {
      const p = spawn(py, [script, "--vault", cwd], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("error", (e) => {
        dbg(`open-okf-graph spawn error ${e.message}`);
        resolve();
      });
      p.on("exit", (code) => {
        if (code !== 0) dbg(`build_visualizer exit ${code}: ${err.slice(-300)}`);
        resolve();
      });
    });
    const htmlPath = path.join(cwd, bundleDir, "okf-graph.html");
    if (!fs.existsSync(htmlPath)) {
      dbg(`open-okf-graph: graph not generated at ${htmlPath}`);
      return;
    }
    if (okfGraphWin && !okfGraphWin.isDestroyed()) {
      // Cache-bust: loadFile would serve Chromium's cached copy of the same path
    // after the file is regenerated, so the graph never updates. A unique query
    // forces a fresh read from disk each open.
    okfGraphWin.loadURL(require("url").pathToFileURL(htmlPath).href + "?t=" + Date.now());
      okfGraphWin.focus();
      return;
    }
    okfGraphWin = new BrowserWindow({
      width: 1100,
      height: 760,
      title: "OKF 知识图谱",
      backgroundColor: "#0A0A0A",
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    okfGraphWin.on("closed", () => {
      okfGraphWin = null;
    });
    // Cache-bust: loadFile would serve Chromium's cached copy of the same path
    // after the file is regenerated, so the graph never updates. A unique query
    // forces a fresh read from disk each open.
    okfGraphWin.loadURL(require("url").pathToFileURL(htmlPath).href + "?t=" + Date.now());
    if (process.env.PI_OKF_DEVTOOLS) okfGraphWin.webContents.openDevTools({ mode: "bottom" });
    dbg(`open-okf-graph: opened ${htmlPath}`);
  } catch (e) {
    dbg(`open-okf-graph error ${(e && e.stack) || e}`);
  }
});

// ---------------------------------------------------------------------------
// Dashboard (MCP / extensions activation status)
// ---------------------------------------------------------------------------
// Backend for the bottom dashboard bar injected by preload.js. Reads ~/.pi
// config directly (see features/dashboard.js) and reports active/inactive
// MCP servers and extensions. Never throws — returns a partial result + error.
ipcMain.handle("pi-web-desktop:dashboard-status", async () => {
  try {
    // serverUrl: built-in subagents are in-process sessions of the embedded
    // server, so their running state comes from its /api/agent/running.
    // serverPid scopes legacy (pi-subagents) process counting to THIS app's
    // child processes.
    return await dashboard.readStatus({
      sinceMs: APP_BOOT_MS,
      serverUrl,
      serverPid: serverProc && !serverProc.killed ? serverProc.pid : undefined,
    });
  } catch (e) {
    dbg(`dashboard-status error ${(e && e.message) || e}`);
    return {
      mcp: { active: [], inactive: [] },
      extensions: { active: [], inactive: [] },
      tokens: { total: 0, input: 0, output: 0, calls: 0, sessions: 0 },
      subagents: { running: 0, runningList: [], doneSession: 0, abortedSession: 0, failedSession: 0, recent: [] },
      error: String((e && e.message) || e),
    };
  }
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
// Tools (the live session's tool registry)
// ---------------------------------------------------------------------------
// Backend for the Tools chip. Unlike the MCP/extension counts this cannot be
// read off disk — the registry only exists inside a running agent process — so
// features/tools.js asks the embedded pi-web over its session RPC, and only when
// a session's RPC process is already alive (never spawning one just to count).
// See the header of features/tools.js for why the answer is session-scoped.
ipcMain.handle("pi-web-desktop:tools-status", async (_event, payload) => {
  try {
    return await toolsFeature.readTools({
      serverUrl,
      force: !!(payload && payload.force),
    });
  } catch (e) {
    dbg(`tools-status error ${(e && e.message) || e}`);
    return {
      available: false,
      reason: "error",
      total: 0,
      active: 0,
      groups: [],
      error: String((e && e.message) || e),
    };
  }
});

// Stop button on the Sub-agents popover. Payload is one of
//   { sessionId }  built-in (pi-web >= 0.9.0) run → pi-web's own graceful abort
//   { pid }        legacy pi-subagents child process → forced subtree kill
//   { all: true }  everything running, both kinds
// Both identifiers are re-validated inside stopSubagents against fresh state (a
// session id must still be a subagent session file AND live in the server's
// registry; a pid must still be a pi-cli process under OUR server), so a stale
// or forged value from the renderer can't abort the user's main chat or kill an
// arbitrary process. See the header of features/subagents.js.
ipcMain.handle("pi-web-desktop:subagent-stop", async (_event, payload) => {
  const req = payload && typeof payload === "object" ? payload : {};
  const opts = {
    all: req.all === true,
    pids: Number.isInteger(Number(req.pid)) && Number(req.pid) > 1 ? [Number(req.pid)] : [],
    sessionIds: typeof req.sessionId === "string" && req.sessionId ? [req.sessionId] : [],
    serverUrl,
    serverPid: serverProc && !serverProc.killed ? serverProc.pid : undefined,
    sinceMs: APP_BOOT_MS,
    cwd: null,
  };
  const label = opts.all ? "all" : opts.sessionIds.length ? `session ${opts.sessionIds[0]}` : `pid ${req.pid}`;
  try {
    opts.cwd = dashboard.activeCwd();
  } catch {
    /* legacy-package lookup falls back to global settings */
  }
  try {
    const res = await subagents.stopSubagents(opts);
    dbg(
      `subagent-stop ${label} → ok=${res.ok} ` +
        `stopped=[${res.stopped.join(",")}] skipped=${res.skipped.length}${res.error ? ` error=${res.error}` : ""}`
    );
    return res;
  } catch (e) {
    dbg(`subagent-stop error ${(e && e.stack) || e}`);
    return { ok: false, stopped: [], skipped: [], error: String((e && e.message) || e) };
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
// Extension picker window (first run + App → 扩展管理…)
// ---------------------------------------------------------------------------
// A local file:// window rendering extensions-picker.html through its own
// preload (extensions-preload.js). On first run boot AWAITS it, so the pi server
// only starts once the chosen extensions are in place; from the menu it is just
// a modal over the main window.
let extPickerWin = null;
let extPickerResolve = null;
let extPickerApplied = false;

function openExtensionsPicker(parent) {
  if (extPickerWin && !extPickerWin.isDestroyed()) {
    extPickerWin.focus();
    return Promise.resolve(false);
  }
  extPickerApplied = false;
  extPickerWin = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    parent: parent || undefined,
    modal: Boolean(parent),
    backgroundColor: "#0A0A0A",
    autoHideMenuBar: true,
    title: "扩展管理",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "extensions-preload.js"),
    },
  });
  extPickerWin.loadFile(path.join(__dirname, "extensions-picker.html"));

  // Resolves with "did the user apply a selection?" — closing the window (or
  // 稍后再说) leaves ~/.pi untouched and, on first run, re-asks next launch.
  return new Promise((resolve) => {
    extPickerResolve = resolve;
    extPickerWin.on("closed", () => {
      extPickerWin = null;
      const r = extPickerResolve;
      extPickerResolve = null;
      if (r) r(extPickerApplied);
    });
  });
}

ipcMain.handle("pi-web-desktop:ext-status", () => {
  try {
    return extensionsManager.computeStatus(extensionsCtx());
  } catch (e) {
    dbg(`ext-status error ${(e && e.message) || e}`);
    return { ok: false, firstRun: true, extensions: [], error: String((e && e.message) || e) };
  }
});

ipcMain.handle("pi-web-desktop:ext-apply", async (_event, ids) => {
  try {
    const result = await extensionsManager.applySelection(extensionsCtx(), Array.isArray(ids) ? ids : []);
    extPickerApplied = true;
    if (extPickerWin && !extPickerWin.isDestroyed()) extPickerWin.close();
    return { ok: true, ...result };
  } catch (e) {
    dbg(`ext-apply error ${(e && e.stack) || e}`);
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle("pi-web-desktop:ext-restore", (_event, id) => {
  try {
    return extensionsManager.restoreFromBundle(extensionsCtx(), String(id));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle("pi-web-desktop:ext-open-folder", async () => {
  const dir = path.join(piAgentDir(), "extensions");
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  shell.openPath(dir);
});

ipcMain.on("pi-web-desktop:ext-cancel", () => {
  if (extPickerWin && !extPickerWin.isDestroyed()) extPickerWin.close();
});

// Menu entry: manage the selection after install. pi loads extensions when a
// session starts, so an applied change needs the embedded server to restart (or
// a /reload inside pi) before it takes effect — offer that right away.
async function manageExtensions() {
  const applied = await openExtensionsPicker(win);
  if (!applied || !serverProc) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["立即重启服务", "稍后"],
    defaultId: 0,
    cancelId: 1,
    title: "扩展已更新",
    message: "扩展改动需要重启内嵌服务才会生效。",
    detail: "重启会中断正在运行的会话；也可以稍后在 pi 里执行 /reload。",
  });
  if (response === 0) {
    startOrRestartServer().catch((e) => dialog.showErrorBox("重启失败", String(e)));
  }
}

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
    title: "Pi Agent",
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
  // the OS window so the shell consistently presents as "Pi Agent".
  win.on("page-title-updated", (e) => e.preventDefault());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-finish-load", () => {
    const cur = win && win.webContents.getURL();
    if (serverUrl && cur && cur.startsWith(serverUrl)) {
      console.log("[pi-web-desktop] window did-finish-load: pi-web UI rendered");
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
// Startup launcher — which runtime does this launch open?
// ---------------------------------------------------------------------------
// The choice comes FIRST, before any pi runtime work, because that is the whole
// point: a launch that ends up in dsh must not pay for seeding, verifying and
// starting pi-web on the way there.
let launcherWin = null;
// Set while a chosen runtime is starting but its window may not exist yet, so
// closing the launcher can never look like "the last window closed → quit".
let launchInProgress = false;

function launchPrefPath() {
  return path.join(app.getPath("userData"), "launch-preference.json");
}

/** Remembered launch target, or null to ask. Unreadable/unknown values ask. */
function readLaunchPref() {
  try {
    const raw = JSON.parse(fs.readFileSync(launchPrefPath(), "utf8").replace(/^﻿/, ""));
    return raw.target === "pi" || raw.target === "dsh" ? raw.target : null;
  } catch {
    return null;
  }
}

function writeLaunchPref(target) {
  try {
    if (target === null) fs.rmSync(launchPrefPath(), { force: true });
    else fs.writeFileSync(launchPrefPath(), JSON.stringify({ target, savedAt: new Date().toISOString() }, null, 2));
    dbg(`launch preference -> ${target === null ? "ask every time" : target}`);
  } catch (e) {
    dbg(`could not persist launch preference: ${(e && e.message) || e}`);
  }
}

function openLauncher() {
  launcherWin = new BrowserWindow({
    width: 760,
    height: 460,
    resizable: false,
    backgroundColor: "#0A0A0A",
    autoHideMenuBar: true,
    title: "Pi Agent",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "launcher-preload.js"),
    },
  });
  launcherWin.loadFile(path.join(__dirname, "launcher.html"));
  // Keep the OS window/taskbar title as the app name, like the main window.
  launcherWin.on("page-title-updated", (e) => e.preventDefault());
  launcherWin.on("closed", () => {
    launcherWin = null;
  });
}

function closeLauncher() {
  if (launcherWin && !launcherWin.isDestroyed()) launcherWin.close();
  launcherWin = null;
}

ipcMain.handle("pi-web-desktop:launch-info", () => {
  // Best-effort: a runtime that has not been seeded yet simply shows no version.
  let piVersion = null;
  try {
    piVersion = updater.getInstalledVersion(runtimeDir());
  } catch {
    /* ignore */
  }
  let dshVersion = null;
  try {
    dshVersion = dsh.installedVersion();
  } catch {
    /* ignore */
  }
  return { piVersion, dshVersion };
});

/**
 * Start one runtime. The single path for every way a launch can be decided —
 * the launcher's tiles, a remembered preference, PI_DESKTOP_LAUNCH — so the
 * windowless-gap guard and the settle check below cannot apply to one route and
 * not another.
 */
function launchTarget(pick) {
  launchInProgress = true;
  // Both entry points create their window synchronously before their first
  // await, so the launcher can go away immediately without a windowless gap.
  const started = pick === "dsh" ? dsh.open() : bootPi();
  closeLauncher();
  return started
    .catch((e) => dbg(`launch ${pick} failed: ${(e && e.stack) || e}`))
    .finally(() => {
      launchInProgress = false;
      // The guard suppresses window-all-closed for the whole start, not just
      // the launcher gap — so a window closed WHILE its server was still
      // booting (dsh's first run against a fresh $DSH_HOME takes tens of
      // seconds) would otherwise leave the app running with no window and no
      // way back in. Re-check once the launch has settled.
      if (!app.isQuitting && BrowserWindow.getAllWindows().length === 0) {
        dbg("launch settled with no window left — quitting");
        app.isQuitting = true;
        killAllServers();
        app.quit();
      }
    });
}

ipcMain.on("pi-web-desktop:launch-choose", (_event, target, remember) => {
  const pick = target === "dsh" ? "dsh" : "pi";
  dbg(`launcher: chose ${pick}${remember ? " (remembered)" : ""}`);
  if (remember) {
    writeLaunchPref(pick);
    Menu.setApplicationMenu(buildMenu()); // reflect the new default in the radio group
  }
  launchTarget(pick);
});

ipcMain.on("pi-web-desktop:launch-cancel", () => {
  dbg("launcher dismissed — nothing was started, quitting");
  app.isQuitting = true;
  closeLauncher();
  app.quit();
});

/**
 * Decide what this launch opens: a remembered default, an explicit
 * PI_DESKTOP_LAUNCH override (`pi` / `dsh` / `ask`, used by tests and shortcuts),
 * or the launcher window.
 */
async function boot() {
  const override = (process.env.PI_DESKTOP_LAUNCH || "").toLowerCase();
  const remembered = readLaunchPref();
  const target = override === "pi" || override === "dsh" ? override : override === "ask" ? null : remembered;
  dbg(`boot: override=${override || "(none)"} remembered=${remembered || "(none)"} -> ${target || "ask"}`);
  if (target === "dsh" || target === "pi") return launchTarget(target);
  openLauncher();
}

async function bootPi() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  dbg(`boot start; isPackaged=${app.isPackaged} userData=${app.getPath("userData")}`);
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
    // Extensions. First run has no recorded selection, so we ask which ones to
    // install and AWAIT the picker — the server must start with the chosen set
    // in place. Afterwards this is a non-destructive sync that never overwrites
    // a file the user edited. Non-fatal: never block boot.
    try {
      const needsPicker = await ensureBundledExtensions();
      if (needsPicker) {
        dbg("no extension selection recorded — showing the first-run picker");
        const applied = await openExtensionsPicker(win);
        // Dismissed without choosing: install nothing now, ask again next launch.
        if (!applied) dbg("first-run extension picker dismissed — nothing deployed");
      }
    } catch (e) {
      dbg(`ensureBundledExtensions error (non-fatal): ${(e && e.stack) || e}`);
    }
    // Sync the bundled OKF knowledge skills (repo skills-seed/ is the source of
    // truth) into ~/.pi/agent/skills/. Non-fatal: never block boot.
    try {
      await ensureBundledSkills();
    } catch (e) {
      dbg(`ensureBundledSkills error (non-fatal): ${(e && e.stack) || e}`);
    }
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
    // The dsh feature owns its own runtime dir, server, window and lock; it
    // borrows this file's path/probe helpers rather than duplicating them, and
    // nothing here starts until the user asks for it (App → DeepSeek Harness).
    dsh.configure({
      dbg,
      registry: REGISTRY,
      debugLogPath: () => DEBUG_LOG,
      resourcesBase,
      userDataDir: () => app.getPath("userData"),
      bundledNodeExe,
      bundledNodeDir,
      bundledNpmCli,
      bundledPythonPathDirs,
      isWritable,
      copyRuntime,
      getFreePort,
      waitForServer,
    });
    Menu.setApplicationMenu(buildMenu());
    boot();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) boot();
    });
  });
}

function killAllServers() {
  killServer();
  // dsh normally dies with its own window; this covers "quit while it is open".
  try {
    dsh.stop();
  } catch {
    /* never let a dsh failure block the shell from quitting */
  }
}

app.on("window-all-closed", () => {
  // The launcher closes a moment before (or after) the chosen runtime's window
  // appears; quitting in that gap would kill the launch the user just asked for.
  if (launchInProgress) return;
  app.isQuitting = true;
  killAllServers();
  app.quit();
});
app.on("before-quit", () => {
  app.isQuitting = true;
  killAllServers();
});
process.on("exit", killAllServers);

/** Change the remembered launch target and re-check the radio group. */
function setLaunchPref(target) {
  writeLaunchPref(target);
  Menu.setApplicationMenu(buildMenu());
}

function buildMenu() {
  // Read once per build so the radio group shows what is actually on disk —
  // including a change made from the launcher's "记住选择" checkbox.
  const currentPref = readLaunchPref();
  const template = [
    {
      label: "App",
      submenu: [
        {
          label: "检查更新…",
          click: () => checkForUpdates(true),
        },
        {
          label: "扩展管理…",
          click: () => manageExtensions(),
        },
        { type: "separator" },
        {
          label: "Pi Agent",
          click: () => bootPi().catch((e) => dialog.showErrorBox("Pi Agent 启动失败", String(e))),
        },
        {
          label: "DeepSeek Harness",
          click: () => dsh.open().catch((e) => dialog.showErrorBox("DeepSeek Harness 启动失败", String(e))),
        },
        {
          label: "启动时打开",
          submenu: [
            {
              label: "每次询问",
              type: "radio",
              checked: currentPref === null,
              click: () => setLaunchPref(null),
            },
            {
              label: "Pi Agent",
              type: "radio",
              checked: currentPref === "pi",
              click: () => setLaunchPref("pi"),
            },
            {
              label: "DeepSeek Harness",
              type: "radio",
              checked: currentPref === "dsh",
              click: () => setLaunchPref("dsh"),
            },
          ],
        },
        {
          label: "从 Pi 导入模型配置…",
          click: () => dsh.importPiModels(),
        },
        {
          label: "检查 DeepSeek Harness 更新…",
          click: () => dsh.checkUpdate(true),
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
