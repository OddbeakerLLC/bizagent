const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveProvider, listProviders, PROVIDERS } = require("../src/providers");

describe("providers", () => {
  it("lists built-in providers", () => {
    const names = listProviders();
    assert.ok(names.includes("grok"));
    assert.ok(names.includes("chatgpt"));
    assert.ok(names.includes("claude"));
    assert.ok(names.includes("gemini"));
    assert.ok(names.includes("venice"));
  });

  it("resolves explicit provider", () => {
    const r = resolveProvider({
      provider: "venice",
      apiKey: "test-key",
      model: "kimi-k2-7-code",
    });
    assert.equal(r.provider, "venice");
    assert.equal(r.baseURL, PROVIDERS.venice.baseURL);
    assert.equal(r.apiKey, "test-key");
    assert.equal(r.model, "kimi-k2-7-code");
  });

  it("maps xai alias to grok defaults", () => {
    const r = resolveProvider({ provider: "xai", apiKey: "k", model: "grok-4.5" });
    assert.equal(r.baseURL, PROVIDERS.grok.baseURL);
    assert.equal(r.model, "grok-4.5");
  });

  it("honors baseURL override", () => {
    const r = resolveProvider({
      baseURL: "http://127.0.0.1:9999/v1",
      apiKey: "x",
      model: "m",
    });
    assert.equal(r.baseURL, "http://127.0.0.1:9999/v1");
  });

  it("treats unknown provider name + explicit baseURL as custom provider (no grok fallback)", () => {
    const r = resolveProvider({
      provider: "beakernet",
      baseURL: "http://127.0.0.1:8901/v1",
      model: "prism-bonsai-27b",
    });
    assert.equal(r.provider, "beakernet");
    assert.equal(r.baseURL, "http://127.0.0.1:8901/v1");
  });

  it("treats unknown provider name + BIZAGENT_AGENT_BASE_URL as custom provider", () => {
    const prev = process.env.BIZAGENT_AGENT_BASE_URL;
    process.env.BIZAGENT_AGENT_BASE_URL = "http://127.0.0.1:8901/v1";
    try {
      const r = resolveProvider({
        provider: "beakernet",
        model: "prism-bonsai-27b",
      });
      assert.equal(r.provider, "beakernet");
      assert.equal(r.baseURL, "http://127.0.0.1:8901/v1");
    } finally {
      if (prev !== undefined) process.env.BIZAGENT_AGENT_BASE_URL = prev;
      else delete process.env.BIZAGENT_AGENT_BASE_URL;
    }
  });

  it("resolves beakernet from the catalog (local bb serve, optional key)", () => {
    const prev = process.env.BEAKERNET_API_KEY;
    delete process.env.BEAKERNET_API_KEY;
    try {
      const r = resolveProvider({
        provider: "beakernet",
        model: "prism-bonsai-27b",
      });
      assert.equal(r.provider, "beakernet");
      assert.equal(r.baseURL, "http://127.0.0.1:8901/v1");
      assert.ok(r.apiKey); // optionalKey fallback
    } finally {
      if (prev !== undefined) process.env.BEAKERNET_API_KEY = prev;
    }
  });

  it("unknown provider without baseURL still falls back to grok", () => {
    const r = resolveProvider({
      provider: "not-a-real-provider",
      apiKey: "k",
      model: "m",
    });
    assert.equal(r.provider, "grok");
    assert.equal(r.baseURL, PROVIDERS.grok.baseURL);
  });

  it("ollama allows missing key", () => {
    const prev = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    try {
      const r = resolveProvider({ provider: "ollama", model: "llama3.2" });
      assert.ok(r.apiKey);
      assert.equal(r.model, "llama3.2");
    } finally {
      if (prev !== undefined) process.env.OLLAMA_API_KEY = prev;
    }
  });

  it("throws when model is missing (no silent hardcoded default)", () => {
    const prev = process.env.BIZAGENT_AGENT_MODEL;
    delete process.env.BIZAGENT_AGENT_MODEL;
    try {
      assert.throws(
        () => resolveProvider({ provider: "venice", apiKey: "k" }),
        /Model is required/i,
      );
    } finally {
      if (prev !== undefined) process.env.BIZAGENT_AGENT_MODEL = prev;
    }
  });

  it("honors BIZAGENT_AGENT_MODEL env when opts.model empty", () => {
    const prev = process.env.BIZAGENT_AGENT_MODEL;
    process.env.BIZAGENT_AGENT_MODEL = "env-model-x";
    try {
      const r = resolveProvider({ provider: "venice", apiKey: "k" });
      assert.equal(r.model, "env-model-x");
    } finally {
      if (prev !== undefined) process.env.BIZAGENT_AGENT_MODEL = prev;
      else delete process.env.BIZAGENT_AGENT_MODEL;
    }
  });
});
