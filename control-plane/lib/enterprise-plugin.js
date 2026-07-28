'use strict';

/**
 * Phase 0 — optional Enterprise plugin seams (public OSS).
 *
 * When settings.enterprise is absent or enabled !== true, this module is a no-op.
 * When enabled, it resolves @bizagent/enterprise (or package_path / BIZAGENT_ENTERPRISE_PATH),
 * calls register(api), and soft-fails to pure OSS on any error.
 *
 * Dependency rule: public OSS never hard-requires the enterprise package.
 * Enterprise may only attach via this loader. See private bizagent-enterprise docs:
 *   docs/SETTINGS-ENTERPRISE.md
 *   docs/superpowers/specs/2026-07-24-bizagent-enterprise-build-spec.md
 *
 * Plugin API (enterprise_api ≥ 1):
 *   {
 *     hub, registry, appDir,
 *     registerRoute(method, path, handler, opts?),
 *     getSession(req),
 *     requireAuth(req, res),  // optional; may be bound by server
 *     log: { debug, info, warn, error },
 *     hooks: {
 *       authProvider,       // optional override of login/session
 *       resolveUserInbox,   // (hub, frontmatter, session) => abs path | null
 *       filterAgents,       // (agents, session) => agents
 *       getHubSessionPath,  // (hub, session) => abs path | null
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');
const { appDir } = require('./config');
const { logEvent } = require('./log');

/** OSS plugin API version advertised to packages. */
const ENTERPRISE_API = 1;

function enterpriseSettings(registry) {
  const ent =
    registry &&
    registry.settings &&
    registry.settings.enterprise;
  return ent && typeof ent === 'object' ? ent : null;
}

function isEnterpriseEnabled(registry) {
  const ent = enterpriseSettings(registry);
  return !!(ent && ent.enabled === true);
}

function pluginLog(hub, level, message, extra = {}) {
  try {
    logEvent(hub, {
      event: 'enterprise_plugin',
      level,
      message,
      ...extra,
    });
  } catch (_err) {
    // never throw from logging
  }
  const line = `[enterprise-plugin] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug' && process.env.BIZAGENT_DEBUG) console.error(line);
  // info is quiet by default (structured log only)
}

/**
 * Resolve filesystem path or package name to require.
 * Order: BIZAGENT_ENTERPRISE_PATH env → package_path → package name.
 * @returns {{ kind: 'path'|'name', target: string } | null}
 */
function resolveEnterpriseTarget(hub, registry) {
  const ent = enterpriseSettings(registry) || {};
  const envPath = (process.env.BIZAGENT_ENTERPRISE_PATH || '').trim();
  if (envPath) {
    return { kind: 'path', target: path.isAbsolute(envPath) ? envPath : path.resolve(hub, envPath) };
  }
  const packagePath = (ent.package_path || '').trim();
  if (packagePath) {
    return {
      kind: 'path',
      target: path.isAbsolute(packagePath) ? packagePath : path.resolve(hub, packagePath),
    };
  }
  const name = (ent.package || '@bizagent/enterprise').trim();
  if (!name) return null;
  return { kind: 'name', target: name };
}

function tryRequire(target, kind, hub) {
  if (kind === 'path') {
    if (!fs.existsSync(target)) {
      throw new Error(`enterprise package_path not found: ${target}`);
    }
    // Allow requiring a directory with package.json main, or a file.
    const resolved = require.resolve(target);
    // Clear cache so registry reloads can pick up package edits in path mode.
    try {
      delete require.cache[resolved];
    } catch (_e) { /* ignore */ }
    return require(resolved);
  }
  // name: search from hub node_modules then normal resolution
  const candidates = [
    path.join(hub, 'node_modules', target),
    target,
  ];
  let lastErr;
  for (const c of candidates) {
    try {
      const resolved = require.resolve(c, { paths: [hub, process.cwd()] });
      return require(resolved);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`cannot require enterprise package: ${target}`);
}

function createEmptyHooks() {
  return {
    authProvider: null,
    resolveUserInbox: null,
    filterAgents: null,
    getHubSessionPath: null,
  };
}

/**
 * Build the api object passed to package register(api).
 * Server may later bind requireAuth onto api.
 */
function createPluginApi(hub, registry, { routes }) {
  const hooks = createEmptyHooks();
  const log = {
    debug: (msg, extra) => pluginLog(hub, 'debug', String(msg), extra || {}),
    info: (msg, extra) => pluginLog(hub, 'info', String(msg), extra || {}),
    warn: (msg, extra) => pluginLog(hub, 'warn', String(msg), extra || {}),
    error: (msg, extra) => pluginLog(hub, 'error', String(msg), extra || {}),
  };

  function registerRoute(method, routePath, handler, opts = {}) {
    if (!method || !routePath || typeof handler !== 'function') {
      throw new Error('registerRoute(method, path, handler) requires all three args');
    }
    routes.push({
      method: String(method).toUpperCase(),
      path: String(routePath),
      handler,
      auth: opts.auth !== false,
    });
  }

  return {
    hub,
    registry,
    appDir: appDir(hub),
    registerRoute,
    // Bound by server after create when cookie parsing is available.
    getSession: null,
    requireAuth: null,
    log,
    hooks,
    enterprise_api: ENTERPRISE_API,
  };
}

/**
 * Load enterprise plugin if enabled. Never throws to caller for resolve/register
 * failures — returns inactive state and logs.
 *
 * @param {object} config - loadRuntimeConfig result (hub, registry, …)
 * @param {object} [options]
 * @returns {{
 *   active: boolean,
 *   enabled: boolean,
 *   info: object|null,
 *   api: object|null,
 *   hooks: object,
 *   routes: array,
 *   module: object|null,
 *   error: string|null,
 * }}
 */
function loadEnterprisePlugin(config, options = {}) {
  const hub = config.hub;
  const registry = config.registry || {};
  const empty = {
    active: false,
    enabled: false,
    info: null,
    api: null,
    hooks: createEmptyHooks(),
    routes: [],
    module: null,
    error: null,
  };

  if (!isEnterpriseEnabled(registry)) {
    return empty;
  }

  const enabled = true;
  const routes = [];
  const api = createPluginApi(hub, registry, { routes });

  // Allow tests / server to inject getSession before register.
  if (typeof options.getSession === 'function') {
    api.getSession = options.getSession;
  }
  if (typeof options.requireAuth === 'function') {
    api.requireAuth = options.requireAuth;
  }

  let target;
  try {
    target = resolveEnterpriseTarget(hub, registry);
    if (!target) {
      throw new Error('enterprise enabled but no package / package_path / BIZAGENT_ENTERPRISE_PATH');
    }
  } catch (err) {
    pluginLog(hub, 'error', err.message, { status: 'error' });
    return { ...empty, enabled, error: err.message };
  }

  let mod;
  try {
    mod = tryRequire(target.target, target.kind, hub);
  } catch (err) {
    const msg = `enterprise package resolve failed (${target.kind}:${target.target}): ${err.message}`;
    pluginLog(hub, 'error', msg, { status: 'error' });
    return { ...empty, enabled, error: msg };
  }

  if (!mod || typeof mod.register !== 'function') {
    const msg = 'enterprise package does not export register(api)';
    pluginLog(hub, 'error', msg, { status: 'error' });
    return { ...empty, enabled, error: msg, module: mod };
  }

  let info;
  try {
    info = mod.register(api);
  } catch (err) {
    const msg = `enterprise register(api) threw: ${err.message}`;
    pluginLog(hub, 'error', msg, { status: 'error' });
    return { ...empty, enabled, error: msg, module: mod };
  }

  const ent = enterpriseSettings(registry) || {};
  const minApi = Number(ent.enterprise_api_min != null ? ent.enterprise_api_min : 1);
  const reported = info && info.enterprise_api != null ? Number(info.enterprise_api) : 0;
  if (reported < minApi) {
    const msg = `enterprise_api ${reported} < required ${minApi}; treating inactive`;
    pluginLog(hub, 'warn', msg, { status: 'warn' });
    return {
      active: false,
      enabled,
      info: info || null,
      api,
      hooks: api.hooks,
      routes: [],
      module: mod,
      error: msg,
    };
  }

  const active = !!(info && info.active !== false);
  pluginLog(hub, 'info', `${(info && info.name) || 'enterprise'} loaded active=${active}`, {
    status: 'ok',
    version: (info && info.version) || '',
  });

  return {
    active,
    enabled,
    info: info || null,
    api,
    hooks: api.hooks,
    routes: active ? routes : [],
    module: mod,
    error: null,
  };
}

/**
 * Match a registered plugin route. Exact path match for Phase 0
 * (enterprise can register parameterized routes later with its own matcher).
 */
function matchPluginRoute(routes, method, pathname) {
  if (!routes || !routes.length) return null;
  const m = String(method || '').toUpperCase();
  for (const r of routes) {
    if (r.method === m && r.path === pathname) return r;
  }
  return null;
}

/**
 * Apply filterAgents hook when present; otherwise identity.
 */
function applyFilterAgents(enterpriseState, agents, session) {
  const fn =
    enterpriseState &&
    enterpriseState.hooks &&
    enterpriseState.hooks.filterAgents;
  if (typeof fn !== 'function') return agents;
  try {
    const out = fn(agents, session);
    return Array.isArray(out) ? out : agents;
  } catch (_err) {
    return agents;
  }
}

/**
 * Resolve human inbox directory via hook, or default user/inbox.
 */
function applyResolveUserInbox(enterpriseState, hub, frontmatter, session) {
  const fn =
    enterpriseState &&
    enterpriseState.hooks &&
    enterpriseState.hooks.resolveUserInbox;
  if (typeof fn === 'function') {
    try {
      const p = fn(hub, frontmatter, session);
      if (p) return p;
    } catch (_err) {
      // fall through to OSS default
    }
  }
  return path.join(hub, 'user', 'inbox');
}

module.exports = {
  ENTERPRISE_API,
  applyFilterAgents,
  applyResolveUserInbox,
  createEmptyHooks,
  createPluginApi,
  enterpriseSettings,
  isEnterpriseEnabled,
  loadEnterprisePlugin,
  matchPluginRoute,
  resolveEnterpriseTarget,
};
