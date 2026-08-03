const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { executeToolCall, TOOLS } = require("../src/tools");

describe("tools", () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ba-agent-"));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exports OpenAI-style tool schemas", () => {
    assert.ok(TOOLS.length >= 6);
    for (const t of TOOLS) {
      assert.equal(t.type, "function");
      assert.ok(t.function.name);
      assert.ok(t.function.parameters);
    }
  });

  it("write/read/search_replace/delete", async () => {
    const file = path.join(dir, "a.txt");
    let r = await executeToolCall({
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: file, content: "hello world" }),
      },
    });
    assert.equal(r.success, true);

    r = await executeToolCall({
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: file }),
      },
    });
    assert.equal(r.content, "hello world");

    r = await executeToolCall({
      function: {
        name: "search_replace",
        arguments: JSON.stringify({
          path: file,
          old_string: "world",
          new_string: "bizagent",
        }),
      },
    });
    assert.equal(r.success, true);
    assert.equal(fs.readFileSync(file, "utf8"), "hello bizagent");

    r = await executeToolCall({
      function: {
        name: "delete_file",
        arguments: JSON.stringify({ path: file }),
      },
    });
    assert.equal(r.success, true);
    assert.equal(fs.existsSync(file), false);
  });

  it("execute_shell_command", async () => {
    const r = await executeToolCall({
      function: {
        name: "execute_shell_command",
        arguments: JSON.stringify({ command: "echo hi" }),
      },
    });
    assert.equal(r.success, true);
    assert.match(r.stdout, /hi/);
  });
});
