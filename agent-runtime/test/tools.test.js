const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  executeToolCall,
  TOOLS,
  searchReplaceTool,
} = require('../src/tools');

describe('tools', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-agent-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exports expanded tool schemas', () => {
    const names = TOOLS.map((t) => t.function.name);
    for (const n of [
      'list_directory',
      'glob_files',
      'grep_search',
      'read_file',
      'write_file',
      'search_replace',
      'execute_shell_command',
    ]) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
  });

  it('write/read/search_replace/delete', async () => {
    const file = path.join(dir, 'a.txt');
    let r = await executeToolCall({
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: file, content: 'hello world' }),
      },
    });
    assert.equal(r.success, true);

    r = await executeToolCall({
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ path: file }),
      },
    });
    assert.equal(r.content, 'hello world');

    r = await executeToolCall({
      function: {
        name: 'search_replace',
        arguments: JSON.stringify({
          path: file,
          old_string: 'world',
          new_string: 'bizagent',
        }),
      },
    });
    assert.equal(r.success, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello bizagent');

    r = await executeToolCall({
      function: {
        name: 'delete_file',
        arguments: JSON.stringify({ path: file }),
      },
    });
    assert.equal(r.success, true);
    assert.equal(fs.existsSync(file), false);
  });

  it('search_replace rejects ambiguous matches', async () => {
    const file = path.join(dir, 'dup.txt');
    fs.writeFileSync(file, 'aa aa aa');
    await assert.rejects(
      () => searchReplaceTool(file, 'aa', 'bb', false),
      /3 times|matched/,
    );
    const r = await searchReplaceTool(file, 'aa', 'bb', true);
    assert.equal(r.replacements, 3);
    assert.equal(fs.readFileSync(file, 'utf8'), 'bb bb bb');
  });

  it('list_directory and grep_search', async () => {
    const f = path.join(dir, 'findme.js');
    fs.writeFileSync(f, 'const uniqueTokenBizAgent = 1;\n');
    let r = await executeToolCall({
      function: {
        name: 'list_directory',
        arguments: JSON.stringify({ path: dir }),
      },
    });
    assert.equal(r.success, true);
    assert.ok(r.entries.some((e) => e.name === 'findme.js'));

    r = await executeToolCall({
      function: {
        name: 'grep_search',
        arguments: JSON.stringify({
          pattern: 'uniqueTokenBizAgent',
          path: dir,
        }),
      },
    });
    assert.equal(r.success, true);
    assert.ok(r.count >= 1);
  });

  it('execute_shell_command returns non-zero without throwing', async () => {
    const r = await executeToolCall({
      function: {
        name: 'execute_shell_command',
        arguments: JSON.stringify({ command: 'exit 7' }),
      },
    });
    assert.equal(r.success, false);
    assert.equal(r.exit_code, 7);
  });

  it('execute_shell_command success', async () => {
    const r = await executeToolCall({
      function: {
        name: 'execute_shell_command',
        arguments: JSON.stringify({ command: 'echo hi' }),
      },
    });
    assert.equal(r.success, true);
    assert.match(r.stdout, /hi/);
  });
});
