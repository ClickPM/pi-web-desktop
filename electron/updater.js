"use strict";

/**
 * Runtime self-updater for the bundled npm runtimes.
 *
 * pi-web (and its dependency @earendil-works/pi-coding-agent) lives in a
 * writable per-user runtime dir, installed from the published npm package which
 * ships a prebuilt `.next` — so updating is a plain `npm install`, no compile.
 *
 * Every entry point takes the package name as an argument, defaulting to
 * pi-web's. That parameterisation was added when the shell also bundled
 * @deepseek-ai/dsh as a second runtime; that runtime is gone (DeepSeek Harness
 * is now upstream's own application, see features/dsh.js), so pi-web is once
 * again the only caller — but the argument stays, since it costs nothing and
 * is the seam a second bundled runtime would use again.
 *
 * All npm calls go through the BUNDLED node + npm so the target machine needs
 * nothing pre-installed.
 *
 * NOTE ON WHERE INSTALLS LAND: `installInto()` is the entry point used by
 * runtime-guard.js, which always points it at a STAGING directory and only
 * swaps the result into place once it verifies. `installLatest()` — the old
 * in-place install — is kept only for callers that explicitly want the legacy
 * behaviour; new code should not use it, because an interruption mid-install
 * corrupts the live runtime (exactly the failure this module's staging path
 * was added to prevent).
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PKG = "@agegr/pi-web";
// Bundled inside @agegr/pi-web; surfaced in the update CTA so the result names
// both packages the user cares about.
const AGENT_PKG = "@earendil-works/pi-coding-agent";

/** Installed version of `pkg` inside a runtime dir, or null when absent/unreadable. */
function getInstalledVersion(runtimeDir, pkg = PKG) {
  try {
    const p = path.join(runtimeDir, "node_modules", ...pkg.split("/"), "package.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).version;
  } catch {
    return null;
  }
}

function getInstalledAgentVersion(runtimeDir) {
  try {
    const p = path.join(
      runtimeDir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json"
    );
    return JSON.parse(fs.readFileSync(p, "utf8")).version;
  } catch {
    return null;
  }
}

function runNpm(ctx, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const fullArgs = [ctx.npmCli, ...args, `--registry=${ctx.registry}`];
    const child = execFile(
      ctx.bundledNode,
      fullArgs,
      {
        cwd: opts.cwd || ctx.runtimeDir,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeout || 0,
        env: {
          ...process.env,
          // Make sure any child node/npx the install spawns resolves to bundled node.
          PATH: ctx.nodeDir + path.delimiter + (process.env.PATH || ""),
          npm_config_yes: "true",
          // When the Windows user-profile path contains non-ASCII characters
          // (e.g. Chinese usernames with parentheses), npm's default cache
          // under %LOCALAPPDATA% hits EPERM on temp-file operations.  Redirect
          // the cache to a path under os.tmpdir() — on Windows this resolves
          // through the 8.3 short name, sidestepping the encoding issue, and
          // it is always writable even when the runtime dir lives under the
          // read-only Program Files tree.
          npm_config_cache: path.join(os.tmpdir(), "pi-npm-cache"),
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout || "");
          err.stderr = String(stderr || "");
          reject(err);
        } else {
          resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
        }
      }
    );
    if (opts.onProgress && child.stderr) {
      child.stderr.on("data", (d) => opts.onProgress(String(d)));
    }
  });
}

/**
 * Resolve the newest version `pkg` offers across `tags`.
 *
 * WHY THIS TAKES A TAG LIST — AND WHY NOBODY PASSES ONE TODAY. `npm view <pkg>
 * version` reads the `latest` dist-tag and nothing else. That is right for
 * pi-web, which publishes nothing else; it was wrong for @deepseek-ai/dsh,
 * whose developer previews land on `next` first and reach `latest` only later
 * (0.1.5-rc.1 sat on `next` alone for a week, until 2026-09-10), so an update
 * check reading `latest` could not see a build the shell had already bundled.
 *
 * The dsh runtime is gone — DeepSeek Harness is upstream's own application now
 * — so the only live caller is pi-web on the default `["latest"]`, i.e. exactly
 * the old behaviour. The list form is kept because it is the general rule and
 * because taking the MAXIMUM across tags is what makes a preview channel safe
 * in both directions: whenever a build is promoted to `latest`, that one wins
 * on its own, with no code change (which is what happened, hours after this
 * was written). Unknown or unpublished tags are simply absent from the answer.
 *
 * One `npm view … dist-tags --json` call covers every tag, so asking for more
 * costs no extra round trip.
 *
 * @returns the winning version string, or "" when no requested tag exists.
 */
async function getLatestVersion(ctx, pkg = PKG, tags = ["latest"]) {
  const { stdout } = await runNpm(ctx, ["view", pkg, "dist-tags", "--json"], { timeout: 60000 });
  let distTags;
  try {
    distTags = JSON.parse(stdout);
  } catch {
    throw new Error(`npm view ${pkg} dist-tags returned unparseable output: ${stdout.trim().slice(0, 200)}`);
  }
  return pickNewestTag(distTags, tags);
}

/**
 * Pick the newest version among `tags` in an npm `dist-tags` map.
 *
 * Split out from getLatestVersion so the selection rule is testable without a
 * network round trip. A tag the registry does not publish is skipped, not
 * treated as an error: asking for `next` on a package that has none must not
 * break the check.
 *
 * @param distTags - parsed `npm view <pkg> dist-tags --json` output.
 * @param tags - tag names to consider.
 * @returns the winning version string, or "" when none of the tags exist.
 */
function pickNewestTag(distTags, tags) {
  let best = "";
  for (const tag of tags) {
    const version = distTags && typeof distTags[tag] === "string" ? distTags[tag].trim() : "";
    if (version && isNewer(version, best || null)) best = version;
  }
  return best;
}

async function installLatest(ctx, onProgress, pkg = PKG) {
  return runNpm(
    ctx,
    ["install", `${pkg}@latest`, "--omit=dev", "--no-audit", "--no-fund"],
    { timeout: 600000, onProgress }
  );
}

/**
 * Install into an arbitrary directory (in practice: runtime-guard's staging dir).
 *
 * `spec` selects the two modes that matter:
 *   - a package spec (e.g. "@agegr/pi-web@latest") → an UPDATE. npm resolves the
 *     new version and rewrites package.json/package-lock.json in the staging dir,
 *     so the manifests travel with the tree they describe when it is swapped in.
 *   - null → a REINSTALL of what the copied lockfile already pins. Used by the
 *     self-heal path: reproduce the current version exactly rather than silently
 *     turning "your install is damaged" into "you also got upgraded".
 *
 * `npm ci` is preferred for the null case because it installs strictly from the
 * lockfile into an empty tree — the most reproducible option available. It
 * refuses to run when the lockfile is absent or out of sync with package.json,
 * so fall back to `npm install` there.
 */
async function installInto(ctx, dir, spec, onProgress) {
  const common = ["--omit=dev", "--no-audit", "--no-fund"];
  const opts = { cwd: dir, timeout: 900000, onProgress };

  if (spec) {
    return runNpm(ctx, ["install", spec, ...common], opts);
  }

  const fs = require("fs");
  const hasLock = fs.existsSync(path.join(dir, "package-lock.json"));
  if (hasLock) {
    try {
      return await runNpm(ctx, ["ci", ...common], opts);
    } catch (e) {
      // Out-of-sync lockfile (EUSAGE) — fall through to a normal install rather
      // than leaving the user with an unrepairable runtime.
      const msg = String((e && e.stderr) || (e && e.message) || "");
      if (!/EUSAGE|can only install packages when|lock ?file/i.test(msg)) throw e;
    }
  }
  return runNpm(ctx, ["install", ...common], opts);
}

/**
 * Split `x.y.z[-pre][+build]` into its release numbers and prerelease
 * identifiers. Build metadata is dropped: semver says it never affects
 * precedence.
 */
function parseVersion(v) {
  const [core, ...preParts] = String(v).trim().split("+")[0].split("-");
  return {
    release: core.split(".").map((n) => parseInt(n, 10) || 0),
    // Rejoining on "-" keeps a tag like `rc.1-hotfix` intact as one string
    // before it is split on "." into identifiers.
    pre: preParts.length ? preParts.join("-").split(".") : [],
  };
}

/**
 * Compare two prerelease identifier lists by semver §11.4.
 *
 * Numeric identifiers compare numerically, alphanumerics compare in ASCII
 * order, numeric always sorts BELOW alphanumeric, and when one list is a
 * prefix of the other the longer one wins.
 */
function comparePre(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    const na = /^\d+$/.test(a[i]);
    const nb = /^\d+$/.test(b[i]);
    if (na && nb) return Number(a[i]) < Number(b[i]) ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Compare semver versions; returns true if `latest` > `installed`.
 *
 * PRERELEASES ARE SIGNIFICANT. The old implementation truncated at the first
 * "-", which made `0.1.0-rc.5` and `0.1.0-rc.6` compare EQUAL — harmless while
 * the only tracked package (pi-web) shipped plain releases, but it would have
 * frozen @deepseek-ai/dsh forever: its entire published history so far is
 * `X.Y.Z-rc.N`, so every check would have reported "already up to date".
 */
function isNewer(latest, installed) {
  if (!installed) return true;
  if (!latest) return false;
  const a = parseVersion(latest);
  const b = parseVersion(installed);
  for (let i = 0; i < Math.max(a.release.length, b.release.length); i++) {
    const x = a.release[i] || 0;
    const y = b.release[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  // Same release numbers: a version WITHOUT a prerelease outranks one with.
  if (!a.pre.length && !b.pre.length) return false;
  if (!a.pre.length) return true;
  if (!b.pre.length) return false;
  return comparePre(a.pre, b.pre) > 0;
}

module.exports = {
  PKG,
  AGENT_PKG,
  getInstalledVersion,
  getInstalledAgentVersion,
  getLatestVersion,
  pickNewestTag,
  installLatest,
  installInto,
  isNewer,
  // exported for tests
  parseVersion,
  comparePre,
};
