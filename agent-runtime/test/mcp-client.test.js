'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  McpSession,
  loadMcpConfig,
  mcpToolName,
  parseMcpToolName,
} = require('../src/mcp-client');

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

describe('mcp-client', () => {
  let hubDir;

  before(() => {
    hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-mcp-hub-'));
  });

  after(() => {
    fs.rmSync(hubDir, { recursive: true, force: true });
  });

  it('mcpToolName / parseMcpToolName round-trip', () => {
    const full = mcpToolName('demo', 'echo');
    assert.equal(full, 'mcp__demo__echo');
    const parsed = parseMcpToolName(full);
    assert.deepEqual(parsed, { server: 'demo', tool: 'echo' });
  });

  it('loadMcpConfig defaults enabled=false when missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-mcp-empty-'));
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ settings: {} }));
    const cfg = loadMcpConfig(dir);
    assert.equal(cfg.enabled, false);
    assert.deepEqual(cfg.servers, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('disabled config connects nothing', async () => {
    fs.writeFileSync(
      path.join(hubDir, 'registry.json'),
      JSON.stringify({
        settings: {
          mcp: {
            enabled: false,
            servers: [
              {
                name: 'fake',
                transport: 'stdio',
                command: process.execPath,
                args: [FAKE_SERVER],
              },
            ],
          },
        },
      }),
    );
    const session = new McpSession();
    await session.start({ hubRoot: hubDir });
    assert.equal(session.enabled, false);
    assert.equal(session.getOpenAiTools().length, 0);
    await session.close();
  });

  it('list + call round-trip against fake stdio server', async () => {
    fs.writeFileSync(
      path.join(hubDir, 'registry.json'),
      JSON.stringify({
        settings: {
          mcp: {
            enabled: true,
            servers: [
              {
                name: 'fake',
                transport: 'stdio',
                command: process.execPath,
                args: [FAKE_SERVER],
              },
            ],
          },
        },
      }),
    );
    const session = new McpSession();
    await session.start({ hubRoot: hubDir, connectTimeoutMs: 10000 });
    const tools = session.getOpenAiTools();
    assert.ok(tools.length >= 1, 'expected at least one MCP tool');
    const echo = tools.find((t) => t.function.name === 'mcp__fake__echo');
    assert.ok(echo, 'mcp__fake__echo missing');
    assert.match(echo.function.description, /MCP:fake/);

    const result = await session.callTool('mcp__fake__echo', { text: 'hello-mcp' });
    assert.equal(result.success, true);
    assert.equal(result.content, 'hello-mcp');
    assert.equal(result.mcp, true);

    await session.close();
  });

  it('server-down soft-fails and leaves no tools', async () => {
    fs.writeFileSync(
      path.join(hubDir, 'registry.json'),
      JSON.stringify({
        settings: {
          mcp: {
            enabled: true,
            servers: [
              {
                name: 'down',
                transport: 'stdio',
                command: process.execPath,
                args: ['-e', "process.exit(1)"],
              },
              {
                name: 'missing-bin',
                transport: 'stdio',
                command: '/nonexistent/mcp-server-binary-xyz',
                args: [],
              },
            ],
          },
        },
      }),
    );
    const session = new McpSession();
    await session.start({ hubRoot: hubDir, connectTimeoutMs: 3000 });
    // Soft-fail: session still "enabled" but no tools from dead servers
    assert.equal(session.enabled, true);
    assert.equal(session.getOpenAiTools().length, 0);
    assert.equal(session.servers.size, 0);
    await session.close();
  });

  it('one dead server does not block a healthy peer', async () => {
    fs.writeFileSync(
      path.join(hubDir, 'registry.json'),
      JSON.stringify({
        settings: {
          mcp: {
            enabled: true,
            servers: [
              {
                name: 'dead',
                transport: 'stdio',
                command: '/nonexistent/nope',
                args: [],
              },
              {
                name: 'fake',
                transport: 'stdio',
                command: process.execPath,
                args: [FAKE_SERVER],
              },
            ],
          },
        },
      }),
    );
    const session = new McpSession();
    await session.start({ hubRoot: hubDir, connectTimeoutMs: 8000 });
    const names = session.getOpenAiTools().map((t) => t.function.name);
    assert.ok(names.includes('mcp__fake__echo'));
    assert.ok(!names.some((n) => n.includes('dead')));
    const r = await session.callTool('mcp__fake__echo', { text: 'peer-ok' });
    assert.equal(r.success, true);
    assert.equal(r.content, 'peer-ok');
    await session.close();
  });
});
