'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  McpSession,
  loadMcpConfig,
  mcpToolName,
  parseMcpToolName,
  resolveHeaderRefs,
  normalizeTransport,
} = require('../src/mcp-client');

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
const FAKE_HTTP = path.join(__dirname, 'fixtures', 'fake-mcp-http-server.js');
const FAKE_SSE = path.join(__dirname, 'fixtures', 'fake-mcp-sse-server.js');

/**
 * Spawn a fixture HTTP server; resolve with { port, stop }.
 */
function startFixtureServer(scriptPath, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [scriptPath, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill('SIGTERM');
        } catch (_e) {
          /* ignore */
        }
        reject(new Error('fixture server start timeout'));
      }
    }, 8000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      const m = buf.match(/PORT\s+(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          port: Number(m[1]),
          stop: () =>
            new Promise((res) => {
              proc.once('close', () => res());
              try {
                proc.kill('SIGTERM');
              } catch (_e) {
                res();
              }
              setTimeout(() => {
                try {
                  proc.kill('SIGKILL');
                } catch (_e) {
                  /* ignore */
                }
                res();
              }, 1500).unref?.();
            }),
        });
      }
    });
    proc.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`fixture exited early code=${code}`));
      }
    });
  });
}

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

  it('normalizeTransport aliases', () => {
    assert.equal(normalizeTransport('stdio'), 'stdio');
    assert.equal(normalizeTransport('http'), 'http');
    assert.equal(normalizeTransport('streamable-http'), 'http');
    assert.equal(normalizeTransport('SSE'), 'sse');
    assert.equal(normalizeTransport('http+sse'), 'sse');
  });

  it('resolveHeaderRefs uses env names not literals', () => {
    process.env.BA_MCP_TEST_TOKEN = 'secret-value-xyz';
    const h = resolveHeaderRefs({ Authorization: 'BA_MCP_TEST_TOKEN' });
    assert.equal(h.Authorization, 'secret-value-xyz');
    delete process.env.BA_MCP_TEST_TOKEN;
    const missing = resolveHeaderRefs({ Authorization: 'BA_MCP_TEST_TOKEN' });
    assert.equal(missing.Authorization, undefined);
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

  it('list + call round-trip against fake Streamable HTTP server', async () => {
    const fixture = await startFixtureServer(FAKE_HTTP);
    try {
      fs.writeFileSync(
        path.join(hubDir, 'registry.json'),
        JSON.stringify({
          settings: {
            mcp: {
              enabled: true,
              servers: [
                {
                  name: 'remote',
                  transport: 'http',
                  url: `http://127.0.0.1:${fixture.port}/mcp`,
                },
              ],
            },
          },
        }),
      );
      const session = new McpSession();
      await session.start({ hubRoot: hubDir, connectTimeoutMs: 10000 });
      const tools = session.getOpenAiTools();
      const echo = tools.find((t) => t.function.name === 'mcp__remote__echo');
      assert.ok(echo, 'mcp__remote__echo missing');
      const result = await session.callTool('mcp__remote__echo', { text: 'hello-http' });
      assert.equal(result.success, true);
      assert.equal(result.content, 'hello-http');
      await session.close();
    } finally {
      await fixture.stop();
    }
  });

  it('list + call round-trip against fake HTTP server with SSE response body', async () => {
    const fixture = await startFixtureServer(FAKE_HTTP, ['--sse-response']);
    try {
      fs.writeFileSync(
        path.join(hubDir, 'registry.json'),
        JSON.stringify({
          settings: {
            mcp: {
              enabled: true,
              servers: [
                {
                  name: 'remote_sse_body',
                  transport: 'http',
                  url: `http://127.0.0.1:${fixture.port}/mcp`,
                },
              ],
            },
          },
        }),
      );
      const session = new McpSession();
      await session.start({ hubRoot: hubDir, connectTimeoutMs: 10000 });
      const result = await session.callTool('mcp__remote_sse_body__echo', {
        text: 'sse-body',
      });
      assert.equal(result.success, true);
      assert.equal(result.content, 'sse-body');
      await session.close();
    } finally {
      await fixture.stop();
    }
  });

  it('list + call round-trip against fake legacy SSE server', async () => {
    const fixture = await startFixtureServer(FAKE_SSE);
    try {
      fs.writeFileSync(
        path.join(hubDir, 'registry.json'),
        JSON.stringify({
          settings: {
            mcp: {
              enabled: true,
              servers: [
                {
                  name: 'legacy',
                  transport: 'sse',
                  url: `http://127.0.0.1:${fixture.port}/sse`,
                },
              ],
            },
          },
        }),
      );
      const session = new McpSession();
      await session.start({ hubRoot: hubDir, connectTimeoutMs: 10000 });
      const tools = session.getOpenAiTools();
      const echo = tools.find((t) => t.function.name === 'mcp__legacy__echo');
      assert.ok(echo, 'mcp__legacy__echo missing');
      const result = await session.callTool('mcp__legacy__echo', { text: 'hello-sse' });
      assert.equal(result.success, true);
      assert.equal(result.content, 'hello-sse');
      await session.close();
    } finally {
      await fixture.stop();
    }
  });

  it('HTTP unreachable soft-fails and leaves no tools', async () => {
    fs.writeFileSync(
      path.join(hubDir, 'registry.json'),
      JSON.stringify({
        settings: {
          mcp: {
            enabled: true,
            servers: [
              {
                name: 'down_http',
                transport: 'http',
                // Port unlikely to be listening
                url: 'http://127.0.0.1:9/mcp',
              },
            ],
          },
        },
      }),
    );
    const session = new McpSession();
    await session.start({ hubRoot: hubDir, connectTimeoutMs: 2000 });
    assert.equal(session.enabled, true);
    assert.equal(session.getOpenAiTools().length, 0);
    assert.equal(session.servers.size, 0);
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
                args: ['-e', 'process.exit(1)'],
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

  it('HTTP header env refs are applied (Authorization)', async () => {
    const fixture = await startFixtureServer(FAKE_HTTP);
    process.env.BA_MCP_HDR_TEST = 'Bearer test-token';
    try {
      fs.writeFileSync(
        path.join(hubDir, 'registry.json'),
        JSON.stringify({
          settings: {
            mcp: {
              enabled: true,
              servers: [
                {
                  name: 'authed',
                  transport: 'http',
                  url: `http://127.0.0.1:${fixture.port}/mcp`,
                  headers: { Authorization: 'BA_MCP_HDR_TEST' },
                },
              ],
            },
          },
        }),
      );
      const session = new McpSession();
      await session.start({ hubRoot: hubDir, connectTimeoutMs: 10000 });
      const r = await session.callTool('mcp__authed__echo', { text: 'hdr-ok' });
      assert.equal(r.success, true);
      assert.equal(r.content, 'hdr-ok');
      await session.close();
    } finally {
      delete process.env.BA_MCP_HDR_TEST;
      await fixture.stop();
    }
  });
});
