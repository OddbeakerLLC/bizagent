const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeMessages,
  chatCompletion,
  isTransientError,
  retryDelayMs,
  agentMaxRetries,
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
