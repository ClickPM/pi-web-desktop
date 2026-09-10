"use strict";

/**
 * Import pi's model providers into dsh.
 *
 * WHY THIS IS EVEN POSSIBLE
 * -------------------------
 * dsh's main LLM adapter (@deepseek-ai/dsh-llm-pi-ai) depends on
 * `@earendil-works/pi-ai` — the SAME model layer pi itself runs on. So `api`,
 * `baseUrl`, `input`, thinking-level maps and the openai-completions compat
 * switches all mean exactly the same thing on both sides, and a company gateway
 * the user already configured in pi can be restated as a dsh provider route
 * almost field for field.
 *
 * WHAT IS AND ISN'T CARRIED OVER
 * ------------------------------
 * Only the CUSTOM providers in `~/.pi/agent/models.json` (the ones with their
 * own baseUrl — company gateways, self-hosted endpoints) are imported. The
 * catalog credentials in `auth.json` are deliberately NOT written into
 * `llm-pi-ai`: dsh ships its own native DeepSeek adapter with a separate
 * settings key, and inventing an llm-pi-ai route for a provider whose id the
 * installed catalog may not carry would make dsh refuse the config at boot —
 * i.e. break the app to save one paste. They are reported instead.
 *
 * Three pi fields have NO dsh equivalent and are reported as warnings rather
 * than silently dropped:
 *   - `cost` — PiAiModelProfile has no pricing surface.
 *   - `compat.supportsDeveloperRole` / `supportsStore` /
 *     `requiresReasoningContentOnAssistantMessages` — dsh exposes only
 *     `thinkingFormat` and `supportsReasoningEffort`; everything else falls
 *     back to pi-ai's baseURL-derived auto-detection, which may guess wrong for
 *     a private gateway.
 *
 * SECRETS NEVER LEAVE pi
 * ----------------------
 * pi keeps provider keys in plaintext inside models.json. This importer does
 * NOT copy them: it writes `apiKeyEnv: <NAME>` into dsh's settings and hands
 * main.js an env map built by re-reading pi's file at spawn time. dsh's
 * credentials-local resolves the inherited process environment ABOVE its own
 * managed store, so the key is live for the session and never lands in
 * `$DSH_HOME/.credentials.yaml`.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

/** Prefix for the generated credential env-var names. */
const ENV_PREFIX = "PI_DSH_KEY_";

/** dsh rejects these two spellings — they drive the request through chatTemplateKwargs. */
const WITHHELD_THINKING_FORMATS = new Set(["chat-template", "qwen-chat-template"]);

/** Where pi keeps its agent config (same env var pi-web-desktop already honours). */
function piAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** Read pi's two provider files. Either may legitimately be absent. */
function readPiConfig(dir = piAgentDir()) {
  return {
    models: readJson(path.join(dir, "models.json")) || {},
    auth: readJson(path.join(dir, "auth.json")) || {},
  };
}

/** Deterministic env-var name for a provider id (`variflight-ticket` → `PI_DSH_KEY_VARIFLIGHT_TICKET`). */
function envVarNameFor(providerId) {
  return ENV_PREFIX + String(providerId).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Translate pi's thinking-level map into dsh's `reasoningEfforts`.
 *
 * pi records unsupported levels as explicit nulls (kimi-k3 nulls out minimal /
 * medium / xhigh). dsh reads a declared level as "offered", and every level
 * except `off` MUST name a wire spelling — so a null has to be dropped, not
 * translated, or the route is refused. `off: null` is legal and meaningful
 * ("supported, send nothing").
 */
function mapReasoningEfforts(thinkingLevelMap) {
  const out = {};
  for (const [level, wire] of Object.entries(thinkingLevelMap || {})) {
    if (wire === null || wire === undefined) {
      if (level === "off") out[level] = null;
      continue;
    }
    if (typeof wire === "string" && wire !== "") out[level] = wire;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Map one pi model entry to a dsh PiAiModelProfile, collecting per-model warnings. */
function mapModel(providerId, providerApi, piModel, warn) {
  const where = `${providerId}/${piModel.id}`;
  const out = { id: piModel.id };
  if (piModel.name) out.name = piModel.name;
  if (typeof piModel.contextWindow === "number") out.contextWindow = piModel.contextWindow;
  if (typeof piModel.maxTokens === "number") out.maxTokens = piModel.maxTokens;
  if (Array.isArray(piModel.input) && piModel.input.length) out.input = [...piModel.input];

  if (piModel.reasoning === true) {
    const efforts = mapReasoningEfforts(piModel.thinkingLevelMap);
    if (efforts) out.reasoningEfforts = efforts;
  } else {
    // dsh spells "this model does not reason" as an explicit false.
    out.reasoningEfforts = false;
  }

  const compat = {};
  const piCompat = piModel.compat || {};
  if (typeof piCompat.thinkingFormat === "string") {
    if (WITHHELD_THINKING_FORMATS.has(piCompat.thinkingFormat)) {
      warn(`${where}: thinkingFormat "${piCompat.thinkingFormat}" 无法在 dsh 中配置，已跳过该字段`);
    } else {
      compat.thinkingFormat = piCompat.thinkingFormat;
    }
  }
  if (typeof piCompat.supportsReasoningEffort === "boolean") {
    compat.supportsReasoningEffort = piCompat.supportsReasoningEffort;
  }
  if (Object.keys(compat).length) out.compat = compat;

  // The fields with no dsh equivalent. Naming the model matters: these are the
  // entries most likely to behave differently after the import.
  for (const dropped of ["supportsDeveloperRole", "supportsStore", "requiresReasoningContentOnAssistantMessages"]) {
    if (piCompat[dropped] !== undefined) {
      warn(`${where}: compat.${dropped}=${JSON.stringify(piCompat[dropped])} 在 dsh 无对应字段，将回退到 pi-ai 按 baseURL 的自动探测`);
    }
  }
  if (piModel.cost) warn(`${where}: cost 定价信息在 dsh 无对应字段，已丢弃`);
  if (piModel.api && providerApi && piModel.api !== providerApi) {
    warn(`${where}: 该模型声明 api=${piModel.api} 与提供方的 ${providerApi} 不同，dsh 的协议只能配在路由上，已按提供方的取值处理`);
  }

  return out;
}

/**
 * Map pi's provider config to dsh's `llm-pi-ai.providers` section.
 *
 * @returns {{providers: object, credentials: Array<{providerId: string, envVar: string}>, warnings: string[], skipped: string[]}}
 *   `credentials` names the env vars the caller must populate at spawn time;
 *   no secret value is ever part of this result.
 */
function mapProviders(piConfig) {
  const providers = {};
  const credentials = [];
  const warnings = [];
  const skipped = [];
  const warn = (m) => warnings.push(m);

  const piProviders = (piConfig && piConfig.models && piConfig.models.providers) || {};
  for (const [id, p] of Object.entries(piProviders)) {
    if (!p || typeof p !== "object") continue;
    if (!p.baseUrl) {
      skipped.push(`${id}（没有 baseUrl，不是自建网关）`);
      continue;
    }
    const route = { baseURL: p.baseUrl };
    if (p.name) route.displayName = p.name;
    if (p.api) route.api = p.api;

    const models = Array.isArray(p.models) ? p.models.filter((m) => m && m.id) : [];
    if (!models.length) {
      skipped.push(`${id}（没有列出任何模型）`);
      continue;
    }
    route.models = models.map((m) => mapModel(id, p.api, m, warn));

    if (p.apiKey) {
      route.apiKeyEnv = envVarNameFor(id);
      credentials.push({ providerId: id, envVar: route.apiKeyEnv });
    } else {
      warn(`${id}: pi 里没有存 apiKey，dsh 侧需要自行提供凭据`);
    }
    providers[id] = route;
  }

  // Catalog credentials are reported, never written — see the module header.
  for (const id of Object.keys((piConfig && piConfig.auth) || {})) {
    if (!providers[id]) skipped.push(`${id}（pi 的目录型提供方凭据，请在 dsh 设置→模型里直接填写）`);
  }

  return { providers, credentials, warnings, skipped };
}

/**
 * Merge the mapped routes into a dsh settings.yaml, leaving every other
 * section untouched.
 *
 * js-yaml is BORROWED from a bundled runtime rather than added as a shell
 * dependency, which is what keeps this package's dependency list empty
 * (electron + electron-builder, both dev). The lender is injected because it
 * changed: it used to be the dsh runtime this shell shipped, and since that
 * runtime went away — DeepSeek Harness is now upstream's own application — it
 * is the pi runtime, which carries js-yaml too.
 */
function mergeIntoSettings(settingsPath, providers, requireFromRuntime) {
  const yaml = requireFromRuntime("js-yaml");
  let doc = {};
  let backup = null;
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, "utf8").replace(/^﻿/, "");
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed;
    // A settings file the user may have hand-edited is worth a copy before we
    // rewrite it: a route dsh refuses at boot is otherwise a dead app with no
    // obvious way back.
    backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
    fs.writeFileSync(backup, raw, "utf8");
  }

  const section = doc["llm-pi-ai"] && typeof doc["llm-pi-ai"] === "object" ? doc["llm-pi-ai"] : {};
  section.providers = { ...(section.providers || {}), ...providers };
  doc["llm-pi-ai"] = section;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, yaml.dump(doc, { lineWidth: 120, noRefs: true }), "utf8");
  return { backup };
}

/**
 * Build the credential env for a dsh launch: `{ENV_VAR: <live key from pi>}`.
 *
 * Read fresh on every spawn on purpose — rotating a key in pi is then enough,
 * with no re-import and no second copy of the secret anywhere on disk.
 */
function buildCredentialEnv(credentials, dir = piAgentDir()) {
  const env = {};
  if (!Array.isArray(credentials) || !credentials.length) return env;
  const piProviders = (readJson(path.join(dir, "models.json")) || {}).providers || {};
  for (const { providerId, envVar } of credentials) {
    const key = piProviders[providerId] && piProviders[providerId].apiKey;
    if (key) env[envVar] = key;
  }
  return env;
}

module.exports = {
  ENV_PREFIX,
  piAgentDir,
  readPiConfig,
  envVarNameFor,
  mapReasoningEfforts,
  mapModel,
  mapProviders,
  mergeIntoSettings,
  buildCredentialEnv,
};
