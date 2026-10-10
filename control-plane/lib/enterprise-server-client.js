'use strict';

/**
 * Enterprise Server connect client (public hub side).
 *
 * Lets a public BizAgent hub join a silent Enterprise Server box with a
 * URL + shared token (spec: docs/2026-10-03-enterprise-server-mvp-spec.md).
 *
 * Connection state lives in <hub>/.bizagent/enterprise-server.json
 * (gitignored — holds the shared token). Shape:
 *   { connected: true, url, token, hub_id, connected_at, inference_url,
 *     selected_products: [slug...] }
 *
 * Locked behaviors implemented here:
 *   - Remotes are per-product opt-in ONLY. Connect never dumps the registry;
 *     empty selection is valid; new products stay off until chosen.
 *   - Company upload: the hub's company/ tree is pushed to the server
 *     (enterprise company directory), personal KS stays local.
 *   - Ask Enterprise agent (slug ask-enterprise) is provisioned at connect.
 *   - Weekly KS cron is disabled while connected (guard in weekly scripts).
 *   - Disconnect removes the connection; Ask Enterprise then reports it is
 *     disconnected instead of answering from local company files.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { loadRegistry, writeRegistry } = require('./config');

const ASK_ENTERPRISE_SLUG = 'ask-enterprise';
const MAX_UPLOAD_FILES = 500;
const MAX_UPLOAD_FILE_BYTES = 2 * 1024 * 1024;

function connectionFile(hub) {
  return path.join(hub, '.bizagent', 'enterprise-server.json');
}

function loadConnection(hub) {
  try {
    const conn = JSON.parse(fs.readFileSync(connectionFile(hub), 'utf8'));
    if (conn && conn.connected && conn.url && conn.token) return conn;
    return null;
  } catch (_err) {
    return null;
  }
}

function saveConnection(hub, conn) {
  const file = connectionFile(hub);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(conn, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return conn;
}

function clearConnection(hub) {
  try {
    fs.rmSync(connectionFile(hub), { force: true });
  } catch (_err) { /* ignore */ }
}

function request(method, baseUrl, urlPath, token, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlPath, baseUrl);
    } catch (err) {
      reject(new Error(`invalid enterprise URL: ${err.message}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = (mod).request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (_err) { /* non-JSON */ }
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('enterprise server timeout'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Products the operator may opt in: registry products that have at least one
 * project with a non-empty remote. Never the full registry.
 */
function eligibleProducts(registry) {
  const out = [];
  for (const product of registry.products || []) {
    const projects = (product.projects || [])
      .filter((p) => p && String(p.remote || '').trim() && String(p.name || '').trim())
      .map((p) => ({ name: String(p.name).trim(), remote: String(p.remote).trim() }));
    if (projects.length) out.push({ slug: product.slug, name: product.name || product.slug, projects });
  }
  return out;
}

function selectedEntries(registry, slugs) {
  const wanted = new Set(Array.isArray(slugs) ? slugs : []);
  const entries = [];
  for (const product of eligibleProducts(registry)) {
    if (!wanted.has(product.slug)) continue;
    for (const project of product.projects) {
      entries.push({
        product_slug: product.slug,
        project_name: project.name,
        remote_url: project.remote,
      });
    }
  }
  return entries;
}

function hubIdFor(hub) {
  // Stable per-machine id: hostname slug. Server dedupes on it.
  const os = require('os');
  const slug = String(os.hostname() || 'hub')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'hub';
}

/** Collect the hub's company/ tree for upload (utf8/base64 payloads). */
function collectCompanyFiles(hub) {
  const root = path.join(hub, 'company');
  const files = [];
  if (!fs.existsSync(root)) return files;
  const walk = (dir) => {
    if (files.length >= MAX_UPLOAD_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_UPLOAD_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          if (stat.size > MAX_UPLOAD_FILE_BYTES) continue;
          files.push({
            path: path.relative(root, full).replace(/\\/g, '/'),
            content_base64: fs.readFileSync(full).toString('base64'),
          });
        } catch (_err) { /* skip unreadable */ }
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Connect the hub to an enterprise server.
 * @param {string} hub hub root
 * @param {{url:string, token:string, products?:string[]}} opts
 *   products = operator-selected slugs (opt-in only; empty valid).
 * @returns {object} persisted connection
 */
async function connect(hub, opts) {
  const url = String(opts.url || '').trim().replace(/\/+$/, '');
  const token = String(opts.token || '').trim();
  if (!url) throw new Error('enterprise URL required');
  if (!token) throw new Error('shared token required');

  const registry = loadRegistry(hub);
  const entries = selectedEntries(registry, opts.products);

  const res = await request('POST', url, '/api/connect', token, {
    hub_id: hubIdFor(hub),
    hub_name: (registry.hub && registry.hub.name) || hubIdFor(hub),
    products: entries,
  });
  if (res.status !== 200 || !res.json || !res.json.ok) {
    throw new Error(
      `connect failed: ${res.status} ${(res.json && res.json.error) || res.text.slice(0, 200)}`,
    );
  }

  const conn = {
    connected: true,
    url,
    token,
    hub_id: res.json.hub_id,
    connected_at: new Date().toISOString(),
    inference_url: res.json.inference_url || '',
    ks: res.json.ks || { list: '/api/ks', file: '/api/ks/file?name=', ask: '/api/ask' },
    selected_products: [...new Set(entries.map((e) => e.product_slug))],
  };
  saveConnection(hub, conn);

  // Company upload (spec §8): on connect, push the whole company/ tree.
  try {
    await pushCompany(hub, conn);
  } catch (_err) { /* non-fatal; sync script retries */ }

  provisionAskEnterprise(hub, registry);
  return conn;
}

/** Update the opted-in product list on the server (later opt-in/opt-out). */
async function updateRemotes(hub, slugs) {
  const conn = loadConnection(hub);
  if (!conn) throw new Error('not connected to an enterprise server');
  const registry = loadRegistry(hub);
  const entries = selectedEntries(registry, slugs);
  const res = await request('POST', conn.url, '/api/remotes', conn.token, {
    hub_id: conn.hub_id,
    products: entries,
  });
  if (res.status !== 200 || !res.json || !res.json.ok) {
    throw new Error(`remotes update failed: ${res.status}`);
  }
  conn.selected_products = [...new Set(entries.map((e) => e.product_slug))];
  saveConnection(hub, conn);
  return conn;
}

/** Push the hub's company/ tree to the server (connect + periodic sync). */
async function pushCompany(hub, connInput) {
  const conn = connInput || loadConnection(hub);
  if (!conn) throw new Error('not connected to an enterprise server');
  const files = collectCompanyFiles(hub);
  const res = await request('POST', conn.url, '/api/upload-company', conn.token, {
    hub_id: conn.hub_id,
    files,
  }, 120000);
  if (res.status !== 200 || !res.json || !res.json.ok) {
    throw new Error(`company upload failed: ${res.status}`);
  }
  return res.json;
}

/**
 * Disconnect: remove the connection. The server drops the hub's remotes +
 * uploads. Ask Enterprise stays installed but reports "disconnected".
 */
async function disconnect(hub) {
  const conn = loadConnection(hub);
  if (conn) {
    try {
      await request('POST', conn.url, '/api/disconnect', conn.token, { hub_id: conn.hub_id });
    } catch (_err) { /* server may be gone; local disconnect still applies */ }
  }
  clearConnection(hub);
  return { ok: true };
}

/**
 * Provision the Ask Enterprise agent on this hub (locked decision 5):
 * a registry product entry + agents/<slug>/agent.md. One agent, one mailbox,
 * no second web UI. Idempotent.
 */
function provisionAskEnterprise(hub, registryInput) {
  const registry = registryInput || loadRegistry(hub);
  registry.products = registry.products || [];
  let product = registry.products.find((p) => p && p.slug === ASK_ENTERPRISE_SLUG);
  if (!product) {
    product = {
      slug: ASK_ENTERPRISE_SLUG,
      name: 'Ask Enterprise',
      agent_name: 'Ask Enterprise',
      provider: '',
      model: '',
      projects: [],
    };
    registry.products.push(product);
  }
  product._enterprise = product._enterprise || { kind: 'ask-enterprise' };
  writeRegistry(hub, registry);

  // Agent constitution from the committed template.
  const agentsDir = path.join(hub, 'agents', ASK_ENTERPRISE_SLUG);
  fs.mkdirSync(agentsDir, { recursive: true });
  const templatePath = path.join(__dirname, '..', '..', 'templates', 'ask-enterprise.agent.md');
  const agentMd = path.join(agentsDir, 'agent.md');
  if (!fs.existsSync(agentMd) && fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, agentMd);
  }
  for (const dir of ['inbox', 'outbox']) {
    fs.mkdirSync(path.join(agentsDir, dir), { recursive: true });
  }
  return product;
}

module.exports = {
  ASK_ENTERPRISE_SLUG,
  clearConnection,
  collectCompanyFiles,
  connect,
  disconnect,
  eligibleProducts,
  hubIdFor,
  loadConnection,
  provisionAskEnterprise,
  pushCompany,
  request,
  saveConnection,
  selectedEntries,
  updateRemotes,
};
