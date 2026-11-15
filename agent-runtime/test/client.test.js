const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeMessages,
  ensureUserMessage,
  chatCompletion,
  isTransientError,
  retryDelayMs,
  agentMaxRetries,
  isOllamaBaseURL,
  ollamaOrigin,
  thinkingLevelToThink,
  ollamaNativeChatCompletion,
} = require("../src/client");

describe("sanitizeMessages", () => {
  it("strips name:null and junk fields from a malformed assistant message", () => {
    // Shape observed in the wild from Venice (400 on replay: name must be a string)
    const dirty = {
      content: "",
      name: null,
      role: "assistant",
      tool_calls: [
        {
          id: "chatcmpl-tool-aba3024e9c34dc83",
          type: "function",
          function: { name: "execute_shell_command", arguments: '{"command":"ls"}' },
        },
      ],
      reasoning: "smoking gun",
    };
    const [out] = sanitizeMessages([dirty]);
    assert.deepEqual(out, {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "chatcmpl-tool-aba3024e9c34dc83",
          type: "function",
          function: { name: "execute_shell_command", arguments: '{"command":"ls"}' },
        },
      ],
      reasoning: "smoking gun",
    });
    assert.equal(out.name, undefined);
  });

  it("keeps a clean Venice message intact incl. reasoning_content", () => {
    const clean = {
      role: "assistant",
      content: "",
      refusal: null,
      annotations: null,
      audio: null,
      function_call: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "t", arguments: "{}" } },
      ],
      reasoning_content: "thinking...",
    };
    const [out] = sanitizeMessages([clean]);
    assert.equal(out.role, "assistant");
    assert.equal(out.content, "");
    assert.equal(out.tool_calls.length, 1);
    assert.equal(out.tool_calls[0].id, "c1");
    assert.equal(out.reasoning_content, "thinking...");
    assert.equal(out.refusal, undefined);
    assert.equal(out.annotations, undefined);
  });

  it("drops invalid tool_calls entries and keeps name when a string", () => {
    const msg = {
      role: "assistant",
      content: "hi",
      name: "agent",
      tool_calls: [
        { id: "ok", type: "function", function: { name: "t", arguments: "{}" } },
        { id: "bad", type: "function", function: {} },
        null,
      ],
    };
    const [out] = sanitizeMessages([msg]);
    assert.equal(out.name, "agent");
    assert.equal(out.tool_calls.length, 1);
    assert.equal(out.tool_calls[0].id, "ok");
  });

  it("normalizes tool and user messages", () => {
    const msgs = sanitizeMessages([
      { role: "tool", tool_call_id: "c1", content: { ok: true } },
      { role: "user", content: "hello" },
      { role: "", content: "x" },
    ]);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], { role: "tool", tool_call_id: "c1", content: '{"ok":true}' });
    assert.deepEqual(msgs[1], { role: "user", content: "hello" });
  });
});

describe("transient-error retry with real backoff", () => {
  const ENV_KEYS = ["BIZAGENT_AGENT_MAX_RETRIES", "BIZAGENT_AGENT_RETRY_BASE_MS"];

  function withEnv(fn) {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    return async () => {
      try {
        await fn();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };
  }

  function fakeClient(script) {
    let call = 0;
    const calls = [];
    return {
      calls,
      chat: {
        completions: {
          async create(body) {
            calls.push({ body, at: Date.now() });
            const step = script[Math.min(call, script.length - 1)];
            call += 1;
            if (step instanceof Error) throw step;
            return step;
          },
        },
      },
    };
  }

  it("retries a 502 with growing delays and recovers",
    withEnv(async () => {
      process.env.BIZAGENT_AGENT_MAX_RETRIES = "3";
      process.env.BIZAGENT_AGENT_RETRY_BASE_MS = "20";
      const err502 = Object.assign(new Error("bad gateway"), { status: 502 });
      const client = fakeClient([err502, err502, { choices: [{ message: { content: "ok" } }] }]);
      const out = await chatCompletion(client, "m", [{ role: "user", content: "hi" }], []);
      assert.equal(out.choices[0].message.content, "ok");
      assert.equal(client.calls.length, 3);
      // Second attempt must be spaced by at least the base delay (not instant).
      const gap = client.calls[1].at - client.calls[0].at;
      assert.ok(gap >= 20, `expected retry spaced >=20ms, got ${gap}ms`);
    }));

  it("gives up after max retries and rethrows the last error, total window spread over the delays",
    withEnv(async () => {
      process.env.BIZAGENT_AGENT_MAX_RETRIES = "2";
      process.env.BIZAGENT_AGENT_RETRY_BASE_MS = "20";
      const err502 = Object.assign(new Error("bad gateway"), { status: 502 });
      const client = fakeClient([err502]);
      const t0 = Date.now();
      await assert.rejects(
        () => chatCompletion(client, "m", [{ role: "user", content: "hi" }], []),
        /bad gateway/,
      );
      const elapsed = Date.now() - t0;
      // attempts: 1 immediate + 2 retries; delays ~20ms + ~40ms (+jitter) => >= 55ms total
      assert.ok(client.calls.length === 3, `expected 3 attempts, got ${client.calls.length}`);
      assert.ok(elapsed >= 55, `expected total retry window >=55ms, got ${elapsed}ms`);
    }));

  it("does not retry non-transient errors (400/401/402)", async () => {
    const err400 = Object.assign(new Error("bad request"), { status: 400 });
    const client = fakeClient([err400]);
    await assert.rejects(
      () => chatCompletion(client, "m", [{ role: "user", content: "hi" }], []),
      /bad request/,
    );
    assert.equal(client.calls.length, 1);
  });

  it("classifies transient vs non-transient errors", () => {
    assert.ok(isTransientError(Object.assign(new Error("x"), { status: 502 })));
    assert.ok(isTransientError(Object.assign(new Error("x"), { status: 429 })));
    assert.ok(isTransientError(Object.assign(new Error("x"), { status: 500 })));
    assert.ok(isTransientError(Object.assign(new Error("x"), { code: "ECONNRESET" })));
    assert.ok(isTransientError(Object.assign(new Error("x"), { name: "APIConnectionError" })));
    assert.ok(!isTransientError(Object.assign(new Error("x"), { status: 400 })));
    assert.ok(!isTransientError(Object.assign(new Error("x"), { status: 401 })));
    assert.ok(!isTransientError(null));
  });

  it("honors a Retry-After header over the computed backoff", () => {
    const err = Object.assign(new Error("x"), {
      status: 502,
      headers: { "retry-after": "7" },
    });
    assert.ok(retryDelayMs(0, err) >= 7000);
  });

  it("default config spreads the full retry cycle over ~30-60s", () => {
    delete process.env.BIZAGENT_AGENT_MAX_RETRIES;
    delete process.env.BIZAGENT_AGENT_RETRY_BASE_MS;
    assert.equal(agentMaxRetries(), 3);
    // base 5s: delays 5s + 10s + 20s = 35s minimum total window (plus jitter)
    const d0 = retryDelayMs(0, null);
    const d1 = retryDelayMs(1, null);
    const d2 = retryDelayMs(2, null);
    for (const [d, lo, hi] of [[d0, 5000, 10000], [d1, 10000, 20000], [d2, 20000, 40000]]) {
      assert.ok(d >= lo && d <= hi, `delay ${d} outside [${lo},${hi}]`);
    }
    assert.ok(d0 + d1 + d2 >= 30000 && d0 + d1 + d2 <= 60000,
      `default total window ${d0 + d1 + d2}ms outside 30-60s`);
  });
});

describe("ensureUserMessage (Ollama 'no user query found in messages' 500)", () => {
  it("appends a neutral user message when the history has none", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "hi" },
    ];
    const out = ensureUserMessage(msgs);
    assert.equal(out.length, 3);
    assert.equal(out[out.length - 1].role, "user");
    assert.ok(typeof out[out.length - 1].content === "string");
  });

  it("leaves a history that already has a user message untouched", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const out = ensureUserMessage(msgs);
    assert.equal(out.length, 3);
    assert.equal(out[1].content, "hello");
  });

  it("chatCompletion injects the user message into the request body", async () => {
    const bodies = [];
    const client = {
      chat: {
        completions: {
          async create(body) {
            bodies.push(body);
            return { choices: [{ message: { content: "ok" } }] };
          },
        },
      },
    };
    await chatCompletion(client, "m", [
      { role: "system", content: "sys" },
      { role: "assistant", content: "hi" },
    ], []);
    assert.equal(bodies[0].messages[bodies[0].messages.length - 1].role, "user");
  });
});

describe("ollama thinking control", () => {
  it("maps levels to the native think flag", () => {
    assert.equal(thinkingLevelToThink("low"), false);
    assert.equal(thinkingLevelToThink("off"), false);
    assert.equal(thinkingLevelToThink("medium"), true);
    assert.equal(thinkingLevelToThink("on"), true);
    assert.equal(thinkingLevelToThink("high"), true);
    assert.equal(thinkingLevelToThink(""), null);
    assert.equal(thinkingLevelToThink("bogus"), null);
  });

  it("detects Ollama base URLs and strips /v1 for the native origin", () => {
    assert.ok(isOllamaBaseURL("http://127.0.0.1:11434/v1"));
    assert.ok(isOllamaBaseURL("http://localhost:11434/v1"));
    assert.ok(isOllamaBaseURL("http://jobe.lan:11434/v1"));
    assert.equal(isOllamaBaseURL("https://api.venice.ai/api/v1"), false);
    assert.equal(ollamaOrigin("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434");
    assert.equal(ollamaOrigin("http://jobe.lan:11434"), "http://jobe.lan:11434");
  });

  it("routes an explicit thinking level for an Ollama baseURL through the native API", async () => {
    const savedFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: "qwen3.8:27b-64k",
          created_at: "2026-11-14T00:00:00Z",
          message: { role: "assistant", content: "native says hi" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 11,
          eval_count: 7,
        }),
      };
    };
    try {
      const client = { baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama" };
      const out = await chatCompletion(
        client,
        "qwen3.8:27b-64k",
        [{ role: "system", content: "sys" }, { role: "assistant", content: "hi" }],
        [],
        { thinking: "low" },
      );
      // Native endpoint, think:false honored, OpenAI-shaped response back.
      assert.equal(requests.length, 1);
      assert.ok(requests[0].url.endsWith("/api/chat"));
      assert.equal(requests[0].body.think, false);
      assert.equal(requests[0].body.stream, false);
      // No-user-message history got the neutral user message injected.
      const roles = requests[0].body.messages.map((m) => m.role);
      assert.ok(roles.includes("user"));
      assert.equal(out.object, "chat.completion");
      assert.equal(out.choices[0].message.content, "native says hi");
      assert.equal(out.choices[0].finish_reason, "stop");
      assert.equal(out.usage.total_tokens, 18);
    } finally {
      global.fetch = savedFetch;
    }
  });

  it("keeps the OpenAI-compatible endpoint when no thinking level is set", async () => {
    const client = {
      baseURL: "http://127.0.0.1:11434/v1",
      chat: {
        completions: {
          async create(body) {
            return { choices: [{ message: { content: "sdk path" } }] };
          },
        },
      },
    };
    const out = await chatCompletion(client, "m", [{ role: "user", content: "hi" }], []);
    assert.equal(out.choices[0].message.content, "sdk path");
  });

  it("native path converts OpenAI tool_calls to Ollama shape and back", async () => {
    const savedFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, init) => {
      requests.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: "m",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "list_directory", arguments: { path: "." } } }],
          },
          done: true,
          done_reason: "stop",
        }),
      };
    };
    try {
      const client = { baseURL: "http://localhost:11434/v1", apiKey: "" };
      const out = await chatCompletion(
        client,
        "m",
        [{
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }],
        }],
        [],
        { thinking: "medium" },
      );
      // Outgoing: assistant tool_calls converted to Ollama native shape.
      const outMsg = requests[0].messages[0];
      assert.deepEqual(outMsg.tool_calls[0], { function: { name: "read_file", arguments: { path: "x" } } });
      assert.equal(requests[0].think, true);
      // Incoming: Ollama tool_calls converted back to OpenAI shape.
      const tc = out.choices[0].message.tool_calls[0];
      assert.equal(tc.type, "function");
      assert.equal(tc.function.name, "list_directory");
      assert.equal(tc.function.arguments, '{"path":"."}');
      assert.equal(out.choices[0].finish_reason, "tool_calls");
    } finally {
      global.fetch = savedFetch;
    }
  });

  it("llmapi-mode client passes the thinking level through to the API", async () => {
    const savedEnv = process.env.BIZAGENT_LLMAPI_URL;
    const savedFetch = global.fetch;
    process.env.BIZAGENT_LLMAPI_URL = "http://127.0.0.1:18799";
    const requests = [];
    global.fetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      };
    };
    try {
      const { createClient } = require("../src/client");
      const client = createClient({ apiKey: "", baseURL: "", provider: "localhost" });
      await chatCompletion(client, "qwen3.8:27b-64k", [{ role: "user", content: "hi" }], [], { thinking: "low" });
      assert.ok(requests[0].url.endsWith("/v1/chat/completions"));
      assert.equal(requests[0].body.thinking, "low");
      assert.equal(requests[0].body.provider, "localhost");
    } finally {
      global.fetch = savedFetch;
      if (savedEnv === undefined) delete process.env.BIZAGENT_LLMAPI_URL;
      else process.env.BIZAGENT_LLMAPI_URL = savedEnv;
    }
  });
});
