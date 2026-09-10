"use strict";

/**
 * Regression tests for electron/runtime-guard.js — run with `npm run test:guard`.
 *
 * These cover the invariants that are easy to break by accident and expensive
 * to discover in production:
 *
 *   - a native module built for ANOTHER platform must never count as damage
 *     (the runtime ships ~14 of them; probing them would fail every launch)
 *   - a torn install must be classified healable, an environment fault must NOT
 *     (an unhealable fault reinstalled in a loop wastes minutes and still fails)
 *   - a failed or rejected install must leave the live runtime bit-for-bit
 *     unchanged, and must not stop the running server
 *   - every top-level metadata file (notably `.seeded`) must survive a swap —
 *     losing it makes ensureRuntime() robocopy the original seed back over a
 *     freshly updated tree, silently downgrading it
 *   - a swap interrupted mid-rename must resolve to completed-forward or
 *     rolled-back, never to a missing runtime dir
 *
 * The suite is self-contained: it works on a temp dir and touches the real
 * runtime only to READ a native module for the truncation fixture. Cases that
 * need artifacts this checkout does not have (no runtime-seed, no bundled node)
 * report as SKIP rather than failing.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO = path.join(__dirname, "..");
const G = require(path.join(REPO, "electron", "runtime-guard.js"));
const U = require(path.join(REPO, "electron", "updater.js"));

const isWin = process.platform === "win32";
const TMP = path.join(os.tmpdir(), `runtime-guard-test-${process.pid}`);

// --- environment discovery -------------------------------------------------
const NODE_DIR = path.join(REPO, "vendor", "node");
const BUNDLED_NODE = path.join(NODE_DIR, isWin ? "node.exe" : path.join("bin", "node"));
// Fall back to the node running this file so the suite still works before
// `vendor/node` has been provisioned.
const NODE = fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;
const NPM_CLI = path.join(NODE_DIR, "node_modules", "npm", "bin", "npm-cli.js");
const RUNTIME = path.join(REPO, "runtime-seed");
const REGISTRY = process.env.PI_WEB_REGISTRY || "https://registry.npmmirror.com";

/** A real .node for THIS platform, used as the truncation fixture. */
function findLocalNative() {
  const nm = path.join(RUNTIME, "node_modules");
  if (!fs.existsSync(nm)) return null;
  const stack = [nm];
  let depth = 0;
  while (stack.length && depth++ < 20000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".node")) {
        const rel = path.relative(nm, full);
        if (!G.isForeignNative(rel)) return full;
      }
    }
  }
  return null;
}
const REAL_NATIVE = findLocalNative();

// --- tiny harness ----------------------------------------------------------
let pass = 0,
  fail = 0,
  skip = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? `  -> ${extra}` : ""}`);
  }
};
const skipped = (name, why) => {
  skip++;
  console.log(`  SKIP  ${name}  (${why})`);
};
const ctx = { bundledNode: NODE, dbg: () => {} };

// --- fixtures --------------------------------------------------------------
/** A tree shaped like a real runtime, which verifyRuntime should accept. */
function writeGoodTree(dir, version, { truncateNative = false, scratch = false, omitBuildId = false } = {}) {
  const nm = path.join(dir, "node_modules");
  const files = [
    ["next/dist/bin/next", "#!/usr/bin/env node\n"],
    ["next/package.json", '{"name":"next"}'],
    ["@agegr/pi-web/package.json", `{"name":"@agegr/pi-web","version":"${version}"}`],
    ["react/package.json", '{"name":"react"}'],
  ];
  if (!omitBuildId) files.push(["@agegr/pi-web/.next/BUILD_ID", "test-build"]);
  for (const [rel, body] of files) {
    const full = path.join(nm, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  fs.writeFileSync(path.join(dir, "package.json"), '{"dependencies":{"@agegr/pi-web":"^0.8.1"}}');
  fs.writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}');

  if (REAL_NATIVE) {
    const dst = path.join(nm, "@next", path.basename(path.dirname(REAL_NATIVE)), path.basename(REAL_NATIVE));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (truncateNative) {
      // Valid header, missing tail — precisely the shape of the shipped bug.
      const fd = fs.openSync(REAL_NATIVE, "r");
      const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, fs.statSync(REAL_NATIVE).size - 1));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      fs.writeFileSync(dst, buf);
    } else {
      fs.copyFileSync(REAL_NATIVE, dst);
    }
  }
  if (scratch) fs.mkdirSync(path.join(nm, ".react-Zg3mU8P1"), { recursive: true });
}

// ---------------------------------------------------------------------------
(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  console.log(`runtime-guard tests — node=${path.basename(NODE)} fixture=${REAL_NATIVE ? "real .node" : "none"}`);

  console.log(`\n[1] isForeignNative — only this platform (${process.platform}/${process.arch}) gets probed`);
  {
    const cases = [
      ["@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node", "win32", "x64"],
      ["@next/swc-darwin-arm64/next-swc.darwin-arm64.node", "darwin", "arm64"],
      ["@mariozechner/clipboard-linux-riscv64-gnu/clipboard.linux-riscv64-gnu.node", "linux", "riscv64"],
      ["@earendil-works/pi-tui/native/win32/prebuilds/win32-arm64/win32-console-mode.node", "win32", "arm64"],
      ["@img/sharp-linux-x64/lib/sharp-linux-x64.node", "linux", "x64"],
    ];
    for (const [rel, plat, arch] of cases) {
      const mine = plat === process.platform && arch === process.arch;
      ok(`${mine ? "probe" : "skip "} ${rel.slice(0, 56)}`, G.isForeignNative(rel) === !mine);
    }
    // No platform token at all -> must always be probed, never assumed foreign.
    ok("probe untagged build/Release/binding.node", G.isForeignNative("pkg/build/Release/binding.node") === false);
  }

  console.log("\n[2] looksCorrupt — reinstall only what reinstalling can fix");
  ok("truncated DLL", G.looksCorrupt("%1 is not a valid Win32 application."));
  ok("missing file", G.looksCorrupt("ENOENT: no such file or directory"));
  ok("bad ELF", G.looksCorrupt("invalid ELF header"));
  ok("ABI mismatch is NOT healable", !G.looksCorrupt("compiled against a different Node.js version"));
  ok("missing system DLL is NOT healable", !G.looksCorrupt("The specified module could not be found."));

  console.log("\n[3] findNpmScratchDirs — torn-install fingerprint");
  {
    const nm = path.join(TMP, "nm");
    for (const d of [".bin", ".cache", "react", ".next-eoq06yop", "@next/.swc-win32-x64-msvc-wKzfl75z"]) {
      fs.mkdirSync(path.join(nm, d), { recursive: true });
    }
    const found = G.findNpmScratchDirs(nm);
    ok("finds top-level scratch", found.includes(".next-eoq06yop"), JSON.stringify(found));
    ok("finds scoped scratch", found.some((s) => s.includes("wKzfl75z")), JSON.stringify(found));
    ok("leaves .bin/.cache/real pkgs alone", !found.some((s) => /(\.bin|\.cache|react)$/.test(s)), JSON.stringify(found));
  }

  console.log("\n[4] verifyRuntime");
  {
    const good = path.join(TMP, "rt-good");
    writeGoodTree(good, "0.8.1");
    const r = await G.verifyRuntime(ctx, good);
    ok("intact tree passes", r.ok === true, JSON.stringify(r.failures));

    if (REAL_NATIVE) {
      const torn = path.join(TMP, "rt-torn");
      writeGoodTree(torn, "0.8.1", { truncateNative: true });
      const t = await G.verifyRuntime(ctx, torn);
      ok("truncated native detected", t.ok === false);
      ok("truncated native is healable", t.healable === true, JSON.stringify(t.failures));
      ok("classified corrupt", t.failures.some((f) => f.kind === "corrupt"), JSON.stringify(t.failures.map((f) => f.kind)));
    } else {
      skipped("truncated native detection", "no runtime-seed to source a .node from");
    }

    const nobuild = path.join(TMP, "rt-nobuild");
    writeGoodTree(nobuild, "0.8.1", { omitBuildId: true });
    const b = await G.verifyRuntime(ctx, nobuild);
    ok("missing .next/BUILD_ID detected", b.ok === false && b.healable === true);

    const dirty = path.join(TMP, "rt-dirty");
    writeGoodTree(dirty, "0.8.1", { scratch: true });
    const d = await G.verifyRuntime(ctx, dirty);
    ok("npm scratch dir detected", d.failures.some((f) => f.kind === "scratch"), JSON.stringify(d.failures));

    if (fs.existsSync(path.join(RUNTIME, "node_modules"))) {
      const real = await G.verifyRuntime(ctx, RUNTIME);
      ok("the checkout's own runtime-seed verifies", real.ok === true, JSON.stringify(real.failures));
    } else {
      skipped("real runtime-seed verifies", "runtime-seed not provisioned");
    }
  }

  console.log("\n[5] provisionRuntime — commit path");
  {
    const live = path.join(TMP, "prov-ok");
    writeGoodTree(live, "0.8.1");
    fs.writeFileSync(path.join(live, ".seeded"), "0.8.1");
    const events = [];
    await G.provisionRuntime(
      {
        ...ctx,
        runtimeDir: live,
        installInto: async (dir) => {
          events.push("install");
          writeGoodTree(dir, "0.8.2");
        },
      },
      { spec: "pkg@latest", reason: "test", stopServer: async () => events.push("stopServer") }
    );
    const v = JSON.parse(fs.readFileSync(path.join(live, "node_modules/@agegr/pi-web/package.json"), "utf8")).version;
    ok("new tree is live", v === "0.8.2", v);
    ok(".seeded survives the swap", fs.existsSync(path.join(live, ".seeded")));
    ok("staging consumed", !fs.existsSync(G.stagingDir(live)));
    ok("download happens before the server stops", events.indexOf("install") < events.indexOf("stopServer"), events.join(","));
    ok("server stopped exactly once", events.filter((e) => e === "stopServer").length === 1, events.join(","));
  }

  console.log("\n[6] provisionRuntime — failure must not touch the live runtime");
  {
    // install throws (network down, bad tarball, killed npm)
    const live = path.join(TMP, "prov-installfail");
    writeGoodTree(live, "0.8.1");
    const events = [];
    let threw = null;
    try {
      await G.provisionRuntime(
        { ...ctx, runtimeDir: live, installInto: async () => { throw new Error("ENOTFOUND registry"); } },
        { spec: "pkg@latest", reason: "test", stopServer: async () => events.push("stopServer") }
      );
    } catch (e) {
      threw = e;
    }
    ok("error propagates", threw !== null);
    ok("live version unchanged", JSON.parse(fs.readFileSync(path.join(live, "node_modules/@agegr/pi-web/package.json"), "utf8")).version === "0.8.1");
    ok("staging cleaned", !fs.existsSync(G.stagingDir(live)));
    ok("server never stopped", events.length === 0, events.join(","));
    ok("no journal left", !fs.existsSync(G.journalPath(live)));

    // install "succeeds" but produces a corrupt tree -> must be rejected
    if (REAL_NATIVE) {
      const live2 = path.join(TMP, "prov-verifyfail");
      writeGoodTree(live2, "0.8.1");
      const ev2 = [];
      let threw2 = null;
      try {
        await G.provisionRuntime(
          { ...ctx, runtimeDir: live2, installInto: async (dir) => writeGoodTree(dir, "0.9.0", { truncateNative: true }) },
          { spec: "pkg@latest", reason: "test", stopServer: async () => ev2.push("stopServer") }
        );
      } catch (e) {
        threw2 = e;
      }
      ok("corrupt staging rejected", threw2 !== null && /完整性校验/.test(threw2.message), String(threw2 && threw2.message));
      ok("live version unchanged after rejection", JSON.parse(fs.readFileSync(path.join(live2, "node_modules/@agegr/pi-web/package.json"), "utf8")).version === "0.8.1");
      ok("server never stopped on rejection", ev2.length === 0, ev2.join(","));
    } else {
      skipped("corrupt staging rejected", "no .node fixture available");
    }
  }

  console.log("\n[7] recoverInterruptedSwap — every crash point resolves");
  {
    // died after moving live out, with the new tree staged -> complete forward
    const a = path.join(TMP, "crash-forward");
    fs.mkdirSync(G.stagingDir(a), { recursive: true });
    fs.writeFileSync(path.join(G.stagingDir(a), "who"), "NEW");
    fs.mkdirSync(G.trashDir(a), { recursive: true });
    fs.writeFileSync(path.join(G.trashDir(a), "who"), "OLD");
    fs.writeFileSync(G.journalPath(a), JSON.stringify({ phase: "moved-out" }));
    await G.recoverInterruptedSwap(ctx, a);
    ok("completes forward from staging", fs.readFileSync(path.join(a, "who"), "utf8") === "NEW");
    ok("journal cleared", !fs.existsSync(G.journalPath(a)));

    // died after moving live out, staging gone -> roll back
    const b = path.join(TMP, "crash-rollback");
    fs.mkdirSync(G.trashDir(b), { recursive: true });
    fs.writeFileSync(path.join(G.trashDir(b), "who"), "OLD");
    fs.writeFileSync(G.journalPath(b), JSON.stringify({ phase: "moved-out" }));
    await G.recoverInterruptedSwap(ctx, b);
    ok("rolls back from trash", fs.readFileSync(path.join(b, "who"), "utf8") === "OLD");

    // died before anything moved -> live intact, sidecars swept
    const c = path.join(TMP, "crash-early");
    fs.mkdirSync(c, { recursive: true });
    fs.writeFileSync(path.join(c, "who"), "OLD");
    fs.mkdirSync(G.stagingDir(c), { recursive: true });
    fs.writeFileSync(G.journalPath(c), JSON.stringify({ phase: "begin" }));
    await G.recoverInterruptedSwap(ctx, c);
    ok("keeps the intact live dir", fs.readFileSync(path.join(c, "who"), "utf8") === "OLD");
    ok("sweeps stale staging", !fs.existsSync(G.stagingDir(c)));

    // no journal, healthy live dir -> stale sidecars still swept
    const d = path.join(TMP, "clean");
    fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(G.stagingDir(d), { recursive: true });
    const r = await G.recoverInterruptedSwap(ctx, d);
    ok("no-journal sweep", !fs.existsSync(G.stagingDir(d)) && r.recovered === false);
  }

  console.log("\n[8] installInto — real bundled npm");
  if (!fs.existsSync(NPM_CLI) || process.env.SKIP_NETWORK_TESTS) {
    skipped("bundled npm install", fs.existsSync(NPM_CLI) ? "SKIP_NETWORK_TESTS set" : "vendor/node not provisioned");
  } else {
    const dir = path.join(TMP, "npm-real");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"probe","version":"1.0.0","dependencies":{}}');
    const nctx = { bundledNode: NODE, npmCli: NPM_CLI, nodeDir: NODE_DIR, registry: REGISTRY };
    try {
      await U.installInto(nctx, dir, "is-number@7.0.0");
      ok("spec install lands in the target dir", fs.existsSync(path.join(dir, "node_modules/is-number/package.json")));
      ok("manifests written alongside it", fs.existsSync(path.join(dir, "package-lock.json")));
      fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
      await U.installInto(nctx, dir, null); // lockfile mode = the self-heal path
      ok("lockfile reinstall restores the tree", fs.existsSync(path.join(dir, "node_modules/is-number/package.json")));
    } catch (e) {
      ok("bundled npm install", false, String((e && e.message) || e));
    }
  }

  console.log("\n[9] isNewer — prereleases decide whether dsh can ever update");
  {
    // Plain releases (pi-web's whole history) must keep behaving as before.
    ok("patch bump", U.isNewer("0.8.9", "0.8.8"));
    ok("minor bump", U.isNewer("0.9.0", "0.8.99"));
    ok("major bump", U.isNewer("1.0.0", "0.9.9"));
    ok("same version is not newer", !U.isNewer("0.8.8", "0.8.8"));
    ok("downgrade is not newer", !U.isNewer("0.8.7", "0.8.8"));
    ok("missing installed counts as newer", U.isNewer("0.1.0", null));

    // The case that motivated the rewrite: the old truncate-at-"-" comparison
    // reported these as equal, so dsh would never have offered an update.
    ok("rc.6 > rc.5", U.isNewer("0.1.0-rc.6", "0.1.0-rc.5"));
    ok("rc.5 is not > rc.6", !U.isNewer("0.1.0-rc.5", "0.1.0-rc.6"));
    ok("rc.10 > rc.9 (numeric, not lexical)", U.isNewer("0.1.0-rc.10", "0.1.0-rc.9"));
    ok("release > its own prerelease", U.isNewer("0.1.0", "0.1.0-rc.6"));
    ok("prerelease is not > the release", !U.isNewer("0.1.0-rc.6", "0.1.0"));
    ok("next release > prerelease", U.isNewer("0.2.0-rc.1", "0.1.0"));
    ok("longer identifier list wins", U.isNewer("0.1.0-rc.1.1", "0.1.0-rc.1"));
    ok("numeric sorts below alphanumeric", U.isNewer("0.1.0-alpha", "0.1.0-1"));
    ok("build metadata is ignored", !U.isNewer("0.1.0+build2", "0.1.0+build1"));
  }

  console.log("\n[9b] pickNewestTag — a preview channel must not hide behind `latest`");
  {
    // The shape observed on the morning of 2026-09-10, which is why this
    // exists: @deepseek-ai/dsh 0.1.5-rc.1 was published under `next` only, so a
    // check reading `latest` alone saw nothing newer than the week-old
    // 0.1.2-rc.1. Upstream promoted `latest` hours later — the point of the
    // rule is that neither state needs a code change, so both are pinned here.
    // No shipped runtime passes a tag list today (dsh moved to upstream's own
    // application); these lock the RULE, not a current caller.
    const real = { latest: "0.1.2-rc.1", next: "0.1.5-rc.1", alpha: "0.1.5-alpha.2" };
    ok("next wins when it is ahead", U.pickNewestTag(real, ["latest", "next"]) === "0.1.5-rc.1");
    ok("latest alone still sees only latest", U.pickNewestTag(real, ["latest"]) === "0.1.2-rc.1");
    ok("an untracked tag is ignored", U.pickNewestTag(real, ["latest", "next"]) !== "0.1.5-alpha.2");

    // The other direction must need no code change: once upstream promotes a
    // build to `latest` and lets `next` fall behind, `latest` has to win.
    const promoted = { latest: "0.1.5-rc.1", next: "0.1.5-rc.1" };
    ok("latest wins after promotion", U.pickNewestTag(promoted, ["latest", "next"]) === "0.1.5-rc.1");
    const stale = { latest: "0.2.0", next: "0.1.5-rc.1" };
    ok("a stale next never drags the answer back", U.pickNewestTag(stale, ["latest", "next"]) === "0.2.0");

    // Absent / malformed maps must degrade to "nothing to offer", never throw:
    // isNewer("", installed) would otherwise be asked to compare a non-version.
    ok("missing next is skipped", U.pickNewestTag({ latest: "0.1.2-rc.1" }, ["latest", "next"]) === "0.1.2-rc.1");
    ok("no requested tag exists", U.pickNewestTag({ beta: "9.9.9" }, ["latest", "next"]) === "");
    ok("empty dist-tags", U.pickNewestTag({}, ["latest", "next"]) === "");
    ok("null dist-tags", U.pickNewestTag(null, ["latest", "next"]) === "");
    ok("non-string tag value is skipped", U.pickNewestTag({ latest: 12 }, ["latest"]) === "");

    // "" must read as "no update", not as an update to nothing.
    ok("empty result is not newer than an install", !U.isNewer(U.pickNewestTag({}, ["next"]), "0.1.5-rc.1"));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n===== ${pass} passed, ${fail} failed, ${skip} skipped =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(2);
});
