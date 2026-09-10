"use strict";

/**
 * DeepSeek Harness — a HAND-OFF, not an embedded runtime.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This shell used to wrap dsh itself: bundle `@deepseek-ai/dsh` as a second
 * runtime seed, run `dsh web --host 127.0.0.1 --port <n>`, and point a
 * BrowserWindow at the loopback server. Upstream now ships its OWN Electron
 * application (`@deepseek-ai/dsh-desktop`), and it is not a wrapper around the
 * same web server — it is a replacement for it:
 *
 *   - it opens NO listening port (a bundled Node child, framed byte pipes, and
 *     a `dsh-app://` protocol carry Fetch traffic and the client assets), so
 *     the port / readiness-probe / launch-token machinery this file used to
 *     carry has no counterpart on the other side;
 *   - it owns `$DSH_HOME/profiles/desktop` exclusively, with its own pnpm store
 *     and its own staging + health-check + rollback activation path;
 *   - its version is locked to the dsh release it carries ("a dsh upgrade is a
 *     Desktop release"), so it also owns its own updates.
 *
 * Keeping a second, differently-composed dsh next to that one would mean two
 * shells racing over the same `$DSH_HOME` and two update stories for the same
 * product. So the dsh launch path is now a hand-off: resolve the installed
 * application, start it, and get out of the way.
 *
 * WHAT THIS SHELL STILL CONTRIBUTES
 * ---------------------------------
 *  1. THE LAUNCHER TILE. `App → DeepSeek Harness` and the startup picker keep
 *     working, so the two runtimes are still chosen from one place.
 *
 *  2. THE MODEL IMPORT, INCLUDING ITS SECRET HANDLING. `$DSH_HOME/settings.yaml`
 *     is shared product data — upstream's Desktop carves out only `desktop/`
 *     and `profiles/desktop` — so the routes written by
 *     `从 Pi 导入模型配置…` are read by the official application unchanged. And
 *     because WE start that application, the `apiKeyEnv` indirection survives
 *     intact: the keys are read out of pi's `models.json` at spawn time and
 *     handed over in the child environment, exactly as before, so they still
 *     never land in `$DSH_HOME/.credentials.yaml`.
 *
 * WHAT IT DELIBERATELY NO LONGER DOES
 * -----------------------------------
 * No runtime seed, no runtime-guard branch, no update check, and no attempt to
 * stop the application on quit: it is an independent app with its own
 * single-instance lock and its own lifecycle. Closing Pi Agent must not kill a
 * DeepSeek Harness session the user is still working in.
 */

const { dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const piModelImport = require("./pi-model-import");

/** Injected by main.js — see configure(). */
let ctx = null;

/** Executable name electron-builder gives the official application. */
const APP_EXE = "DeepSeek Harness.exe";

function dbg(msg) {
  if (ctx && ctx.dbg) ctx.dbg(`[dsh] ${msg}`);
}

// ---------------------------------------------------------------------------
// Locating the application
// ---------------------------------------------------------------------------
/**
 * Where a path chosen through 「选择位置…」 is remembered.
 *
 * In userData rather than in the install tree: the install tree may be
 * read-only (Program Files), and this is a per-user choice anyway.
 */
function locationStatePath() {
  return path.join(ctx.userDataDir(), "dsh-app-location.json");
}

function readRememberedLocation() {
  try {
    const raw = fs.readFileSync(locationStatePath(), "utf8").replace(/^﻿/, "");
    const value = JSON.parse(raw);
    return typeof value.exe === "string" && value.exe ? value.exe : null;
  } catch {
    return null;
  }
}

function rememberLocation(exe) {
  try {
    fs.mkdirSync(path.dirname(locationStatePath()), { recursive: true });
    fs.writeFileSync(locationStatePath(), JSON.stringify({ exe, rememberedAt: new Date().toISOString() }, null, 2));
    dbg(`remembered location: ${exe}`);
  } catch (e) {
    dbg(`could not remember location: ${(e && e.message) || e}`);
  }
}

/**
 * Accept either the executable itself or a directory holding it, so a value
 * pasted into PI_DESKTOP_DSH_APP does not have to guess which one we want.
 */
function normalizeCandidate(candidate) {
  if (!candidate) return null;
  try {
    if (fs.statSync(candidate).isDirectory()) {
      const inside = path.join(candidate, APP_EXE);
      return fs.existsSync(inside) ? inside : null;
    }
  } catch {
    return null;
  }
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the application, most explicit first.
 *
 * The bundled slot (`resources/dsh-app`) is checked but NOT required: shipping
 * upstream's application inside this installer costs ~723MB on top of what the
 * pi runtime already carries, so whether to do that stays a packaging decision
 * (electron-builder.yml) rather than something this file assumes either way.
 *
 * @returns {{exe: string, source: string} | null}
 */
function resolveApp() {
  const candidates = [
    { source: "PI_DESKTOP_DSH_APP", value: process.env.PI_DESKTOP_DSH_APP },
    { source: "记住的位置", value: readRememberedLocation() },
    { source: "随本应用分发", value: path.join(ctx.resourcesBase(), "dsh-app", APP_EXE) },
    {
      source: "用户级安装",
      value: process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", APP_EXE)
        : null,
    },
    {
      source: "系统级安装",
      value: process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "DeepSeek Harness", APP_EXE) : null,
    },
  ];
  for (const { source, value } of candidates) {
    const exe = normalizeCandidate(value);
    if (exe) {
      dbg(`resolved app via ${source}: ${exe}`);
      return { exe, source };
    }
  }
  dbg("no DeepSeek Harness application found");
  return null;
}

/**
 * The release the resolved application carries.
 *
 * Read from the packaged seed's own release record rather than from the
 * executable: upstream binds the Electron shell and `@deepseek-ai/dsh` to one
 * exact version, and that file is where it states it.
 */
function installedVersion() {
  const found = resolveApp();
  if (!found) return null;
  try {
    const record = path.join(path.dirname(found.exe), "resources", "seed", "desktop-release.json");
    const raw = fs.readFileSync(record, "utf8").replace(/^﻿/, "");
    const version = JSON.parse(raw).version;
    return typeof version === "string" ? version : null;
  } catch {
    // An application we can start but cannot introspect is still usable; the
    // launcher tile simply shows no version.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------
/**
 * `$DSH_HOME` for the child. Same default as the CLI (`~/.dsh`), so the
 * official application, a terminal `dsh`, and this shell's model import all
 * agree on where settings and sessions live.
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

/**
 * Environment for the child: the shared Harness home plus the credentials the
 * import mapped, read fresh from pi so rotating a key there needs no re-import.
 */
function childEnv() {
  const credentialEnv = piModelImport.buildCredentialEnv(readImportState().credentials);
  const names = Object.keys(credentialEnv);
  if (names.length) dbg(`injecting ${names.length} imported provider credential(s): ${names.join(", ")}`);
  return { ...process.env, DSH_HOME: dshHome(), ...credentialEnv };
}

/**
 * Offer to locate the application by hand, and remember the answer.
 *
 * @returns {Promise<string | null>} the chosen executable, or null.
 */
async function promptForLocation() {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["选择位置…", "取消"],
    defaultId: 0,
    cancelId: 1,
    title: "DeepSeek Harness",
    message: "没有找到 DeepSeek Harness 应用",
    detail:
      "本应用不再内置 dsh 的 Web UI 套壳，改为启动 DeepSeek Harness 官方桌面端。\n\n" +
      "已查找的位置：\n" +
      `  · 环境变量 PI_DESKTOP_DSH_APP\n` +
      `  · ${path.join(ctx.resourcesBase(), "dsh-app")}\n` +
      `  · %LOCALAPPDATA%\\Programs\\DeepSeek Harness\n` +
      `  · %ProgramFiles%\\DeepSeek Harness\n\n` +
      "若已装在别处，可直接指定它的 " + APP_EXE + "。",
  });
  if (response !== 0) return null;
  const picked = await dialog.showOpenDialog({
    title: "选择 DeepSeek Harness",
    properties: ["openFile"],
    filters: [{ name: "应用程序", extensions: ["exe"] }],
  });
  if (picked.canceled || !picked.filePaths.length) return null;
  const exe = normalizeCandidate(picked.filePaths[0]);
  if (!exe) return null;
  rememberLocation(exe);
  return exe;
}

/**
 * Start the official application.
 *
 * Detached and with its stdio released: it must outlive this process, because
 * the launcher's whole job for this choice is to hand over and quit. `unref()`
 * is what lets our event loop drain while the child keeps running.
 */
function spawnApp(exe) {
  dbg(`spawning ${exe} (DSH_HOME=${dshHome()})`);
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: childEnv(),
    stdio: "ignore",
    detached: true,
    windowsHide: false,
  });
  child.on("error", (e) => {
    dbg(`spawn ERROR ${(e && e.message) || e}`);
    dialog.showErrorBox("DeepSeek Harness 启动失败", String((e && e.message) || e));
  });
  child.unref();
}

/**
 * Launcher tile / menu entry: start DeepSeek Harness.
 *
 * Resolves to a promise so main.js's launchTarget() can treat it exactly like
 * bootPi(); unlike bootPi it creates no window of ours, which is precisely why
 * the settle check there quits the shell afterwards.
 */
async function open() {
  let found = resolveApp();
  if (!found) {
    const exe = await promptForLocation();
    if (!exe) {
      dbg("no application and the user declined to locate one");
      return;
    }
    found = { exe, source: "手动选择" };
  }
  spawnApp(found.exe);
}

// ---------------------------------------------------------------------------
// Model import
// ---------------------------------------------------------------------------
/**
 * Menu entry: restate pi's custom providers as dsh routes.
 *
 * `js-yaml` is still borrowed from a bundled runtime rather than added as a
 * dependency of this shell — only now from the PI runtime, which carries it
 * too. That keeps this package's dependency list empty (electron +
 * electron-builder, both dev) now that there is no dsh runtime to borrow from.
 */
async function importPiModels() {
  try {
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
      "API Key 不会被复制：settings 里只写环境变量名，密钥在每次启动 DeepSeek Harness 时从 pi 的配置读出并通过子进程环境注入。",
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
    const { backup } = piModelImport.mergeIntoSettings(settingsPath, mapped.providers, ctx.requireFromPiRuntime);
    fs.writeFileSync(
      importStatePath(),
      JSON.stringify({ importedAt: new Date().toISOString(), providers: ids, credentials: mapped.credentials }, null, 2)
    );
    dbg(`imported ${ids.length} provider(s); backup=${backup || "(none)"}`);

    dialog.showMessageBox({
      type: "info",
      title: "从 Pi 导入模型配置",
      message: `已导入 ${ids.length} 个提供方`,
      detail:
        (backup ? `原 settings.yaml 已备份为 ${path.basename(backup)}。\n` : "") +
        // We no longer own the dsh process, so we cannot restart it for them.
        "重启 DeepSeek Harness 后生效。\n" +
        "若它因配置被拒而起不来，恢复该备份即可。",
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
  configure,
  open,
  importPiModels,
  installedVersion,
  // exported for diagnostics/tests
  resolveApp,
  dshHome,
  APP_EXE,
};
