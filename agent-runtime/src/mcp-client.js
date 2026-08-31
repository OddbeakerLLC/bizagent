'use strict';

/**
 * MCP client (stdio + remote HTTP transports).
 *
 * Free/open base: runtime + BYO servers from registry settings.mcp.
 * Soft-fails per server so missing/hung MCP never blocks built-in tools.
 *
 * Transports:
 *   stdio              — local subprocess (newline-delimited JSON-RPC)
 *   http | streamable-http — MCP Streamable HTTP (POST JSON or SSE response)
 *   sse                — legacy HTTP+SSE (2024-11-05): GET SSE + POST messages
 *
 * Extension points (additive):
 *   settings.mcp.allowlists / policy / audit — enterprise layering later
 *
 * MCP is in-turn capability only. Filesystem mail remains the agent bus.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { URL } = require('url');

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

/**
 * headers map: header name → env-var *ref* (name), not secret literal.
 * { "Authorization": "MCP_REMOTE_TOKEN" } with process.env.MCP_REMOTE_TOKEN
 * set to "Bearer sk-…" → Authorization: Bearer sk-…
 * Never logs resolved values.
 */
function resolveHeaderRefs(headerRefs) {
  const out = {};
  if (!headerRefs || typeof headerRefs !== 'object') return out;
  for (const [headerName, ref] of Object.entries(headerRefs)) {
    if (!headerName || typeof ref !== 'string' || !ref.trim()) continue;
    const val = process.env[ref.trim()];
    if (val === undefined || val === '') {
      logWarn(`header ref ${headerName}←${ref} is unset; omitting`);
      continue;
    }
    out[headerName] = val;
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

function normalizeTransport(raw) {
  const t = String(raw || 'stdio').toLowerCase().trim();
  if (t === 'streamable-http' || t === 'streamable_http' || t === 'http') return 'http';
  if (t === 'sse' || t === 'http+sse' || t === 'http-sse') return 'sse';
  if (t === 'stdio') return 'stdio';
  return t;
}

function tlsRejectUnauthorized() {
  // TLS verify on by default. Only disable when explicitly set.
  const v = process.env.BIZAGENT_MCP_TLS_INSECURE;
  if (v === '1' || v === 'true' || v === 'yes') return false;
  return true;
}

/**
 * Low-level HTTP(S) request. Never logs header values.
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
 */
function httpRequest(urlStr, { method, headers, body, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(new Error(`invalid URL: ${urlStr}`));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: method || 'GET',
      headers: headers || {},
      rejectUnauthorized: tlsRejectUnauthorized(),
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    const t = timeoutMs || DEFAULT_CALL_TIMEOUT_MS;
    req.setTimeout(t, () => {
      req.destroy(new Error(`HTTP ${method || 'GET'} timeout after ${t}ms`));
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'));
        return;
      }
      const onAbort = () => req.destroy(new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    if (body != null) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Parse SSE text into events: { event, data, id }[].
 * Concatenates multi-line data fields with \n per SSE spec.
 */
function parseSseEvents(text) {
  const events = [];
  const blocks = String(text || '').split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message';
    let id = null;
    const dataLines = [];
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine;
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim();
      }
    }
    if (dataLines.length === 0) continue;
    events.push({ event, data: dataLines.join('\n'), id });
  }
  return events;
}

/**
 * Extract JSON-RPC response matching `id` from a Streamable HTTP body
 * (application/json or text/event-stream).
 */
function extractJsonRpcResult(bodyBuf, contentType, expectId) {
  const ct = String(contentType || '').toLowerCase();
  const text = bodyBuf.toString('utf8');
  if (ct.includes('text/event-stream')) {
    const events = parseSseEvents(text);
    for (const ev of events) {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_e) {
        continue;
      }
      if (Array.isArray(msg)) {
        for (const m of msg) {
          if (m && m.id === expectId && (m.result !== undefined || m.error !== undefined)) {
            return m;
          }
        }
      } else if (msg && msg.id === expectId && (msg.result !== undefined || msg.error !== undefined)) {
        return msg;
      }
    }
    throw new Error('SSE stream ended without matching JSON-RPC response');
  }
  // application/json (or unspecified)
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON response: ${err.message}`);
  }
  if (Array.isArray(msg)) {
    const hit = msg.find(
      (m) => m && m.id === expectId && (m.result !== undefined || m.error !== undefined),
    );
    if (!hit) throw new Error('batch response missing matching id');
    return hit;
  }
  return msg;
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

/**
 * Streamable HTTP transport (MCP 2025-03-26+).
 * Each JSON-RPC request/notification is a POST to the MCP endpoint.
 * Responses may be application/json or text/event-stream.
 * Captures Mcp-Session-Id when the server issues one.
 */
class HttpJsonRpc extends EventEmitter {
  constructor({ url, headers, name, connectTimeoutMs }) {
    super();
    this.name = name;
    this.url = url;
    this.headers = headers || {};
    this.connectTimeoutMs = connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    this._nextId = 1;
    this._closed = false;
    this._sessionId = null;
    this._started = false;
  }

  async start() {
    if (this._started) return;
    // Connectivity is proven on first initialize request; nothing to open.
    this._started = true;
  }

  _baseHeaders(extra) {
    const h = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...this.headers,
      ...extra,
    };
    if (this._sessionId) {
      h['Mcp-Session-Id'] = this._sessionId;
    }
    return h;
  }

  async request(method, params, timeoutMs) {
    if (this._closed) {
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
    const res = await httpRequest(this.url, {
      method: 'POST',
      headers: this._baseHeaders(),
      body: JSON.stringify(payload),
      timeoutMs: t,
    });
    const sid = res.headers['mcp-session-id'];
    if (sid) this._sessionId = Array.isArray(sid) ? sid[0] : sid;

    if (res.status === 404 && this._sessionId) {
      // Session expired — clear and surface so caller can soft-fail/reconnect later
      this._sessionId = null;
      throw new Error(`MCP session expired (HTTP 404) on ${method}`);
    }
    if (res.status < 200 || res.status >= 300) {
      const snippet = res.body.toString('utf8').slice(0, 200);
      throw new Error(`MCP HTTP ${res.status} on ${method}: ${snippet}`);
    }

    const msg = extractJsonRpcResult(res.body, res.headers['content-type'], id);
    if (msg.error) {
      const e = new Error(msg.error.message || JSON.stringify(msg.error));
      e.code = msg.error.code;
      e.data = msg.error.data;
      throw e;
    }
    return msg.result;
  }

  async notify(method, params) {
    if (this._closed) return;
    const payload = {
      jsonrpc: '2.0',
      method,
      params: params === undefined ? {} : params,
    };
    try {
      const res = await httpRequest(this.url, {
        method: 'POST',
        headers: this._baseHeaders(),
        body: JSON.stringify(payload),
        timeoutMs: this.connectTimeoutMs,
      });
      // 202 Accepted is normal for notifications; also tolerate 2xx JSON
      if (res.status === 202) return;
      if (res.status < 200 || res.status >= 300) {
        logWarn(`${this.name}: notify ${method} HTTP ${res.status}`);
      }
    } catch (err) {
      logWarn(`${this.name}: notify ${method} failed: ${err.message || err}`);
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._sessionId) {
      try {
        await httpRequest(this.url, {
          method: 'DELETE',
          headers: this._baseHeaders({ Accept: 'application/json' }),
          timeoutMs: 5000,
        });
      } catch (_e) {
        /* ignore — server may not support session DELETE */
      }
      this._sessionId = null;
    }
    this.emit('close', {});
  }
}

/**
 * Legacy HTTP+SSE transport (MCP 2024-11-05).
 * GET opens SSE; first `endpoint` event gives the POST URL for messages.
 * Server replies arrive as SSE `message` events.
 */
class SseJsonRpc extends EventEmitter {
  constructor({ url, headers, name, connectTimeoutMs }) {
    super();
    this.name = name;
    this.url = url;
    this.headers = headers || {};
    this.connectTimeoutMs = connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    this._nextId = 1;
    this._pending = new Map();
    this._closed = false;
    this._messageUrl = null;
    this._req = null;
    this._res = null;
    this._buf = '';
  }

  start() {
    if (this._messageUrl) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      let parsed;
      try {
        parsed = new URL(this.url);
      } catch (err) {
        fail(new Error(`invalid URL: ${this.url}`));
        return;
      }

      const timer = setTimeout(() => {
        fail(new Error(`SSE connect timeout after ${this.connectTimeoutMs}ms`));
        this.close().catch(() => {});
      }, this.connectTimeoutMs);

      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const opts = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...this.headers,
        },
        rejectUnauthorized: tlsRejectUnauthorized(),
      };

      const req = lib.request(opts, (res) => {
        this._res = res;
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          fail(new Error(`SSE GET HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => this._onSseData(chunk, ok, fail));
        res.on('end', () => {
          this._closed = true;
          const err = new Error(`MCP SSE server "${this.name}" stream ended`);
          for (const [, p] of this._pending) {
            clearTimeout(p.timer);
            p.reject(err);
          }
          this._pending.clear();
          this.emit('close', {});
          if (!settled) fail(err);
        });
        res.on('error', (err) => {
          if (!settled) fail(err);
        });
      });
      this._req = req;
      req.on('error', (err) => fail(err));
      req.setTimeout(this.connectTimeoutMs, () => {
        /* connect timer above handles overall; idle is fine after start */
      });
      req.end();
    });
  }

  _onSseData(chunk, onReady, onFail) {
    this._buf += chunk;
    let sep;
    while ((sep = this._buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = this._buf.slice(0, sep);
      const match = this._buf.slice(sep).match(/^\r?\n\r?\n/);
      this._buf = this._buf.slice(sep + (match ? match[0].length : 2));
      if (!block.trim()) continue;
      const events = parseSseEvents(`${block}\n\n`);
      for (const ev of events) {
        if (ev.event === 'endpoint') {
          try {
            this._messageUrl = new URL(ev.data.trim(), this.url).toString();
            if (onReady) onReady();
          } catch (err) {
            if (onFail) onFail(err);
          }
          continue;
        }
        // message (default) or explicit message event
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_e) {
          logWarn(`${this.name}: non-JSON SSE data ignored`);
          continue;
        }
        this._handleMessage(msg);
      }
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
    }
  }

  request(method, params, timeoutMs) {
    if (this._closed || !this._messageUrl) {
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
      httpRequest(this._messageUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(payload),
        timeoutMs: t,
      })
        .then((res) => {
          if (res.status < 200 || res.status >= 300) {
            clearTimeout(timer);
            this._pending.delete(id);
            reject(new Error(`MCP SSE POST HTTP ${res.status} on ${method}`));
          }
          // Result arrives via SSE message event
        })
        .catch((err) => {
          clearTimeout(timer);
          this._pending.delete(id);
          reject(err);
        });
    });
  }

  notify(method, params) {
    if (this._closed || !this._messageUrl) return;
    const payload = {
      jsonrpc: '2.0',
      method,
      params: params === undefined ? {} : params,
    };
    httpRequest(this._messageUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(payload),
      timeoutMs: this.connectTimeoutMs,
    }).catch((err) => {
      logWarn(`${this.name}: notify ${method} failed: ${err.message || err}`);
    });
  }

  async close() {
    this._closed = true;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server "${this.name}" closed`));
    }
    this._pending.clear();
    try {
      if (this._req) this._req.destroy();
    } catch (_e) {
      /* ignore */
    }
    try {
      if (this._res) this._res.destroy();
    } catch (_e) {
      /* ignore */
    }
    this._req = null;
    this._res = null;
    this._messageUrl = null;
    this.emit('close', {});
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
    const transport = normalizeTransport(raw.transport || 'stdio');
    const connectTimeoutMs =
      Number(options.connectTimeoutMs) ||
      Number(process.env.BIZAGENT_MCP_CONNECT_TIMEOUT_MS) ||
      DEFAULT_CONNECT_TIMEOUT_MS;
    const listTimeoutMs =
      Number(options.listTimeoutMs) ||
      Number(process.env.BIZAGENT_MCP_LIST_TIMEOUT_MS) ||
      DEFAULT_LIST_TIMEOUT_MS;

    let rpc;
    try {
      if (transport === 'stdio') {
        const command = raw.command && String(raw.command).trim();
        if (!command) {
          logWarn(`server "${name}": missing command; skip`);
          return;
        }
        const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
        const cwd = raw.cwd ? path.resolve(this.hubRoot, raw.cwd) : undefined;
        const env = resolveServerEnv(raw.env);
        rpc = new StdioJsonRpc({
          name,
          command,
          args,
          env,
          cwd,
          connectTimeoutMs,
        });
      } else if (transport === 'http' || transport === 'sse') {
        const url = raw.url && String(raw.url).trim();
        if (!url) {
          logWarn(`server "${name}": missing url for transport ${transport}; skip`);
          return;
        }
        let parsed;
        try {
          parsed = new URL(url);
        } catch (_e) {
          logWarn(`server "${name}": invalid url; skip`);
          return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          logWarn(`server "${name}": url must be http(s); skip`);
          return;
        }
        const headers = resolveHeaderRefs(raw.headers);
        if (transport === 'http') {
          rpc = new HttpJsonRpc({ name, url, headers, connectTimeoutMs });
        } else {
          rpc = new SseJsonRpc({ name, url, headers, connectTimeoutMs });
        }
      } else {
        logWarn(`server "${name}": transport "${raw.transport}" not supported; skip`);
        return;
      }

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
      // notify may be sync (stdio) or async (http)
      await Promise.resolve(rpc.notify('notifications/initialized', {}));
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
      this.servers.set(name, { rpc, tools: toolMap, raw, transport });
      logInfo(
        `server "${name}" connected via ${transport} (${tools.length} tool(s): ${tools
          .map((t) => t.name)
          .join(', ') || 'none'})`,
      );
    } catch (err) {
      logWarn(`server "${name}" soft-fail: ${err.message || err}`);
      if (rpc) {
        try {
          await rpc.close();
        } catch (_e) {
          /* ignore */
        }
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
  HttpJsonRpc,
  SseJsonRpc,
  loadMcpConfig,
  resolveHubRoot,
  resolveServerEnv,
  resolveHeaderRefs,
  mcpToolName,
  parseMcpToolName,
  normalizeTransport,
  startMcpFromHub,
  getMcpSession,
  stopMcp,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_CALL_TIMEOUT_MS,
};
