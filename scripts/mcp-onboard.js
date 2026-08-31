#!/usr/bin/env node
/**
 * mcp-onboard.js — paste-in remote MCP onboarding (hub-owned writes).
 *
 * Operator pastes vendor MCP connection info into hub chat; hub runs this
 * script. Secrets land in hub/.bizagent/env; server entry in registry.json
 * settings.mcp. Never tell the operator to edit those files.
 *
 * Usage:
 *   node scripts/mcp-onboard.js [--hub PATH] parse  [--text T | --file F | --stdin]
 *   node scripts/mcp-onboard.js [--hub PATH] paste  [--text T | --file F | --stdin]
 *       [--name NAME] [--token TOKEN] [--transport http|sse] [--header K=V]...
 *       [--no-verify] [--dry-run]
 *   node scripts/mcp-onboard.js [--hub PATH] list
 *   node scripts/mcp-onboard.js [--hub PATH] verify [server-name]
 *
 * Exit: 0 ok / soft-fail connected-or-saved; 2 needs operator input; 1 hard error.
 * Stdout: single JSON object (hub-friendly). Secrets never printed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');

function resolveHub(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.BIZAGENT_HUB) return path.resolve(process.env.BIZAGENT_HUB);
  // Prefer cwd when it looks like a hub; else this repo root.
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'registry.json'))) return cwd;
  return ROOT;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

function writeRegistryAtomic(hub, registry) {
  const file = path.join(hub, 'registry.json');
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function sanitizeServerName(name) {
  const s = String(name || 'server')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'server';
}

function slugFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = (u.hostname || 'server').replace(/^www\./, '');
    const parts = host.split('.').filter(Boolean);
    // prefer second-level label: mcp.zapier.com → zapier; api.example.io → example
    let base = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || 'server';
    if (base === 'com' || base === 'io' || base === 'ai' || base === 'dev') {
      base = parts[0] || 'server';
    }
    const pathBit = (u.pathname || '')
      .split('/')
      .filter(Boolean)
      .slice(0, 2)
      .join('_');
    const raw = pathBit && pathBit !== 'mcp' ? `${base}_${pathBit}` : base;
    return sanitizeServerName(raw);
  } catch (_e) {
    return 'server';
  }
}

function envKeyForServer(name, kind) {
  const slug = sanitizeServerName(name)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  const suffix = kind === 'header' ? 'HEADER' : 'TOKEN';
  return `MCP_${slug || 'SERVER'}_${suffix}`;
}

function looksLikeEnvRef(val) {
  return typeof val === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(val.trim());
}

function looksLikeSecretLiteral(val) {
  if (typeof val !== 'string') return false;
  const v = val.trim();
  if (!v) return false;
  if (looksLikeEnvRef(v) && !v.includes('-') && v === v.toUpperCase() && v.length < 64) {
    // bare ENV_NAME — treat as ref, not secret
    return false;
  }
  // Bearer tokens, sk-, long opaque strings, JSON-ish
  if (/^bearer\s+/i.test(v)) return true;
  if (/^(sk|rk|key|tok)[_-]/i.test(v)) return true;
  if (v.length >= 16 && /[A-Za-z0-9_\-.]{16,}/.test(v)) return true;
  if (/\s/.test(v)) return true;
  return false;
}

function normalizeAuthValue(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^bearer\s+/i.test(v)) return v.replace(/^bearer\s+/i, 'Bearer ');
  // bare token → Bearer prefix (common MCP HTTP expectation)
  if (!/^[A-Za-z-]+:\s*/.test(v) && !/^basic\s+/i.test(v)) {
    return `Bearer ${v}`;
  }
  return v;
}

/**
 * Read paste payload from flags.
 */
function readPasteInput(args) {
  const textIdx = args.indexOf('--text');
  if (textIdx >= 0) return String(args[textIdx + 1] || '');
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0) {
    const f = args[fileIdx + 1];
    if (!f) throw new Error('--file requires a path');
    return fs.readFileSync(f, 'utf8');
  }
  if (args.includes('--stdin') || !process.stdin.isTTY) {
    try {
      return fs.readFileSync(0, 'utf8');
    } catch (_e) {
      return '';
    }
  }
  return '';
}

function tryParseJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // full JSON
  try {
    return JSON.parse(t);
  } catch (_e) {
    /* continue */
  }
  // fenced ```json
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (_e) {
      /* continue */
    }
  }
  // first {...} block
  const brace = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (brace >= 0 && last > brace) {
    try {
      return JSON.parse(t.slice(brace, last + 1));
    } catch (_e) {
      /* continue */
    }
  }
  return null;
}

function pickUrl(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c.trim())) return c.trim();
  }
  return '';
}

function inferTransport(raw, url) {
  const t = String(raw || '')
    .toLowerCase()
    .trim();
  if (t === 'sse' || t === 'http+sse' || t === 'http-sse') return 'sse';
  if (t === 'http' || t === 'streamable-http' || t === 'streamable_http') return 'http';
  if (url && /sse/i.test(url)) return 'sse';
  return 'http';
}

/**
 * Normalize vendor paste into { name?, url, transport, headers: {name: valueOrRef},
 * secrets: { ENV_KEY: literal }, missing: [], notes: [] }
 */
function parsePaste(text, overrides = {}) {
  const notes = [];
  const missing = [];
  let name = overrides.name ? String(overrides.name).trim() : '';
  let url = overrides.url ? String(overrides.url).trim() : '';
  let transport = overrides.transport ? inferTransport(overrides.transport) : '';
  /** @type {Record<string,string>} header name → env ref OR unresolved literal marker */
  const headerLiterals = {}; // header → secret literal (to stash)
  const headerRefs = {}; // header → env ref name
  const secrets = {}; // envKey → literal

  // Explicit --header K=V overrides
  if (overrides.headers && typeof overrides.headers === 'object') {
    for (const [k, v] of Object.entries(overrides.headers)) {
      if (!k || v == null) continue;
      const vs = String(v);
      if (looksLikeEnvRef(vs) && !looksLikeSecretLiteral(vs)) {
        headerRefs[k] = vs.trim();
      } else {
        headerLiterals[k] = vs;
      }
    }
  }
  if (overrides.token) {
    headerLiterals.Authorization = normalizeAuthValue(overrides.token);
  }

  const raw = String(text || '').trim();
  const json = tryParseJson(raw);

  if (json && typeof json === 'object') {
    // Cursor / Claude Desktop style: { mcpServers: { name: { url, headers, ... } } }
    if (json.mcpServers && typeof json.mcpServers === 'object') {
      const keys = Object.keys(json.mcpServers);
      if (keys.length >= 1) {
        if (keys.length > 1 && !name) {
          notes.push(`paste lists ${keys.length} servers; using first (${keys[0]}). Pass --name to pick.`);
        }
        const key = name && json.mcpServers[name] ? name : keys[0];
        const entry = json.mcpServers[key] || {};
        if (!name) name = key;
        url = url || pickUrl(entry.url, entry.serverUrl, entry.href, entry.endpoint);
        transport = transport || inferTransport(entry.transport || entry.type, url);
        mergeHeaders(entry.headers || entry.httpHeaders, headerLiterals, headerRefs);
        if (entry.apiKey || entry.token || entry.auth) {
          headerLiterals.Authorization = normalizeAuthValue(
            entry.apiKey || entry.token || entry.auth,
          );
        }
        if (entry.command || entry.args) {
          notes.push('stdio/command fields ignored (remote HTTP only for paste-in).');
        }
      }
    } else if (Array.isArray(json.servers) && json.servers[0]) {
      const entry = json.servers[0];
      if (!name) name = entry.name || '';
      url = url || pickUrl(entry.url, entry.serverUrl);
      transport = transport || inferTransport(entry.transport, url);
      mergeHeaders(entry.headers, headerLiterals, headerRefs);
    } else {
      // flat object
      if (!name) name = String(json.name || json.serverName || json.id || '').trim();
      url =
        url ||
        pickUrl(
          json.url,
          json.serverUrl,
          json.mcpUrl,
          json.endpoint,
          json.href,
          json.SSE_URL,
          json.sse_url,
        );
      transport = transport || inferTransport(json.transport || json.type, url);
      mergeHeaders(json.headers || json.httpHeaders, headerLiterals, headerRefs);
      const tok = json.token || json.apiKey || json.api_key || json.authToken || json.authorization;
      if (tok && !headerLiterals.Authorization && !headerRefs.Authorization) {
        if (looksLikeEnvRef(String(tok)) && !looksLikeSecretLiteral(String(tok))) {
          headerRefs.Authorization = String(tok).trim();
        } else {
          headerLiterals.Authorization = normalizeAuthValue(tok);
        }
      }
      // Authorization as top-level string
      if (json.Authorization && !headerLiterals.Authorization && !headerRefs.Authorization) {
        const a = String(json.Authorization);
        if (looksLikeEnvRef(a) && !looksLikeSecretLiteral(a)) headerRefs.Authorization = a.trim();
        else headerLiterals.Authorization = normalizeAuthValue(a);
      }
    }
  } else if (raw) {
    // Plain text: URL line + optional Authorization: / Bearer / KEY=val
    const urlMatch = raw.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) url = url || urlMatch[0].replace(/[.,;)]+$/, '');
    const bearer = raw.match(/Bearer\s+(\S+)/i);
    if (bearer && !headerLiterals.Authorization) {
      headerLiterals.Authorization = normalizeAuthValue(`Bearer ${bearer[1]}`);
    }
    const authLine = raw.match(/Authorization\s*[:=]\s*(.+)/i);
    if (authLine && !headerLiterals.Authorization && !headerRefs.Authorization) {
      const a = authLine[1].trim().replace(/^["']|["']$/g, '');
      if (looksLikeEnvRef(a) && !looksLikeSecretLiteral(a)) headerRefs.Authorization = a;
      else headerLiterals.Authorization = normalizeAuthValue(a);
    }
    // KEY=value lines
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/,
      );
      if (!m) continue;
      const k = m[1];
      let v = m[2].replace(/^["']|["']$/g, '');
      if (/^URL$/i.test(k) || /MCP.*URL/i.test(k)) {
        url = url || pickUrl(v);
      } else if (/TOKEN|API_?KEY|SECRET|AUTH/i.test(k)) {
        if (!headerLiterals.Authorization) {
          headerLiterals.Authorization = normalizeAuthValue(v);
        }
      } else if (/TRANSPORT|TYPE/i.test(k)) {
        transport = transport || inferTransport(v, url);
      } else if (/NAME|SERVER/i.test(k) && !name) {
        name = v;
      }
    }
    if (/sse/i.test(raw) && !transport) transport = 'sse';
  }

  transport = transport || inferTransport('', url);

  if (!url) {
    missing.push({
      id: 'url',
      prompt: 'MCP server URL (https://… endpoint from the vendor).',
    });
  } else {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        missing.push({ id: 'url', prompt: 'URL must be http(s).' });
      }
    } catch (_e) {
      missing.push({ id: 'url', prompt: `Invalid URL: ${url}` });
    }
  }

  if (!name && url) name = slugFromUrl(url);
  name = sanitizeServerName(name || 'server');

  // Promote literals → secrets + refs
  for (const [headerName, literal] of Object.entries(headerLiterals)) {
    if (!literal || !String(literal).trim()) continue;
    if (looksLikeEnvRef(literal) && !looksLikeSecretLiteral(literal)) {
      headerRefs[headerName] = literal.trim();
      continue;
    }
    const envKey =
      headerName.toLowerCase() === 'authorization'
        ? envKeyForServer(name, 'token')
        : envKeyForServer(name, 'header') +
          `_${headerName.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
    secrets[envKey] = headerName.toLowerCase() === 'authorization'
      ? normalizeAuthValue(literal)
      : String(literal).trim();
    headerRefs[headerName] = envKey;
  }

  // Many remote MCP vendors require auth; if none at all, ask once (soft).
  if (
    Object.keys(headerRefs).length === 0 &&
    !overrides.allowNoAuth &&
    url &&
    missing.every((m) => m.id !== 'url')
  ) {
    // Don't hard-block: some servers are open. Note only.
    notes.push('No auth headers detected; connecting without Authorization.');
  }

  // If token explicitly required via missing from overrides
  if (overrides.requireToken && !headerRefs.Authorization) {
    missing.push({
      id: 'token',
      prompt: 'Access token / API key for this MCP server (will be stored in the hub env store).',
    });
  }

  return {
    name,
    url: url || '',
    transport: transport === 'sse' ? 'sse' : 'http',
    headers: headerRefs,
    secrets,
    missing,
    notes,
  };
}

function mergeHeaders(src, headerLiterals, headerRefs) {
  if (!src || typeof src !== 'object') return;
  for (const [k, v] of Object.entries(src)) {
    if (!k || v == null) continue;
    const vs = String(v).trim();
    if (!vs) continue;
    if (looksLikeEnvRef(vs) && !looksLikeSecretLiteral(vs)) {
      headerRefs[k] = vs;
    } else {
      headerLiterals[k] = /authorization/i.test(k) ? normalizeAuthValue(vs) : vs;
    }
  }
}

/**
 * Merge KEY=val into hub/.bizagent/env (mode 600). Never logs values.
 */
function upsertEnvKeys(hub, secrets) {
  const envPath = path.join(hub, '.bizagent', 'env');
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  let text = '';
  if (fs.existsSync(envPath)) {
    text = fs.readFileSync(envPath, 'utf8');
  } else {
    text = '# Written by scripts/mcp-onboard.js — never commit this file.\n';
  }
  const keys = Object.keys(secrets || {});
  if (keys.length === 0) return { path: envPath, updated: [] };

  let lines = text.split(/\n/);
  // Drop trailing empty line noise; keep structure
  const updated = [];
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid env key: ${key}`);
    }
    const val = secrets[key];
    const escaped = shellSingleQuote(String(val));
    const newLine = `${key}=${escaped}`;
    let found = false;
    lines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return line;
      const k = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
      if (k === key) {
        found = true;
        updated.push(key);
        return newLine;
      }
      return line;
    });
    if (!found) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push('# MCP server secret — managed by mcp-onboard');
      lines.push(newLine);
      updated.push(key);
    }
  }
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  const finalBody = body.endsWith('\n') ? body : `${body}\n`;
  const tmp = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, finalBody, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, envPath);
  try {
    fs.chmodSync(envPath, 0o600);
  } catch (_e) {
    /* ignore */
  }
  return { path: envPath, updated };
}

function shellSingleQuote(s) {
  // Prefer double-quote with escapes when value has no newline; keep simple.
  if (!/[\n\r]/.test(s) && !/"/.test(s) && !/`/.test(s) && !/\$/.test(s)) {
    return `"${s}"`;
  }
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function ensureMcpSettings(registry) {
  if (!registry.settings || typeof registry.settings !== 'object') {
    registry.settings = {};
  }
  if (!registry.settings.mcp || typeof registry.settings.mcp !== 'object') {
    registry.settings.mcp = {
      _comment:
        'MCP client (in-turn tools). Prefer scripts/mcp-onboard.js paste-in; secrets in .bizagent/env as header env-var refs.',
      enabled: false,
      servers: [],
    };
  }
  if (!Array.isArray(registry.settings.mcp.servers)) {
    registry.settings.mcp.servers = [];
  }
  return registry.settings.mcp;
}

function upsertServer(mcp, serverEntry) {
  const name = sanitizeServerName(serverEntry.name);
  const servers = mcp.servers;
  let idx = servers.findIndex(
    (s) => s && sanitizeServerName(s.name) === name,
  );
  if (idx < 0 && serverEntry.url) {
    idx = servers.findIndex(
      (s) => s && String(s.url || '') === String(serverEntry.url),
    );
  }
  const clean = {
    name,
    transport: serverEntry.transport === 'sse' ? 'sse' : 'http',
    url: serverEntry.url,
  };
  if (serverEntry.headers && Object.keys(serverEntry.headers).length) {
    clean.headers = serverEntry.headers;
  }
  let updated = false;
  if (idx >= 0) {
    // Preserve unknown keys (allowlists etc. on server later)
    const prev = servers[idx] || {};
    servers[idx] = { ...prev, ...clean };
    // If new entry has no headers, drop stale headers only when explicitly empty object passed
    if (!clean.headers && prev.headers) {
      /* keep prev headers when re-paste without auth change */
      if (serverEntry.clearHeaders) delete servers[idx].headers;
      else servers[idx].headers = prev.headers;
    }
    updated = true;
  } else {
    servers.push(clean);
  }
  mcp.enabled = true;
  return { name, updated, entry: servers.find((s) => sanitizeServerName(s.name) === name) };
}

/**
 * Apply secrets into process.env for verify (does override).
 */
function applySecretsToProcess(secrets) {
  for (const [k, v] of Object.entries(secrets || {})) {
    process.env[k] = v;
  }
}

function loadEnvFileIntoProcess(hub, { override = false } = {}) {
  const envFile = path.join(hub, '.bizagent', 'env');
  if (!fs.existsSync(envFile)) return;
  const text = fs.readFileSync(envFile, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (override || process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = val;
    }
  }
}

async function verifyServers(hub, onlyName) {
  const mcpClientPath = path.join(hub, 'agent-runtime', 'src', 'mcp-client.js');
  const fallback = path.join(ROOT, 'agent-runtime', 'src', 'mcp-client.js');
  const modPath = fs.existsSync(mcpClientPath) ? mcpClientPath : fallback;
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const { McpSession, loadMcpConfig } = require(modPath);

  loadEnvFileIntoProcess(hub, { override: true });
  const cfg = loadMcpConfig(hub);
  if (!cfg.enabled) {
    return {
      ok: false,
      status: 'disabled',
      message: 'settings.mcp.enabled is false',
      servers: [],
    };
  }
  let servers = cfg.servers || [];
  if (onlyName) {
    const want = sanitizeServerName(onlyName);
    servers = servers.filter((s) => sanitizeServerName(s.name) === want);
    if (servers.length === 0) {
      return {
        ok: false,
        status: 'error',
        message: `server not found: ${onlyName}`,
        servers: [],
      };
    }
  }
  const session = new McpSession();
  try {
    await session.start({
      hubRoot: hub,
      config: { ...cfg, enabled: true, servers },
      connectTimeoutMs: Number(process.env.BIZAGENT_MCP_CONNECT_TIMEOUT_MS) || 15000,
      listTimeoutMs: Number(process.env.BIZAGENT_MCP_LIST_TIMEOUT_MS) || 15000,
    });
    const tools = session.getOpenAiTools().map((t) => t.function.name);
    const byServer = {};
    for (const t of tools) {
      const rest = t.startsWith('mcp__') ? t.slice(5) : t;
      const idx = rest.indexOf('__');
      const sName = idx > 0 ? rest.slice(0, idx) : 'unknown';
      byServer[sName] = byServer[sName] || [];
      byServer[sName].push(t);
    }
    const connected = Object.keys(byServer);
    const toolCount = tools.length;
    if (toolCount === 0) {
      return {
        ok: true,
        status: 'soft_fail',
        message:
          onlyName
            ? `saved but unreachable or empty tools: ${onlyName}`
            : 'no MCP tools available (servers soft-failed or empty)',
        tools: [],
        tool_count: 0,
        servers: connected,
        by_server: byServer,
      };
    }
    const parts = connected.map((n) => `${n} → ${(byServer[n] || []).length} tools`);
    return {
      ok: true,
      status: 'connected',
      message: `connected: ${parts.join('; ')}`,
      tools,
      tool_count: toolCount,
      servers: connected,
      by_server: byServer,
    };
  } finally {
    await session.close().catch(() => {});
  }
}

function emit(obj, exitCode) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let hub;
  const hubIdx = args.indexOf('--hub');
  if (hubIdx >= 0) {
    hub = args[hubIdx + 1];
    args.splice(hubIdx, 2);
  }
  const cmd = args[0] || 'help';
  const rest = args.slice(1);
  return { hub: resolveHub(hub), cmd, rest };
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function collectHeaders(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--header' && args[i + 1]) {
      const raw = args[i + 1];
      const eq = raw.indexOf('=');
      if (eq > 0) out[raw.slice(0, eq)] = raw.slice(eq + 1);
      i += 1;
    }
  }
  return out;
}

async function main() {
  const { hub, cmd, rest } = parseArgs(process.argv);

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    emit(
      {
        ok: true,
        status: 'help',
        message:
          'mcp-onboard: parse|paste|list|verify — see docs/MCP-ONBOARD.md',
        hub,
      },
      0,
    );
  }

  if (cmd === 'parse') {
    let text = '';
    try {
      text = readPasteInput(rest);
    } catch (err) {
      emit({ ok: false, status: 'error', message: err.message }, 1);
    }
    const overrides = {
      name: flagValue(rest, '--name'),
      token: flagValue(rest, '--token'),
      transport: flagValue(rest, '--transport'),
      headers: collectHeaders(rest),
    };
    const parsed = parsePaste(text, overrides);
    const status = parsed.missing.length ? 'needs_input' : 'ok';
    emit(
      {
        ok: status === 'ok',
        status,
        parsed: {
          name: parsed.name,
          url: parsed.url,
          transport: parsed.transport,
          headers: parsed.headers,
          secret_keys: Object.keys(parsed.secrets),
          notes: parsed.notes,
        },
        questions: parsed.missing,
        message:
          status === 'needs_input'
            ? `Need ${parsed.missing.map((m) => m.id).join(', ')}`
            : `parsed: ${parsed.name} → ${parsed.url}`,
      },
      status === 'needs_input' ? 2 : 0,
    );
  }

  if (cmd === 'list') {
    const registry = loadJson(path.join(hub, 'registry.json'), null);
    if (!registry) {
      emit({ ok: false, status: 'error', message: `no registry.json at ${hub}` }, 1);
    }
    const mcp = (registry.settings && registry.settings.mcp) || {};
    const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
    emit(
      {
        ok: true,
        status: 'ok',
        enabled: mcp.enabled === true,
        servers: servers.map((s) => ({
          name: s.name,
          transport: s.transport || 'stdio',
          url: s.url || null,
          headers: s.headers ? Object.keys(s.headers) : [],
        })),
        message: mcp.enabled
          ? `${servers.length} server(s) configured`
          : 'MCP disabled',
        reload: 'none — next agent turn re-reads registry + sources .bizagent/env',
      },
      0,
    );
  }

  if (cmd === 'verify') {
    const only = rest[0] && !rest[0].startsWith('-') ? rest[0] : flagValue(rest, '--name');
    try {
      const result = await verifyServers(hub, only);
      emit(
        {
          ...result,
          reload: 'none — next agent turn picks this up automatically',
        },
        result.status === 'error' ? 1 : 0,
      );
    } catch (err) {
      emit({ ok: false, status: 'error', message: err.message || String(err) }, 1);
    }
  }

  if (cmd === 'paste') {
    let text = '';
    try {
      text = readPasteInput(rest);
    } catch (err) {
      emit({ ok: false, status: 'error', message: err.message }, 1);
    }
    if (!text.trim() && !flagValue(rest, '--url') && !flagValue(rest, '--name')) {
      emit(
        {
          ok: false,
          status: 'needs_input',
          questions: [
            {
              id: 'paste',
              prompt:
                'Paste the MCP connection info from your vendor (URL, headers/token, optional name).',
            },
          ],
          message: 'No paste text provided',
        },
        2,
      );
    }

    const overrides = {
      name: flagValue(rest, '--name'),
      url: flagValue(rest, '--url'),
      token: flagValue(rest, '--token'),
      transport: flagValue(rest, '--transport'),
      headers: collectHeaders(rest),
      allowNoAuth: rest.includes('--allow-no-auth'),
      requireToken: rest.includes('--require-token'),
    };
    const parsed = parsePaste(text, overrides);
    if (parsed.missing.length) {
      emit(
        {
          ok: false,
          status: 'needs_input',
          questions: parsed.missing,
          parsed: {
            name: parsed.name,
            url: parsed.url,
            transport: parsed.transport,
            notes: parsed.notes,
          },
          message: `Need ${parsed.missing.map((m) => m.id).join(', ')} before connecting`,
        },
        2,
      );
    }

    const dryRun = rest.includes('--dry-run');
    const noVerify = rest.includes('--no-verify');

    const registryPath = path.join(hub, 'registry.json');
    const registry = loadJson(registryPath, null);
    if (!registry) {
      emit(
        {
          ok: false,
          status: 'error',
          message: `no registry.json at ${hub} — refuse to create a hub registry from MCP onboard`,
        },
        1,
      );
    }

    if (dryRun) {
      emit(
        {
          ok: true,
          status: 'dry_run',
          would_write: {
            server: {
              name: parsed.name,
              transport: parsed.transport,
              url: parsed.url,
              headers: parsed.headers,
            },
            secret_keys: Object.keys(parsed.secrets),
            enable_mcp: true,
          },
          notes: parsed.notes,
          message: `dry-run: ${parsed.name} → ${parsed.url}`,
        },
        0,
      );
    }

    // 1) secrets → env store
    let envResult = { path: path.join(hub, '.bizagent', 'env'), updated: [] };
    try {
      envResult = upsertEnvKeys(hub, parsed.secrets);
    } catch (err) {
      emit({ ok: false, status: 'error', message: `env write failed: ${err.message}` }, 1);
    }
    applySecretsToProcess(parsed.secrets);

    // 2) registry settings.mcp
    const mcp = ensureMcpSettings(registry);
    const { name, updated, entry } = upsertServer(mcp, {
      name: parsed.name,
      transport: parsed.transport,
      url: parsed.url,
      headers: parsed.headers,
    });
    try {
      writeRegistryAtomic(hub, registry);
    } catch (err) {
      emit(
        {
          ok: false,
          status: 'error',
          message: `registry write failed: ${err.message}`,
        },
        1,
      );
    }

    const base = {
      ok: true,
      server: {
        name,
        transport: entry.transport,
        url: entry.url,
        headers: entry.headers ? Object.keys(entry.headers) : [],
        updated,
      },
      secret_keys_set: envResult.updated,
      notes: parsed.notes,
      reload: 'none — next agent turn re-reads registry.json and sources .bizagent/env (no CP restart)',
    };

    if (noVerify) {
      emit(
        {
          ...base,
          status: 'saved',
          message: `saved: ${name} → ${entry.url} (verify skipped)`,
          tool_count: null,
          tools: [],
        },
        0,
      );
    }

    try {
      const verified = await verifyServers(hub, name);
      const toolCount = verified.tool_count || 0;
      if (verified.status === 'connected') {
        emit(
          {
            ...base,
            status: 'connected',
            message: `connected: ${name} → ${toolCount} tool${toolCount === 1 ? '' : 's'}`,
            tools: verified.tools,
            tool_count: toolCount,
            by_server: verified.by_server,
          },
          0,
        );
      }
      // soft-fail: config saved; server unreachable
      emit(
        {
          ...base,
          status: 'soft_fail',
          message:
            verified.message ||
            `saved: ${name} (server unreachable or returned no tools; will soft-fail on agent turns)`,
          tools: verified.tools || [],
          tool_count: toolCount,
          verify_status: verified.status,
        },
        0,
      );
    } catch (err) {
      emit(
        {
          ...base,
          status: 'soft_fail',
          message: `saved: ${name} (verify error: ${err.message || err}; agent turns will soft-fail this server)`,
          tools: [],
          tool_count: 0,
        },
        0,
      );
    }
  }

  emit(
    {
      ok: false,
      status: 'error',
      message: `unknown command: ${cmd} (use parse|paste|list|verify)`,
    },
    1,
  );
}

// Exported for unit tests
module.exports = {
  parsePaste,
  sanitizeServerName,
  slugFromUrl,
  upsertEnvKeys,
  upsertServer,
  ensureMcpSettings,
  normalizeAuthValue,
  envKeyForServer,
  looksLikeSecretLiteral,
  looksLikeEnvRef,
};

if (require.main === module) {
  main().catch((err) => {
    emit({ ok: false, status: 'error', message: err.message || String(err) }, 1);
  });
}
