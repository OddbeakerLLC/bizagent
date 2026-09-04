#!/usr/bin/env bash
# test-provider-models.sh — key-gated provider picker + live model lists
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

LIB="$ROOT/control-plane/lib/provider-models.js"
[ -f "$LIB" ] || fail "control-plane/lib/provider-models.js missing"
[ -f "$ROOT/control-plane/server.js" ] || fail "control-plane/server.js missing"
[ -f "$ROOT/control-plane/public/app.js" ] || fail "web UI missing"

# Wiring: endpoint, key gating, custom-model fallback UI.
grep -q "/api/provider-models" "$ROOT/control-plane/server.js" \
  || fail "server.js missing /api/provider-models endpoint"
grep -q "providerHasApiKey(config.hub, providers\[name\])" "$ROOT/control-plane/server.js" \
  || fail "server.js provider list not key-gated"
grep -q "provider-models" "$ROOT/control-plane/public/app.js" \
  || fail "app.js does not fetch live provider models"
grep -q "modalModelCustom" "$ROOT/control-plane/public/index.html" \
  || fail "index.html missing custom model input"
grep -q "v=20260904-paste-vision" "$ROOT/control-plane/public/index.html" \
  || fail "index.html missing cache-bust for model picker"

node - "$ROOT" <<'NODE' || exit 1
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const lib = require(path.join(process.argv[2], "control-plane/lib/provider-models"));

function assert(cond, msg) {
  if (!cond) { console.error("  FAIL: " + msg); process.exit(1); }
}

// --- Chat-model filtering (OpenAI-style ids, no modality info) ---
const openAiList = [
  { id: "gpt-5.4", object: "model" },
  { id: "gpt-4o", object: "model" },
  { id: "text-embedding-3-small" },
  { id: "whisper-1" },
  { id: "tts-1" },
  { id: "dall-e-3" },
  { id: "gpt-4o-audio-preview" },
  { id: "gpt-4o-realtime-preview" },
  { id: "omni-moderation-latest" },
  { id: "sora-2" },
  { id: "gpt-image-1" },
  { id: "gpt-4o-mini-transcribe" },
];
const filtered = lib.normalizeModels(openAiList);
assert(filtered.length === 2, `expected 2 chat models, got ${filtered.length} (${filtered.map(m=>m.id)})`);
assert(filtered[0].id === "gpt-5.4" && filtered[1].id === "gpt-4o", "chat model ids wrong");
assert(filtered[0].name === "gpt-5.4", "display name should fall back to id");
assert(filtered[0].pricing === null, "no pricing data should stay null");

// --- Anthropic style: display_name + type "model" kept ---
const anthropicModels = lib.normalizeModels([
  { type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
]);
assert(anthropicModels.length === 1, "anthropic model dropped");
assert(anthropicModels[0].name === "Claude Sonnet 5", "anthropic display_name not used");

// --- Venice style: type field wins; pricing + display name from model_spec ---
const veniceModels = lib.normalizeModels([
  { id: "llama-3.3-70b", type: "text", model_spec: { name: "Llama 3.3 70B",
    pricing: { input: { usd: 0.2 }, output: { usd: 0.3 } } } },
  { id: "venice-image-model", type: "image" },
  { id: "venice-embed-model", type: "embedding" },
]);
assert(veniceModels.length === 1, "venice non-text models not dropped");
assert(veniceModels[0].name === "Llama 3.3 70B", "venice model_spec.name not used");
assert(veniceModels[0].pricing && veniceModels[0].pricing.input === 0.2
  && veniceModels[0].pricing.output === 0.3, "venice pricing not extracted");

// --- OpenRouter-style per-token pricing scaled to 1M ---
const orPricing = lib.extractPricing({ pricing: { prompt: "0.000003", completion: "0.000015" } });
assert(orPricing && orPricing.input === 3 && orPricing.output === 15,
  `openrouter pricing wrong: ${JSON.stringify(orPricing)}`);
assert(lib.extractPricing({ id: "gpt-4o" }) === null, "no pricing should be null");

// --- Gemini-style id prefix stripped ---
assert(lib.normalizeModelId("models/gemini-2.5-flash") === "gemini-2.5-flash", "models/ prefix not stripped");

// --- Key gating ---
const hub = fs.mkdtempSync(path.join(os.tmpdir(), "bizagent-pm-"));
fs.mkdirSync(path.join(hub, ".bizagent"), { recursive: true });
fs.writeFileSync(path.join(hub, ".bizagent", "env"), "PMTEST_SAVED_KEY=abc123\n");
assert(lib.providerHasApiKey(hub, { keyEnv: "PMTEST_SAVED_KEY" }) === true, "saved key not detected");
assert(lib.providerHasApiKey(hub, { keyEnv: "PMTEST_MISSING_KEY" }) === false, "missing key should gate out");
assert(lib.providerHasApiKey(hub, { keyEnv: "PMTEST_MISSING_KEY", optionalKey: true }) === true, "optionalKey should pass");
assert(lib.providerHasApiKey(hub, {}) === true, "keyless provider should pass");
assert(lib.providerHasApiKey(hub, null) === false, "missing entry should fail");

// --- URL building + style detection ---
assert(lib.modelsUrlFor({ baseURL: "https://api.openai.com/v1" }) === "https://api.openai.com/v1/models", "models url join wrong");
assert(lib.modelsUrlFor({ baseURL: "https://api.anthropic.com/v1/" }) === "https://api.anthropic.com/v1/models", "trailing slash join wrong");
assert(lib.modelsUrlFor({ baseURL: "https://gw.example/v1", modelsPath: "/openai/models" }) === "https://gw.example/v1/openai/models", "modelsPath override wrong");
assert(lib.providerModelsStyle({ baseURL: "https://api.anthropic.com/v1/" }) === "anthropic", "anthropic style not inferred");
assert(lib.providerModelsStyle({ baseURL: "https://api.x.ai/v1" }) === "openai", "openai style expected");
assert(lib.providerModelsStyle({ baseURL: "https://gw/v1", modelsStyle: "anthropic" }) === "anthropic", "modelsStyle override ignored");

// --- Live fetch against a local OpenAI-compatible mock ---
function withServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  let sawAuth = null;
  const openaiMock = await withServer((req, res) => {
    sawAuth = req.headers.authorization || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [
      { id: "chat-model-x" }, { id: "chat-model-y" }, { id: "dall-e-99" }, { id: "embed-99" },
    ] }));
  });
  const openaiBase = `http://127.0.0.1:${openaiMock.address().port}/v1`;
  const cliJsonOpenai = { mockopen: { baseURL: openaiBase, keyEnv: "PMTEST_SAVED_KEY", models: ["static-fallback-model"] } };

  const live = await lib.listProviderModels({ hub, cliJson: cliJsonOpenai, provider: "mockopen" });
  assert(live.ok === true && live.source === "live", `openai-style live fetch failed: ${live.error}`);
  assert(sawAuth === "Bearer abc123", "saved API key not sent as Bearer");
  assert(live.models.length === 2, `mock chat filter wrong: ${JSON.stringify(live.models.map(m=>m.id))}`);
  assert(live.models.some((m) => m.id === "chat-model-x"), "live model missing");

  // Unreachable endpoint → curated static fallback + error
  const down = await lib.listProviderModels({
    hub,
    cliJson: { mockdown: { baseURL: "http://127.0.0.1:1/v1", keyEnv: "PMTEST_SAVED_KEY", models: ["static-fallback-model"] } },
    provider: "mockdown",
  });
  assert(down.ok === false && down.source === "fallback", "unreachable provider should fall back");
  assert(down.models.length === 1 && down.models[0].id === "static-fallback-model", "static fallback list wrong");
  assert(String(down.error || "").length > 0, "fallback should carry an error");

  // Missing key → fallback, key never required for the list request
  const keyless = await lib.listProviderModels({
    hub,
    cliJson: { mockkey: { baseURL: openaiBase, keyEnv: "PMTEST_MISSING_KEY", models: ["static-fallback-model"] } },
    provider: "mockkey",
  });
  assert(keyless.ok === false && keyless.source === "fallback", "keyless provider should fall back");
  assert(/No API key saved/.test(keyless.error || ""), "keyless error should mention the key");

  // optionalKey provider (e.g. Ollama) fetches live without any key
  let optionalAuth = "sent";
  const optionalMock = await withServer((req, res) => {
    optionalAuth = req.headers.authorization || "none";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "local-chat-model" }] }));
  });
  const optionalBase = `http://127.0.0.1:${optionalMock.address().port}/v1`;
  const optional = await lib.listProviderModels({
    hub,
    cliJson: { mocklocal: { baseURL: optionalBase, keyEnv: "PMTEST_MISSING_KEY", optionalKey: true, models: ["static-local"] } },
    provider: "mocklocal",
  });
  assert(optional.ok === true && optional.source === "live", `optionalKey live fetch failed: ${optional.error}`);
  assert(optionalAuth === "none", "optionalKey provider must not send a stale/empty key header");
  assert(optional.models.length === 1 && optional.models[0].id === "local-chat-model", "optionalKey live models wrong");
  optionalMock.close();

  openaiMock.close();

  // --- Anthropic-style mock with pagination + x-api-key header ---
  const pages = [
    { data: [{ type: "model", id: "claude-a", display_name: "Claude A" }], has_more: true },
    { data: [{ type: "model", id: "claude-b", display_name: "Claude B" }], has_more: false },
  ];
  let sawXApiKey = null;
  const anthropicMock = await withServer((req, res) => {
    sawXApiKey = req.headers["x-api-key"] || "";
    const url = new URL(req.url, "http://x");
    const after = url.searchParams.get("after_id");
    const body = after ? pages[1] : pages[0];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const anthropicBase = `http://127.0.0.1:${anthropicMock.address().port}/v1`;
  const liveAnthropic = await lib.listProviderModels({
    hub,
    cliJson: { mockclaude: { baseURL: anthropicBase, modelsStyle: "anthropic", keyEnv: "PMTEST_SAVED_KEY", models: ["static-claude"] } },
    provider: "mockclaude",
  });
  assert(liveAnthropic.ok === true && liveAnthropic.source === "live", `anthropic-style fetch failed: ${liveAnthropic.error}`);
  assert(sawXApiKey === "abc123", "x-api-key header not sent for anthropic style");
  assert(liveAnthropic.models.length === 2, "anthropic pagination merged wrong");
  assert(liveAnthropic.models[0].name === "Claude A" && liveAnthropic.models[1].id === "claude-b",
    "anthropic display names/pagination wrong");
  anthropicMock.close();

  // Unknown provider → graceful fallback shape
  const unknown = await lib.listProviderModels({ hub, cliJson: cliJsonOpenai, provider: "not-a-provider" });
  assert(unknown.ok === false && Array.isArray(unknown.models) && unknown.models.length === 0,
    "unknown provider should return empty fallback");

  console.log("provider-models: ok");
})().catch((err) => { console.error("  FAIL: " + (err && err.message)); process.exit(1); });
NODE

echo "provider-models: all checks passed"
