/**
 * MCP Bridge for pi
 *
 * pi 原生不做 MCP。本扩展扮演 MCP 客户端:启动时连接 ~/.pi/agent/mcp.json 里配置的
 * MCP server,把它们的工具注册成 pi 自定义工具(命名 mcp__<server>__<tool>,沿用
 * Claude Code 的约定),LLM 即可直接调用。退出时关闭连接,避免孤儿子进程。
 *
 * 支持 transport: stdio / http(StreamableHTTP) / sse(已废弃,见下)。
 *
 * 协议版本(2026-07-28 起):
 *   MCP 2026-07-28 把协议改成了无状态(取消 initialize/initialized 握手与
 *   Mcp-Session-Id,改为每个请求在 _meta 里自带协议版本与客户端能力,能力发现走
 *   server/discover)。本扩展默认以 auto 模式连接:先用 server/discover 探测,探到
 *   新协议就走新协议,探不到就退回 2025 版 initialize 握手,新旧 server 都能连。
 *   用 PI_MCP_PROTOCOL / 单服 protocol 字段可改成 legacy 或钉死某个版本。
 *
 *   同版本还把服务端反向请求(elicitation / sampling / roots)换成了 MRTR
 *   (Multi Round-Trip Requests):server 返回 resultType:"input_required",客户端
 *   补上 inputResponses 重发原请求。SDK 会自动跑这套循环,并回调本扩展注册的
 *   elicitation 处理器 —— 即工具执行到一半要用户补参数/确认时,pi 会弹对话框
 *   (见 PI_MCP_ELICIT)。sampling / roots 已被官方标记废弃,本扩展不实现。
 *
 * 依赖(必须先装,否则 jiti 加载失败):
 *   在 ~/.pi/agent/extensions/ 目录执行:
 *     npm install @modelcontextprotocol/client        # SDK v2,支持 2026-07-28
 *   仍装着旧的 @modelcontextprotocol/sdk(v1.x)也能跑:自动回退,但只能连 2025 版
 *   协议的 server,且没有 elicitation 支持。
 *
 * 配置文件 ~/.pi/agent/mcp.json(或用 PI_MCP_CONFIG 指定其它路径):
 *   {
 *     "mcpServers": {
 *       "filesystem": { "type": "stdio", "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/My_work_byPi"] },
 *       "context7":   { "type": "http", "url": "https://mcp.context7.com/mcp" },
 *       "example-sse":{ "type": "sse",  "url": "https://example.com/sse",
 *         "headers": { "Authorization": "Bearer xxx" } }
 *     }
 *   }
 *   每个 server 可选字段:
 *     disabled: true   跳过该 server
 *     confirm:  true   调用该 server 的工具前弹确认(等价 PI_MCP_CONFIRM=all 的单服开关);
 *                      无 UI 可用时直接拒绝该次调用,不会为了不卡住而放行
 *     tools: { allow: ["toolA"] }  只注册白名单里的工具,其余不暴露给模型
 *     eager:    true   该 server 的工具默认激活(进上下文),不走惰性加载
 *     eager: ["toolA"]  仅指定工具默认激活,其余惰性加载
 *     env: {...}       stdio 子进程额外环境变量(只加这些,不再继承 pi 的完整环境)
 *     cwd: "<path>"    stdio 子进程工作目录
 *     headers: {...}   http/sse 请求头
 *     timeout: <ms>    该 server 的连接超时,覆盖全局默认 15s
 *     protocol: "auto" | "legacy" | "2026-07-28"   该 server 的协议版本策略,覆盖
 *                      PI_MCP_PROTOCOL;auto=先探测再决定,legacy=只用 2025 版握手,
 *                      写具体日期=钉死该版本(连不上就报错,不回退)
 *
 * agent-config 注册表叠加(mcp.json 里可选的 "agentConfig" 块):
 *   除 mcpServers 外,桥接默认还会叠加全局 @local/agent-config 的 MCP 注册表:
 *   注册表里的服务按 id 覆盖同名 mcpServers 条目(transport 由 materialize 现算,
 *   带上 tools.allow),policy.retired 列出的 id 则直接删掉。
 *   {
 *     "agentConfig": {
 *       "enabled": false,             // 关掉叠加,只用 mcpServers(默认开)
 *       "configDir": "<path>",        // 注册表目录,默认 AGENT_CONFIG_HOME 或 ~/.agent-config
 *       "target": "pi",               // 取哪个 agent 的视图,默认 pi
 *       "confirm": ["<id>"],          // 这些服务强制调用前确认
 *       "eager":    { "<id>": true }, // 覆盖惰性加载,取值同上面的 eager 字段
 *       "timeout":  { "<id>": 30000 },
 *       "protocol": { "<id>": "legacy" }
 *     }
 *   }
 *   @local/agent-config 是全局 npm 包,不在扩展目录的解析路径上,按各平台的全局
 *   node_modules 顺序查找(AGENT_CONFIG_MCP_MODULE 可钉死 src/mcp.mjs 的绝对路径);
 *   找不到就跳过叠加,只加载 mcp.json,并在启动日志里说明。
 *
 * 开关(环境变量):
 *   PI_MCP_CONFIG=<path>     覆盖 mcp.json 路径
 *   PI_MCP_CONFIRM=all       所有 MCP 工具调用前都确认(默认仅 server 自带 confirm:true 才确认)
 *   PI_MCP_INSTRUCTIONS=0    不把各 server 的 instructions 注入 system prompt(默认注入)
 *   PI_MCP_TIMEOUT=<ms>      每个 server 的连接超时,默认 15000;超时记为失败,不阻塞启动
 *   PI_MCP_LAZY=0            关闭惰性加载,所有 MCP 工具开机即激活(旧行为)
 *   PI_MCP_PROTOCOL=<mode>   全局协议策略,默认 auto;可填 legacy 或 2026-07-28 这样的版本号
 *   PI_MCP_ELICIT=0          关闭 elicitation:server 中途要用户补参数时直接拒绝(默认弹框询问)
 *   PI_MCP_ELICIT_TIMEOUT=<ms>  单个 elicitation 对话框的超时,默认 120000
 *
 * 惰性加载(默认开):
 *   所有 MCP 工具照旧注册,但默认不激活(不进上下文);仅保留加载器工具
 *   mcp_search_tools 常驻。模型需要某能力时调 mcp_search_tools 搜索并自动激活命中工具,
 *   pi 在下一次请求才把新工具定义补进去(支持 native deferred loading 的模型不破坏前缀缓存)。
 *   可用 /mcp-load <server|工具名> 手动激活。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function off(v: string | undefined): boolean {
  return v === "0" || v?.toLowerCase() === "false" || v?.toLowerCase() === "no";
}

// 借 Claude Code normalizeNameForMCP:压进 API 允许的安全字符集
function norm(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function piToolName(server: string, tool: string): string {
  return `mcp__${norm(server)}__${norm(tool)}`;
}

function configPath(): string {
  return process.env.PI_MCP_CONFIG || path.join(os.homedir(), ".pi", "agent", "mcp.json");
}

// ---------------------------------------------------------------------------
// @local/agent-config 的定位
//
// agent-config 是全局安装的 npm 包(`npm i -g`),不在 ~/.pi/agent/extensions/ 的
// 模块解析路径上,裸 specifier 解析不到,所以按固定顺序探测各平台的全局
// node_modules 目录再动态 import —— 与 electron/features/dashboard.js 里
// findAgentConfigMcpFile() 完全同一套顺序,两边看到的注册表必须一致。
// AGENT_CONFIG_MCP_MODULE 可直接钉死 mcp.mjs 的绝对路径(装在非常规位置时用)。
// 找不到就返回 null,桥接退回“只读 mcp.json”,不影响已有 mcpServers。
// ---------------------------------------------------------------------------

const AGENT_CONFIG_MCP_REL = path.join("@local", "agent-config", "src", "mcp.mjs");

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findAgentConfigMcpFile(): string | null {
  const pinned = process.env.AGENT_CONFIG_MCP_MODULE?.trim();
  if (pinned) return isFile(pinned) ? pinned : null;
  const dirs: string[] = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  if (process.env.npm_config_prefix) {
    dirs.push(path.join(process.env.npm_config_prefix, "node_modules"));
    dirs.push(path.join(process.env.npm_config_prefix, "lib", "node_modules"));
  }
  dirs.push("/usr/local/lib/node_modules");
  dirs.push(path.join(os.homedir(), ".npm-global", "lib", "node_modules"));
  dirs.push(path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules"));
  for (const dir of dirs) {
    const full = path.join(dir, AGENT_CONFIG_MCP_REL);
    if (isFile(full)) return full;
  }
  return null;
}

type AgentConfigMcp = {
  resolveMcp: (dir: string, opts: { target: string; workspace: string }) => any;
  materializeMcpService: (dir: string, id: string, opts: Record<string, any>) => any;
};

// undefined = 还没找过;null = 找不到/加载失败;对象 = 已加载
let agentConfigMcpMod: AgentConfigMcp | null | undefined = undefined;

async function loadAgentConfigMcp(): Promise<AgentConfigMcp | null> {
  if (agentConfigMcpMod !== undefined) return agentConfigMcpMod;
  const file = findAgentConfigMcpFile();
  if (!file) {
    agentConfigMcpMod = null;
    return null;
  }
  try {
    agentConfigMcpMod = (await import(pathToFileURL(file).href)) as AgentConfigMcp;
  } catch {
    agentConfigMcpMod = null;
  }
  return agentConfigMcpMod;
}

type BridgeConfig = {
  agentConfig?: {
    enabled?: boolean;
    configDir?: string;
    target?: string;
    confirm?: string[];
    eager?: Record<string, boolean | string[]>;
    timeout?: Record<string, number>;
    protocol?: Record<string, string>;
  };
  mcpServers?: Record<string, any>;
};

function loadBridgeConfig(): BridgeConfig {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as BridgeConfig;
  } catch (e) {
    throw new Error(`mcp.json 解析失败 (${p}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

function applyLocalPolicy(cfg: any, serviceId: string, bridge: BridgeConfig): any {
  const ac = bridge.agentConfig ?? {};
  const out = { ...cfg };
  if (ac.confirm?.includes(serviceId)) out.confirm = true;
  if (ac.eager && Object.hasOwn(ac.eager, serviceId)) out.eager = ac.eager[serviceId];
  if (ac.timeout && Number(ac.timeout[serviceId]) > 0) out.timeout = Number(ac.timeout[serviceId]);
  if (ac.protocol?.[serviceId]) out.protocol = ac.protocol[serviceId];
  return out;
}

async function loadServers(
  workspace: string,
  sessionId: string,
  notes: string[],
): Promise<Record<string, any>> {
  const bridge = loadBridgeConfig();
  const servers: Record<string, any> = { ...(bridge.mcpServers ?? {}) };
  if (bridge.agentConfig?.enabled === false) return servers;

  const mod = await loadAgentConfigMcp();
  if (!mod) {
    notes.push("未找到全局 @local/agent-config,本次只加载 mcp.json 里的 mcpServers。");
    return servers;
  }

  const dir = path.resolve(
    bridge.agentConfig?.configDir ||
      process.env.AGENT_CONFIG_HOME ||
      path.join(os.homedir(), ".agent-config"),
  );
  const target = bridge.agentConfig?.target || "pi";
  const contract = mod.resolveMcp(dir, { target, workspace });
  if (contract.kind !== "agent-config/mcp-integration" || contract.contractVersion !== 1) {
    throw new Error("agent-config MCP contract version/kind is unsupported");
  }
  if (contract.readyToPasteIntoClientConfig !== false) {
    throw new Error("agent-config MCP contract unexpectedly claims native client compatibility");
  }

  for (const retired of contract.policy?.retired ?? []) delete servers[retired];
  for (const service of contract.services ?? []) {
    const materialized = mod.materializeMcpService(dir, service.id, {
      workspace,
      env: process.env,
      session: { id: sessionId },
    });
    const native = {
      ...materialized.transport,
      ...(materialized.tools ? { tools: materialized.tools } : {}),
    };
    servers[service.id] = applyLocalPolicy(native, service.id, bridge);
  }
  return servers;
}

// ---------------------------------------------------------------------------
// SDK 装载:优先 v2(@modelcontextprotocol/client,支持 2026-07-28),
// 回退 v1(@modelcontextprotocol/sdk,只有 2025 版协议)
// ---------------------------------------------------------------------------

type Sdk = {
  v2: boolean;
  Client: any;
  StdioClientTransport: any;
  SSEClientTransport: any;
  StreamableHTTPClientTransport: any;
  note?: string; // 回退原因,启动时提示用户
};

async function loadSdk(): Promise<Sdk> {
  let v2Error = "";
  try {
    const core: any = await import("@modelcontextprotocol/client");
    const stdio: any = await import("@modelcontextprotocol/client/stdio");
    return {
      v2: true,
      Client: core.Client,
      SSEClientTransport: core.SSEClientTransport,
      StreamableHTTPClientTransport: core.StreamableHTTPClientTransport,
      StdioClientTransport: stdio.StdioClientTransport,
    };
  } catch (e) {
    v2Error = e instanceof Error ? e.message : String(e);
  }
  // 旧安装:@modelcontextprotocol/sdk v1.x
  const idx: any = await import("@modelcontextprotocol/sdk/client/index.js");
  const stdio: any = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const sse: any = await import("@modelcontextprotocol/sdk/client/sse.js");
  const http: any = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  return {
    v2: false,
    Client: idx.Client,
    StdioClientTransport: stdio.StdioClientTransport,
    SSEClientTransport: sse.SSEClientTransport,
    StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
    note:
      `MCP: 未加载到 SDK v2(@modelcontextprotocol/client),已回退旧版 SDK —— ` +
      `只能连 2025 版协议的 server,且不支持 elicitation。原因: ${v2Error}`,
  };
}

function makeTransport(sdk: Sdk, cfg: any): any {
  const type = cfg.type ?? "stdio";
  if (type === "http") {
    const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
    return new sdk.StreamableHTTPClientTransport(new URL(cfg.url), opts as any);
  }
  if (type === "sse") {
    const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
    return new sdk.SSEClientTransport(new URL(cfg.url), opts as any);
  }
  // 默认 stdio。不 spread process.env:SDK 内部会自动合并 getDefaultEnvironment()
  //(PATH 等安全子集)+ 下面的 env(stdio.js:67-69)。塞完整 process.env 会把 pi 的
  // 全部环境(含任何密钥)泄露给每个 MCP 子进程,正好抵消 SDK 的过滤。
  return new sdk.StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env,
    cwd: cfg.cwd,
  });
}

// 协议策略字符串 → SDK 的 versionNegotiation 选项。
// auto=探测(新旧都连);legacy=只走 2025 版握手;YYYY-MM-DD=钉死该版本。
const PROTOCOL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function negotiationOf(raw: unknown): { mode: any } | undefined {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return undefined;
  if (v === "auto") return { mode: "auto" };
  if (v === "legacy" || v === "2025") return { mode: "legacy" };
  if (PROTOCOL_DATE.test(v)) return { mode: { pin: v } };
  return undefined; // 认不出来 → 交给调用方用默认值
}

// MCP CallToolResult.content → pi 工具结果 content
// text/image 真透传(pi ImageContent = {type:"image",data,mimeType},与 MCP image 块一致);
// resource 块取内嵌文本或图片;audio 等 pi 暂不支持的类型降级为文本摘要。
type OutBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function mapContent(res: any): { content: OutBlock[]; isError: boolean } {
  const blocks = Array.isArray(res?.content) ? res.content : [];
  const out: OutBlock[] = [];
  for (const c of blocks) {
    if (c?.type === "text") {
      out.push({ type: "text", text: String(c.text ?? "") });
    } else if (c?.type === "image" && typeof c.data === "string") {
      out.push({ type: "image", data: c.data, mimeType: c.mimeType ?? "image/png" });
    } else if (c?.type === "resource" && c.resource) {
      const r = c.resource;
      if (typeof r.text === "string") {
        out.push({ type: "text", text: r.text });
      } else if (typeof r.blob === "string" && typeof r.mimeType === "string" && r.mimeType.startsWith("image/")) {
        out.push({ type: "image", data: r.blob, mimeType: r.mimeType });
      } else {
        out.push({ type: "text", text: `[resource ${r.uri ?? ""}] ${JSON.stringify(r).slice(0, 2000)}` });
      }
    } else {
      out.push({ type: "text", text: `[${c?.type ?? "non-text"}] ${JSON.stringify(c).slice(0, 2000)}` });
    }
  }
  return {
    content: out.length ? out : [{ type: "text", text: "(empty result)" }],
    isError: res?.isError === true,
  };
}

// v2 的无 cursor listTools() 自己走完所有分页;v1 要手动翻。两边都靠 nextCursor 收敛。
async function listAllTools(client: any): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const page: any = await client.listTools(cursor ? { cursor } : undefined);
    if (Array.isArray(page?.tools)) all.push(...page.tools);
    cursor = page?.nextCursor;
  } while (cursor);
  return all;
}

// ---------------------------------------------------------------------------
// elicitation(2026-07-28 起由 MRTR 承载:工具执行到一半回来问用户)
// ---------------------------------------------------------------------------

// 单选枚举的两种写法:{enum:[...], enumNames?:[...]} / {oneOf:[{const,title}]}
function singleChoices(schema: any): { value: string; label: string }[] | undefined {
  if (Array.isArray(schema?.oneOf)) {
    return schema.oneOf.map((o: any) => ({ value: String(o?.const ?? ""), label: String(o?.title ?? o?.const ?? "") }));
  }
  if (Array.isArray(schema?.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((v: any, i: number) => ({ value: String(v), label: String(names[i] ?? v) }));
  }
  return undefined;
}

// 多选枚举:{type:"array", items:{enum:[...]}} / {type:"array", items:{anyOf:[{const,title}]}}
function multiChoices(schema: any): { value: string; label: string }[] | undefined {
  if (schema?.type !== "array") return undefined;
  const items = schema.items ?? {};
  if (Array.isArray(items.anyOf)) {
    return items.anyOf.map((o: any) => ({ value: String(o?.const ?? ""), label: String(o?.title ?? o?.const ?? "") }));
  }
  if (Array.isArray(items.enum)) {
    return items.enum.map((v: any) => ({ value: String(v), label: String(v) }));
  }
  return undefined;
}

function fieldLabel(key: string, schema: any): string {
  const title = String(schema?.title ?? "").trim() || key;
  const desc = String(schema?.description ?? "").trim();
  return desc && desc !== title ? `${title} — ${desc}` : title;
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

type ToolEntry = { server: string; tool: string; client: any; confirm: boolean; eager: boolean };
type ServerInfo = {
  name: string;
  type: string;
  ok: boolean;
  toolCount: number;
  error?: string;
  era?: string; // "modern"(2026-07-28+)/"legacy"(2025 版握手)
  protocol?: string; // 协商出来的协议版本号
};

const LOADER_TOOL = "mcp_search_tools";

// server.eager 字段解析:true=整服;数组=指定工具名(原始 MCP 名);其余=false
function isEager(cfg: any, toolName: string): boolean {
  const e = cfg?.eager;
  if (e === true) return true;
  if (Array.isArray(e)) return e.includes(toolName);
  return false;
}

export default async function (pi: ExtensionAPI) {
  const clients: any[] = [];
  const registry = new Map<string, ToolEntry>(); // pi 工具名 -> 调用信息
  const serverInfos: ServerInfo[] = [];
  const instructionsBlocks: { server: string; text: string }[] = [];
  const startupLog: string[] = [];
  const confirmAll = process.env.PI_MCP_CONFIRM?.toLowerCase() === "all";
  const lazy = !off(process.env.PI_MCP_LAZY); // 默认开启惰性加载
  const elicitEnabled = !off(process.env.PI_MCP_ELICIT); // 默认允许 server 中途问用户
  const elicitTimeout = Number(process.env.PI_MCP_ELICIT_TIMEOUT) > 0 ? Number(process.env.PI_MCP_ELICIT_TIMEOUT) : 120000;
  // 全局协议策略:默认 auto(先探测,新旧 server 都能连)
  const defaultNegotiation = negotiationOf(process.env.PI_MCP_PROTOCOL) ?? { mode: "auto" };

  // 最近可用的 ctx(session_start 与每次 execute 都会刷新),两处要用:
  // ① elicitation 在工具执行中途弹 UI,而 Client 上的处理器拿不到当次调用的 ctx;
  // ② refreshStatus 在运行时刷新状态栏(激活数实时反映当前真正激活的 MCP 工具)。
  let uiCtx: ExtensionContext | undefined;

  let sdk: Sdk;
  try {
    sdk = await loadSdk();
    if (sdk.note) startupLog.push(sdk.note);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `MCP 桥接未启用: 找不到 MCP 客户端 SDK。请在 ~/.pi/agent/extensions/ 执行 ` +
            `npm install @modelcontextprotocol/client\n原因: ${msg}`,
          "warning",
        );
      }
    });
    return;
  }

  let servers: Record<string, any> = {};
  try {
    // One fresh ID per Pi conversation, stable for the lifetime of this extension instance.
    // PI_SESSION_ID is injected by Pi; the fallback covers hosts that do not expose it.
    const sessionId = process.env.PI_SESSION_ID || crypto.randomUUID();
    servers = await loadServers(process.cwd(), sessionId, startupLog);
  } catch (e) {
    startupLog.push(e instanceof Error ? e.message : String(e));
  }

  // 每个 server 的连接超时(ms):PI_MCP_TIMEOUT 全局 / server.timeout 单服 / 默认 15s
  const defaultTimeoutMs = Number(process.env.PI_MCP_TIMEOUT) > 0 ? Number(process.env.PI_MCP_TIMEOUT) : 15000;

  async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // MCP elicitation/create → pi 对话框。无 UI(headless)或被关掉时一律 decline,
  // 绝不静默编造回答;用户中途取消必填项则整个 elicitation 记为 cancel。
  async function handleElicit(server: string, params: any): Promise<any> {
    const ctx = uiCtx;
    if (!elicitEnabled || !ctx?.hasUI) return { action: "decline" };
    const dialog = { timeout: elicitTimeout };
    const message = String(params?.message ?? "").trim();

    // URL 模式:让用户去浏览器里完成,回来点确认
    if (params?.mode === "url" && params?.url) {
      const ok = await ctx.ui.confirm(
        `MCP ${server} 需要你在浏览器中完成操作`,
        `${message}\n${params.url}\n完成后点确认,放弃点取消。`,
        dialog,
      );
      return { action: ok ? "accept" : "cancel" };
    }

    const props: Record<string, any> = params?.requestedSchema?.properties ?? {};
    const required = new Set<string>(params?.requestedSchema?.required ?? []);
    const keys = Object.keys(props);
    if (keys.length === 0) {
      const ok = await ctx.ui.confirm(`MCP ${server} 请求确认`, message || "(无说明)", dialog);
      return { action: ok ? "accept" : "decline", content: {} };
    }
    if (message) ctx.ui.notify(`MCP ${server}: ${message}`, "info");

    const content: Record<string, any> = {};
    for (const key of keys) {
      const schema = props[key] ?? {};
      const label = fieldLabel(key, schema);
      const isRequired = required.has(key);
      const title = `MCP ${server}: ${label}${isRequired ? "" : "(可选)"}`;

      // 多选
      const multi = multiChoices(schema);
      if (multi) {
        const DONE = "✓ 完成选择";
        const picked: string[] = [];
        const max = Number(schema?.maxItems) > 0 ? Number(schema.maxItems) : Infinity;
        while (picked.length < max) {
          const rest = multi.filter((c) => !picked.includes(c.value));
          if (rest.length === 0) break;
          const ans = await ctx.ui.select(`${title} — 已选 ${picked.length}`, [...rest.map((c) => c.label), DONE], dialog);
          if (ans === undefined) return { action: "cancel" };
          if (ans === DONE) break;
          const hit = rest.find((c) => c.label === ans);
          if (hit) picked.push(hit.value);
        }
        const min = Number(schema?.minItems) > 0 ? Number(schema.minItems) : (isRequired ? 1 : 0);
        if (picked.length < min) return { action: "cancel" };
        if (picked.length > 0 || isRequired) content[key] = picked;
        continue;
      }

      // 单选
      const single = singleChoices(schema);
      if (single) {
        const ans = await ctx.ui.select(title, single.map((c) => c.label), dialog);
        if (ans === undefined) {
          if (isRequired) return { action: "cancel" };
          continue;
        }
        const hit = single.find((c) => c.label === ans);
        if (hit) content[key] = hit.value;
        continue;
      }

      // 布尔
      if (schema?.type === "boolean") {
        content[key] = await ctx.ui.confirm(title, String(schema?.description ?? "确认?"), dialog);
        continue;
      }

      // 数字 / 字符串:数字最多重试 3 次,免得一个笔误就把整次调用废掉
      const numeric = schema?.type === "number" || schema?.type === "integer";
      const hint = schema?.default !== undefined ? `默认 ${schema.default}` : numeric ? "输入数字" : "";
      let tries = 0;
      while (true) {
        const raw = await ctx.ui.input(title, hint, dialog);
        if (raw === undefined) {
          if (isRequired) return { action: "cancel" };
          break;
        }
        const text = raw.trim();
        if (!text) {
          if (schema?.default !== undefined) {
            content[key] = schema.default;
            break;
          }
          if (isRequired) return { action: "cancel" };
          break;
        }
        if (!numeric) {
          content[key] = text;
          break;
        }
        const num = Number(text);
        if (Number.isFinite(num) && (schema.type !== "integer" || Number.isInteger(num))) {
          content[key] = num;
          break;
        }
        if (++tries >= 3) return { action: "cancel" };
        ctx.ui.notify(`「${text}」不是合法的${schema.type === "integer" ? "整数" : "数字"},请重输`, "warning");
      }
    }
    return { action: "accept", content };
  }

  async function connectServer(server: string, cfg: any): Promise<void> {
    const type = cfg?.type ?? "stdio";
    if (cfg?.disabled) {
      serverInfos.push({ name: server, type, ok: false, toolCount: 0, error: "disabled" });
      return;
    }
    if (type === "sse") {
      startupLog.push(`MCP ${server}: sse 传输已在 2026-07-28 中标记废弃,建议改成 "type": "http"(Streamable HTTP)`);
    }
    const negotiation = negotiationOf(cfg?.protocol) ?? defaultNegotiation;
    if (cfg?.protocol && !negotiationOf(cfg.protocol)) {
      startupLog.push(`MCP ${server}: 认不出 protocol="${cfg.protocol}",已按 ${JSON.stringify(negotiation.mode)} 处理(可填 auto / legacy / 2026-07-28)`);
    }
    const client = new sdk.Client(
      { name: "pi-mcp-bridge", version: "0.2.0" },
      sdk.v2
        ? {
            // 只声明真正实现了的能力(sampling / roots 已被 2026-07-28 标记废弃,不实现)
            capabilities: elicitEnabled ? { elicitation: {} } : {},
            versionNegotiation: negotiation,
            // MRTR:server 返回 input_required 时,SDK 自动回调下面的处理器并重发原请求
            inputRequired: { autoFulfill: true, maxRounds: 4 },
          }
        : { capabilities: {} },
    );
    if (sdk.v2 && elicitEnabled) {
      client.setRequestHandler("elicitation/create", async (request: any) => handleElicit(server, request?.params ?? request));
    }
    const ms = Number(cfg?.timeout) > 0 ? Number(cfg.timeout) : defaultTimeoutMs;
    try {
      // 加超时:任一 server 挂起也不会卡死 pi 启动(工厂被 pi await)
      await withTimeout(client.connect(makeTransport(sdk, cfg)), ms, `连接 ${server}`);
      clients.push(client);

      // server 自报的 instructions(若有)→ 收集,稍后注入 system prompt
      const serverInstr = (client.getInstructions?.() as string | undefined) ?? undefined;
      if (serverInstr && serverInstr.trim()) {
        instructionsBlocks.push({ server, text: `## ${server}\n${serverInstr.trim()}` });
      }

      const needsConfirm = confirmAll || cfg?.confirm === true;
      const tools = await withTimeout(listAllTools(client), ms, `列出 ${server} 工具`);
      const allow = Array.isArray(cfg?.tools?.allow) ? new Set<string>(cfg.tools.allow) : undefined;
      let registered = 0;
      for (const t of tools) {
        if (allow && !allow.has(t.name)) continue;
        const name = piToolName(server, t.name);
        if (registry.has(name)) {
          startupLog.push(`跳过重名工具 ${name}(来自 ${server})`);
          continue;
        }
        registry.set(name, { server, tool: t.name, client, confirm: needsConfirm, eager: isEager(cfg, t.name) });
        pi.registerTool({
          name,
          label: `${server}: ${t.name}`,
          description: t.description ?? t.name,
          // pi-ai 校验双路径支持纯 JSON Schema(validation.js),MCP inputSchema 原样可用
          parameters: t.inputSchema ?? { type: "object", properties: {} },
          async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
            if (ctx) uiCtx = ctx; // elicitation 要用当次调用的 UI
            try {
              const opts = signal ? { signal } : undefined;
              // v2 的 callTool 是 (params, options);v1 中间还夹着一个 resultSchema
              const res = sdk.v2
                ? await client.callTool({ name: t.name, arguments: params ?? {} }, opts)
                : await client.callTool({ name: t.name, arguments: params ?? {} }, undefined, opts);
              return mapContent(res);
            } catch (e) {
              return {
                content: [{ type: "text", text: `MCP 调用失败 (${server}/${t.name}): ${e instanceof Error ? e.message : String(e)}` }],
                isError: true,
              };
            }
          },
        });
        registered++;
      }
      serverInfos.push({
        name: server,
        type,
        ok: true,
        toolCount: registered,
        era: client.getProtocolEra?.(),
        protocol: client.getNegotiatedProtocolVersion?.(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      serverInfos.push({ name: server, type, ok: false, toolCount: 0, error: msg });
      startupLog.push(`MCP ${server} 连接失败: ${msg}`);
      try { await client.close(); } catch { /* ignore */ }
    }
  }

  // 并行连接所有 server(allSettled:任一失败/超时不影响其它,也不阻塞 pi 启动)
  await Promise.allSettled(Object.entries(servers).map(([server, cfg]) => connectServer(server, cfg)));

  // -------------------------------------------------------------------------
  // 惰性加载:注册加载器工具 + 计算初始激活集
  // -------------------------------------------------------------------------

  const allMcpNames = () => [...registry.keys()];
  const eagerNames = () => allMcpNames().filter((n) => registry.get(n)!.eager);
  // 惰性隐藏的工具集合(需要靠 mcp_search_tools / mcp-load 激活)
  const lazyNames = () => (lazy ? allMcpNames().filter((n) => !registry.get(n)!.eager) : []);

  // 当前真正激活的 MCP 工具数(含运行时被 mcp_search_tools / mcp-load 动态激活的);
  // 不含 loader 工具,因为它不在 registry 里
  const activeMcpCount = () => pi.getActiveTools().filter((n) => registry.has(n)).length;

  // 重算并刷新状态栏。激活数为实时值,惰性 = 总数 - 激活;非惰性模式沿用简洁文案
  function refreshStatus(): void {
    if (!uiCtx?.hasUI) return;
    const serverCount = serverInfos.filter((s) => s.ok).length;
    const total = registry.size;
    const active = activeMcpCount();
    const status = lazy
      ? `MCP: ${serverCount} server / ${total} tools (${active} 激活, ${total - active} 惰性)`
      : `MCP: ${serverCount} server / ${total} tools`;
    uiCtx.ui.setStatus("mcp", status);
  }

  // 纯新增地激活一批工具名,返回真正新加的名字
  function activate(names: string[]): string[] {
    const active = pi.getActiveTools();
    const added = names.filter((n) => registry.has(n) && !active.includes(n));
    if (added.length > 0) {
      pi.setActiveTools([...new Set([...active, ...added])]);
      refreshStatus(); // 动态激活后立即刷新状态栏计数
    }
    return added;
  }

  // 关键词匹配:在工具名 + 描述里打分
  function searchTools(query: string, limit: number): string[] {
    const terms = query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
    if (terms.length === 0) return [];
    return [...registry.entries()]
      .map(([name, e]) => {
        const hay = `${name} ${e.server} ${e.tool} ${pi.getAllTools().find((t) => t.name === name)?.description ?? ""}`.toLowerCase();
        const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
        return { name, score };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((m) => m.name);
  }

  if (lazy && registry.size > 0) {
    pi.registerTool({
      name: LOADER_TOOL,
      label: "MCP: search tools",
      description:
        "Search for and enable additional MCP tools that are not currently active. " +
        "Use this whenever a task needs a capability (e.g. email, calendar, web search, database) " +
        "that the currently active tools cannot perform. Pass a natural-language query describing " +
        "the capability; matching tools are activated and become callable on the next step.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要查找的能力或任务,如 'send email'、'日历日程'、'search web'" },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "最多激活多少个工具,默认 5" },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: any) {
        const query = String(params?.query ?? "").trim();
        const limit = Number(params?.limit) > 0 ? Math.min(Number(params.limit), 20) : 5;
        if (!query) {
          return { content: [{ type: "text", text: "query 不能为空" }], details: {}, isError: true };
        }
        const matches = searchTools(query, limit);
        if (matches.length === 0) {
          const hint = [...registry.keys()].slice(0, 30).join(", ");
          return {
            content: [{ type: "text", text: `未找到匹配 "${query}" 的 MCP 工具。\n已注册的工具(部分): ${hint}` }],
            details: { matches: [] },
          };
        }
        const added = activate(matches);
        const text = added.length > 0
          ? `已激活工具: ${added.join(", ")}\n现在可直接调用它们。`
          : `匹配的工具已处于激活状态: ${matches.join(", ")}`;
        return { content: [{ type: "text", text }], details: { matches, added } };
      },
    });
  }

  // 计算并应用初始激活集:剔除所有惰性 MCP 工具,保留内置/其它扩展工具 + eager 工具 + 加载器
  function applyInitialActive() {
    if (!lazy || registry.size === 0) return;
    const hidden = new Set(lazyNames());
    const base = pi.getActiveTools().filter((n) => !hidden.has(n));
    const keep = [...base, ...eagerNames(), LOADER_TOOL];
    pi.setActiveTools([...new Set(keep)]);
  }

  // 启动后把连接结果反馈给用户(工厂里没有 ctx,放到 session_start)
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    uiCtx = ctx;
    applyInitialActive();
    const ok = serverInfos.filter((s) => s.ok);
    const total = registry.size;
    const lazyCount = lazyNames().length;
    if (ctx.hasUI) {
      refreshStatus(); // 初始激活数(= eager 数),之后动态激活会实时更新
      if (ok.length > 0) {
        const modern = ok.filter((s) => s.era === "modern").length;
        const era = sdk.v2 && modern > 0 ? `,其中 ${modern} 个走 2026-07-28 新协议` : "";
        const msg = lazy
          ? `MCP 已桥接 ${ok.length} 个 server,共 ${total} 个工具(${lazyCount} 个惰性加载,需时由 ${LOADER_TOOL} 激活)${era}`
          : `MCP 已桥接 ${ok.length} 个 server,共 ${total} 个工具${era}`;
        ctx.ui.notify(msg, "info");
      }
      for (const line of startupLog) ctx.ui.notify(line, "warning");
    }
  });

  // 注入各 server 的 instructions(默认开,PI_MCP_INSTRUCTIONS=0 关)
  pi.on("before_agent_start", async (event) => {
    if (off(process.env.PI_MCP_INSTRUCTIONS) || instructionsBlocks.length === 0) return undefined;
    // 惰性模式下只注入「至少有一个工具已激活」的 server 的 instructions,避免未激活 server 白占上下文
    let blocks = instructionsBlocks;
    if (lazy) {
      const active = new Set(pi.getActiveTools());
      const activeServers = new Set(
        [...registry.entries()].filter(([n]) => active.has(n)).map(([, e]) => e.server),
      );
      blocks = instructionsBlocks.filter((b) => activeServers.has(b.server));
    }
    if (blocks.length === 0) return undefined;
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n# MCP Server Instructions\n` +
        `The following MCP servers provided usage instructions for their tools:\n\n` +
        blocks.map((b) => b.text).join("\n\n"),
    };
  });

  // 确认闸门:对需要确认的 mcp__ 工具,调用前弹确认;无 UI 时拒绝,不能绕过权限策略。
  pi.on("tool_call", async (event, ctx) => {
    const entry = registry.get(event.toolName);
    if (!entry || !entry.confirm) return undefined;
    if (!ctx.hasUI) return { block: true, reason: `MCP 工具 ${event.toolName} 需要交互确认,当前模式无可用 UI。` };
    const preview = JSON.stringify(event.input ?? {}).slice(0, 300);
    const okToRun = await ctx.ui.confirm(
      `运行 MCP 工具 ${entry.server}/${entry.tool}?`,
      `参数: ${preview}`,
    );
    if (!okToRun) {
      return { block: true, reason: `用户取消了 MCP 工具 ${event.toolName} 的调用。` };
    }
    return undefined;
  });

  // 退出时关闭所有连接(对应 CC 的 cleanup,杀掉 stdio 子进程)
  pi.on("session_shutdown", async () => {
    for (const c of clients) {
      try { await c.close(); } catch { /* ignore */ }
    }
  });

  pi.registerCommand("mcp", {
    description: "列出已桥接的 MCP server 与工具",
    handler: async (_args, ctx) => {
      const lines: string[] = [
        `配置文件: ${configPath()}`,
        `SDK: ${sdk.v2 ? "@modelcontextprotocol/client v2(支持 2026-07-28)" : "@modelcontextprotocol/sdk v1(仅 2025 版协议)"}` +
          `  协议策略: ${JSON.stringify(defaultNegotiation.mode)}` +
          `  elicitation: ${sdk.v2 && elicitEnabled ? "开" : "关"}`,
        "",
      ];
      if (serverInfos.length === 0) {
        lines.push("(mcp.json 未配置任何 server)");
      } else {
        for (const s of serverInfos) {
          const proto = s.ok && s.protocol ? ` ${s.protocol}${s.era === "modern" ? " (stateless)" : ""}` : "";
          lines.push(`${s.ok ? "✓" : "✗"} ${s.name} [${s.type}${proto}] — ${s.ok ? `${s.toolCount} tools` : s.error}`);
          if (s.ok) {
            const active = new Set(pi.getActiveTools());
            for (const [name, e] of registry) {
              if (e.server !== s.name) continue;
              const state = active.has(name) ? "●激活" : "○惰性";
              lines.push(`    ${state} ${name}${e.confirm ? "  (需确认)" : ""}`);
            }
          }
        }
      }
      if (lazy) lines.push("", `提示: 惰性工具由模型调 ${LOADER_TOOL} 自动激活,或用 /mcp-load <server|工具名> 手动激活。`);
      ctx.ui.notify(lines.join("\n"), serverInfos.some((s) => !s.ok && s.error !== "disabled") ? "warning" : "info");
    },
  });

  // 手动激活:/mcp-load <server|完整工具名|关键词> — 把匹配的惰性工具加入激活集
  pi.registerCommand("mcp-load", {
    description: "激活惰性加载的 MCP 工具: /mcp-load <server名|完整工具名|关键词>",
    handler: async (args, ctx) => {
      const arg = (Array.isArray(args) ? args.join(" ") : String(args ?? "")).trim();
      if (!arg) {
        ctx.ui.notify(`用法: /mcp-load <server名|完整工具名|关键词>\n例: /mcp-load wecom-mail  或  /mcp-load all`, "info");
        return;
      }
      let targets: string[];
      if (arg === "all") {
        targets = allMcpNames();
      } else if (registry.has(arg)) {
        targets = [arg];
      } else {
        // 先按 server 名完全匹配,否则当关键词搜索
        const byServer = allMcpNames().filter((n) => registry.get(n)!.server === arg);
        targets = byServer.length > 0 ? byServer : searchTools(arg, 20);
      }
      if (targets.length === 0) {
        ctx.ui.notify(`未找到匹配 "${arg}" 的 MCP 工具`, "warning");
        return;
      }
      const added = activate(targets);
      ctx.ui.notify(
        added.length > 0 ? `已激活: ${added.join(", ")}` : `匹配的工具已处于激活状态: ${targets.join(", ")}`,
        "info",
      );
    },
  });
}
