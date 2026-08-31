'use strict';

/**
 * MCP client (stdio transport, v1).
 *
 * Free/open base: runtime + BYO servers from registry settings.mcp.
 * Soft-fails per server so missing/hung MCP never blocks built-in tools.
 *
 * Extension points (additive, unused in v1):
 *   settings.mcp.allowlists / policy / audit — enterprise layering later
 *   settings.mcp.servers[].transport — only "stdio" in v1 (sse/http later)
 *
 * MCP is in-turn capability only. Filesystem mail remains the agent bus.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const DEFAULT_PROTOCOL = '2024-11-05';
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_LIST_TIMEOUT_MS = 15_000;

function logInfo(msg) {
  console.error(`[mcp] ${msg}`);
}

function logWarn(msg) {
  console.error(`[mcp] WARN: ${msg}`);
}

/**
 * Resolve hub root: BIZAGENT_HUB env, else walk up from cwd for registry.json.
 */
function resolveHubRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.BIZAGENT_HUB) return path.resolve(process.env.BIZAGENT_HUB);
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, 'registry.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function loadMcpConfig(hubRoot) {
  const file = path.join(hubRoot, 'registry.json');
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return { enabled: false, servers: [], hubRoot, source: file, found: false };
  }
  const mcp = (registry.settings && registry.settings.mcp) || {};
  const enabled = mcp.enabled === true;
  const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
  return {
    enabled,
    servers,
    hubRoot,
    source: file,
    found: true,
    // reserved for future enterprise layering (do not strip unknown keys upstream)
    allowlists: mcp.allowlists,
    policy: mcp.policy,
    audit: mcp.audit,
  };
}

/**
 * env map values are *refs* to process env var names (not secret literals in git).
 * { "TOKEN": "GITHUB_TOKEN" } → child env TOKEN=<process.env.GITHUB_TOKEN>
 */
function resolveServerEnv(envRefs) {
  const out = { ...process.env };
  if (!envRefs || typeof envRefs !== 'object') return out;
  for (const [childKey, ref] of Object.entries(envRefs)) {
    if (!childKey || typeof ref !== 'string' || !ref.trim()) continue;
    const val = process.env[ref.trim()];
    if (val === undefined || val === '') {
      logWarn(`env ref ${childKey}←${ref} is unset; omitting`);
      continue;
    }
    out[childKey] = val;
  }
  return out;
}

function sanitizeServerName(name) {
  const s = String(name || 'server')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'server';
}

function mcpToolName(serverName, toolName) {
  return `mcp__${sanitizeServerName(serverName)}__${String(toolName || '').trim()}`;
}

function parseMcpToolName(full) {
  const m = String(full || '').match(/^mcp__([^_]+(?:[._-][^_]+)*)__(.+)$/);
  // Prefer split on first "mcp__" + server + "__"
  if (String(full || '').startsWith('mcp__')) {
    const rest = String(full).slice('mcp__'.length);
    const idx = rest.indexOf('__');
    if (idx > 0) {
      return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
    }
  }
  if (m) return { server: m[1], tool: m[2] };
  return null;
}

class StdioJsonRpc extends EventEmitter {
  constructor({ command, args, env, cwd, name, connectTimeoutMs }) {
    super();
    this.name = name;
    this.command = command;
    this.args = args || [];
    this.env = env;
    this.cwd = cwd;
    this.connectTimeoutMs = connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    this._proc = null;
    this._buf = '';
    this._nextId = 1;
    this._pending = new Map();
    this._closed = false;
  }

  start() {
    if (this._proc) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      try {
        this._proc = spawn(this.command, this.args, {
          env: this.env,
          cwd: this.cwd || undefined,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } catch (err) {
        fail(err);
        return;
      }

      const timer = setTimeout(() => {
        fail(new Error(`spawn/connect timeout after ${this.connectTimeoutMs}ms`));
        this.close().catch(() => {});
      }, this.connectTimeoutMs);

      this._proc.once('spawn', () => {
        clearTimeout(timer);
        ok();
      });
      this._proc.once('error', (err) => {
        clearTimeout(timer);
        fail(err);
      });
      this._proc.on('close', (code, signal) => {
        this._closed = true;
        const err = new Error(
          `MCP server "${this.name}" exited code=${code} signal=${signal || ''}`,
        );
        for (const [, p] of this._pending) {
          p.reject(err);
        }
        this._pending.clear();
        this.emit('close', { code, signal });
      });

      this._proc.stdout.setEncoding('utf8');
      this._proc.stdout.on('data', (chunk) => this._onData(chunk));
      this._proc.stderr.setEncoding('utf8');
      this._proc.stderr.on('data', (chunk) => {
        const line = String(chunk).trim();
        if (line) logInfo(`${this.name} stderr: ${line.slice(0, 300)}`);
      });
    });
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      let line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_err) {
        logWarn(`${this.name}: non-JSON line ignored`);
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg && msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const e = new Error(msg.error.message || JSON.stringify(msg.error));
        e.code = msg.error.code;
        e.data = msg.error.data;
        pending.reject(e);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // notifications / server requests ignored in v1 client
  }

  request(method, params, timeoutMs) {
    if (this._closed || !this._proc || !this._proc.stdin.writable) {
      return Promise.reject(new Error(`MCP server "${this.name}" is not connected`));
    }
    const id = this._nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params: params === undefined ? {} : params,
    };
    const t = timeoutMs || DEFAULT_CALL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP ${method} timeout after ${t}ms (server=${this.name})`));
      }, t);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._proc.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    if (this._closed || !this._proc || !this._proc.stdin.writable) return;
    const payload = {
      jsonrpc: '2.0',
      method,
      params: params === undefined ? {} : params,
    };
    try {
      this._proc.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (_err) {
      /* ignore */
    }
  }

  async close() {
    if (!this._proc) return;
    const proc = this._proc;
    this._proc = null;
    this._closed = true;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server "${this.name}" closed`));
    }
    this._pending.clear();
    try {
      proc.stdin.end();
    } catch (_e) {
      /* ignore */
    }
    await new Promise((resolve) => {
      const done = () => resolve();
      proc.once('close', done);
      try {
        proc.kill('SIGTERM');
      } catch (_e) {
        resolve();
        return;
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch (_e) {
          /* ignore */
        }
        resolve();
      }, 2000).unref?.();
    });
  }
}

class McpSession {
  constructor() {
    this.servers = new Map(); // name → { rpc, tools: Map(toolName → def) }
    this.toolRoutes = new Map(); // full openai name → { server, tool }
    this.openaiTools = [];
    this.enabled = false;
  }

  /**
   * Connect configured servers. Soft-fails individually.
   * @returns {Promise<McpSession>}
   */
  async start(options = {}) {
    const hubRoot = resolveHubRoot(options.hubRoot);
    const cfg = options.config || loadMcpConfig(hubRoot);
    this.enabled = cfg.enabled === true;
    this.hubRoot = hubRoot;
    this.config = cfg;

    if (!this.enabled) {
      return this;
    }

    const servers = cfg.servers || [];
    if (servers.length === 0) {
      logInfo('enabled but no servers configured');
      return this;
    }

    for (const raw of servers) {
      await this._connectOne(raw, options);
    }

    if (this.openaiTools.length > 0) {
      const names = this.openaiTools.map((t) => t.function.name).join(', ');
      logInfo(`ready: ${this.openaiTools.length} tool(s) — ${names}`);
    } else {
      logInfo('no MCP tools available (all servers soft-failed or empty)');
    }
    return this;
  }

  async _connectOne(raw, options) {
    const name = sanitizeServerName(raw && raw.name);
    if (!raw || !name) {
      logWarn('skipping server with empty name');
      return;
    }
    if (this.servers.has(name)) {
      logWarn(`duplicate server name "${name}"; skipping`);
      return;
    }
    const transport = (raw.transport || 'stdio').toLowerCase();
    if (transport !== 'stdio') {
      logWarn(`server "${name}": transport "${transport}" not supported in v1 (stdio only); skip`);
      return;
    }
    const command = raw.command && String(raw.command).trim();
    if (!command) {
      logWarn(`server "${name}": missing command; skip`);
      return;
    }
    const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    const cwd = raw.cwd ? path.resolve(this.hubRoot, raw.cwd) : undefined;
    const env = resolveServerEnv(raw.env);
    const connectTimeoutMs =
      Number(options.connectTimeoutMs) ||
      Number(process.env.BIZAGENT_MCP_CONNECT_TIMEOUT_MS) ||
      DEFAULT_CONNECT_TIMEOUT_MS;
    const listTimeoutMs =
      Number(options.listTimeoutMs) ||
      Number(process.env.BIZAGENT_MCP_LIST_TIMEOUT_MS) ||
      DEFAULT_LIST_TIMEOUT_MS;

    const rpc = new StdioJsonRpc({
      name,
      command,
      args,
      env,
      cwd,
      connectTimeoutMs,
    });

    try {
      await rpc.start();
      await rpc.request(
        'initialize',
        {
          protocolVersion: DEFAULT_PROTOCOL,
          capabilities: {},
          clientInfo: { name: 'bizagent-agent', version: '0.1.0' },
        },
        connectTimeoutMs,
      );
      rpc.notify('notifications/initialized', {});
      const listed = await rpc.request('tools/list', {}, listTimeoutMs);
      const tools = Array.isArray(listed && listed.tools) ? listed.tools : [];
      const toolMap = new Map();
      for (const t of tools) {
        if (!t || !t.name) continue;
        toolMap.set(t.name, t);
        const fullName = mcpToolName(name, t.name);
        if (this.toolRoutes.has(fullName)) {
          logWarn(`tool name collision ${fullName}; keeping first`);
          continue;
        }
        this.toolRoutes.set(fullName, { server: name, tool: t.name });
        this.openaiTools.push({
          type: 'function',
          function: {
            name: fullName,
            description: `[MCP:${name}] ${t.description || t.name}`,
            parameters: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
          },
        });
      }
      this.servers.set(name, { rpc, tools: toolMap, raw });
      logInfo(
        `server "${name}" connected (${tools.length} tool(s): ${tools
          .map((t) => t.name)
          .join(', ') || 'none'})`,
      );
    } catch (err) {
      logWarn(`server "${name}" soft-fail: ${err.message || err}`);
      try {
        await rpc.close();
      } catch (_e) {
        /* ignore */
      }
    }
  }

  isMcpTool(name) {
    return this.toolRoutes.has(name) || (typeof name === 'string' && name.startsWith('mcp__'));
  }

  /**
   * Forward tools/call. Logs tool name only (not argument payloads).
   */
  async callTool(fullName, args, options = {}) {
    const route =
      this.toolRoutes.get(fullName) || parseMcpToolName(fullName);
    if (!route) {
      return { success: false, error: `Invalid MCP tool name: ${fullName}` };
    }
    const serverKey = sanitizeServerName(route.server);
    const entry = this.servers.get(serverKey);
    if (!entry) {
      return {
        success: false,
        error: `MCP server "${route.server}" is not connected`,
      };
    }
    const timeoutMs =
      Number(options.timeoutMs) ||
      Number(process.env.BIZAGENT_MCP_CALL_TIMEOUT_MS) ||
      DEFAULT_CALL_TIMEOUT_MS;

    logInfo(`call ${fullName}`);
    try {
      const result = await entry.rpc.request(
        'tools/call',
        {
          name: route.tool,
          arguments: args && typeof args === 'object' ? args : {},
        },
        timeoutMs,
      );
      // MCP result: { content: [...], isError?: boolean }
      const isError = !!(result && result.isError);
      const content = result && result.content;
      let text = '';
      if (Array.isArray(content)) {
        text = content
          .map((c) => {
            if (!c) return '';
            if (c.type === 'text') return c.text || '';
            return JSON.stringify(c);
          })
          .join('\n');
      } else if (result != null) {
        text = typeof result === 'string' ? result : JSON.stringify(result);
      }
      if (text.length > 100000) {
        text = `${text.slice(0, 100000)}\n…[truncated]`;
      }
      return {
        success: !isError,
        mcp: true,
        server: route.server,
        tool: route.tool,
        content: text,
        isError,
        structured: result && result.structuredContent,
      };
    } catch (err) {
      logWarn(`call ${fullName} failed: ${err.message || err}`);
      return {
        success: false,
        error: err.message || String(err),
        mcp: true,
        server: route.server,
        tool: route.tool,
      };
    }
  }

  getOpenAiTools() {
    return this.openaiTools.slice();
  }

  async close() {
    const closers = [];
    for (const [name, entry] of this.servers) {
      closers.push(
        entry.rpc.close().catch((err) => {
          logWarn(`close ${name}: ${err.message || err}`);
        }),
      );
    }
    this.servers.clear();
    this.toolRoutes.clear();
    this.openaiTools = [];
    await Promise.all(closers);
  }
}

/** Singleton helper for the agent process. */
let _session = null;

async function startMcpFromHub(options = {}) {
  if (_session) {
    await _session.close().catch(() => {});
    _session = null;
  }
  _session = new McpSession();
  await _session.start(options);
  return _session;
}

function getMcpSession() {
  return _session;
}

async function stopMcp() {
  if (!_session) return;
  const s = _session;
  _session = null;
  await s.close();
}

module.exports = {
  McpSession,
  StdioJsonRpc,
  loadMcpConfig,
  resolveHubRoot,
  resolveServerEnv,
  mcpToolName,
  parseMcpToolName,
  startMcpFromHub,
  getMcpSession,
  stopMcp,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_CALL_TIMEOUT_MS,
};
