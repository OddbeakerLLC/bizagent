const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  toolCallSignature,
  loopGuardThresholds,
  LOOP_NUDGE_TEXT,
} = require("../src/index");

describe("toolCallSignature", () => {
  it("is stable for identical name + args regardless of key order", () => {
    const a = toolCallSignature("grep_search", { pattern: "x", path: "y" });
    const b = toolCallSignature("grep_search", { path: "y", pattern: "x" });
    assert.equal(a, b);
  });

  it("differs when args differ", () => {
    const a = toolCallSignature("grep_search", { pattern: "x" });
    const b = toolCallSignature("grep_search", { pattern: "y" });
    assert.notEqual(a, b);
  });

  it("differs when tool name differs", () => {
    const a = toolCallSignature("grep_search", { pattern: "x" });
    const b = toolCallSignature("read_file", { pattern: "x" });
    assert.notEqual(a, b);
  });

  it("handles unparseable / non-object args without throwing", () => {
    assert.doesNotThrow(() => toolCallSignature("t", null));
    assert.doesNotThrow(() => toolCallSignature("t", "raw"));
    assert.notEqual(toolCallSignature("t", null), toolCallSignature("t", "raw"));
  });
});

describe("loopGuardThresholds", () => {
  it("defaults to nudge=3 stop=5", () => {
    const savedNudge = process.env.BIZAGENT_AGENT_LOOP_NUDGE;
    const savedStop = process.env.BIZAGENT_AGENT_LOOP_STOP;
    delete process.env.BIZAGENT_AGENT_LOOP_NUDGE;
    delete process.env.BIZAGENT_AGENT_LOOP_STOP;
    try {
      assert.deepEqual(loopGuardThresholds(), { nudge: 3, stop: 5 });
    } finally {
      if (savedNudge != null) process.env.BIZAGENT_AGENT_LOOP_NUDGE = savedNudge;
      if (savedStop != null) process.env.BIZAGENT_AGENT_LOOP_STOP = savedStop;
    }
  });

  it("honors env overrides and clamps to sane bounds", () => {
    const savedNudge = process.env.BIZAGENT_AGENT_LOOP_NUDGE;
    const savedStop = process.env.BIZAGENT_AGENT_LOOP_STOP;
    try {
      process.env.BIZAGENT_AGENT_LOOP_NUDGE = "2";
      process.env.BIZAGENT_AGENT_LOOP_STOP = "7";
      assert.deepEqual(loopGuardThresholds(), { nudge: 2, stop: 7 });
      process.env.BIZAGENT_AGENT_LOOP_NUDGE = "bogus";
      process.env.BIZAGENT_AGENT_LOOP_STOP = "-4";
      assert.deepEqual(loopGuardThresholds(), { nudge: 3, stop: 3 });
    } finally {
      if (savedNudge != null) process.env.BIZAGENT_AGENT_LOOP_NUDGE = savedNudge;
      else delete process.env.BIZAGENT_AGENT_LOOP_NUDGE;
      if (savedStop != null) process.env.BIZAGENT_AGENT_LOOP_STOP = savedStop;
      else delete process.env.BIZAGENT_AGENT_LOOP_STOP;
    }
  });
});

describe("LOOP_NUDGE_TEXT", () => {
  it("tells the model to stop repeating and change approach", () => {
    assert.match(LOOP_NUDGE_TEXT, /Do NOT repeat it/);
    assert.match(LOOP_NUDGE_TEXT, /different approach/);
  });
});
