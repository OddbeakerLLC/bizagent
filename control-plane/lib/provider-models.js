const fs = require("fs");
const path = require("path");
const { providerEntries, resolveProviderName } = require("./cli-config");

/**
 * Live provider model lists for the console picker.
 *
 * The models-list fetch always happens here (control-plane side) so the
 * saved API key never reaches the browser. Keys are read from the hub
 * `.bizagent/env` file / process env; values are never logged or returned.
 */

const REQUEST_TIMEOUT_MS = 10000;
const ANTHROPIC_MODELS_LIMIT = 1000;
const ANTHROPIC_MAX_PAGES = 5;
const ANTHROPIC_VERSION = "2023-06-01";

/** Model-id fragments of non-chat models (image, audio/voice, video, embedding, moderation, …). */
const NON_CHAT_ID_PATTERNS = [
  "embed", // text-embedding-*, nomic-embed-*, gemini-embedding-*
  "moderation", // omni-moderation-*
  "whisper",
  "tts", // tts-1, tts-1-hd
  "audio", // gpt-4o-audio-preview
  "realtime", // gpt-4o-realtime-preview
  "voice",
  "speech",
  "transcri", // gpt-4o-mini-transcribe
  "dall-e",
  "image", // gpt-image-1, grok-2-image, image variants
  "imagen",
  "video",
  "sora",
  "veo",
  "rerank",
  "guard",
  "safety",
];

/** model.type values that mean chat/text-capable (Venice "text", Anthropic "model"). */
const CHAT_MODEL_TYPES = ["chat", "text", "model", "language", "llm"];

/** Same charset cli-config allows for --model at launch. */
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]+$/;

function hubEnvFilePath(hub) {
  return path.join(hub, ".bizagent", "env");
}

/** Parse KEY=value lines from hub/.bizagent/env (values never logged). */
function readHubEnvFile(hub) {
  const out = {};
  try {
    const text = fs.readFileSync(hubEnvFilePath(hub), "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = val;
    }
  } catch (_err) {
    /* missing env file is normal */
  }
  return out;
}

/**
 * The saved API key for a provider entry: process env first (boot-time
 * loadHubEnv), then a fresh read of .bizagent/env so keys saved after the
 * control plane started are picked up too. Never logged.
 */
function providerApiKey(hub, entry) {
  const keyEnv = String((entry && entry.keyEnv) || "").trim();
  if (!keyEnv) return "";
  if (process.env[keyEnv]) return process.env[keyEnv];
  const fileEnv = readHubEnvFile(hub);
  return fileEnv[keyEnv] || "";
}

/**
 * True when the provider is usable for the key-gated picker: it has a
 * saved API key, or it needs no key (no keyEnv / optionalKey, e.g. Ollama).
 */
function providerHasApiKey(hub, entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.optionalKey) return true;
  const keyEnv = String(entry.keyEnv || "").trim();
  if (!keyEnv) return true; // provider has no key concept
  return !!providerApiKey(hub, entry);
}

function normalizeModelId(id) {
  // Gemini-style "models/gemini-2.5-flash" prefix.
  return String(id || "").replace(/^models\//, "").trim();
}

function isChatModelId(id) {
  const lower = String(id || "").toLowerCase();
  if (!lower) return false;
  return !NON_CHAT_ID_PATTERNS.some((frag) => lower.includes(frag));
}

function modelType(model) {
  const m = model || {};
  const raw = m.type != null ? m.type : m.modality != null ? m.modality : "";
  return String(raw || "").toLowerCase();
}

/**
 * Chat-capable check. When the API reports a modality/type (Venice types),
 * trust it; otherwise fall back to the conservative id blocklist.
 */
function isChatModel(model, id) {
  const type = modelType(model);
  if (type) return CHAT_MODEL_TYPES.includes(type);
  return isChatModelId(id);
}

/** Real display name from the API when it provides one; else the id. */
function modelDisplayName(model, id) {
  const m = model || {};
  const name = String(
    m.display_name ||
      m.name ||
      (m.model_spec && typeof m.model_spec === "object" ? m.model_spec.name : "") ||
      "",
  ).trim();
  return name || id;
}

function toUsdNumber(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    // Venice-style { usd: 0.9375, diem: … } — use the USD figure.
    return value.usd != null ? toUsdNumber(value.usd) : null;
  }
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

function roundUsd(n) {
  return Number(n.toPrecision(6));
}

function cleanPricing(input, output) {
  const pricing = {};
  if (input != null) pricing.input = roundUsd(input);
  if (output != null) pricing.output = roundUsd(output);
  return Object.keys(pricing).length ? pricing : null;
}

/**
 * Chat-token pricing as USD per 1M tokens when the provider reports it.
 * Supported shapes (anything else is omitted rather than guessed):
 * - Venice: model_spec.pricing.input.usd / .output.usd (per 1M tokens)
 * - OpenRouter: pricing.prompt / pricing.completion (USD per token → ×1M)
 */
function extractPricing(model) {
  const m = model || {};
  const spec = m.model_spec && m.model_spec.pricing;
  if (spec && typeof spec === "object") {
    const pricing = cleanPricing(toUsdNumber(spec.input), toUsdNumber(spec.output));
    if (pricing) return pricing;
  }
  const pr = m.pricing;
  if (pr && typeof pr === "object") {
    const prompt = toUsdNumber(pr.prompt);
    const completion = toUsdNumber(pr.completion);
    if (prompt != null || completion != null) {
      return cleanPricing(
        prompt == null ? null : prompt * 1e6,
        completion == null ? null : completion * 1e6,
      );
    }
  }
  return null;
}

/** Curated static list (cli.json `models`) used when no live endpoint answers. */
function staticModelsFor(entry) {
  const models = Array.isArray(entry && entry.models) ? entry.models : [];
  return models
    .map((m) => String(m || "").trim())
    .filter((id) => id)
    .map((id) => ({ id, name: id, pricing: null }));
}

/**
 * Request style: "anthropic" (x-api-key + display_name) or "openai"
 * (Bearer + { data: [{ id }] }) for every OpenAI-compatible provider.
 * Per-entry override: modelsStyle. Anthropic inferred from the baseURL.
 */
function providerModelsStyle(entry) {
  const declared = String((entry && entry.modelsStyle) || "").trim().toLowerCase();
  if (declared) return declared;
  const base = String((entry && (entry.baseURL || entry.baseUrl)) || "");
  if (/api\.anthropic\.com/i.test(base)) return "anthropic";
  return "openai";
}

function modelsUrlFor(entry) {
  const override = String((entry && entry.modelsUrl) || "").trim();
  if (override) {
    if (!/^https?:\/\//i.test(override)) {
      throw new Error("modelsUrl must be an http(s) URL");
    }
    return override;
  }
  const base = String((entry && (entry.baseURL || entry.baseUrl)) || "")
    .trim()
    .replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new Error("provider baseURL must be an http(s) URL");
  }
  const modelsPath = String((entry && entry.modelsPath) || "/models");
  const suffix = modelsPath.startsWith("/") ? modelsPath : `/${modelsPath}`;
  return `${base}${suffix}`;
}

async function fetchJson(url, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenAiStyleModels(url, apiKey) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = await fetchJson(url, headers);
  return body && Array.isArray(body.data) ? body.data : [];
}

async function fetchAnthropicModels(url, apiKey) {
  const models = [];
  let afterId = "";
  for (let page = 0; page < ANTHROPIC_MAX_PAGES; page++) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("limit", String(ANTHROPIC_MODELS_LIMIT));
    if (afterId) pageUrl.searchParams.set("after_id", afterId);
    const headers = { "anthropic-version": ANTHROPIC_VERSION };
    if (apiKey) headers["x-api-key"] = apiKey;
    const body = await fetchJson(pageUrl.toString(), headers);
    const list = body && Array.isArray(body.data) ? body.data : [];
    models.push(...list);
    if (!body || body.has_more !== true) break;
    const last = list.length ? String(list[list.length - 1].id || "") : "";
    if (!last || last === afterId) break;
    afterId = last;
  }
  return models;
}

/**
 * Normalize a raw models array to { id, name, pricing } chat models.
 * Dedupes, drops non-chat models and unusable ids.
 */
function normalizeModels(rawModels) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    if (!raw || typeof raw !== "object") continue;
    const id = normalizeModelId(raw.id);
    if (!id || !MODEL_ID_RE.test(id)) continue;
    if (seen.has(id)) continue;
    if (!isChatModel(raw, id)) continue;
    seen.add(id);
    out.push({ id, name: modelDisplayName(raw, id), pricing: extractPricing(raw) });
  }
  return out;
}

/**
 * List chat-capable models for a provider, live from its models-list
 * endpoint (server-side, saved key, never exposed). Falls back to the
 * provider's curated static list (cli.json `models`) when the provider has
 * no reachable list endpoint or no saved key. Always resolves; `ok:false`
 * carries a human-readable `error`.
 *
 * @param {{ hub: string, cliJson: object, provider: string, apiKey?: string }} opts
 * @returns {Promise<{ ok: boolean, provider: string, source: "live"|"fallback", models: Array<{id:string,name:string,pricing:object|null}>, error?: string, style?: string }>}
 */
async function listProviderModels(opts = {}) {
  const { hub, cliJson, provider } = opts;
  const requested = String(provider || "").trim();
  if (!requested) {
    return { ok: false, provider: "", source: "fallback", models: [], error: "provider is required" };
  }
  const key = resolveProviderName(requested, cliJson) || requested;
  const entry = (providerEntries(cliJson) || {})[key] || null;
  const fallback = staticModelsFor(entry);

  if (!entry) {
    return {
      ok: false,
      provider: key,
      source: "fallback",
      models: fallback,
      error: `cli.json has no provider "${key}"`,
    };
  }

  const keyEnv = String(entry.keyEnv || "").trim();
  const effectiveKey =
    opts.apiKey !== undefined ? opts.apiKey : providerApiKey(hub, entry);
  if (keyEnv && !effectiveKey && !entry.optionalKey) {
    return {
      ok: false,
      provider: key,
      source: "fallback",
      models: fallback,
      error: `No API key saved for ${key} — set ${keyEnv} in .bizagent/env`,
    };
  }

  const style = providerModelsStyle(entry);
  try {
    const url = modelsUrlFor(entry);
    const raw =
      style === "anthropic"
        ? await fetchAnthropicModels(url, effectiveKey)
        : await fetchOpenAiStyleModels(url, effectiveKey);
    const models = normalizeModels(raw);
    if (models.length === 0) {
      throw new Error("models list empty or no chat-capable models");
    }
    return { ok: true, provider: key, source: "live", models, style };
  } catch (err) {
    return {
      ok: false,
      provider: key,
      source: "fallback",
      models: fallback,
      error: (err && err.message) || "failed to list models",
    };
  }
}

module.exports = {
  ANTHROPIC_MAX_PAGES,
  ANTHROPIC_MODELS_LIMIT,
  ANTHROPIC_VERSION,
  CHAT_MODEL_TYPES,
  NON_CHAT_ID_PATTERNS,
  extractPricing,
  fetchAnthropicModels,
  fetchOpenAiStyleModels,
  isChatModel,
  isChatModelId,
  listProviderModels,
  modelDisplayName,
  modelsUrlFor,
  normalizeModelId,
  normalizeModels,
  providerApiKey,
  providerHasApiKey,
  providerModelsStyle,
  staticModelsFor,
};
