"use strict";

/**
 * Runtime integrity guard — atomic provisioning + boot-time verification.
 *
 * WHY THIS EXISTS
 * ---------------
 * The runtime used to be updated IN PLACE (`npm install` straight into the dir
 * the server runs from). A single interrupted install therefore corrupted the
 * live runtime with no way back. That is not theoretical: two interrupted
 * installs left `@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node`
 * truncated to 113MB of an expected 130.5MB. Its PE header was still valid, so
 * nothing noticed until Windows refused the partial DLL with "is not a valid
 * Win32 application" — which broke `next.config.ts` loading, which broke the
 * server, which surfaced to the user as the useless "server not ready in time".
 *
 * Two mechanisms fix that, and they are deliberately built from the SAME
 * primitives so they can never disagree or fight each other:
 *
 *   1. ATOMIC PROVISIONING — install into a sibling staging dir, verify it,
 *      and only then swap it into place with a directory rename. A failure at
 *      any point leaves the live runtime untouched.
 *
 *   2. BOOT VERIFICATION — before starting the server, check that the runtime's
 *      native modules actually load. If they don't, self-heal by running the
 *      exact same provisioning path.
 *
 * The shared pieces are what make them compose:
 *   - `verifyRuntime()` is the boot-time preflight AND the staging acceptance
 *     test. A build that would fail at boot can therefore never be swapped in.
 *   - `provisionRuntime()` is both "update to latest" and "reinstall what we
 *     already have"; only the requested spec differs.
 *   - `recoverInterruptedSwap()` reconciles a swap that died mid-rename, so a
 *     crash (or a pulled power cord) degrades to a rollback, not a brick.
 *
 * Callers serialize every entry point through a single lock (see main.js), so
 * a self-heal and an update check can never run concurrently.
 *
 * CRITICAL — never `require()` a runtime .node from the Electron main process:
 *   (a) Electron's NODE_MODULE_VERSION differs from the bundled node's, so the
 *       result would be meaningless, and
 *   (b) a loaded DLL is locked by Windows, which would make the directory
 *       rename in `swapIn()` fail forever.
 * All native probing happens in a short-lived BUNDLED-node child process whose
 * exit releases every handle.
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Paths — staging/trash/journal all live NEXT TO the runtime dir
// ---------------------------------------------------------------------------
// Same parent => same volume => `fs.rename` is a real atomic move rather than a
// copy+delete. (A staging dir under %TEMP% could land on another drive and lose
// that guarantee entirely.)
function sidecar(runtimeDir, suffix) {
  const parent = path.dirname(runtimeDir);
  const base = path.basename(runtimeDir);
  return path.join(parent, `.${base}.${suffix}`);
}
const stagingDir = (rt) => sidecar(rt, "staging");
const trashDir = (rt) => sidecar(rt, "trash");
const journalPath = (rt) => sidecar(rt, "swap.json");

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

async function rmrf(p) {
  try {
    await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best effort — a leftover trash dir is cosmetic, never fatal */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rename with retries. On Windows a directory rename fails with EPERM/EBUSY
 * while ANY process still holds a handle inside it — a just-killed server, an
 * antivirus scan, or an Explorer window. Retrying with a growing delay clears
 * the common cases instead of failing the whole swap.
 */
async function renameWithRetry(from, to, dbg, attempts = 8) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (e && (e.code === "ENOENT" || e.code === "ENOTEMPTY")) throw e;
      const wait = 150 * (i + 1);
      if (dbg) dbg(`rename retry ${i + 1}/${attempts} (${e && e.code}) ${from} -> ${to}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

// Platform/arch tokens that appear in prebuilt native package names. Used to
// skip the ~14 .node files shipped for OTHER platforms (darwin, linux, arm64…),
// which of course cannot load here and would be false "corruption".
const PLATFORM_TOKENS = ["darwin", "linux", "win32", "android", "freebsd", "openbsd", "sunos"];
const ARCH_TOKENS = ["x64", "arm64", "ia32", "riscv64", "ppc64", "s390x", "loong64"];

/** True when this .node path targets some platform/arch OTHER than ours. */
function isForeignNative(relPath) {
  const p = relPath.toLowerCase().replace(/\\/g, "/");
  // Token match must be delimited so "arm64" never matches inside "arm64x" and
  // "x64" never matches inside "riscv64".
  const has = (tok) => new RegExp(`(^|[^a-z0-9])${tok}([^a-z0-9]|$)`).test(p);
  const platMentions = PLATFORM_TOKENS.filter(has);
  if (platMentions.length && !platMentions.includes(process.platform)) return true;
  const archMentions = ARCH_TOKENS.filter(has);
  if (archMentions.length && !archMentions.includes(process.arch)) return true;
  return false;
}

/** Collect this platform's .node files under a node_modules tree. */
function collectNativeModules(nodeModulesDir, limit = 64) {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (out.length >= limit || depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === ".bin" || e.name === ".cache") continue;
        walk(full, r, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".node")) {
        if (!isForeignNative(r)) out.push({ rel: r, full });
      }
    }
  };
  walk(nodeModulesDir, "", 0);
  return out;
}

// A failure whose message matches one of these means the FILE is wrong —
// truncated, empty, or missing — which is exactly what a torn install leaves
// behind, and exactly what reinstalling fixes. Anything else (a missing
// sibling DLL, an ABI mismatch, an undefined symbol) is an environment problem
// that a reinstall would NOT fix, so it must not trigger a self-heal loop.
const CORRUPT_PATTERNS = [
  /is not a valid win32 application/i,
  /%1 is not a valid/i,
  /bad exe format/i,
  /invalid elf header/i,
  /file too short/i,
  /truncated/i,
  /premature end/i,
  /unexpected end of/i,
  /ENOENT/,
  /cannot find module/i,
];
const looksCorrupt = (msg) => CORRUPT_PATTERNS.some((re) => re.test(String(msg || "")));

// Probe script executed by the BUNDLED node (never by Electron — see header).
// Receives .node paths as argv and prints one JSON line per failure. Kept as an
// inline string because `electron/` is packed into app.asar at build time, and
// the bundled node cannot read a script from inside an asar archive. Passed via
// execFile (no shell), so there is nothing to escape.
const PROBE_SRC = `
const out = [];
for (const p of process.argv.slice(1)) {
  try { require(p); }
  catch (e) { out.push({ path: p, message: String((e && e.message) || e) }); }
}
process.stdout.write(JSON.stringify(out));
`;

function probeNativeModules(ctx, files) {
  return new Promise((resolve) => {
    if (!files.length) return resolve([]);
    execFile(
      ctx.bundledNode,
      ["-e", PROBE_SRC, ...files.map((f) => f.full)],
      { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        // A crashed probe (segfault on a corrupt library) yields no parsable
        // output. Treat that as "cannot verify", not as "everything is fine".
        try {
          return resolve(JSON.parse(String(stdout || "[]")));
        } catch {
          return resolve(
            err
              ? [{ path: "(probe)", message: `probe process failed: ${(err && err.message) || err}` }]
              : []
          );
        }
      }
    );
  });
}

/**
 * Leftover `.<pkg>-<random>` staging dirs are npm's own extraction scratch
 * space. Their presence is a direct fingerprint of an install that was killed
 * mid-flight — the same signature the truncated SWC binary was found alongside.
 */
function findNpmScratchDirs(nodeModulesDir) {
  const found = [];
  const scan = (dir, rel, depth) => {
    if (depth > 2 || found.length >= 20) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      // npm writes `.<name>-<10 random chars>`; `.bin`/`.cache` are legitimate.
      if (/^\.[^.]/.test(e.name) && /-[A-Za-z0-9_-]{8,}$/.test(e.name)) {
        found.push(r);
      } else if (e.name.startsWith("@")) {
        scan(path.join(dir, e.name), r, depth + 1); // scopes nest one level
      }
    }
  };
  scan(nodeModulesDir, "", 0);
  return found;
}

/**
 * Landmark files whose absence means the tree is not a usable runtime, keyed
 * by the runtime they describe. Paths are relative to `node_modules`.
 *
 * dsh's list is deliberately short: unlike pi-web (whose prebuilt `.next` is
 * the thing most likely to arrive half-written) dsh is plain JS plus prebuilt
 * native addons, and the native probe below covers those far better than any
 * file-existence check could. The frontend `dist` is listed because a dsh
 * install without it starts and then serves 404s — a failure that would
 * otherwise reach the user as a blank window.
 */
const PI_WEB_REQUIRED_FILES = [
  { rel: ["next", "dist", "bin", "next"], label: "next CLI" },
  { rel: ["@agegr", "pi-web", "package.json"], label: "pi-web package" },
  { rel: ["@agegr", "pi-web", ".next", "BUILD_ID"], label: "pi-web prebuilt .next" },
  { rel: ["react", "package.json"], label: "react" },
];

/**
 * Verify a runtime tree — used BOTH as the boot preflight and as the acceptance
 * test for a freshly staged install. Same checks in both roles, so anything
 * that would fail at boot is rejected before it can be swapped in.
 *
 * Returns { ok, healable, failures[] }.
 *   healable — every failure looks like a torn/incomplete install, so
 *              reinstalling is expected to fix it. When false the tree is
 *              broken in a way npm cannot repair (bad ABI, missing system DLL)
 *              and the caller must NOT loop on reinstalling.
 */
async function verifyRuntime(ctx, dir) {
  const failures = [];
  const nm = path.join(dir, "node_modules");

  // --- structural checks (cheap, catch a wholesale-missing install) ---
  // The landmark list stays injectable even though pi-web is once again the
  // only bundled runtime: `ctx.requiredFiles` is what let this guard serve a
  // second runtime (dsh, until its launch path moved to upstream's own
  // application) without forking any of the surrounding machinery, and it is
  // the seam any future one would use. The default is pi-web's.
  const required = ctx.requiredFiles || PI_WEB_REQUIRED_FILES;
  for (const { rel, label } of required) {
    const p = path.join(nm, ...rel);
    if (!exists(p)) failures.push({ kind: "missing", label, detail: p });
  }

  // --- torn-install fingerprint ---
  for (const scratch of findNpmScratchDirs(nm)) {
    failures.push({
      kind: "scratch",
      label: "npm scratch dir left behind",
      detail: scratch,
    });
  }

  // --- native modules actually load (in a child process; see header) ---
  const natives = collectNativeModules(nm);
  if (natives.length) {
    for (const bad of await probeNativeModules(ctx, natives)) {
      failures.push({
        kind: looksCorrupt(bad.message) ? "corrupt" : "unloadable",
        label: path.relative(nm, bad.path) || bad.path,
        detail: bad.message,
      });
    }
  }
  if (ctx.dbg) {
    ctx.dbg(
      `verifyRuntime ${dir}: ${natives.length} native module(s) probed, ${failures.length} failure(s)`
    );
    for (const f of failures) ctx.dbg(`  [${f.kind}] ${f.label}: ${String(f.detail).slice(0, 200)}`);
  }

  // "unloadable" (as opposed to missing/corrupt/scratch) is an environment
  // fault; reinstalling the same bytes would change nothing.
  const healable = failures.length > 0 && failures.every((f) => f.kind !== "unloadable");
  return { ok: failures.length === 0, healable, failures };
}

/** One-line human summary for logs and dialogs. */
function describeFailures(failures, max = 4) {
  const head = failures.slice(0, max).map((f) => `${f.label} (${f.kind})`);
  const rest = failures.length - head.length;
  return head.join("、") + (rest > 0 ? ` 等 ${failures.length} 项` : "");
}

// ---------------------------------------------------------------------------
// Swap journal — makes a mid-rename crash recoverable
// ---------------------------------------------------------------------------
function writeJournal(rt, data) {
  try {
    fs.writeFileSync(journalPath(rt), JSON.stringify({ ts: Date.now(), ...data }));
  } catch {
    /* journal is an optimization; a failed write must not abort the swap */
  }
}
function readJournal(rt) {
  try {
    return JSON.parse(fs.readFileSync(journalPath(rt), "utf8"));
  } catch {
    return null;
  }
}
function clearJournal(rt) {
  try {
    fs.unlinkSync(journalPath(rt));
  } catch {
    /* ignore */
  }
}

/**
 * Reconcile a swap that was interrupted. MUST run at boot before anything reads
 * the runtime.
 *
 * The swap is two renames with a journal write between them, so exactly three
 * states are possible on restart:
 *   - phase "begin"     — nothing moved yet, or the live dir moved to trash
 *   - phase "moved-out" — live dir is in trash, new tree not yet in place
 *   - phase "done"      — new tree is live, trash is just garbage
 */
async function recoverInterruptedSwap(ctx, rt) {
  const j = readJournal(rt);
  const staging = stagingDir(rt);
  const trash = trashDir(rt);
  const dbg = ctx.dbg || (() => {});

  if (!j) {
    // No swap was in flight. Clear any stale scratch so a later swap starts
    // clean — but only when the live runtime is actually present.
    if (exists(rt)) {
      if (exists(staging)) {
        dbg(`recover: dropping stale staging ${staging}`);
        await rmrf(staging);
      }
      if (exists(trash)) {
        dbg(`recover: dropping stale trash ${trash}`);
        await rmrf(trash);
      }
    }
    return { recovered: false };
  }

  dbg(`recover: journal phase=${j.phase}`);

  if (exists(rt)) {
    // Live dir is present, so either the swap completed or it never started.
    // Either way the sidecars are garbage.
    await rmrf(staging);
    await rmrf(trash);
    clearJournal(rt);
    return { recovered: true, action: "cleaned" };
  }

  // Live dir is GONE — we died between the two renames. Prefer the new tree
  // (it passed verification before the swap began); fall back to the old one.
  if (exists(staging)) {
    dbg("recover: completing interrupted swap from staging");
    await renameWithRetry(staging, rt, dbg);
    await rmrf(trash);
    clearJournal(rt);
    return { recovered: true, action: "completed" };
  }
  if (exists(trash)) {
    dbg("recover: rolling back interrupted swap from trash");
    await renameWithRetry(trash, rt, dbg);
    clearJournal(rt);
    return { recovered: true, action: "rolled-back" };
  }

  clearJournal(rt);
  return { recovered: false, action: "nothing-to-restore" };
}

/**
 * Atomically replace the live runtime with a verified staged tree.
 *
 * The caller MUST have stopped the server first: on Windows the running node
 * process holds handles inside node_modules (the SWC DLL above all), and a
 * directory rename cannot move a tree with open handles.
 */
async function swapIn(ctx, rt) {
  const staging = stagingDir(rt);
  const trash = trashDir(rt);
  const dbg = ctx.dbg || (() => {});

  if (!exists(staging)) throw new Error(`staging dir missing: ${staging}`);
  await rmrf(trash);

  writeJournal(rt, { phase: "begin", target: rt, staging, trash });
  if (exists(rt)) {
    await renameWithRetry(rt, trash, dbg);
  }
  writeJournal(rt, { phase: "moved-out", target: rt, staging, trash });

  try {
    await renameWithRetry(staging, rt, dbg);
  } catch (e) {
    // Could not install the new tree — put the old one back so the app still
    // runs, and surface the failure.
    dbg(`swapIn: staging rename failed (${(e && e.message) || e}); rolling back`);
    if (!exists(rt) && exists(trash)) await renameWithRetry(trash, rt, dbg);
    clearJournal(rt);
    throw e;
  }

  writeJournal(rt, { phase: "done", target: rt, trash });
  // Deleting ~130MB of old tree is slow and entirely optional — the swap is
  // already committed. Do it in the background; recover() sweeps any remnant.
  rmrf(trash).then(() => clearJournal(rt));
  dbg(`swapIn: committed ${staging} -> ${rt}`);
}

// ---------------------------------------------------------------------------
// Provisioning — the single write path for BOTH self-heal and update
// ---------------------------------------------------------------------------
/**
 * Build a fresh runtime in staging, verify it, and swap it in.
 *
 * opts:
 *   spec      — "<pkg>@<version>" to install, or null to restore the tree the
 *               current package-lock.json describes (the self-heal case).
 *   reason    — short tag for logs/telemetry ("self-heal" | "update").
 *   onProgress(text) — npm stderr passthrough for the updating UI.
 *   stopServer()     — async; called ONLY after staging passes verification,
 *                      immediately before the swap. Keeps the old server
 *                      serving for the entire download.
 *
 * Nothing outside `staging` is touched until verification passes, so a failed
 * install — network drop, bad tarball, killed process — leaves the live runtime
 * exactly as it was.
 */
async function provisionRuntime(ctx, opts = {}) {
  const rt = ctx.runtimeDir;
  const staging = stagingDir(rt);
  const dbg = ctx.dbg || (() => {});
  const reason = opts.reason || "provision";

  dbg(`provision[${reason}] start; spec=${opts.spec || "(lockfile)"} staging=${staging}`);

  // 1. Clean staging. A fresh install (rather than a copy of the live tree) is
  //    deliberate: it cannot inherit whatever corruption we are healing from,
  //    and it leaves no npm scratch dirs behind.
  await rmrf(staging);
  await fs.promises.mkdir(staging, { recursive: true });

  // 2. Carry over every top-level FILE from the live runtime — not just the
  //    manifests. package.json/package-lock.json are the obvious ones (the
  //    lockfile keeps untouched dependencies pinned to tested versions), but
  //    `.seeded` matters just as much: ensureRuntime() treats its absence as
  //    "this user dir was never seeded" and would robocopy the app's ORIGINAL
  //    seed back over the tree we just installed — silently reverting the
  //    update and leaving a half-old, half-new mix. Copying the whole file
  //    layer keeps that class of bug from reappearing when a new marker file
  //    is introduced. node_modules is excluded: it is what we are replacing.
  let entries = [];
  try {
    entries = await fs.promises.readdir(rt, { withFileTypes: true });
  } catch {
    /* live dir unreadable — the package.json check below reports it */
  }
  for (const e of entries) {
    if (!e.isFile() || e.name === "node_modules") continue;
    try {
      await fs.promises.copyFile(path.join(rt, e.name), path.join(staging, e.name));
    } catch (err) {
      dbg(`provision[${reason}] could not carry over ${e.name}: ${(err && err.message) || err}`);
    }
  }
  if (!exists(path.join(staging, "package.json"))) {
    await rmrf(staging);
    throw new Error(`cannot provision: no package.json in ${rt}`);
  }

  // 3. Install into staging with the bundled npm.
  try {
    await ctx.installInto(staging, opts.spec, opts.onProgress);
  } catch (e) {
    await rmrf(staging);
    throw e;
  }

  // 4. Acceptance test — the SAME verification the boot preflight runs, so a
  //    tree that would fail to boot can never reach the live path.
  const check = await verifyRuntime(ctx, staging);
  if (!check.ok) {
    const summary = describeFailures(check.failures);
    await rmrf(staging);
    throw new Error(`新安装的运行时未通过完整性校验：${summary}`);
  }
  dbg(`provision[${reason}] staging verified`);

  // 5. Stop the server and commit. Everything above this line was safe to
  //    abandon; from here the old tree is on its way out.
  if (opts.stopServer) await opts.stopServer();
  await swapIn(ctx, rt);
  dbg(`provision[${reason}] done`);
  return { ok: true };
}

module.exports = {
  PI_WEB_REQUIRED_FILES,
  stagingDir,
  trashDir,
  journalPath,
  verifyRuntime,
  describeFailures,
  recoverInterruptedSwap,
  swapIn,
  provisionRuntime,
  // exported for tests
  isForeignNative,
  findNpmScratchDirs,
  looksCorrupt,
};
