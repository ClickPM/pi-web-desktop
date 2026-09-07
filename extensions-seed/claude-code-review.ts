/**
 * Claude Code Review for pi —— 把 Claude Code 当成「代码 review 服务」挂到 pi 上
 *
 * pi 自己没有专职的 review 通路：让主模型直接读 diff 评审，既占上下文、又和当前
 * 会话的任务混在一起。本扩展把评审外包给一个**独立的 Claude Code 子进程**
 * （`claude -p` 非交互模式），子进程带自己的只读工具（Read / Grep / Glob / git 查询类
 * 命令）去仓库里翻上下文，评审结果以**结构化 JSON** 回给 pi，不污染主会话。
 *
 * === 三条硬性约束（按需求实现） ===
 *
 *  1) **网络闸门**：只有当前连着 Variflight 无线网才可用。每次调用前读网卡当前
 *     SSID（Windows 走 `netsh wlan show interfaces`，macOS 走 `networksetup`，
 *     Linux 走 `nmcli` / `iwgetid`），不匹配直接拒绝、不发起任何请求。结果按
 *     PI_CR_SSID_TTL 缓存几秒，避免连续调用时反复起进程。
 *
 *  2) **非交互 + 结构化 JSON**：子进程固定 `-p --output-format json`，并用
 *     `--json-schema` 让 Claude 的最终输出受 schema 约束（老版本 CLI 不认这个参数时
 *     自动去掉重试一次，靠提示词里的输出契约兜底）。工具返回给 pi 的 text 本身
 *     就是一份 JSON，`details` 里带同一份对象供 UI 渲染。
 *
 *  3) **模型与思考强度**：默认 `claude-opus-5` + `--effort xhigh`；pi 调用时可用
 *     `model` / `effort` 参数指定别的 Claude 模型与强度（low/medium/high/xhigh/max）。
 *     只接受 Claude 系模型（别名或 `claude-*`），传别家模型会被拒。
 *
 * === 注册的工具 ===
 *   `claude_code_review`  —— 对指定范围的改动做一次代码审查，返回结构化 JSON
 *
 * === 注册的命令 ===
 *   `/claude-review`      —— 打印当前 SSID 闸门状态、claude 可执行文件、默认模型/强度
 *
 * === 可选环境变量 ===
 *   PI_CR_REQUIRED_SSID   闸门要求的 SSID，默认 "Variflight"；设为空字符串则**关闭闸门**
 *   PI_CR_MODEL           默认模型，默认 "claude-opus-5"
 *   PI_CR_EFFORT          默认思考强度，默认 "xhigh"
 *   PI_CR_CLAUDE_BIN      claude 可执行文件的绝对路径（PATH 里找不到时用）
 *   PI_CR_TIMEOUT         单次评审超时(ms)，默认 1800000（30 分钟，opus xhigh 很慢）
 *   PI_CR_MAX_DIFF_BYTES  塞进提示词的 diff 上限，默认 200000（超出截断并告知模型自己去 git 里取）
 *   PI_CR_SSID_TTL        SSID 探测结果缓存(ms)，默认 10000
 *   PI_CR_CONFIRM         设为 1 时每次调用前弹确认框（默认不弹，费用在结果里回报）
 *
 * 无外部依赖（只用 node 内置），不需要 npm install。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 空字符串 = 显式关闭闸门；未设置 = 用默认的 Variflight */
const REQUIRED_SSID =
  process.env.PI_CR_REQUIRED_SSID === undefined ? "Variflight" : process.env.PI_CR_REQUIRED_SSID.trim();
const DEFAULT_MODEL = process.env.PI_CR_MODEL?.trim() || "claude-opus-5";
const DEFAULT_EFFORT = process.env.PI_CR_EFFORT?.trim() || "xhigh";
const TIMEOUT_MS = Number(process.env.PI_CR_TIMEOUT) > 0 ? Number(process.env.PI_CR_TIMEOUT) : 1_800_000;
const MAX_DIFF_BYTES = Number(process.env.PI_CR_MAX_DIFF_BYTES) > 0 ? Number(process.env.PI_CR_MAX_DIFF_BYTES) : 200_000;
const SSID_TTL_MS = Number(process.env.PI_CR_SSID_TTL) >= 0 ? Number(process.env.PI_CR_SSID_TTL) : 10_000;
const CONFIRM_BEFORE_RUN = process.env.PI_CR_CONFIRM === "1";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** `--model` 认的别名；其余必须长得像 claude-* */
const MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable", "opusplan", "default"];

// ---------------------------------------------------------------------------
// 1) 网络闸门：当前连的是不是 Variflight 无线网
// ---------------------------------------------------------------------------

type SsidProbe = { ssid: string | null; error: string | null };

let ssidCache: { at: number; probe: SsidProbe } | null = null;

/**
 * 起一个短命子进程读 SSID。
 *
 * 编码说明：Windows 上 netsh 按控制台代码页（中文机器是 GBK）输出，字段名与
 * "Variflight" 都是 ASCII，用 latin1 逐字节解码可以保证 ASCII 部分绝不被
 * UTF-8 解码器的替换字符吃掉（中文字段名会变乱码，但我们不读它们）。
 */
function runProbe(command: string, args: string[]): string | null {
  try {
    const r = spawnSync(command, args, {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "latin1",
    });
    if (r.error || r.status !== 0) return null;
    return typeof r.stdout === "string" ? r.stdout : null;
  } catch {
    return null;
  }
}

function probeSsidWindows(): SsidProbe {
  const out = runProbe("netsh", ["wlan", "show", "interfaces"]);
  if (out === null) return { ssid: null, error: "netsh wlan show interfaces 执行失败（WLAN 服务未启动或无无线网卡）" };
  // 只匹配行首缩进后紧跟 SSID 的那一行；"AP BSSID"/"BSSID" 因为行首是别的词不会命中。
  // 字段名 SSID 在各语言版本的 netsh 里都不翻译。
  for (const line of out.split(/\r?\n/)) {
    const m = /^[ \t]*SSID[ \t]*[:：][ \t]*(.*)$/.exec(line);
    if (m) {
      const ssid = m[1].trim();
      if (ssid) return { ssid, error: null };
    }
  }
  return { ssid: null, error: "无线网卡当前未连接到任何 SSID" };
}

function probeSsidDarwin(): SsidProbe {
  for (const dev of ["en0", "en1"]) {
    const out = runProbe("networksetup", ["-getairportnetwork", dev]);
    if (!out) continue;
    const m = /Current Wi-?Fi Network:\s*(.+)$/im.exec(out);
    if (m && m[1].trim()) return { ssid: m[1].trim(), error: null };
  }
  return { ssid: null, error: "networksetup 未报告任何已连接的 Wi-Fi 网络" };
}

function probeSsidLinux(): SsidProbe {
  const nm = runProbe("nmcli", ["-t", "-f", "active,ssid", "dev", "wifi"]);
  if (nm) {
    for (const line of nm.split(/\r?\n/)) {
      if (line.startsWith("yes:")) {
        const ssid = line.slice(4).trim();
        if (ssid) return { ssid, error: null };
      }
    }
  }
  const iw = runProbe("iwgetid", ["-r"]);
  if (iw && iw.trim()) return { ssid: iw.trim(), error: null };
  return { ssid: null, error: "nmcli / iwgetid 未报告任何已连接的 Wi-Fi 网络" };
}

function probeSsid(): SsidProbe {
  const now = Date.now();
  if (ssidCache && now - ssidCache.at < SSID_TTL_MS) return ssidCache.probe;
  let probe: SsidProbe;
  if (process.platform === "win32") probe = probeSsidWindows();
  else if (process.platform === "darwin") probe = probeSsidDarwin();
  else probe = probeSsidLinux();
  ssidCache = { at: now, probe };
  return probe;
}

type GateResult = { allowed: boolean; ssid: string | null; required: string | null; reason: string };

function checkNetworkGate(): GateResult {
  if (!REQUIRED_SSID) return { allowed: true, ssid: null, required: null, reason: "" }; // 显式关闭
  const { ssid, error } = probeSsid();
  if (!ssid) {
    return {
      allowed: false,
      ssid: null,
      required: REQUIRED_SSID,
      reason: `未检测到已连接的无线网络（${error ?? "原因未知"}）；本工具要求连接 "${REQUIRED_SSID}" 无线网后才能使用。`,
    };
  }
  if (ssid.toLowerCase() !== REQUIRED_SSID.toLowerCase()) {
    return {
      allowed: false,
      ssid,
      required: REQUIRED_SSID,
      reason: `当前无线网是 "${ssid}"，本工具只在连接 "${REQUIRED_SSID}" 无线网时可用。请切换网络后重试。`,
    };
  }
  return { allowed: true, ssid, required: REQUIRED_SSID, reason: "" };
}

// ---------------------------------------------------------------------------
// 2) 定位 claude 可执行文件
// ---------------------------------------------------------------------------

type SpawnSpec = { command: string; args: string[]; extraEnv: Record<string, string>; display: string };

function isExecutableFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** npm 全局装出来的是 claude.cmd（node 起不动 .cmd，也不想为它去过 cmd.exe 的引号地狱）→ 找它旁边的 cli.js */
function cliJsBesideShim(shim: string): string | null {
  const dir = path.dirname(shim);
  const candidates = [
    path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    path.join(dir, "..", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
  ];
  for (const c of candidates) if (isExecutableFile(c)) return path.resolve(c);
  return null;
}

function whichClaude(): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  const out = runProbe(finder, ["claude"]);
  if (!out) return null;
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim();
    if (p && isExecutableFile(p)) return p;
  }
  return null;
}

function resolveClaude(): SpawnSpec | { error: string } {
  const candidates: string[] = [];
  const override = process.env.PI_CR_CLAUDE_BIN?.trim();
  // 显式指定就必须用它：指错了要当场报错，绝不悄悄回退到 PATH 上的另一个 claude
  if (override) {
    if (!isExecutableFile(override)) return { error: `PI_CR_CLAUDE_BIN 指向的文件不存在或不是文件: ${override}` };
    candidates.push(override);
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    candidates.push(path.join(home, ".local", "bin", "claude.exe"));
    candidates.push(path.join(home, "AppData", "Local", "Programs", "claude", "claude.exe"));
  } else {
    candidates.push(path.join(home, ".local", "bin", "claude"));
    candidates.push("/usr/local/bin/claude", "/opt/homebrew/bin/claude");
  }
  const fromPath = whichClaude();
  if (fromPath) candidates.push(fromPath);

  for (const c of candidates) {
    if (!isExecutableFile(c)) continue;
    const ext = path.extname(c).toLowerCase();
    if (ext === ".cmd" || ext === ".bat" || ext === ".ps1") {
      const js = cliJsBesideShim(c);
      if (!js) {
        if (c === override) {
          return { error: `PI_CR_CLAUDE_BIN 指向的是脚本外壳 ${override}，但旁边找不到 @anthropic-ai/claude-code/cli.js；请改指向原生的 claude 可执行文件。` };
        }
        continue;
      }
      // 用当前进程的 node（在 Electron 里要显式切成 node 模式）直接跑 cli.js
      return {
        command: process.execPath,
        args: [js],
        extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
        display: `${process.execPath} ${js}`,
      };
    }
    return { command: c, args: [], extraEnv: {}, display: c };
  }

  if (override) return { error: `PI_CR_CLAUDE_BIN 指向的文件不可用: ${override}` };
  return {
    error:
      "找不到 claude 可执行文件。请先安装 Claude Code（native 版会装在 ~/.local/bin/claude），" +
      "或用 PI_CR_CLAUDE_BIN 环境变量指定绝对路径。",
  };
}

/**
 * 子进程环境：剥掉「宿主 Claude Code 会话」的标记变量。
 * 在 Claude Code 里开发 pi 时这些变量会被继承下去，子 claude 会以为自己是被宿主
 * 托管的会话、把 OAuth 刷新委托给一个并不存在的宿主，然后报鉴权失败。
 * ANTHROPIC_* 是用户自己的正经配置，保留不动。
 */
const HOST_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
];

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of HOST_SESSION_ENV) delete env[k];
  if (!extra.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  env.FORCE_COLOR = "0";
  return env;
}

// ---------------------------------------------------------------------------
// 3) git：范围解析与 diff 采集
// ---------------------------------------------------------------------------

type GitResult = { ok: boolean; stdout: string; stderr: string };

function git(cwd: string, args: string[]): GitResult {
  try {
    const r = spawnSync("git", args, {
      cwd,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 128 * 1024 * 1024,
      encoding: "utf8",
    });
    if (r.error) return { ok: false, stdout: "", stderr: r.error.message };
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

function repoRoot(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.stdout.trim() ? path.normalize(r.stdout.trim()) : null;
}

/** 没传 base 时的基线分支：origin/HEAD → origin/main → origin/master → main → master */
function detectBaseRef(cwd: string): string | null {
  const head = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", ref]).ok) return ref;
  }
  return null;
}

type ScopeName = "working" | "staged" | "branch" | "commit" | "files";

type Collected = {
  scope: ScopeName;
  label: string;
  base: string | null;
  commit: string | null;
  diff: string;
  stat: string;
  files: string[];
  untracked: string[];
  truncated: boolean;
  rawBytes: number;
};

function splitStatFiles(stat: string): string[] {
  const files: string[] = [];
  for (const line of stat.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s+\|\s+\d+/.exec(line);
    if (m) files.push(m[1].trim());
  }
  return files;
}

function truncateDiff(diff: string): { diff: string; truncated: boolean; rawBytes: number } {
  const rawBytes = Buffer.byteLength(diff, "utf8");
  if (rawBytes <= MAX_DIFF_BYTES) return { diff, truncated: false, rawBytes };
  // 按行截断，避免把一行 hunk 劈成半截
  const lines = diff.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const n = Buffer.byteLength(line, "utf8") + 1;
    if (used + n > MAX_DIFF_BYTES) break;
    kept.push(line);
    used += n;
  }
  return { diff: kept.join("\n"), truncated: true, rawBytes };
}

type CollectError = { error: string; code: string };

function collect(cwd: string, scope: ScopeName, opts: { base?: string; commit?: string; paths?: string[] }): Collected | CollectError {
  const paths = (opts.paths ?? []).filter((p) => typeof p === "string" && p.trim());
  const pathArgs = paths.length ? ["--", ...paths] : [];

  if (scope === "files") {
    if (!paths.length) return { code: "BAD_PARAM", error: 'scope="files" 必须同时给出 paths（要通读的文件列表）' };
    const missing = paths.filter((p) => !fs.existsSync(path.isAbsolute(p) ? p : path.join(cwd, p)));
    if (missing.length) return { code: "BAD_PARAM", error: `以下文件不存在: ${missing.join(", ")}` };
    // 整文件通读：不给 diff，让子进程用 Read 自己读（避免把大文件塞进提示词）
    return {
      scope,
      label: `通读文件：${paths.join(", ")}`,
      base: null,
      commit: null,
      diff: "",
      stat: "",
      files: paths,
      untracked: [],
      truncated: false,
      rawBytes: 0,
    };
  }

  let diffArgs: string[];
  let statArgs: string[];
  let label: string;
  let base: string | null = null;
  let commit: string | null = null;

  if (scope === "working") {
    diffArgs = ["diff", "HEAD", "--no-color"];
    statArgs = ["diff", "HEAD", "--stat", "--no-color"];
    label = "工作区相对 HEAD 的全部改动（已暂存 + 未暂存）";
  } else if (scope === "staged") {
    diffArgs = ["diff", "--cached", "--no-color"];
    statArgs = ["diff", "--cached", "--stat", "--no-color"];
    label = "已暂存（index）的改动";
  } else if (scope === "branch") {
    base = (opts.base ?? "").trim() || detectBaseRef(cwd) || "";
    if (!base) return { code: "BAD_PARAM", error: "无法确定基线分支，请显式传 base（例如 origin/main）" };
    if (!git(cwd, ["rev-parse", "--verify", "--quiet", base]).ok) return { code: "BAD_PARAM", error: `基线 ref 不存在: ${base}` };
    diffArgs = ["diff", `${base}...HEAD`, "--no-color"];
    statArgs = ["diff", `${base}...HEAD`, "--stat", "--no-color"];
    label = `当前分支相对 ${base} 的改动（三点 diff，从共同祖先算起）`;
  } else {
    commit = (opts.commit ?? "").trim();
    if (!commit) return { code: "BAD_PARAM", error: 'scope="commit" 必须同时给出 commit（提交号或 ref）' };
    if (!git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).ok) return { code: "BAD_PARAM", error: `提交不存在: ${commit}` };
    diffArgs = ["show", commit, "--no-color", "--format=medium"];
    statArgs = ["show", commit, "--stat", "--no-color", "--format=medium"];
    label = `单个提交 ${commit} 的改动`;
  }

  const d = git(cwd, [...diffArgs, ...pathArgs]);
  if (!d.ok) return { code: "GIT_FAILED", error: `git ${diffArgs.join(" ")} 失败: ${d.stderr.trim() || "未知错误"}` };
  const s = git(cwd, [...statArgs, ...pathArgs]);

  const untracked =
    scope === "working"
      ? git(cwd, ["ls-files", "--others", "--exclude-standard", ...pathArgs])
          .stdout.split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean)
      : [];

  const { diff, truncated, rawBytes } = truncateDiff(d.stdout);
  if (!diff.trim() && untracked.length === 0) {
    return { code: "NO_CHANGES", error: `${label} 里没有任何改动，无需审查${paths.length ? `（paths 过滤: ${paths.join(", ")}）` : ""}` };
  }

  return {
    scope,
    label: paths.length ? `${label}（限定路径: ${paths.join(", ")}）` : label,
    base,
    commit,
    diff,
    stat: s.ok ? s.stdout : "",
    files: splitStatFiles(s.ok ? s.stdout : ""),
    untracked,
    truncated,
    rawBytes,
  };
}

// ---------------------------------------------------------------------------
// 4) 输出契约：JSON Schema
// ---------------------------------------------------------------------------

/**
 * 全部字段都放进 required、不用 nullable：不同版本的结构化输出实现对「可选字段」
 * 的宽容度不一样，全必填 + 用空串/0 表示「没有」是兼容性最好的写法。
 */
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "verdict", "findings", "highlights", "followups"],
  properties: {
    summary: { type: "string", description: "整体结论，两三句话说清这份改动干了什么、风险在哪" },
    verdict: {
      type: "string",
      enum: ["approve", "comment", "request_changes"],
      description: "有 critical/high 问题填 request_changes；只有中低问题填 comment；没问题填 approve",
    },
    findings: {
      type: "array",
      description: "具体问题，按严重度从高到低排序；没有问题就给空数组",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "severity", "category", "title", "detail", "suggestion", "confidence"],
        properties: {
          file: { type: "string", description: "相对仓库根的文件路径" },
          line: { type: "integer", description: "改动后新文件里的行号；定位不到具体行填 0" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          category: {
            type: "string",
            enum: [
              "correctness",
              "security",
              "performance",
              "concurrency",
              "error-handling",
              "api-design",
              "maintainability",
              "testing",
              "style",
              "docs",
            ],
          },
          title: { type: "string", description: "一句话说清问题本身" },
          detail: { type: "string", description: "为什么是问题：触发条件 + 后果" },
          suggestion: { type: "string", description: "可直接采纳的改法；没有就填空字符串" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    highlights: { type: "array", description: "这份改动里做得好的地方；没有就给空数组", items: { type: "string" } },
    followups: { type: "array", description: "本次没深挖、建议后续跟进的点；没有就给空数组", items: { type: "string" } },
  },
};

// ---------------------------------------------------------------------------
// 5) 提示词
// ---------------------------------------------------------------------------

const DEFAULT_FOCUS = [
  "正确性：边界条件、空值/异常路径、并发与竞态、资源泄漏、错误被吞掉",
  "安全性：注入、路径穿越、凭证泄漏、越权、不受信输入直接落盘或执行",
  "契约一致性：改了签名/返回值/错误码后，调用方是否都跟上了",
  "可维护性：重复实现、该复用没复用、命名与既有代码风格不一致",
  "测试：新增/修改的分支有没有对应测试",
].join("\n- ");

function buildPrompt(repo: string, branch: string, c: Collected, instructions: string): string {
  const parts: string[] = [];

  parts.push("你是一名资深代码 reviewer。请对下面这份改动做一次严格、可执行的代码审查。");
  parts.push("");
  parts.push("## 仓库信息");
  parts.push(`- 仓库根目录: ${repo}`);
  parts.push(`- 当前分支: ${branch || "(未知)"}`);
  parts.push(`- 审查范围: ${c.label}`);
  if (c.files.length) parts.push(`- 变更文件数: ${c.files.length}`);

  parts.push("");
  parts.push("## 审查重点");
  parts.push(instructions.trim() ? instructions.trim() : `- ${DEFAULT_FOCUS}`);

  parts.push("");
  parts.push("## 工作方式");
  parts.push("- 你有 Read / Grep / Glob 和 git 的只读命令（diff / log / show / blame / status 等）。diff 里看不清的上下文，自己去仓库里读，不要靠猜。");
  parts.push("- 这是**只读审查**：不要修改、创建或删除任何文件，也不要运行会改状态的命令。");
  parts.push("- 报问题要能落到具体代码：给出文件路径和改动后新文件里的行号。定位不到具体某一行的（比如整文件级问题）行号填 0。");
  parts.push("- 只报你有把握的问题。不确定的写进 followups，不要当成 finding 凑数。");
  parts.push("- 不要输出纯风格偏好（除非项目里有明确规范被违反）。");
  parts.push("- 所有文本字段用简体中文。");

  if (c.scope === "files") {
    parts.push("");
    parts.push("## 要通读的文件");
    parts.push("本次没有 diff，请用 Read 完整读下列文件后逐个审查：");
    for (const f of c.files) parts.push(`- ${f}`);
  }

  if (c.stat.trim()) {
    parts.push("");
    parts.push("## 变更统计");
    parts.push("===== BEGIN STAT =====");
    parts.push(c.stat.trimEnd());
    parts.push("===== END STAT =====");
  }

  if (c.untracked.length) {
    parts.push("");
    parts.push("## 未跟踪的新文件（不在下面的 diff 里，请用 Read 自行读取后一并审查）");
    for (const f of c.untracked.slice(0, 100)) parts.push(`- ${f}`);
    if (c.untracked.length > 100) parts.push(`- ...（另有 ${c.untracked.length - 100} 个未列出）`);
  }

  if (c.diff.trim()) {
    parts.push("");
    parts.push("## 统一 diff");
    if (c.truncated) {
      parts.push(
        `注意：完整 diff 有 ${c.rawBytes} 字节，超过注入上限，下面只给了前 ${Buffer.byteLength(c.diff, "utf8")} 字节。` +
          "被截断的部分请自己用 git diff 按文件分批取。",
      );
    }
    parts.push("===== BEGIN DIFF =====");
    parts.push(c.diff.trimEnd());
    parts.push("===== END DIFF =====");
  }

  parts.push("");
  parts.push("## 输出要求");
  parts.push("审查完成后，**只输出一个 JSON 对象**，不要有任何前后缀说明、不要包代码块围栏。字段必须完全符合下面的 schema：");
  parts.push(JSON.stringify(REVIEW_SCHEMA, null, 2));

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 6) 跑 claude -p
// ---------------------------------------------------------------------------

/** 只读审查够用的工具集：不给 Write/Edit，Bash 只放行 git 查询类命令 */
const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
  "Bash(git blame:*)",
  "Bash(git rev-parse:*)",
  "Bash(git ls-files:*)",
  "Bash(git branch:*)",
];

type RunOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

function runClaude(
  spec: SpawnSpec,
  args: string[],
  prompt: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onTick: ((elapsedMs: number) => void) | undefined,
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(spec.command, [...spec.args, ...args], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: childEnv(spec.extraEnv),
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(ticker);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const kill = () => {
      try {
        child.kill();
      } catch {
        /* 进程可能已经退出 */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);

    const ticker = onTick
      ? setInterval(() => {
          if (!settled) onTick(Date.now() - started);
        }, 15_000)
      : (undefined as unknown as NodeJS.Timeout);

    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      /* 子进程提前退出时的 EPIPE，交给 close 事件处理 */
    });
    child.stdin.end(prompt, "utf8");

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(ticker);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code, sig) => finish({ code, signal: sig, stdout, stderr, timedOut, aborted }));
  });
}

/** stdout 里最后一个完整 JSON 对象就是 --output-format json 的结果信封 */
function parseEnvelope(stdout: string): any | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 前面可能混进了非 JSON 的行，往下逐行找 */
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object") return obj;
    } catch {
      /* 继续往上找 */
    }
  }
  return null;
}

/** 从文本里抠出第一个配平的 JSON 对象（模型没老实只输出 JSON 时的兜底） */
function extractJsonObject(text: string): any | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 结构化结果三级回退：structured_output → result 直接 parse → result 里抠 JSON */
function extractReview(envelope: any): any | null {
  const so = envelope?.structured_output;
  if (so && typeof so === "object" && !Array.isArray(so)) return so;
  const result = envelope?.result;
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* 落到抠取兜底 */
  }
  return extractJsonObject(result);
}

// ---------------------------------------------------------------------------
// 7) 扩展入口
// ---------------------------------------------------------------------------

function fail(code: string, message: string, extra?: Record<string, unknown>) {
  const payload = { ok: false, error: { code, message }, ...(extra ?? {}) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
    isError: true,
  };
}

export default function claudeCodeReview(pi: ExtensionAPI) {
  pi.registerTool({
    name: "claude_code_review",
    label: "代码审查 (Claude Code)",
    description:
      "把指定范围的代码改动交给一个独立的 Claude Code 子进程（claude -p 非交互模式）做代码审查，" +
      "返回结构化 JSON：整体结论 verdict、逐条 findings（文件/行号/严重度/类别/说明/改法）、亮点与后续跟进项。" +
      "子进程带只读工具（Read/Grep/Glob + git 查询命令）自行补上下文，不占用当前会话的上下文窗口。" +
      "默认模型 claude-opus-5、思考强度 xhigh，可用 model / effort 参数改。" +
      "限制：只有当前连接 Variflight 无线网时可用；审查是只读的，不会修改任何文件。",
    promptSnippet: "用独立的 Claude Code 子进程做代码审查，返回结构化 JSON 结论",
    promptGuidelines: [
      "当用户要求 review / 代码审查 / 检查改动有没有问题时，用 claude_code_review，不要自己读 diff 逐行评审。",
      "默认审 scope=\"working\"（工作区相对 HEAD 的改动）；要审整条分支用 scope=\"branch\"，审某次提交用 scope=\"commit\"。",
      "拿到结果后按 findings 的 severity 从高到低向用户复述，别把整份 JSON 原样贴出来。",
    ],
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["working", "staged", "branch", "commit", "files"],
          description:
            "审查范围：working=工作区相对 HEAD 的全部改动（默认）；staged=已暂存的改动；" +
            "branch=当前分支相对基线分支的改动；commit=某一次提交；files=通读指定文件（不看 diff）。",
        },
        repo: {
          type: "string",
          description: "仓库目录，默认当前工作目录。",
        },
        base: {
          type: "string",
          description: 'scope="branch" 时的基线 ref，如 origin/main。不传则自动探测 origin/HEAD → main → master。',
        },
        commit: {
          type: "string",
          description: 'scope="commit" 时要审的提交号或 ref。',
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            'working/staged/branch 下用作路径过滤；scope="files" 下是要通读的文件列表（必填）。路径相对仓库根。',
        },
        instructions: {
          type: "string",
          description: "额外的审查重点，自然语言描述。不传则用默认清单（正确性/安全/契约一致性/可维护性/测试）。",
        },
        model: {
          type: "string",
          description:
            "审查用的 Claude 模型，默认 claude-opus-5。可传别名（opus/sonnet/haiku/fable）或完整名（claude-*）。只接受 Claude 系模型。",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description: "思考强度，默认 xhigh。",
        },
        max_cost_usd: {
          type: "number",
          description: "本次审查的花费上限（美元）。不传则不设限。",
        },
      },
    },
    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: ExtensionContext,
    ) {
      // --- 闸门：必须连着 Variflight 无线网 ---
      const gate = checkNetworkGate();
      if (!gate.allowed) {
        return fail("NETWORK_GATE", gate.reason, { gate: { current_ssid: gate.ssid, required_ssid: gate.required } });
      }

      // --- 参数校验 ---
      const scope: ScopeName = (params?.scope ?? "working") as ScopeName;
      if (!["working", "staged", "branch", "commit", "files"].includes(scope)) {
        return fail("BAD_PARAM", `不认识的 scope: ${scope}`);
      }

      const effort = String(params?.effort ?? DEFAULT_EFFORT).trim();
      if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
        return fail("BAD_PARAM", `不认识的 effort: ${effort}（可选 ${EFFORT_LEVELS.join(" / ")}）`);
      }

      const model = String(params?.model ?? DEFAULT_MODEL).trim();
      if (!model) return fail("BAD_PARAM", "model 不能为空字符串");
      if (!MODEL_ALIASES.includes(model.toLowerCase()) && !/^claude-[a-z0-9._-]+$/i.test(model)) {
        return fail(
          "BAD_PARAM",
          `本工具只支持 Claude 模型，收到的是 "${model}"。可传别名（${MODEL_ALIASES.join(" / ")}）或 claude-* 完整名。`,
        );
      }

      const maxCost = Number(params?.max_cost_usd);
      if (params?.max_cost_usd !== undefined && (!Number.isFinite(maxCost) || maxCost <= 0)) {
        return fail("BAD_PARAM", "max_cost_usd 必须是正数");
      }

      // --- 定位仓库 ---
      const rawRepo = String(params?.repo ?? "").trim();
      const requested = rawRepo ? (path.isAbsolute(rawRepo) ? rawRepo : path.join(ctx.cwd, rawRepo)) : ctx.cwd;
      if (!fs.existsSync(requested)) return fail("BAD_PARAM", `目录不存在: ${requested}`);
      const root = repoRoot(requested);
      if (!root && scope !== "files") {
        return fail("NOT_A_REPO", `${requested} 不在任何 git 仓库里，无法取 diff（只想通读文件可以用 scope="files"）`);
      }
      const cwd = root ?? requested;
      const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();

      // --- 采集改动 ---
      const collected = collect(cwd, scope, {
        base: params?.base,
        commit: params?.commit,
        paths: Array.isArray(params?.paths) ? params.paths.map((p: unknown) => String(p)) : [],
      });
      if ("error" in collected) return fail(collected.code, collected.error);

      // --- 定位 claude ---
      const spec = resolveClaude();
      if ("error" in spec) return fail("CLI_MISSING", spec.error);

      // --- 可选确认（PI_CR_CONFIRM=1 时才弹） ---
      if (CONFIRM_BEFORE_RUN && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "确认发起 Claude Code 代码审查",
          [
            `仓库：${cwd}`,
            `范围：${collected.label}`,
            `模型：${model}　思考强度：${effort}`,
            `变更文件：${collected.files.length} 个，diff ${collected.rawBytes} 字节`,
            "",
            "该操作会起一个 Claude Code 子进程并产生 API 费用，是否继续？",
          ].join("\n"),
        );
        if (!ok) return fail("CANCELLED", "用户取消了本次代码审查，未发起请求");
      }

      // --- 组装命令行 ---
      const prompt = buildPrompt(cwd, branch, collected, String(params?.instructions ?? ""));
      const baseArgs = [
        "-p", // 非交互：读 stdin 的提示词，跑完即退
        "--output-format",
        "json",
        "--model",
        model,
        "--effort",
        effort,
        "--tools",
        "Bash,Read,Grep,Glob",
        "--allowedTools",
        ...ALLOWED_TOOLS,
        "--strict-mcp-config", // 审查用不上 MCP，别去连用户配的 server
      ];
      if (params?.max_cost_usd !== undefined) baseArgs.push("--max-budget-usd", String(maxCost));
      const withSchema = [...baseArgs, "--json-schema", JSON.stringify(REVIEW_SCHEMA)];

      const tick = (elapsedMs: number) => {
        try {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `正在用 ${model}（effort=${effort}）审查 ${collected.files.length} 个文件…已用时 ${Math.round(elapsedMs / 1000)}s`,
              },
            ],
            details: { phase: "running", elapsed_ms: elapsedMs, model, effort },
          });
        } catch {
          /* onUpdate 在 tool 结束后调用会被忽略，这里也不该炸 */
        }
      };

      const startedAt = Date.now();
      let outcome: RunOutcome;
      let schemaEnforced = true;
      try {
        outcome = await runClaude(spec, withSchema, prompt, cwd, signal, tick);
        // 老版本 CLI 不认 --json-schema：去掉重试一次，靠提示词里的输出契约兜底
        if (outcome.code !== 0 && /unknown option|unrecognized option/i.test(outcome.stderr) && /json-schema/i.test(outcome.stderr)) {
          schemaEnforced = false;
          outcome = await runClaude(spec, baseArgs, prompt, cwd, signal, tick);
        }
      } catch (e) {
        return fail("SPAWN_FAILED", `启动 claude 失败（${spec.display}）：${e instanceof Error ? e.message : String(e)}`);
      }

      const durationMs = Date.now() - startedAt;

      if (outcome.aborted) return fail("ABORTED", "代码审查已被取消");
      if (outcome.timedOut) {
        return fail("TIMEOUT", `代码审查超时（超过 ${TIMEOUT_MS} ms）。可以调大 PI_CR_TIMEOUT，或缩小审查范围。`);
      }

      const envelope = parseEnvelope(outcome.stdout);

      if (outcome.code !== 0 && !envelope) {
        const detail = (outcome.stderr.trim() || outcome.stdout.trim() || "无输出").slice(0, 1500);
        return fail("CLAUDE_FAILED", `claude 退出码 ${outcome.code}：${detail}`);
      }
      if (!envelope) {
        return fail("BAD_OUTPUT", `没能从 claude 的输出里解析出 JSON 信封：${outcome.stdout.slice(0, 1000) || "(空)"}`);
      }
      if (envelope.is_error) {
        return fail("CLAUDE_ERROR", `claude 报错：${String(envelope.result ?? envelope.subtype ?? "未知错误").slice(0, 1500)}`, {
          runner: { session_id: envelope.session_id ?? null, terminal_reason: envelope.terminal_reason ?? null },
        });
      }

      const review = extractReview(envelope);
      if (!review) {
        return fail(
          "BAD_OUTPUT",
          `claude 跑完了但没给出可解析的 JSON 审查结果。原始输出：${String(envelope.result ?? "").slice(0, 1500)}`,
          { runner: { session_id: envelope.session_id ?? null } },
        );
      }

      const findings = Array.isArray(review.findings) ? review.findings : [];
      const bySeverity: Record<string, number> = {};
      for (const f of findings) {
        const s = String(f?.severity ?? "unknown");
        bySeverity[s] = (bySeverity[s] ?? 0) + 1;
      }

      const payload = {
        ok: true,
        gate: { current_ssid: gate.ssid, required_ssid: gate.required },
        runner: {
          model,
          effort,
          schema_enforced: schemaEnforced,
          session_id: envelope.session_id ?? null,
          num_turns: envelope.num_turns ?? null,
          duration_ms: durationMs,
          total_cost_usd: envelope.total_cost_usd ?? null,
        },
        target: {
          repo: cwd,
          branch: branch || null,
          scope,
          label: collected.label,
          base: collected.base,
          commit: collected.commit,
          files_changed: collected.files.length,
          files: collected.files,
          untracked: collected.untracked,
          diff_bytes: collected.rawBytes,
          diff_truncated: collected.truncated,
        },
        stats: { findings_total: findings.length, by_severity: bySeverity },
        review,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
        isError: false,
      };
    },
  });

  // 诊断命令：闸门 / 可执行文件 / 默认参数一眼看全
  pi.registerCommand("claude-review", {
    description: "显示 Claude 代码审查工具的网络闸门状态、claude 可执行文件与默认模型/强度",
    handler: async (_args: unknown, cmdCtx: any) => {
      const gate = checkNetworkGate();
      const spec = resolveClaude();
      const lines: string[] = [];

      lines.push("【网络闸门】");
      if (!REQUIRED_SSID) {
        lines.push("  已通过 PI_CR_REQUIRED_SSID=\"\" 关闭闸门（任意网络均可用）");
      } else {
        const probe = probeSsid();
        lines.push(`  要求 SSID: ${REQUIRED_SSID}`);
        lines.push(`  当前 SSID: ${probe.ssid ?? `(未连接 — ${probe.error ?? "原因未知"})`}`);
        lines.push(`  状态: ${gate.allowed ? "通过，可用" : "不通过，工具会拒绝调用"}`);
      }

      lines.push("");
      lines.push("【claude 可执行文件】");
      lines.push("error" in spec ? `  不可用 — ${spec.error}` : `  ${spec.display}`);

      lines.push("");
      lines.push("【默认参数】");
      lines.push(`  模型: ${DEFAULT_MODEL}`);
      lines.push(`  思考强度: ${DEFAULT_EFFORT}`);
      lines.push(`  单次超时: ${TIMEOUT_MS} ms`);
      lines.push(`  diff 注入上限: ${MAX_DIFF_BYTES} 字节`);
      lines.push(`  调用前确认: ${CONFIRM_BEFORE_RUN ? "开（PI_CR_CONFIRM=1）" : "关"}`);

      cmdCtx.ui.notify(lines.join("\n"), gate.allowed ? "info" : "warning");
    },
  });
}
