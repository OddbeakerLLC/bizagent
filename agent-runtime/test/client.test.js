const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeMessages } = require("../src/client");

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
