'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  parsePaste,
  sanitizeServerName,
  slugFromUrl,
  upsertEnvKeys,
  upsertServer,
  ensureMcpSettings,
  normalizeAuthValue,
  envKeyForServer,
} = require('./mcp-onboard.js');

const ONBOARD = path.join(__dirname, 'mcp-onboard.js');
const FAKE_HTTP = path.join(
  __dirname,
  '..',
  'agent-runtime',
  'test',
  'fixtures',
  'fake-mcp-http-server.js',
);

function startFixtureServer(scriptPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [scriptPath], {
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

function runOnboard(hub, args, input) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [ONBOARD, '--hub', hub, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BIZAGENT_HUB: hub },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c) => {
      stdout += c;
    });
    proc.stderr.on('data', (c) => {
      stderr += c;
    });
    proc.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch (_e) {
        /* leave null */
      }
      resolve({ code, stdout, stderr, json });
    });
    if (input != null) {
      proc.stdin.write(input);
    }
    proc.stdin.end();
  });
}

describe('mcp-onboard unit', () => {
  it('sanitizeServerName / slugFromUrl', () => {
    assert.equal(sanitizeServerName('Zapier MCP!'), 'Zapier_MCP');
    assert.equal(slugFromUrl('https://mcp.zapier.com/api/mcp/s/abc'), 'zapier_api_mcp');
    assert.ok(slugFromUrl('https://example.com/mcp').length > 0);
  });

  it('normalizeAuthValue adds Bearer', () => {
    assert.equal(normalizeAuthValue('sk-abc'), 'Bearer sk-abc');
    assert.equal(normalizeAuthValue('Bearer sk-abc'), 'Bearer sk-abc');
    assert.equal(normalizeAuthValue('bearer tok'), 'Bearer tok');
  });

  it('parse Cursor-style mcpServers JSON', () => {
    const paste = JSON.stringify({
      mcpServers: {
        zapier: {
          url: 'https://mcp.zapier.com/api/mcp/s/xyz',
          headers: { Authorization: 'Bearer secret-token-value-12345' },
        },
      },
    });
    const p = parsePaste(paste);
    assert.equal(p.missing.length, 0);
    assert.equal(p.name, 'zapier');
    assert.equal(p.url, 'https://mcp.zapier.com/api/mcp/s/xyz');
    assert.equal(p.transport, 'http');
    assert.ok(p.headers.Authorization);
    assert.ok(p.secrets[p.headers.Authorization]);
    assert.match(p.secrets[p.headers.Authorization], /^Bearer /);
    assert.ok(!JSON.stringify(p.headers).includes('secret-token'));
  });

  it('parse plain URL + Bearer text', () => {
    const paste = `
      MCP endpoint: https://tools.example.com/mcp
      Authorization: Bearer my-long-token-value-999
    `;
    const p = parsePaste(paste);
    assert.equal(p.missing.length, 0);
    assert.equal(p.url, 'https://tools.example.com/mcp');
    assert.ok(p.headers.Authorization);
  });

  it('parse flat JSON with token field', () => {
    const p = parsePaste(
      JSON.stringify({
        name: 'acme',
        url: 'https://mcp.acme.test/v1',
        token: 'tok_abcdef0123456789',
      }),
    );
    assert.equal(p.name, 'acme');
    assert.equal(p.url, 'https://mcp.acme.test/v1');
    assert.ok(Object.keys(p.secrets).length >= 1);
  });

  it('parse needs url when missing', () => {
    const p = parsePaste('just some notes, no endpoint');
    assert.ok(p.missing.some((m) => m.id === 'url'));
  });

  it('header env ref preserved (not treated as secret)', () => {
    const p = parsePaste(
      JSON.stringify({
        name: 'refed',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'MY_EXISTING_TOKEN' },
      }),
    );
    assert.equal(p.headers.Authorization, 'MY_EXISTING_TOKEN');
    assert.equal(Object.keys(p.secrets).length, 0);
  });

  it('upsertEnvKeys merges idempotently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-mcp-env-'));
    fs.mkdirSync(path.join(dir, '.bizagent'));
    fs.writeFileSync(path.join(dir, '.bizagent', 'env'), 'FOO=bar\n', 'utf8');
    const key = envKeyForServer('demo', 'token');
    upsertEnvKeys(dir, { [key]: 'Bearer one' });
    upsertEnvKeys(dir, { [key]: 'Bearer two' });
    const text = fs.readFileSync(path.join(dir, '.bizagent', 'env'), 'utf8');
    assert.match(text, /FOO=bar/);
    assert.equal(text.split(key).length - 1, 1);
    assert.match(text, /Bearer two/);
    assert.doesNotMatch(text, /Bearer one/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upsertServer updates in place by name', () => {
    const reg = { settings: {} };
    const mcp = ensureMcpSettings(reg);
    upsertServer(mcp, {
      name: 'a',
      transport: 'http',
      url: 'https://one.example/mcp',
      headers: { Authorization: 'K1' },
    });
    const r2 = upsertServer(mcp, {
      name: 'a',
      transport: 'sse',
      url: 'https://two.example/mcp',
      headers: { Authorization: 'K2' },
    });
    assert.equal(r2.updated, true);
    assert.equal(mcp.servers.length, 1);
    assert.equal(mcp.servers[0].url, 'https://two.example/mcp');
    assert.equal(mcp.servers[0].transport, 'sse');
    assert.equal(mcp.enabled, true);
  });
});

describe('mcp-onboard CLI', () => {
  let hubDir;
  let fixture;

  before(async () => {
    hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-mcp-onboard-hub-'));
    fs.mkdirSync(path.join(hubDir, '.bizagent'));
    fs.mkdirSync(path.join(hubDir, 'agent-runtime', 'src'), { recursive: true });
    // Point session verify at real mcp-client via copy/symlink of module tree is heavy;
    // instead symlink the whole agent-runtime from this repo.
    fs.rmSync(path.join(hubDir, 'agent-runtime'), { recursive: true, force: true });
    fs.symlinkSync(
      path.join(__dirname, '..', 'agent-runtime'),
      path.join(hubDir, 'agent-runtime'),
      'dir',
    );
    fs.writeFileSync(
      path.join(hubDir, 'registry.json'),
      JSON.stringify({ org: 'Test', settings: {}, products: [] }, null, 2),
    );
    fixture = await startFixtureServer(FAKE_HTTP);
  });

  after(async () => {
    if (fixture) await fixture.stop();
    if (hubDir) fs.rmSync(hubDir, { recursive: true, force: true });
  });

  it('paste connects to fixture and lists tools', async () => {
    const url = `http://127.0.0.1:${fixture.port}/mcp`;
    const paste = JSON.stringify({
      name: 'local_fixture',
      url,
      // open fixture — no auth
    });
    const r = await runOnboard(hubDir, ['paste', '--stdin', '--allow-no-auth'], paste);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.json);
    assert.equal(r.json.status, 'connected');
    assert.ok(r.json.tool_count >= 1);
    assert.match(r.json.message, /connected: local_fixture/);

    const reg = JSON.parse(fs.readFileSync(path.join(hubDir, 'registry.json'), 'utf8'));
    assert.equal(reg.settings.mcp.enabled, true);
    assert.equal(reg.settings.mcp.servers.length, 1);
    assert.equal(reg.settings.mcp.servers[0].url, url);

    // idempotent re-paste
    const r2 = await runOnboard(hubDir, ['paste', '--stdin', '--allow-no-auth'], paste);
    assert.equal(r2.code, 0);
    const reg2 = JSON.parse(fs.readFileSync(path.join(hubDir, 'registry.json'), 'utf8'));
    assert.equal(reg2.settings.mcp.servers.length, 1);
  });

  it('paste with token writes env ref not literal in registry', async () => {
    const url = `http://127.0.0.1:${fixture.port}/mcp`;
    const paste = JSON.stringify({
      name: 'authed_fix',
      url,
      token: 'super-secret-token-xyz-999',
    });
    const r = await runOnboard(hubDir, ['paste', '--stdin', '--no-verify'], paste);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const reg = JSON.parse(fs.readFileSync(path.join(hubDir, 'registry.json'), 'utf8'));
    const srv = reg.settings.mcp.servers.find((s) => s.name === 'authed_fix');
    assert.ok(srv);
    assert.ok(srv.headers.Authorization);
    assert.equal(srv.headers.Authorization.startsWith('MCP_'), true);
    const regText = fs.readFileSync(path.join(hubDir, 'registry.json'), 'utf8');
    assert.doesNotMatch(regText, /super-secret-token/);
    const envText = fs.readFileSync(path.join(hubDir, '.bizagent', 'env'), 'utf8');
    assert.match(envText, /super-secret-token-xyz-999/);
    assert.doesNotMatch(r.stdout, /super-secret-token-xyz-999/);
  });

  it('parse exit 2 when url missing', async () => {
    const r = await runOnboard(hubDir, ['parse', '--stdin'], 'no url here');
    assert.equal(r.code, 2);
    assert.equal(r.json.status, 'needs_input');
  });
});
