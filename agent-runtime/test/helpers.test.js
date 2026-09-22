'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acquireSlot,
  effectivePoolSize,
  hireHelper,
  loadHelpersConfig,
  productCount,
  releaseSlot,
} = require('../src/helpers');
const { helperToolsForKind, TOOLS } = require('../src/tools');
const { buildHelperSystemPrompt, buildSystemPrompt } = require('../src/system-prompt');

function writeRegistry(dir, { enabled = true, pool_size = 10, products = 2 } = {}) {
  const list = [];
  for (let i = 0; i < products; i += 1) {
    list.push({ slug: `p${i}`, name: `P${i}`, agent_name: `Agent ${i}` });
  }
  const registry = {
    org: 'Test',
    settings: {
      helpers: {
        enabled,
        pool_size,
        provider: 'venice',
        model: 'qwen3-5-9b',
        max_concurrent_per_agent: 1,
        max_wall_secs: 120,
        max_depth: 1,
        allow: ['research', 'search', 'summarize', 'test-extract'],
      },
    },
    products: list,
  };
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(registry, null, 2));
}

describe('standby helpers', () => {
  let dir;
  const prevHub = process.env.BIZAGENT_HUB;
  const prevSlug = process.env.BIZAGENT_AGENT_SLUG;
  const prevHelper = process.env.BIZAGENT_HELPER;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-helpers-'));
    process.env.BIZAGENT_HUB = dir;
    process.env.BIZAGENT_AGENT_SLUG = 'widgets';
    delete process.env.BIZAGENT_HELPER;
  });

  after(() => {
    if (prevHub === undefined) delete process.env.BIZAGENT_HUB;
    else process.env.BIZAGENT_HUB = prevHub;
    if (prevSlug === undefined) delete process.env.BIZAGENT_AGENT_SLUG;
    else process.env.BIZAGENT_AGENT_SLUG = prevSlug;
    if (prevHelper === undefined) delete process.env.BIZAGENT_HELPER;
    else process.env.BIZAGENT_HELPER = prevHelper;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pool floor 10, matches product count when higher', () => {
    assert.equal(effectivePoolSize(10, 2), 10);
    assert.equal(effectivePoolSize(10, 12), 12);
    assert.equal(effectivePoolSize(2, 0), 2);
  });

  it('loads registry helpers and effective pool', () => {
    writeRegistry(dir, { products: 12, pool_size: 10 });
    const cfg = loadHelpersConfig(dir);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.product_count, 12);
    assert.equal(cfg.effective_pool, 12);
    assert.equal(cfg.provider, 'venice');
    assert.equal(cfg.model, 'qwen3-5-9b');
    assert.equal(productCount(JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'))), 12);
  });

  it('refuses hire when disabled', async () => {
    writeRegistry(dir, { enabled: false, products: 2 });
    const r = await hireHelper({
      kind: 'research',
      justification: 'Summarize these files so I can decide.',
      prompt: 'Read README',
      done_when: 'Return bullets',
    }, dir);
    assert.equal(r.success, false);
    assert.match(r.error, /disabled/i);
  });

  it('refuses unknown kind and nested hire', async () => {
    writeRegistry(dir, { enabled: true, products: 2 });
    let r = await hireHelper({
      kind: 'rewrite',
      justification: 'Do a write for me please.',
      prompt: 'edit files',
      done_when: 'done',
    }, dir);
    assert.equal(r.success, false);
    assert.match(r.error, /not allowed/);

    process.env.BIZAGENT_HELPER = '1';
    r = await hireHelper({
      kind: 'research',
      justification: 'Need a nested helper.',
      prompt: 'look around',
      done_when: 'done',
    }, dir);
    delete process.env.BIZAGENT_HELPER;
    assert.equal(r.success, false);
    assert.match(r.error, /cannot hire/i);
  });

  it('pool full returns a clear error', async () => {
    writeRegistry(dir, { enabled: true, pool_size: 10, products: 2 });
    const slots = [];
    for (let i = 0; i < 10; i += 1) {
      process.env.BIZAGENT_AGENT_SLUG = `agent-${i}`;
      const slot = acquireSlot(dir, {
        parentSlug: `agent-${i}`,
        kind: 'research',
        pool: 10,
        perAgent: 1,
      });
      assert.equal(slot.ok, true, slot.error);
      slots.push(slot);
    }
    process.env.BIZAGENT_AGENT_SLUG = 'overflow';
    const r = await hireHelper({
      kind: 'search',
      justification: 'Need one more grep than the pool allows.',
      prompt: 'grep foo',
      done_when: 'hits',
    }, dir);
    assert.equal(r.success, false);
    assert.match(r.error, /pool full/i);
    for (const s of slots) releaseSlot(dir, s.id);
    process.env.BIZAGENT_AGENT_SLUG = 'widgets';
  });

  it('helper tool set is read-only; test-extract adds shell', () => {
    const names = helperToolsForKind('research').map((t) => t.function.name);
    assert.ok(names.includes('read_file'));
    assert.ok(!names.includes('write_file'));
    assert.ok(!names.includes('hire_helper'));
    assert.ok(!names.includes('execute_shell_command'));
    const testNames = helperToolsForKind('test-extract').map((t) => t.function.name);
    assert.ok(testNames.includes('execute_shell_command'));
    assert.ok(TOOLS.some((t) => t.function.name === 'hire_helper'));
  });

  it('helper system prompt forbids writes and hire', () => {
    const helper = buildHelperSystemPrompt({ cwd: '/tmp' });
    assert.match(helper, /standby helper/i);
    assert.match(helper, /cannot write/i);
    const parent = buildSystemPrompt({ cwd: '/tmp' });
    assert.match(parent, /hire_helper/);
  });

  it('executeToolCall blocks writes in helper process', async () => {
    const { executeToolCall } = require('../src/tools');
    process.env.BIZAGENT_HELPER = '1';
    try {
      const r = await executeToolCall({
        function: {
          name: 'write_file',
          arguments: JSON.stringify({ path: path.join(dir, 'nope.txt'), content: 'x' }),
        },
      });
      assert.equal(r.success, false);
      assert.match(r.error, /cannot use write_file/i);
      assert.equal(fs.existsSync(path.join(dir, 'nope.txt')), false);
    } finally {
      delete process.env.BIZAGENT_HELPER;
    }
  });

  it('index.js gates helper tools with helperToolsForKind, not unbound HELPER_TOOLS', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    assert.match(src, /helperToolsForKind\(process\.env\.BIZAGENT_HELPER_KIND\)/);
    assert.equal(/\bHELPER_TOOLS\b/.test(src), false);
  });

  it('helper process can run a read tool without throwing', async () => {
    const { executeToolCall, helperToolsForKind } = require('../src/tools');
    const src = path.join(dir, 'helper-read.txt');
    fs.writeFileSync(src, 'helper-ok\n');
    process.env.BIZAGENT_HELPER = '1';
    process.env.BIZAGENT_HELPER_KIND = 'research';
    try {
      const allowed = helperToolsForKind(process.env.BIZAGENT_HELPER_KIND).some(
        (t) => t.function.name === 'read_file',
      );
      assert.equal(allowed, true);
      const r = await executeToolCall({
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: src }),
        },
      });
      assert.equal(r.success, true);
      assert.match(r.content, /helper-ok/);
    } finally {
      delete process.env.BIZAGENT_HELPER;
      delete process.env.BIZAGENT_HELPER_KIND;
    }
  });
});
