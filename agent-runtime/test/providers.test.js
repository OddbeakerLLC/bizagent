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
    const r = resolveProvider({ provider: "xai", apiKey: "k" });
    assert.equal(r.baseURL, PROVIDERS.grok.baseURL);
  });

  it("honors baseURL override", () => {
    const r = resolveProvider({
      baseURL: "http://127.0.0.1:9999/v1",
      apiKey: "x",
      model: "m",
    });
    assert.equal(r.baseURL, "http://127.0.0.1:9999/v1");
  });

  it("ollama allows missing key", () => {
    const prev = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    try {
      const r = resolveProvider({ provider: "ollama" });
      assert.ok(r.apiKey);
    } finally {
      if (prev !== undefined) process.env.OLLAMA_API_KEY = prev;
    }
  });
});
