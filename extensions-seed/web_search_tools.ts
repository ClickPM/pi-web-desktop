/**
 * Web Search for pi —— 通用联网搜索插件
 *
 * 本扩展注册五个互补的联网搜索工具，agent 应根据实际任务需要和成本选择：
 *
 *  1) `web_search`            —— 默认首选、**免费**。走 CPA（CLIProxyAPI）的
 *     **Responses API**（/v1/responses，stream=true 流式接收）携带内置 web_search 工具，
 *     返回“带来源的 prose 答案”。适合要一句话结论 / 已综合好的回答，也是日常默认入口。
 *
 *  2) `google_search`          —— 与 1) 并列的免费首选，走的是 **Google 后端**。
 *     调 CPA 的 **Chat Completions**（/v1/chat/completions，stream=true）并携带 Gemini 原生
 *     grounding 工具 `tools: [{"google_search": {}}]`，由 Google 服务端自动检索、抓取、
 *     合成证据后**一次往返**直接返回成品答案（Server-side Grounding，无需客户端工具循环）。
 *     强特征模型会带出 vertexaisearch 签名重定向链接，是真调通 Google 搜索后端的最强证据。
 *     与 1) 后端不同（Google vs OpenAI），关键结论可互相印证；通常本工具更快。
 *
 *  3) `perplexity_search`      —— **收费 $0.005/次**（仅按请求次数，无 token 费）。
 *     直连 Perplexity **Search API**（https://api.perplexity.ai/search，POST），
 *     返回“结构化 ranked results”（title / url / snippet / date），不做 LLM 综述。
 *     适合要多条真实来源 URL、按域名/语言/地区过滤、多角度检索。
 *
 *  4) `perplexity_pro_search`  —— **收费 $0.008/次 + Sonar Pro token 费**，最贵。
 *     走 Perplexity **Sonar Pro 聊天补全**（/chat/completions，流式 + search_type=pro），
 *     模型自动多步检索 + 抓取页面内容后生成“带引用的深度 prose 答案”。
 *     仅在需要多步推理、复杂跨源综合时才用；简单查询不要用它（贵且慢）。
 *     每次调用前必须由用户在确认对话框中明确同意；无交互 UI 时默认阻止。
 *
 *  5) `perplexity_async_sonar` —— **收费、真异步、最重**。走 Perplexity 官方异步接口
 *     POST /v1/async/sonar 提交任务、GET /v1/async/sonar/{id} 轮询取结果。默认模型
 *     `sonar-deep-research`（深度研究，token 费明显更贵；该异步接口仅接受此模型）。
 *     适合要跨大量来源、可能跑几分钟到十几分钟的长任务；服务端排队执行，客户端只
 *     轮询，不怕断连。日常搜索用 1)/2)，多步推理用 4)，仅真正需要深度调研才用本工具。
 *     每次调用（包括 probe_only）前必须由用户在确认对话框中明确同意；无交互 UI 时默认阻止。
 *
 * pi 引擎不原生支持服务端 web_search（provider 切 openai-responses 也只是聊天，
 * 不会自动注入 tools:[{web_search}]），所以这里用自定义工具补齐能力。
 *
 * === 凭证来源 ===
 * web_search / google_search：读 ~/.pi/agent/models.json 里**已配置的 provider**
 *   （默认 `cliproxy-dmit`）的 apiKey + baseURL —— 不新增密钥、不硬编码。
 * perplexity_search / perplexity_pro_search / perplexity_async_sonar：优先读环境变量 PERPLEXITY_API_KEY；
 *   若无，则回退读 models.json 里名为 `perplexity` 的 provider 的 apiKey。
 * apiKey 三态：字面量 / `!shell命令`(取 stdout) / 环境变量名（与 pi 自身一致）。
 *
 * === 可选环境变量 ===
 *   VF_WEB_SEARCH_PROVIDER      models.json 里用作凭证来源的 provider 名，默认 "cliproxy-dmit"
 *   VF_WEB_SEARCH_MODEL         web_search 调用的模型，默认 "gpt-5.6-luna"
 *   VF_WEB_SEARCH_TIMEOUT       web_search 流式搜索【总时长上限】(ms)，默认 600000（10 分钟）
 *   VF_WEB_SEARCH_IDLE_TIMEOUT  web_search 流式【空闲超时】(ms)，默认 90000：
 *                               超过该时长未收到任何 SSE 事件才判定卡死。只要服务端持续
 *                               推事件（web_search 各阶段/文本增量），就不会被掐断。
 *   VF_GOOGLE_SEARCH_MODEL      google_search 默认模型，默认 "gemini-3.8-flash-high"
 *                               （必须是 owned_by=antigravity 的 Gemini 文本模型；
 *                               claude-* / gpt-oss-* / *-image 在本网关不通 grounding）
 *   VF_GOOGLE_SEARCH_TIMEOUT    google_search 流式【总时长上限】(ms)，默认 300000（5 分钟）
 *   VF_GOOGLE_SEARCH_IDLE_TIMEOUT google_search 流式【空闲超时】(ms)，默认 90000
 *   PERPLEXITY_API_KEY          Perplexity 密钥（search / pro search / async sonar 共用，首选来源）
 *   PERPLEXITY_PROVIDER         models.json 里 Perplexity 凭证兜底的 provider 名，默认 "perplexity"
 *   PERPLEXITY_BASE_URL         Perplexity API base，默认 "https://api.perplexity.ai"
 *   PERPLEXITY_SEARCH_TIMEOUT   perplexity_search 单次超时(ms)，默认 90000
 *   PERPLEXITY_PRO_MODEL        pro search 用的 Sonar 模型，默认 "sonar-pro"
 *   PERPLEXITY_PRO_TIMEOUT      pro search 流式【总时长上限】(ms)，默认 600000（10 分钟）
 *   PERPLEXITY_PRO_IDLE_TIMEOUT pro search 流式【空闲超时】(ms)，默认 180000（多步推理较慢）
 *   PERPLEXITY_ASYNC_MODEL      async sonar 模型，默认 "sonar-deep-research"（该接口仅此模型）
 *   PERPLEXITY_ASYNC_MAX_WAIT   async 轮询【总时长上限】(ms)，默认 900000（15 分钟）
 *   PERPLEXITY_ASYNC_POLL_INTERVAL async 轮询间隔(ms)，默认 5000
 *
 * === 2026-07-27 改造说明 ===
 * web_search 由「一次性 POST + 90s 硬超时」改为「stream=true 流式 SSE 接收 +
 * 空闲/总时长双计时器」。原因：网关侧 web_search + 综合常超过 90s（实测 114s），旧的
 * 单次硬超时必然掐断；流式下服务端持续推事件，只需对“无数据”设限。注意：网关的
 * Responses background 模式（POST 返回 queued 后 GET /v1/responses/{id} 轮询）已实测
 * 不可用——GET 被网关鉴权拦截（401），故未采用。
 * 同日 perplexity_pro_search 也从单一 180s 硬超时改为同款空闲/总时长双计时器；
 * 并新增第四个工具 perplexity_async_sonar（走 Perplexity 官方 async 接口，已实测联通）。
 * 异步接口硬编码用 /v1/async/sonar（与同步 /chat/completions 旧根不同），且实测仅接受
 * sonar-deep-research 模型（传 sonar 会被 400 invalid_model 拒）。
 *
 * === 2026-09-07 新增 google_search（探针实测结论，勿凭猜测改动） ===
 * 在 CPA /v1/chat/completions 上对 4 种触发写法做过 A/B 对照，只有一种真正联网：
 *   ✅ tools: [{"google_search": {}}]      —— Gemini 原生 grounding，网关直接透传给
 *      Google 上游。实测 gemini-3.1-flash-lite 拿到真实当天日期与 vertexaisearch 签名
 *      重定向链接；同一模型在同一时刻的其他三种写法全部答成知识截止期的旧闻。
 *   ❌ 不传 tools、只在 prompt 里写“请联网搜索”—— 模型无联网通道，直接编造过期内容
 *      （实测答成 2024-05 的旧新闻，且自带看似合理的 BBC 链接，极具迷惑性）。
 *   ❌ tools: [{"type": "web_search"}]     —— 网关不把 OpenAI 专有格式映射到 Gemini 上游，
 *      不报错、静默退化成离线作答，同样编造旧闻。这是最危险的一种失败。
 *   ⚠️ tools: [{"type":"function", …}]     —— 视模型而定：gemini-3.8-flash-high 会返回
 *      finish_reason=tool_calls 要客户端自己去搜；flash-lite 则直接离线编造。都不是联网。
 * 因此本工具**硬编码** tools: [{ google_search: {} }]，不接受外部覆盖这个字段。
 *
 * 模型分层（同一时刻同一问题实测；只有 owned_by=antigravity 的 Gemini 文本模型可用）：
 *   带签名链接：gemini-3.1-flash-lite、gemini-3.8-flash-high
 *   有实时事实、给常规媒体 URL：gemini-pro-agent、gemini-3.1-pro-low、gemini-3.7-flash-high、
 *     gemini-3-flash、gemini-3.6-flash-high
 *   零搜索（必须拦掉）：claude-sonnet-4-6 / claude-opus-4-6-thinking（自陈无联网能力）、
 *     gpt-oss-120b-medium（吐 harmony 伪 tool-call 标记冒充搜索）、
 *     gemini-3.1-flash-image（日期对、正文和链接是编的，还自曝“此为模拟链接”）。
 *   owned_by=openai 的那批（gpt-5.x / gpt-6 / codex-*）同样不吃 google_search，会直接说
 *     自己无法联网——网关只对 antigravity 侧做 grounding 透传。它们要联网请走 web_search。
 *
 * 取源指令必须放在 **user 轮**，不能放 system：同一问题下把“请给出来源 URL”写进 system
 * 时实测返回 0 条链接，追加到 user 消息末尾则稳定拿到签名链接 + 真实媒体 URL。
 * 故 doGoogleSearch 把 CITE_HINT 拼在 user 内容后面，不发 system 消息。
 *
 * 无外部依赖（只用 node 内置 + 全局 fetch），不需要 npm install。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = process.env.VF_WEB_SEARCH_PROVIDER || "cliproxy-dmit";
const MODEL = process.env.VF_WEB_SEARCH_MODEL || "gpt-5.6-luna";
// web_search（流式）：总时长上限 + 空闲超时（详见头部注释）
const TOTAL_TIMEOUT_MS = Number(process.env.VF_WEB_SEARCH_TIMEOUT) > 0 ? Number(process.env.VF_WEB_SEARCH_TIMEOUT) : 600_000;
const IDLE_TIMEOUT_MS = Number(process.env.VF_WEB_SEARCH_IDLE_TIMEOUT) > 0 ? Number(process.env.VF_WEB_SEARCH_IDLE_TIMEOUT) : 90_000;
// google_search（Gemini 原生 grounding，流式）：同款双计时器。Google 侧是服务端单轮闭环，
// 实测 flash 系 1~13s、pro 系 30~40s，故总时长上限给 5 分钟即可，不必像 Responses 那样给 10 分钟。
const GS_MODEL = process.env.VF_GOOGLE_SEARCH_MODEL || "gemini-3.8-flash-high";
const GS_TOTAL_TIMEOUT_MS = Number(process.env.VF_GOOGLE_SEARCH_TIMEOUT) > 0 ? Number(process.env.VF_GOOGLE_SEARCH_TIMEOUT) : 300_000;
const GS_IDLE_TIMEOUT_MS = Number(process.env.VF_GOOGLE_SEARCH_IDLE_TIMEOUT) > 0 ? Number(process.env.VF_GOOGLE_SEARCH_IDLE_TIMEOUT) : 90_000;
// perplexity_search 单次超时（默认 90s，结构化搜索本身很快）
const PPLX_SEARCH_TIMEOUT_MS = Number(process.env.PERPLEXITY_SEARCH_TIMEOUT) > 0 ? Number(process.env.PERPLEXITY_SEARCH_TIMEOUT) : 90_000;
// Pro Search（流式）：同样用「总时长上限 + 空闲超时」双计时器，只要服务端持续推事件就不掐断
const PRO_TIMEOUT_MS = Number(process.env.PERPLEXITY_PRO_TIMEOUT) > 0 ? Number(process.env.PERPLEXITY_PRO_TIMEOUT) : 600_000;
const PRO_IDLE_TIMEOUT_MS = Number(process.env.PERPLEXITY_PRO_IDLE_TIMEOUT) > 0 ? Number(process.env.PERPLEXITY_PRO_IDLE_TIMEOUT) : 180_000;

// Perplexity Search API 相关
const PPLX_PROVIDER = process.env.PERPLEXITY_PROVIDER || "perplexity";
const PPLX_BASE_URL = (process.env.PERPLEXITY_BASE_URL || "https://api.perplexity.ai").replace(/\/+$/, "");
// Perplexity Pro Search（Sonar Pro 聊天补全）相关
const PPLX_PRO_MODEL = process.env.PERPLEXITY_PRO_MODEL || "sonar-pro";
// Perplexity 异步 Sonar（/v1/async/sonar）相关
const PPLX_ASYNC_MODEL = process.env.PERPLEXITY_ASYNC_MODEL || "sonar-deep-research";
// 异步轮询：总时长上限（默认 15 分钟）与轮询间隔（默认 5s）
const PPLX_ASYNC_MAX_WAIT_MS = Number(process.env.PERPLEXITY_ASYNC_MAX_WAIT) > 0 ? Number(process.env.PERPLEXITY_ASYNC_MAX_WAIT) : 900_000;
const PPLX_ASYNC_POLL_INTERVAL_MS = Number(process.env.PERPLEXITY_ASYNC_POLL_INTERVAL) > 0 ? Number(process.env.PERPLEXITY_ASYNC_POLL_INTERVAL) : 5_000;

function modelsConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "models.json");
}

// 解析 apiKey：字面量 / "!shell命令"(取 stdout) / 环境变量名
function resolveApiKey(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  if (raw.startsWith("!")) {
    try { return execSync(raw.slice(1), { encoding: "utf8" }).trim() || null; } catch { return null; }
  }
  if (/^[A-Z_][A-Z0-9_]*$/.test(raw) && process.env[raw]) return process.env[raw]!;
  return raw; // 字面量
}

type Creds = { baseURL: string; apiKey: string };

function readProviderCreds(): Creds | { error: string } {
  const p = modelsConfigPath();
  if (!fs.existsSync(p)) return { error: `models.json 不存在: ${p}` };
  let cfg: any;
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return { error: `models.json 解析失败: ${e instanceof Error ? e.message : String(e)}` }; }
  const prov = cfg?.providers?.[PROVIDER];
  if (!prov) return { error: `models.json 里未找到 provider "${PROVIDER}"（请先在 Models 配置里添加）` };
  const apiKey = resolveApiKey(prov.apiKey);
  if (!apiKey) return { error: `provider "${PROVIDER}" 未配置可用的 apiKey` };
  const rawBase = prov.baseURL || prov.baseUrl || prov.base_url || "https://aigateway.variflight.com/api";
  const baseURL = String(rawBase).replace(/\/+$/, "");
  return { baseURL, apiKey };
}

// 兼容 models.json 的 baseURL 两种常见写法：以 /v1 结尾，或只写服务根路径。
function responsesUrl(baseURL: string): string {
  return /\/v1$/i.test(baseURL) ? `${baseURL}/responses` : `${baseURL}/v1/responses`;
}

// Responses API 输出抽取：output[] 里 message 项的 content[].output_text 拼接
function extractText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const out = Array.isArray(data?.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.join("\n").trim();
}

// 流式搜索：POST /v1/responses (stream=true)，SSE 事件驱动。
// 双计时器：收到任何数据块就重置空闲计时；总时长为硬上限。解决旧版一次性请求
// 90s 硬超时下，网关长搜索（>90s）必然失败的问题。
async function doSearch(query: string, creds: Creds, signal?: AbortSignal): Promise<string> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  let abortCause: "idle" | "total" | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { abortCause = "idle"; ctrl.abort(); }, IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => { abortCause = "total"; ctrl.abort(); }, TOTAL_TIMEOUT_MS);
  resetIdle();

  try {
    const res = await fetch(responsesUrl(creds.baseURL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ model: MODEL, tools: [{ type: "web_search" }], input: `联网搜索。${query}`, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`CPA 网关 HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    // 网关若忽略 stream 参数返回普通 JSON，按旧逻辑解析（优雅降级）
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      const data = await res.json();
      return extractText(data) || "(无搜索结果)";
    }
    if (!res.body) throw new Error("流式响应无 body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";              // output_text.delta 累计（兜底）
    let finalResponse: any = null; // response.completed 携带的完整响应（优先用它抽取）
    let failed: string | null = null;

    const handleEvent = (jsonStr: string) => {
      if (!jsonStr || jsonStr === "[DONE]") return;
      let evt: any;
      try { evt = JSON.parse(jsonStr); } catch { return; }
      const type = evt?.type;
      if (type === "response.output_text.delta" && typeof evt.delta === "string") answer += evt.delta;
      else if (type === "response.completed") finalResponse = evt.response ?? null;
      else if (type === "response.failed") failed = evt?.response?.error?.message || "服务端处理失败";
      else if (type === "response.incomplete") failed = `响应不完整: ${evt?.response?.incomplete_details?.reason || "unknown"}`;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle(); // 收到数据块 = 服务端存活，重置空闲计时
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("data:")) handleEvent(t.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith("data:")) handleEvent(buffer.trim().slice(5).trim());

    if (failed) throw new Error(failed);
    if (finalResponse) return extractText(finalResponse) || answer.trim() || "(无搜索结果)";
    return answer.trim() || "(无搜索结果)";
  } catch (e) {
    if ((e as any)?.name === "AbortError" && abortCause) {
      if (abortCause === "idle") {
        throw new Error(`搜索超时：${Math.round(IDLE_TIMEOUT_MS / 1000)} 秒内网关未推送任何数据（空闲超时），可调大 VF_WEB_SEARCH_IDLE_TIMEOUT`);
      }
      throw new Error(`搜索超时：总时长超过 ${Math.round(TOTAL_TIMEOUT_MS / 1000)} 秒上限，可调大 VF_WEB_SEARCH_TIMEOUT`);
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// ============================================================================
// Google Search（Gemini 原生 Server-side Grounding，走 CPA 的 Chat Completions）
// ============================================================================

// 实测跑通 grounding 的模型。不在表里的模型仍允许调用，只是会在结果尾注里标为“未经验证”，
// 免得网关上了新模型后被这份名单卡死。
const GS_VERIFIED_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash-high",
  "gemini-3-flash",
  "gemini-3.6-flash-high",
  "gemini-3.1-pro-low",
  "gemini-pro-agent",
];

// 实测**不通** grounding 的模型：网关只把 google_search 透传给 owned_by=antigravity 的
// Gemini 文本模型，其余模型传了也白传——运气好的明确拒答（claude-* / gpt-5.x / gpt-6），
// 运气差的静默编造带链接的旧闻假闻（gpt-oss-* 吐 harmony 伪 tool-call 标记，
// gemini-*-image 连“此为模拟链接”都写出来了）。后一种比拒答危险得多，故一律拦掉。
const GS_BLOCKED_MODEL = /^claude-|^gpt-oss-|^gpt-image|^gpt-5|^gpt-6|^codex-|image$/i;

// 取源指令。必须拼在 user 轮末尾——同样一句话放进 system 消息，实测来源链接会整体消失。
const GS_CITE_HINT = "\n\n请在回答末尾列出你实际引用的来源 URL（保留原始链接，不要编造、不要改写）。";

// 兼容 models.json 的 baseURL 两种写法（以 /v1 结尾，或只写服务根路径）。
function chatCompletionsUrl(baseURL: string): string {
  return /\/v1$/i.test(baseURL) ? `${baseURL}/chat/completions` : `${baseURL}/v1/chat/completions`;
}

type GoogleSearchOutcome = { answer: string; signedLinks: number; ms: number };

// 流式发起一次 Google grounding 搜索。与 doSearch 同款双计时器（收到数据块重置空闲计时，
// 总时长为硬上限）。tools 字段硬编码，不开放覆盖——其他写法实测都不联网。
async function doGoogleSearch(
  query: string,
  model: string,
  creds: Creds,
  signal?: AbortSignal,
): Promise<GoogleSearchOutcome> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  let abortCause: "idle" | "total" | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { abortCause = "idle"; ctrl.abort(); }, GS_IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => { abortCause = "total"; ctrl.abort(); }, GS_TOTAL_TIMEOUT_MS);
  resetIdle();
  const t0 = Date.now();

  try {
    const res = await fetch(chatCompletionsUrl(creds.baseURL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: "user", content: query + GS_CITE_HINT }],
        tools: [{ google_search: {} }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`CPA 网关 HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    let answer = "";
    let toolCalls = 0;
    let failed: string | null = null;

    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream") || !res.body) {
      // 网关忽略 stream 参数时的降级路径
      const data: any = await res.json().catch(() => null);
      const msg = data?.choices?.[0]?.message ?? {};
      if (typeof msg.content === "string") answer = msg.content;
      if (Array.isArray(msg.tool_calls)) toolCalls = msg.tool_calls.length;
      if (data?.error) failed = data.error.message || String(data.error);
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleEvent = (jsonStr: string) => {
        if (!jsonStr || jsonStr === "[DONE]") return;
        let evt: any;
        try { evt = JSON.parse(jsonStr); } catch { return; }
        if (evt?.error) { failed = evt.error.message || String(evt.error); return; }
        const choice = evt?.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string") answer += delta;
        // 非增量式网关会把整段 content 塞在 message 里，取更长的那份
        const whole = choice?.message?.content;
        if (typeof whole === "string" && whole.length > answer.length) answer = whole;
        if (Array.isArray(choice?.delta?.tool_calls)) toolCalls += choice.delta.tool_calls.length;
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle(); // 收到数据块 = 服务端存活
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith("data:")) handleEvent(t.slice(5).trim());
        }
      }
      if (buffer.trim().startsWith("data:")) handleEvent(buffer.trim().slice(5).trim());
    }

    if (failed) throw new Error(failed);
    answer = answer.trim();
    // 模型只丢回 tool_calls 声明 = 它把 google_search 当成了要客户端代跑的函数，并没有联网。
    if (!answer && toolCalls > 0) {
      throw new Error(
        `模型 ${model} 未走服务端 grounding，只返回了 ${toolCalls} 个 tool_calls 声明（本网关不会替你执行搜索）。` +
          `请改用已验证的模型，如 ${GS_VERIFIED_MODELS[0]}。`,
      );
    }
    return {
      answer: answer || "(无搜索结果)",
      signedLinks: (answer.match(/grounding-api-redirect\//g) || []).length,
      ms: Date.now() - t0,
    };
  } catch (e) {
    if ((e as any)?.name === "AbortError" && abortCause) {
      if (abortCause === "idle") {
        throw new Error(`Google 搜索超时：${Math.round(GS_IDLE_TIMEOUT_MS / 1000)} 秒内网关未推送任何数据（空闲超时），可调大 VF_GOOGLE_SEARCH_IDLE_TIMEOUT`);
      }
      throw new Error(`Google 搜索超时：总时长超过 ${Math.round(GS_TOTAL_TIMEOUT_MS / 1000)} 秒上限，可调大 VF_GOOGLE_SEARCH_TIMEOUT`);
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// 给答案追加一行取证尾注：签名重定向链接是“真调通 Google 后端”的最强证据；没有它并不等于
// 造假（多数 grounded 模型直接给媒体原始 URL），但足够提示 agent 对关键结论再核一次。
function groundingFootnote(model: string, out: GoogleSearchOutcome): string {
  const verified = GS_VERIFIED_MODELS.includes(model) ? "" : "；该模型未在本扩展中验证过 grounding，结论请谨慎采信";
  const evidence = out.signedLinks > 0
    ? `含 ${out.signedLinks} 条 Google 签名重定向链接（vertexaisearch），确认已走 Google 搜索后端`
    : "未出现 Google 签名重定向链接（grounded 模型常直接给媒体原始 URL，属正常现象）；关键结论请核实链接可访问";
  return `\n\n———\n〔google_search｜模型 ${model}｜${(out.ms / 1000).toFixed(1)}s〕${evidence}${verified}。`;
}

// ============================================================================
// Perplexity Search API
// ============================================================================

// 读取 Perplexity apiKey：优先环境变量 PERPLEXITY_API_KEY，其次 models.json 里
// 名为 PPLX_PROVIDER 的 provider（沿用三态 resolveApiKey）。
function readPerplexityApiKey(): { apiKey: string } | { error: string } {
  const fromEnv = process.env.PERPLEXITY_API_KEY;
  if (fromEnv && fromEnv.trim()) return { apiKey: fromEnv.trim() };

  const p = modelsConfigPath();
  if (!fs.existsSync(p)) {
    return { error: `未设置环境变量 PERPLEXITY_API_KEY，且 models.json 不存在: ${p}` };
  }
  let cfg: any;
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return { error: `models.json 解析失败: ${e instanceof Error ? e.message : String(e)}` }; }
  const prov = cfg?.providers?.[PPLX_PROVIDER];
  if (!prov) {
    return { error: `未设置环境变量 PERPLEXITY_API_KEY，且 models.json 里未找到 provider "${PPLX_PROVIDER}"` };
  }
  const apiKey = resolveApiKey(prov.apiKey);
  if (!apiKey) return { error: `provider "${PPLX_PROVIDER}" 未配置可用的 apiKey` };
  return { apiKey };
}

type PplxParams = {
  query: string;
  queries?: string[];
  max_results?: number;
  country?: string;
  search_domain_filter?: string[];
  search_language_filter?: string[];
  search_context_size?: "low" | "medium" | "high";
  max_tokens?: number;
  max_tokens_per_page?: number;
};

type PplxResult = {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string | null;
  last_updated?: string | null;
};

// 组装请求体，处理 search_context_size 与 max_tokens/max_tokens_per_page 的互斥。
function buildPplxBody(params: PplxParams): Record<string, unknown> {
  const queries = Array.isArray(params.queries) ? params.queries.filter((q) => typeof q === "string" && q.trim()) : [];
  const query: string | string[] = queries.length > 0 ? queries.slice(0, 5) : params.query;

  const body: Record<string, unknown> = { query };
  if (Number.isFinite(params.max_results)) {
    body.max_results = Math.min(Math.max(1, Math.trunc(params.max_results as number)), 20);
  }
  if (params.country && params.country.trim()) body.country = params.country.trim();
  if (Array.isArray(params.search_domain_filter) && params.search_domain_filter.length) {
    body.search_domain_filter = params.search_domain_filter.slice(0, 20);
  }
  if (Array.isArray(params.search_language_filter) && params.search_language_filter.length) {
    body.search_language_filter = params.search_language_filter.slice(0, 10);
  }

  const hasManualBudget = Number.isFinite(params.max_tokens) || Number.isFinite(params.max_tokens_per_page);
  if (hasManualBudget) {
    // 手动 token 预算优先；与 search_context_size 互斥，故忽略后者。
    if (Number.isFinite(params.max_tokens)) body.max_tokens = Math.trunc(params.max_tokens as number);
    if (Number.isFinite(params.max_tokens_per_page)) body.max_tokens_per_page = Math.trunc(params.max_tokens_per_page as number);
  } else if (params.search_context_size) {
    body.search_context_size = params.search_context_size;
  }
  return body;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + `…(已截断，共 ${text.length} 字符)`;
}

// 把结构化 ranked results 渲染成便于阅读的文本。
function formatPplxResults(data: any, body: Record<string, unknown>): string {
  const results: PplxResult[] = Array.isArray(data?.results) ? data.results : [];
  const q = body.query;
  const header = Array.isArray(q)
    ? `Perplexity 多查询搜索（${q.length} 条），返回 ${results.length} 个结果：`
    : `Perplexity 搜索「${String(q)}」，返回 ${results.length} 个结果：`;
  if (!results.length) return `${header}\n(无结果)`;

  const lines: string[] = [header, ""];
  results.forEach((r, i) => {
    const title = (r.title || "(无标题)").trim();
    const url = (r.url || "").trim();
    const meta: string[] = [];
    if (r.date) meta.push(`发布 ${r.date}`);
    if (r.last_updated) meta.push(`更新 ${r.last_updated}`);
    lines.push(`${i + 1}. ${title}`);
    if (url) lines.push(`   URL: ${url}`);
    if (meta.length) lines.push(`   ${meta.join(" | ")}`);
    const snippet = (r.snippet || "").trim();
    if (snippet) lines.push(`   摘要: ${truncate(snippet, 1200)}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

async function perplexitySearch(
  params: PplxParams,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = buildPplxBody(params);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), PPLX_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${PPLX_BASE_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Perplexity HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = await res.json();
    return formatPplxResults(data, body);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// ============================================================================
// Perplexity Pro Search（Sonar Pro 聊天补全，流式 + search_type=pro）
// 官方要求：model=sonar-pro + stream=true + web_search_options.search_type="pro"，
// 否则会退化为普通 Sonar Pro（不触发 Pro Search）。返回带引用的 prose 答案。
// ============================================================================

type PplxProParams = {
  query: string;
  search_mode?: "web" | "academic" | "sec";
  search_domain_filter?: string[];
  country?: string;
};

function buildProBody(params: PplxProParams): Record<string, unknown> {
  const webSearchOptions: Record<string, unknown> = { search_type: "pro" };
  if (params.country && params.country.trim()) {
    webSearchOptions.user_location = { country: params.country.trim() };
  }
  const body: Record<string, unknown> = {
    model: PPLX_PRO_MODEL,
    stream: true,
    messages: [{ role: "user", content: params.query }],
    web_search_options: webSearchOptions,
  };
  if (params.search_mode) body.search_mode = params.search_mode;
  if (Array.isArray(params.search_domain_filter) && params.search_domain_filter.length) {
    body.search_domain_filter = params.search_domain_filter.slice(0, 20);
  }
  return body;
}

// 解析 SSE 流：拼接 delta.content，并从最后的 chunk 里取 search_results / citations。
// onChunk：每收到一个数据块回调一次（用于重置空闲计时器）。
async function readSonarStream(res: Response, onChunk?: () => void): Promise<string> {
  if (!res.body) throw new Error("Sonar 流式响应无 body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let citations: string[] = [];
  let searchResults: Array<{ title?: string; url?: string; date?: string | null }> = [];

  const handleEvent = (jsonStr: string) => {
    if (!jsonStr || jsonStr === "[DONE]") return;
    let evt: any;
    try { evt = JSON.parse(jsonStr); } catch { return; }
    const delta = evt?.choices?.[0]?.delta?.content;
    if (typeof delta === "string") answer += delta;
    const msg = evt?.choices?.[0]?.message?.content;
    if (typeof msg === "string" && msg.length > answer.length) answer = msg;
    if (Array.isArray(evt?.citations)) citations = evt.citations;
    if (Array.isArray(evt?.search_results)) searchResults = evt.search_results;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onChunk) onChunk();
    buffer += decoder.decode(value, { stream: true });
    // SSE 以空行分隔事件；逐行取 "data:" 载荷
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) handleEvent(trimmed.slice(5).trim());
    }
  }
  if (buffer.trim().startsWith("data:")) handleEvent(buffer.trim().slice(5).trim());

  answer = answer.trim();
  const parts: string[] = [answer || "(无回答内容)"];
  const sources = searchResults.length
    ? searchResults.map((r, i) => `[${i + 1}] ${(r.title || "").trim()} ${r.url || ""}`.trim())
    : citations.map((c, i) => `[${i + 1}] ${c}`);
  if (sources.length) parts.push("", "来源：", ...sources);
  return parts.join("\n").trim();
}

async function perplexityProSearch(
  params: PplxProParams,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = buildProBody(params);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  // 与 web_search 同款双计时器：空闲超时（每收一个数据块重置）+ 总时长硬上限
  let abortCause: "idle" | "total" | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { abortCause = "idle"; ctrl.abort(); }, PRO_IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => { abortCause = "total"; ctrl.abort(); }, PRO_TIMEOUT_MS);
  resetIdle();

  try {
    const res = await fetch(`${PPLX_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Perplexity Pro HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    return await readSonarStream(res, resetIdle);
  } catch (e) {
    if ((e as any)?.name === "AbortError" && abortCause) {
      if (abortCause === "idle") {
        throw new Error(`Pro 搜索超时：${Math.round(PRO_IDLE_TIMEOUT_MS / 1000)} 秒内未推送任何数据（空闲超时），可调大 PERPLEXITY_PRO_IDLE_TIMEOUT`);
      }
      throw new Error(`Pro 搜索超时：总时长超过 ${Math.round(PRO_TIMEOUT_MS / 1000)} 秒上限，可调大 PERPLEXITY_PRO_TIMEOUT`);
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// ============================================================================
// Perplexity 异步 Sonar（POST /v1/async/sonar 提交 + GET /v1/async/sonar/{id} 轮询）
// 请求体用顶层 request 包裹；响应顶层含 id/status/response，status 取值
// CREATED / IN_PROGRESS / COMPLETED / FAILED；完成后结果在 response（chat completion 对象）。
// ============================================================================

type PplxAsyncParams = {
  query: string;
  model?: string;
  search_mode?: "web" | "academic" | "sec";
  search_domain_filter?: string[];
};

// 异步接口硬编码用 /v1/async/sonar；若 PPLX_BASE_URL 已含 /v1 则不重复拼接。
function asyncSonarBase(): string {
  return /\/v1$/.test(PPLX_BASE_URL) ? `${PPLX_BASE_URL}/async/sonar` : `${PPLX_BASE_URL}/v1/async/sonar`;
}

function buildAsyncRequest(params: PplxAsyncParams): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: params.model || PPLX_ASYNC_MODEL,
    messages: [{ role: "user", content: params.query }],
  };
  if (params.search_mode) request.search_mode = params.search_mode;
  if (Array.isArray(params.search_domain_filter) && params.search_domain_filter.length) {
    request.search_domain_filter = params.search_domain_filter.slice(0, 20);
  }
  return { request };
}

// 单次 HTTP（提交 / 轮询）带短超时，避免单个请求卡死。
async function pplxFetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<any> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`Perplexity async HTTP ${res.status}: ${text.slice(0, 500)}`);
    try { return JSON.parse(text); } catch { throw new Error(`Perplexity async 响应非 JSON: ${text.slice(0, 300)}`); }
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
  }
}

// 从异步任务的 response（chat completion 对象）提取答案 + 来源。
function formatAsyncResponse(job: any): string {
  const resp = job?.response ?? {};
  const answer = String(resp?.choices?.[0]?.message?.content ?? "").trim();
  const searchResults: Array<{ title?: string; url?: string }> = Array.isArray(resp?.search_results) ? resp.search_results : [];
  const citations: string[] = Array.isArray(resp?.citations) ? resp.citations : [];
  const parts: string[] = [answer || "(无回答内容)"];
  const sources = searchResults.length
    ? searchResults.map((r, i) => `[${i + 1}] ${(r.title || "").trim()} ${r.url || ""}`.trim())
    : citations.map((c, i) => `[${i + 1}] ${c}`);
  if (sources.length) parts.push("", "来源：", ...sources);
  return parts.join("\n").trim();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 提交异步任务，返回 {id, status}。probeOnly=true 时不轮询（用于联通性测试、不消耗大量积分）。
async function submitAsyncSonar(
  params: PplxAsyncParams,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ id: string; status: string }> {
  const job = await pplxFetchJson(
    asyncSonarBase(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildAsyncRequest(params)),
    },
    60_000,
    signal,
  );
  const id = String(job?.id ?? "").trim();
  if (!id) throw new Error(`提交成功但未返回任务 id：${JSON.stringify(job).slice(0, 300)}`);
  return { id, status: String(job?.status ?? "UNKNOWN") };
}

// 轮询直到 COMPLETED / FAILED 或超总时长。
async function pollAsyncSonar(
  id: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${asyncSonarBase()}/${encodeURIComponent(id)}`;
  const deadline = Date.now() + PPLX_ASYNC_MAX_WAIT_MS;
  for (;;) {
    const job = await pplxFetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } }, 60_000, signal);
    const status = String(job?.status ?? "").toUpperCase();
    if (status === "COMPLETED") return formatAsyncResponse(job);
    if (status === "FAILED") {
      const reason = job?.error_message || job?.response?.error?.message || "未说明原因";
      throw new Error(`异步任务失败（FAILED）：${reason}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`异步轮询超时：总时长超过 ${Math.round(PPLX_ASYNC_MAX_WAIT_MS / 1000)} 秒（任务 id=${id} 仍未完成，可稍后用 id 重查）`);
    }
    await sleep(PPLX_ASYNC_POLL_INTERVAL_MS);
  }
}

export default async function (pi: ExtensionAPI) {
  // 高费用 Perplexity 工具的强制确认闸门。确认发生在 HTTP 请求发出之前；
  // 无交互 UI（print/json 模式）时默认阻止，避免自动化流程意外产生高额费用。
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "perplexity_pro_search" && event.toolName !== "perplexity_async_sonar") {
      return undefined;
    }

    const input = (event.input && typeof event.input === "object" ? event.input : {}) as Record<string, unknown>;
    const query = String(input.query ?? "").trim();
    const queryPreview = query.length > 300 ? `${query.slice(0, 300)}…` : query || "（未提供查询内容）";

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${event.toolName} 属于高费用工具，当前模式没有交互式确认界面，已阻止请求（未产生费用）`,
      };
    }

    const isAsync = event.toolName === "perplexity_async_sonar";
    const model = isAsync ? String(input.model ?? PPLX_ASYNC_MODEL) : PPLX_PRO_MODEL;
    const probeOnly = isAsync && input.probe_only === true;
    const costWarning = isAsync
      ? [
          "费用：深度研究按 token 计费，成本可能较高。",
          `执行方式：${probeOnly ? "仅提交、不在本地轮询（probe_only）" : "提交并持续轮询结果"}。`,
          "注意：probe_only 只停止本地轮询；任务提交后仍会在服务端执行并可能产生完整费用。",
        ].join("\n")
      : "费用：$0.008/次 Pro Search 请求 + Sonar Pro 输入/输出 token 费。";

    const confirmed = await ctx.ui.confirm(
      "确认使用高费用 Perplexity 工具",
      `工具：${event.toolName}\n模型：${model}\n${costWarning}\n\n查询：${queryPreview}\n\n是否确认发起本次收费请求？`,
    );

    if (!confirmed) {
      return {
        block: true,
        reason: `用户取消了 ${event.toolName} 调用；请求未发送，未产生本次费用`,
      };
    }
    return undefined;
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search (CPA GPT-5.6 Luna, 免费)",
    description:
      "【默认首选・免费】通用联网搜索入口。通过 CPA（CLIProxyAPI）的 GPT-5.6 Luna 联网搜索，返回带来源的实时 prose 答案。" +
      "适用于绝大多数日常搜索：查询最新新闻、实时数据、联网核实事实、获取公开披露文件/页面的真实 URL。" +
      "成本：免费。输入自然语言查询；如需链接可在 query 中要求返回来源 URL。" +
      "选择建议：除非明确需要多条结构化来源（用 perplexity_search）或复杂多步深度研究（用 perplexity_pro_search），否则优先用本工具。" +
      "另有同样免费的 google_search（Google 后端 grounding，通常更快、更擅长当天时效性问题）；两者可互相印证。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "自然语言搜索查询（中文/英文均可）。可在其中明确要求返回真实来源 URL、限定来源等。",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const creds = readProviderCreds();
      if ("error" in creds) {
        return { content: [{ type: "text", text: `CPA 联网搜索不可用：${creds.error}` }], isError: true };
      }
      const query = String(params?.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "query 不能为空" }], isError: true };
      }
      try {
        const answer = await doSearch(query, creds, signal);
        return { content: [{ type: "text", text: answer }], isError: false };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "联网搜索已取消或超时" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `CPA 联网搜索失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  // --------------------------------------------------------------------------
  // Google Search（Gemini 原生 Server-side Grounding，免费，走同一个 CPA 网关）
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "google_search",
    label: "Google Search (CPA Gemini Grounding, 免费)",
    description:
      "【与 web_search 并列的免费首选】通过 CPA 网关调 Gemini 原生 Google Search grounding：Google 服务端自动检索、" +
      "抓网页、合成证据，一次往返直接返回已结合搜索结果写好的答案，常附带 vertexaisearch 签名来源链接。" +
      "成本：免费。速度：flash 系通常 1~15 秒，pro 系可能 30~40 秒。" +
      "选择建议：日常实时查询（今天的新闻、当前日期、刚发生的事件、时效性强的事实）优先用本工具；" +
      "它与 web_search 后端不同（Google vs OpenAI），关键结论可以两边互相印证。" +
      "需要多条结构化可过滤来源用 perplexity_search，需要多步深度推理用 perplexity_pro_search。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "自然语言搜索查询（中文/英文均可）。工具会自动追加“列出实际引用来源 URL”的要求，无需自己写。",
        },
        model: {
          type: "string",
          description:
            "可选，覆盖默认模型（默认 gemini-3.8-flash-high，快且会带签名来源链接）。" +
            "需要跨多来源交叉印证的复杂问题可传 gemini-pro-agent（最强但慢，约 30~40 秒）；" +
            "只要最快回答可传 gemini-3.1-flash-lite。" +
            "注意：claude-* / gpt-oss-* / 图像模型在本网关不支持 grounding，会被直接拒绝。",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const creds = readProviderCreds();
      if ("error" in creds) {
        return { content: [{ type: "text", text: `Google 搜索不可用：${creds.error}` }], isError: true };
      }
      const query = String(params?.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "query 不能为空" }], isError: true };
      }
      const model = String(params?.model ?? "").trim() || GS_MODEL;
      if (GS_BLOCKED_MODEL.test(model)) {
        return {
          content: [{
            type: "text",
            text:
              `模型 ${model} 在本网关不支持 Google grounding：传了 google_search 也不会联网，` +
              `轻则明确拒答、重则静默编造带链接的过期内容。` +
              `请改用已验证的模型，如 ${GS_VERIFIED_MODELS.slice(0, 3).join(" / ")}。`,
          }],
          isError: true,
        };
      }
      try {
        const out = await doGoogleSearch(query, model, creds, signal);
        return {
          content: [{ type: "text", text: out.answer + groundingFootnote(model, out) }],
          isError: false,
        };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "Google 搜索已取消或超时" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `Google 搜索失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  // --------------------------------------------------------------------------
  // Perplexity Search API：返回结构化 ranked results（title/url/snippet/date）
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "perplexity_search",
    label: "Perplexity Search ($0.005/次)",
    description:
      "【收费：$0.005/次请求，仅按请求计费、无 token 额外费】通过 Perplexity Search API 获取结构化、" +
      "按相关性排序的实时网页搜索结果（每条含 title / url / snippet / date）。适用于需要多条真实来源 URL、" +
      "按域名/语言/地区过滤、多角度（多查询）检索的场景。支持多查询（queries，最多 5 条）与预算控制。" +
      "选择建议：仅当任务确实需要多条可核实的排序来源时才用；若只要一句话结论请用（免费的）web_search；" +
      "若需多步推理的深度综合回答请用 perplexity_pro_search。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "单条搜索查询（中文/英文均可）。多查询时可留空并改用 queries。",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "多查询列表（最多 5 条）；提供后优先于 query，结果按查询顺序合并返回。",
        },
        max_results: {
          type: "number",
          description: "返回结果数量，取值 1-20，默认由服务端决定（通常 10）。",
        },
        country: {
          type: "string",
          description: "ISO 3166-1 alpha-2 国家码（如 US、GB、DE、JP、CN），用于地区化结果。",
        },
        search_domain_filter: {
          type: "array",
          items: { type: "string" },
          description:
            "域名过滤（最多 20 个）。白名单直接写域名（如 nature.com、nature.com/articles）；" +
            "黑名单加 - 前缀（如 -reddit.com）。白名单与黑名单不能混用。",
        },
        search_language_filter: {
          type: "array",
          items: { type: "string" },
          description: "语言过滤（最多 10 个），ISO 639-1 两字母码（如 en、zh、fr、de）。",
        },
        search_context_size: {
          type: "string",
          enum: ["low", "medium", "high"],
          description:
            "每页正文抽取量：low 精简、medium 均衡、high 详细（默认）。不能与 max_tokens/max_tokens_per_page 同时使用。",
        },
        max_tokens: {
          type: "number",
          description: "所有结果正文的总 token 上限（最高 1,000,000）。与 search_context_size 互斥，提供后优先。",
        },
        max_tokens_per_page: {
          type: "number",
          description: "单页正文抽取的 token 上限。与 search_context_size 互斥，提供后优先。",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const cred = readPerplexityApiKey();
      if ("error" in cred) {
        return { content: [{ type: "text", text: `Perplexity 搜索不可用：${cred.error}` }], isError: true };
      }
      const query = String(params?.query ?? "").trim();
      const queries = Array.isArray(params?.queries)
        ? params.queries.map((q: unknown) => String(q ?? "").trim()).filter(Boolean)
        : [];
      if (!query && queries.length === 0) {
        return { content: [{ type: "text", text: "query 或 queries 至少提供一个" }], isError: true };
      }
      try {
        const text = await perplexitySearch(
          {
            query: query || queries[0],
            queries,
            max_results: params?.max_results,
            country: params?.country,
            search_domain_filter: params?.search_domain_filter,
            search_language_filter: params?.search_language_filter,
            search_context_size: params?.search_context_size,
            max_tokens: params?.max_tokens,
            max_tokens_per_page: params?.max_tokens_per_page,
          },
          cred.apiKey,
          signal,
        );
        return { content: [{ type: "text", text }], isError: false };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "Perplexity 搜索已取消或超时" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `Perplexity 搜索失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  // --------------------------------------------------------------------------
  // Perplexity Pro Search（Sonar Pro 流式多步检索，返回带引用的深度 prose 答案）
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "perplexity_pro_search",
    label: "Perplexity Pro Search ($0.008/次 + token)",
    description:
      "【调用前必须经用户确认】【收费：$0.008/次 Pro Search 请求 + Sonar Pro 的 token 费（输入/输出按量计费），三个搜索工具中最贵】" +
      "走 Perplexity Sonar Pro 聊天补全（流式 + search_type=pro），模型会自动多步检索、抓取页面内容并多轮推理，" +
      "最终生成带引用的深度综合答案。每次真正发起请求前都会弹出费用确认；用户拒绝或无交互 UI 时不会发送请求。" +
      "仅适用于需要跨多个来源多步推理的复杂问题（如专题调研、多因素对比、需边搜边推导的任务）。" +
      "选择建议：简单事实/新闻查询不要用它（贵且慢），改用免费的 web_search；" +
      "只要一批可核实的排序链接用 perplexity_search（$0.005/次）。除非任务确实需要深度多步研究，否则不要选本工具。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "需要多步推理/深度综合的复杂问题（中文/英文均可）。描述越具体，多步检索效果越好。",
        },
        search_mode: {
          type: "string",
          enum: ["web", "academic", "sec"],
          description: "搜索来源域：web（默认全网）、academic（学术）、sec（美股 SEC 披露文件）。",
        },
        country: {
          type: "string",
          description: "ISO 3166-1 alpha-2 国家码（如 US、CN），用于地区化搜索。",
        },
        search_domain_filter: {
          type: "array",
          items: { type: "string" },
          description:
            "域名过滤（最多 20 个）。白名单直接写域名；黑名单加 - 前缀（如 -reddit.com）。",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const cred = readPerplexityApiKey();
      if ("error" in cred) {
        return { content: [{ type: "text", text: `Perplexity Pro 搜索不可用：${cred.error}` }], isError: true };
      }
      const query = String(params?.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "query 不能为空" }], isError: true };
      }
      try {
        const text = await perplexityProSearch(
          {
            query,
            search_mode: params?.search_mode,
            country: params?.country,
            search_domain_filter: params?.search_domain_filter,
          },
          cred.apiKey,
          signal,
        );
        return { content: [{ type: "text", text }], isError: false };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "Perplexity Pro 搜索已取消或超时" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `Perplexity Pro 搜索失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  // --------------------------------------------------------------------------
  // Perplexity 异步 Sonar（提交 + 轮询，默认 sonar-deep-research 深度研究）
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "perplexity_async_sonar",
    label: "Perplexity Async Sonar (深度研究异步)",
    description:
      "【调用前必须经用户确认】【收费・真异步・最重】走 Perplexity 官方异步接口（POST /v1/async/sonar 提交 + 轮询取结果），" +
      "默认模型 sonar-deep-research，会跨大量来源做详尽研究并生成带引用的深度报告。每次提交前都会弹出费用确认；" +
      "用户拒绝或无交互 UI 时不会发送请求。服务端排队执行，可能耗时几分钟到十几分钟，客户端自动轮询。" +
      "token 费明显比 pro_search 更贵，**仅用于真正需要长时间深度调研的任务**。" +
      "日常搜索用（免费）web_search；多步推理用 perplexity_pro_search。" +
      "probe_only=true 仅表示提交后不在本地轮询；服务端任务仍会执行并可能产生完整费用，因此同样必须确认。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "需要深度研究的复杂问题（中/英文均可）。描述越具体，研究报告越有针对性。",
        },
        model: {
          type: "string",
          description: "异步模型，默认 sonar-deep-research。测试联通性时可传更便宜的 sonar 降低成本。",
        },
        search_mode: {
          type: "string",
          enum: ["web", "academic", "sec"],
          description: "搜索来源域：web（默认全网）、academic（学术）、sec（美股 SEC 披露）。",
        },
        search_domain_filter: {
          type: "array",
          items: { type: "string" },
          description: "域名过滤（最多 20 个）。白名单直接写域名；黑名单加 - 前缀（如 -reddit.com）。",
        },
        probe_only: {
          type: "boolean",
          description: "仅提交不在本地轮询，立即返回任务 id 与初始 status。注意：服务端任务仍会继续执行并可能产生完整费用；调用前同样需要用户确认。默认 false。",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const cred = readPerplexityApiKey();
      if ("error" in cred) {
        return { content: [{ type: "text", text: `Perplexity 异步 Sonar 不可用：${cred.error}` }], isError: true };
      }
      const query = String(params?.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "query 不能为空" }], isError: true };
      }
      const asyncParams: PplxAsyncParams = {
        query,
        model: params?.model,
        search_mode: params?.search_mode,
        search_domain_filter: params?.search_domain_filter,
      };
      try {
        const { id, status } = await submitAsyncSonar(asyncParams, cred.apiKey, signal);
        if (params?.probe_only === true) {
          return {
            content: [{ type: "text", text: `异步任务已提交（probe_only）。id=${id} status=${status}\n可稍后用该 id 轮询 GET /v1/async/sonar/${id} 取结果。` }],
            isError: false,
          };
        }
        const text = await pollAsyncSonar(id, cred.apiKey, signal);
        return { content: [{ type: "text", text: `任务 id=${id}\n\n${text}` }], isError: false };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "Perplexity 异步 Sonar 已取消" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `Perplexity 异步 Sonar 失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });
}
