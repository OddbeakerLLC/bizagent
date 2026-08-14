const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");

// Lazy WS (installed as dep for feed server). Fallback if missing is graceful (SSE path remains).
let WebSocket;
try { WebSocket = require("ws"); } catch (_) { WebSocket = null; }

// --- WebSocket feeds (preferred over SSE). Subscribe model with per-session scoping. ---
// OSS single-operator: full visibility for any valid session.
// Enterprise hook: filter publish by user/roles; conversation visibility = ownership or explicit grant.
const wsAgentsClients = new Set(); // Set<WebSocket>
const wsConvClients = new Map(); // convId -> Set<WebSocket>
const wsClientMeta = new WeakMap(); // ws -> { username, subscribed: Set<string> }

function getClientMeta(ws) {
  let m = wsClientMeta.get(ws);
  if (!m) { m = { username: null, subscribed: new Set() }; wsClientMeta.set(ws, m); }
  return m;
}

function addWsAgentsClient(ws) { wsAgentsClients.add(ws); }
function removeWsAgentsClient(ws) { wsAgentsClients.delete(ws); }

function addWsConvClient(id, ws) {
  if (!wsConvClients.has(id)) wsConvClients.set(id, new Set());
  wsConvClients.get(id).add(ws);
}
function removeWsConvClient(id, ws) {
  const s = wsConvClients.get(id);
  if (!s) return;
  s.delete(ws);
  if (s.size === 0) wsConvClients.delete(id);
}

function wsSend(ws, obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {}
}

function wsBroadcastAgents(snapshot) {
  for (const ws of wsAgentsClients) {
    // OSS: any authenticated session sees full board.
    // Enterprise: filter here by meta.username + roles/seats (documented below).
    wsSend(ws, { feed: 'agents', snapshot });
  }
}

function wsBroadcastConv(id, conv) {
  const set = wsConvClients.get(id);
  if (!set || set.size === 0) return;
  for (const ws of set) {
    // Conversation visibility: currently any valid session may subscribe to any existing conv (OSS sole-op).
    // Enterprise: check conv ownership / ACL against meta.username before including this client.
    wsSend(ws, { feed: `conversation:${id}`, id, conv });
  }
}
const {
  agentsFromRegistry,
  loadHubEnv,
  loadRuntimeConfig,
  readJson,
  refreshRuntimeConfig,
  updateAgentConfig,
} = require("./lib/config");
const {
  createSession,
  destroySession,
  getSession,
  hasAuth,
  initAuth,
  parseCookies,
  verifyLogin,
} = require("./lib/auth");
const {
  applyFilterAgents,
  loadEnterprisePlugin,
  matchPluginRoute,
} = require("./lib/enterprise-plugin");
const {
  activeConversationFile,
  appendMessage,
  conversationNameFromContent,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  readUserInboxMessages,
  setActiveConversation,
  shouldStartNewConversation,
  STATUS_ERROR_KIND,
  writeHubInboxMessage,
} = require("./lib/conversations");
const {
  dispatchPendingAgents,
  drainHubTurnSafety,
  isAgentActive,
  stopAgentTurn,
} = require("./lib/dispatcher");
const {
  listCompanyFiles,
  parseMultipart,
  readRequestBuffer,
  writeCompanyFile,
  MAX_UPLOAD_BYTES,
} = require("./lib/company-files");
const {
  ensureLibrary,
  getLibraryEntry,
  listLibrary,
  resolveLibraryFile,
  MAX_BYTES: LIBRARY_MAX_BYTES,
} = require("./lib/library");
const {
  writeUpload,
  assertAllowedAttachmentPath,
  MAX_UPLOAD_BYTES: UPLOAD_MAX_BYTES,
} = require("./lib/uploads");
const {
  conversationIdsFromSafetyResults,
  setOnConversationMutated,
} = require("./lib/hub-turn-safety");
const { ensureHubRuntimePrompt } = require("./lib/hub-memory");
const { agentMailStatus, routeOutboxes } = require("./lib/mail");
const { getProfile, setProfile } = require("./lib/profile");
const { logEvent, logHubTurn, logError, appendLog } = require("./lib/log");
const {
  clearThinking,
  getThinking,
} = require("./lib/thinking");

const PUBLIC_DIR = path.join(__dirname, "public");

// --- SSE broadcaster (event-driven UI, replaces 2s polling) ---
const stateClients = new Set();
const convClients = new Map(); // id -> Set(res)

function addStateClient(res) {
  stateClients.add(res);
}
function removeStateClient(res) {
  stateClients.delete(res);
}
function broadcastState(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of stateClients) {
    try { c.write(payload); } catch (_) { /* client gone */ }
  }
}

function addConvClient(id, res) {
  if (!convClients.has(id)) convClients.set(id, new Set());
  convClients.get(id).add(res);
}
function removeConvClient(id, res) {
  const s = convClients.get(id);
  if (!s) return;
  s.delete(res);
  if (s.size === 0) convClients.delete(id);
}
function broadcastConv(id, conv) {
  const s = convClients.get(id);
  if (!s || s.size === 0) return;
  const payload = `data: ${JSON.stringify({ id, conv })}\n\n`;
  for (const c of s) {
    try { c.write(payload); } catch (_) { /* client gone */ }
  }
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":
      typeof body === "string" ? "text/plain" : "application/json",
    ...headers,
  });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return false;
  const ext = path.extname(file);
  const types = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
  };
  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function authProvider(config) {
  const custom =
    config.enterprise &&
    config.enterprise.hooks &&
    config.enterprise.hooks.authProvider;
  if (custom && typeof custom === "object") return custom;
  return null;
}

function requireAuth(config, req, res) {
  const provider = authProvider(config);
  const has =
    provider && typeof provider.hasAuth === "function"
      ? provider.hasAuth(config.hub)
      : hasAuth(config.hub);
  if (!has) {
    send(res, 401, { error: "setup required" });
    return false;
  }
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.bizagent_session;
  const session =
    provider && typeof provider.getSession === "function"
      ? provider.getSession(config.hub, sessionId)
      : getSession(config.hub, sessionId);
  if (!session) {
    send(res, 401, { error: "login required" });
    return false;
  }
  req.session = { id: sessionId, ...session };
  return true;
}

/** Attach / reload optional Enterprise plugin (no-op when disabled). Soft-fail. */
function attachEnterprisePlugin(config) {
  const state = loadEnterprisePlugin(config, {
    getSession: (req) => {
      const cookies = parseCookies(req && req.headers && req.headers.cookie);
      const id = cookies.bizagent_session;
      const provider = authProvider(config);
      if (provider && typeof provider.getSession === "function") {
        return provider.getSession(config.hub, id);
      }
      return getSession(config.hub, id);
    },
  });
  // Bind requireAuth for packages that call api.requireAuth(req, res).
  if (state.api) {
    state.api.requireAuth = (req, res) => requireAuth(config, req, res);
    state.api.getSession = (req) => {
      const cookies = parseCookies(req && req.headers && req.headers.cookie);
      const id = cookies.bizagent_session;
      const provider =
        state.hooks && state.hooks.authProvider
          ? state.hooks.authProvider
          : null;
      if (provider && typeof provider.getSession === "function") {
        return provider.getSession(config.hub, id);
      }
      return getSession(config.hub, id);
    };
  }
  config.enterprise = state;
  return state;
}

const { providerEntries, resolveProviderName, getRuntimeDef } = require("./lib/cli-config");

function listCliNames(cliJson) {
  return Object.keys(providerEntries(cliJson));
}

/** True when bizagent-agent runtime launcher exists (or absolute/PATH override). */
function isCliInstalled(executable, hub) {
  const exe = String(executable || "").trim();
  if (!exe) return false;
  if (exe.includes("/") || exe.includes("\\")) {
    const candidates = [];
    if (path.isAbsolute(exe)) candidates.push(exe);
    else {
      if (hub) candidates.push(path.join(hub, exe));
      candidates.push(path.resolve(exe));
    }
    for (const c of candidates) {
      try {
        fs.accessSync(c, fs.constants.X_OK);
        return true;
      } catch (_err) {
        /* try next */
      }
    }
    return false;
  }
  try {
    execFileSync("which", [exe], { stdio: "ignore" });
    return true;
  } catch (_err) {
    return false;
  }
}

// Models for the selection dialog come from each provider's `models` array in
// cli.json. Optional registry override: settings.models.by_cli[name] (legacy name).
function modelsFromCliEntry(entry) {
  if (!entry || typeof entry !== "object") return [];
  if (!Array.isArray(entry.models)) return [];
  return entry.models.map(String).filter((m) => m.length > 0);
}

function buildCliModelsPayload(config) {
  const cliJson = config._cliJson || {};
  const providers = providerEntries(cliJson);
  const allNames = Object.keys(providers);
  const runtime = getRuntimeDef(cliJson);
  const runtimeOk = isCliInstalled(runtime.executable, config.hub);

  // Show all catalog providers when runtime is installed. Always include
  // currently-configured hub/product providers so the dialog can edit them.
  const keep = new Set();
  if (runtimeOk) {
    for (const name of allNames) keep.add(name);
  }
  const hubAgent =
    (config.registry &&
      config.registry.settings &&
      config.registry.settings.hub_agent) ||
    {};
  const hubProv =
    hubAgent.provider || hubAgent.cliName || hubAgent.cli || "";
  if (hubProv) {
    keep.add(resolveProviderName(String(hubProv), cliJson) || String(hubProv));
  }
  for (const product of (config.registry && config.registry.products) || []) {
    const n = product && (product.provider || product.cliName || product.cli);
    if (n) {
      keep.add(resolveProviderName(String(n), cliJson) || String(n));
    }
  }

  const clis = allNames.filter((n) => keep.has(n));
  // If runtime missing, still list configured providers so UI isn't empty.
  if (clis.length === 0) {
    for (const n of keep) {
      if (allNames.includes(n) || providers[n]) clis.push(n);
    }
  }

  const registry = config.registry || {};
  const modelsConfig = (registry.settings && registry.settings.models) || {};
  const byCli =
    modelsConfig.by_cli && typeof modelsConfig.by_cli === "object"
      ? modelsConfig.by_cli
      : modelsConfig.by_provider && typeof modelsConfig.by_provider === "object"
        ? modelsConfig.by_provider
        : {};

  const cliModels = {};
  const labels = {};
  for (const name of clis) {
    const entry = providers[name] || cliJson[name] || {};
    labels[name] = entry.label || name;
    if (Array.isArray(byCli[name]) && byCli[name].length > 0) {
      cliModels[name] = byCli[name].map(String);
    } else {
      cliModels[name] = modelsFromCliEntry(entry);
    }
  }

  const flat = new Set();
  for (const list of Object.values(cliModels)) {
    list.forEach((m) => flat.add(m));
  }

  return {
    // Backward-compatible field names (UI historically said "CLI").
    clis,
    providers: clis,
    models: [...flat],
    cliModels,
    providerModels: cliModels,
    labels,
    defaultModel: modelsConfig.agent_default || "",
    runtime: runtime.executable,
  };
}

function hubAgentEntry(registry) {
  const hub = registry.hub || {};
  const hubAgent = (registry.settings && registry.settings.hub_agent) || {};
  const rawName = hub.name || "BizAgent";
  // Brand the hub product line: registry often has lowercase "bizagent".
  const productName =
    String(rawName).toLowerCase() === "bizagent" ? "BizAgent" : rawName;
  // Match product agents: primary "Agent …", secondary product/system name.
  // agent_name overrides when set (e.g. interview confirmed a custom hub label).
  const agentName = hub.agent_name || "Agent PTL";
  const provider =
    hubAgent.provider || hubAgent.cliName || hubAgent.cli || "";
  return {
    slug: "hub",
    name: productName,
    agentName,
    model: hubAgent.model || "",
    provider,
    cliName: provider,
    projects: [],
  };
}

function currentState(config, session) {
  const hubCli = config.hubProvider || config.hubCliName || "";
  const hubModel = config.hubModel || "";
  const agentDefault = config.agentDefaultModel || "";

  let agents = agentMailStatus(config.hub, [
    hubAgentEntry(config.registry),
    ...agentsFromRegistry(config.registry, config.hub),
  ]).map((agent) => {
    const isHub = agent.slug === "hub";
    // Display effective launch values (empty product fields inherit hub/default).
    const provider = agent.provider || agent.cliName || hubCli || "";
    const model = agent.model || (isHub ? hubModel : agentDefault || hubModel) || "";
    return {
      ...agent,
      provider,
      cliName: provider,
      model,
      projects: Array.isArray(agent.projects) ? agent.projects : [],
      active: isAgentActive(config.hub, agent.slug, config.lockLeaseSecs),
    };
  });
  // Enterprise hook: filter roster by seat/ownership (identity when plugin off).
  agents = applyFilterAgents(config.enterprise, agents, session || null);
  return { agents, org: config.registry.org || "" };
}

function getAgentDetail(hub, slug) {
  const agentDir = path.join(hub, "agents", slug);
  const inboxDir = path.join(agentDir, "inbox");
  const archiveDir = path.join(inboxDir, "archive");
  const journalDir = path.join(agentDir, ".agent", "journal");

  let inbox = 0;
  try {
    inbox = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".md")).length;
  } catch (_) {}

  let lastDispatched = null;
  try {
    let maxMs = 0;
    for (const f of fs.readdirSync(archiveDir)) {
      try {
        const ms = fs.statSync(path.join(archiveDir, f)).mtimeMs;
        if (ms > maxMs) maxMs = ms;
      } catch (_) {}
    }
    if (maxMs > 0) lastDispatched = maxMs;
  } catch (_) {}

  let journal = null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    let journalPath = path.join(journalDir, `${today}.md`);
    if (!fs.existsSync(journalPath)) {
      const files = fs
        .readdirSync(journalDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      journalPath =
        files.length > 0
          ? path.join(journalDir, files[files.length - 1])
          : null;
    }
    if (journalPath) {
      const lines = fs.readFileSync(journalPath, "utf8").split("\n");
      let start = 0;
      if (lines[0] && lines[0].trim() === "---") {
        const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
        if (close > 0) start = close + 1;
      }
      const line = lines.slice(start).find((l) => l.trim() !== "");
      if (line) journal = line.trim();
    }
  } catch (_) {}

  return { inbox, lastDispatched, journal };
}

function syncUserInbox(config) {
  // Returns numeric relayed count. Also push the specific convs that were relayed
  // (prefer updated conv id over only the active file).
  const inbox = path.join(config.hub, 'user', 'inbox');
  let preIds = [];
  try {
    preIds = fs.readdirSync(inbox)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        try {
          const t = fs.readFileSync(path.join(inbox, f), 'utf8');
          const m = t.match(/^conversation_id:\s*(\S+)/m);
          return m ? m[1] : null;
        } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {}
  const result = readUserInboxMessages(config.hub);
  const count = typeof result === 'number' ? result : Number((result && result.relayed) || 0);
  const relayedIds = typeof result === 'number' ? [] : ((result && result.ids) || []);
  const ids = [...new Set([...preIds, ...relayedIds])];
  for (const id of ids) {
    try { pushConv(config, id); } catch (_) {}
  }
  // Also keep active-conv push as a belt-and-suspenders (harmless if already pushed).
  if (count > 0) { try { pushActiveConv(config); } catch (_) {} }
  return count;
}

// Last pushed conversation.updated_at per id — belt-and-suspenders when EXIT-hook
// child process mutates disk without access to this process's WS/SSE client sets.
const lastPushedConvStamp = new Map();

function rememberPushedConv(id, conv) {
  if (id && conv && conv.updated_at) lastPushedConvStamp.set(id, conv.updated_at);
}

// Broadcast helpers used after mutations to push to SSE + WS clients.
function pushState(config) {
  try {
    // OSS sole-op: full board. Enterprise Phase 1+ may re-filter per WS client
    // using hooks.filterAgents + meta.username (see upgrade handler).
    const snap = currentState(config, null);
    broadcastState(snap);
    wsBroadcastAgents(snap);
  } catch (_) {}
}

/** Reload enterprise plugin when settings.enterprise changes on disk. */
function maybeReloadEnterprise(config) {
  const ent =
    config.registry &&
    config.registry.settings &&
    config.registry.settings.enterprise;
  const fp = JSON.stringify(ent || null);
  if (fp === config._enterpriseFp) return config;
  config._enterpriseFp = fp;
  attachEnterprisePlugin(config);
  return config;
}
function pushActiveConv(config) {
  try {
    const active = readJson(activeConversationFile(config.hub), null);
    if (active && active.id) {
      const conv = getConversation(config.hub, active.id);
      if (conv) {
        broadcastConv(active.id, conv);
        wsBroadcastConv(active.id, conv);
        rememberPushedConv(active.id, conv);
      }
    }
  } catch (_) {}
}

// Push a specific conversation (preferred when we know exactly which one mutated).
function pushConv(config, id) {
  if (!id) return;
  try {
    const conv = getConversation(config.hub, id);
    if (conv) {
      broadcastConv(id, conv);
      wsBroadcastConv(id, conv);
      rememberPushedConv(id, conv);
    }
  } catch (_) {}
}

/**
 * If any subscribed (or active) conversation file advanced its updated_at since
 * the last push, broadcast it. Covers hub-turn mutations done in a separate
 * Node process (shell EXIT trap) that cannot see wsConvClients / SSE sets.
 */
function pushConversationsChangedOnDisk(config) {
  const liveIds = [...wsConvClients.keys(), ...convClients.keys()];
  const ids = new Set(liveIds);
  try {
    const active = readJson(activeConversationFile(config.hub), null);
    if (active && active.id) ids.add(active.id);
  } catch (_) {}
  // Keep last-viewed stamp fresh while a browser is subscribed (SSE/WS).
  // Without this, ACTIVE 30s presence expires and delayed agent completions
  // lose conversation_id (UI no longer polls every 2s).
  for (const id of new Set(liveIds)) {
    try { setActiveConversation(config.hub, id); } catch (_) {}
  }
  let pushed = 0;
  for (const id of ids) {
    try {
      const conv = getConversation(config.hub, id);
      if (!conv) continue;
      const stamp = conv.updated_at || '';
      if (lastPushedConvStamp.get(id) === stamp) continue;
      broadcastConv(id, conv);
      wsBroadcastConv(id, conv);
      rememberPushedConv(id, conv);
      pushed += 1;
    } catch (_) {}
  }
  return pushed;
}

async function handleApi(config, req, res) {
  // Pick up registry.json and cli.json edits (agents, dispatch, hub_agent.cliName)
  // without requiring a control-plane restart. Legacy .cli is name-only migration.
  refreshRuntimeConfig(config);
  maybeReloadEnterprise(config);
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Local helpers for post-mutation push (event-driven UI)
  const didChangeState = () => { try { pushState(config); } catch (_) {} };
  const didChangeActiveConv = () => { try { pushActiveConv(config); } catch (_) {} };

  if (url.pathname === "/api/setup" && req.method === "POST") {
    const provider = authProvider(config);
    const already =
      provider && typeof provider.hasAuth === "function"
        ? provider.hasAuth(config.hub)
        : hasAuth(config.hub);
    if (already) return send(res, 409, { error: "auth already initialized" });
    const body = await parseBody(req);
    if (provider && typeof provider.initAuth === "function") {
      provider.initAuth(config.hub, body.username, body.password);
    } else {
      initAuth(config.hub, body.username, body.password);
    }
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await parseBody(req);
    const provider = authProvider(config);
    let sessionId;
    if (provider && typeof provider.verifyLogin === "function") {
      const principal = provider.verifyLogin(
        config.hub,
        body.username,
        body.password,
      );
      if (!principal) return send(res, 401, { error: "invalid login" });
      sessionId =
        typeof provider.createSession === "function"
          ? provider.createSession(config.hub, principal)
          : createSession(
              config.hub,
              (principal && principal.username) || body.username,
            );
    } else {
      if (!verifyLogin(config.hub, body.username, body.password))
        return send(res, 401, { error: "invalid login" });
      sessionId = createSession(config.hub, body.username);
    }
    return send(
      res,
      200,
      { ok: true },
      {
        "Set-Cookie": `bizagent_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/`,
      },
    );
  }

  // Enterprise plugin routes may opt out of auth (rare); default is auth required.
  const pluginRoute = matchPluginRoute(
    config.enterprise && config.enterprise.routes,
    req.method,
    url.pathname,
  );
  if (pluginRoute && pluginRoute.auth === false) {
    try {
      return await pluginRoute.handler(req, res, config);
    } catch (err) {
      return send(res, 500, { error: err.message || "plugin route error" });
    }
  }

  if (!requireAuth(config, req, res)) return null;

  if (pluginRoute) {
    try {
      return await pluginRoute.handler(req, res, config);
    } catch (err) {
      return send(res, 500, { error: err.message || "plugin route error" });
    }
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    const provider = authProvider(config);
    if (req.session && req.session.id) {
      if (provider && typeof provider.destroySession === "function") {
        provider.destroySession(config.hub, req.session.id);
      } else {
        destroySession(config.hub, req.session.id);
      }
    }
    return send(
      res,
      200,
      { ok: true },
      {
        "Set-Cookie":
          "bizagent_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      },
    );
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    // Silent poll — still supported for initial load / fallback.
    return send(res, 200, currentState(config, req.session));
  }

  if (url.pathname === "/api/state/stream" && req.method === "GET") {
    // SSE push for agent state / lights. Replaces 2s poll.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // send a snapshot immediately
    try { res.write(`data: ${JSON.stringify(currentState(config))}\n\n`); } catch (_) {}
    addStateClient(res);
    req.on("close", () => removeStateClient(res));
    return null; // keep open
  }

  // --- Live "thinking" log (streams an in-flight turn's dispatch stdout) ---
  if (url.pathname === "/api/thinking/stream" && req.method === "GET") {
    const convId = (url.searchParams.get("conv") || "").trim();
    const thinking = convId ? getThinking(config.hub, convId) : null;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const sendEvent = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_err) { /* client gone */ }
    };
    if (!thinking || !thinking.logFile) {
      sendEvent({ done: true });
      try { res.end(); } catch (_err) { /* ignore */ }
      return null;
    }
    const { slug, logFile } = thinking;
    let offset = 0;
    const sendTail = () => {
      try {
        if (!fs.existsSync(logFile)) return;
        const stat = fs.statSync(logFile);
        if (stat.size > offset) {
          const length = stat.size - offset;
          const buffer = Buffer.alloc(length);
          const fd = fs.openSync(logFile, "r");
          fs.readSync(fd, buffer, 0, length, offset);
          fs.closeSync(fd);
          offset = stat.size;
          const text = buffer.toString("utf8");
          if (text) sendEvent({ text });
        }
      } catch (_err) { /* ignore */ }
    };
    sendTail();
    const iv = setInterval(() => {
      if (!isAgentActive(config.hub, slug, config.lockLeaseSecs)) {
        clearInterval(iv);
        clearThinking(config.hub, convId);
        sendEvent({ done: true });
        try { res.end(); } catch (_err) { /* ignore */ }
        return;
      }
      sendTail();
    }, 500);
    req.on("close", () => clearInterval(iv));
    return null;
  }

  // --- Hard-stop an in-flight turn (operator pressed Escape) ---
  if (url.pathname === "/api/thinking/stop" && req.method === "POST") {
    const body = await parseBody(req);
    const convId = (body.conversationId || "").trim();
    const thinking = convId ? getThinking(config.hub, convId) : null;
    if (thinking && thinking.slug) {
      try { stopAgentTurn(config.hub, thinking.slug); } catch (_err) { /* ignore */ }
      clearThinking(config.hub, convId);
      try {
        appendMessage(
          config.hub,
          convId,
          "status",
          "Stopped by operator (Escape).",
          { kind: STATUS_ERROR_KIND },
        );
      } catch (_err) { /* ignore */ }
      didChangeState();
      try { pushConv(config, convId); } catch (_err) { /* ignore */ }
    }
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/observability" && req.method === "GET") {
    const hub = config.hub;
    const structuredLogPath = path.join(hub, "logs", "structured.log");
    let recentEvents = [];

    if (fs.existsSync(structuredLogPath)) {
      try {
        const lines = fs.readFileSync(structuredLogPath, "utf8").trim().split("\n").slice(-50);
        recentEvents = lines.map(line => {
          try { return JSON.parse(line); } catch (_) { return { raw: line }; }
        });
      } catch (e) {}
    }

    return send(res, 200, {
      recent_events: recentEvents,
      summary: {
        total_events: recentEvents.length,
        last_tick: recentEvents.find(e => e.event === "control_plane_tick")
      }
    });
  }

  if (url.pathname === "/api/conversations" && req.method === "GET") {
    return send(res, 200, listConversations(config.hub));
  }

  if (url.pathname === "/api/conversations" && req.method === "POST") {
    const body = await parseBody(req);
    return send(res, 200, createConversation(config.hub, body.name));
  }

  if (url.pathname === "/api/profile" && req.method === "GET") {
    return send(res, 200, getProfile(config.hub));
  }

  if (url.pathname === "/api/profile" && req.method === "PUT") {
    const body = await parseBody(req);
    try {
      return send(res, 200, setProfile(config.hub, body));
    } catch (err) {
      return send(res, 400, { error: err.message || "invalid profile" });
    }
  }

  // --- Company files (Knowledge Stack inputs; for operators without hub FS access) ---
  if (url.pathname === "/api/company/files" && req.method === "GET") {
    try {
      const subdir = (url.searchParams.get("subdir") || "").trim();
      const files = listCompanyFiles(config.hub, { subdir });
      return send(res, 200, {
        root: "company/",
        files,
        max_upload_bytes: MAX_UPLOAD_BYTES,
      });
    } catch (err) {
      return send(res, 400, { error: err.message || "list failed" });
    }
  }

  if (url.pathname === "/api/company/files" && req.method === "POST") {
    try {
      const ct = String(req.headers["content-type"] || "");
      let filename = "";
      let subdir = "";
      let overwrite = false;
      let buffer;

      if (ct.includes("multipart/form-data")) {
        const raw = await readRequestBuffer(req);
        const parsed = parseMultipart(raw, ct);
        if (!parsed.file || !parsed.file.buffer) {
          return send(res, 400, { error: "missing file field (use name=file)" });
        }
        filename = parsed.fields.filename || parsed.file.filename || "upload.bin";
        subdir = parsed.fields.subdir || "";
        overwrite =
          parsed.fields.overwrite === "1" ||
          parsed.fields.overwrite === "true" ||
          parsed.fields.overwrite === "yes";
        buffer = parsed.file.buffer;
      } else {
        // JSON: { filename, subdir?, content_base64|content, overwrite? }
        const body = await parseBody(req);
        filename = body.filename || body.name || "";
        subdir = body.subdir || body.dir || "";
        overwrite = !!body.overwrite;
        if (body.content_base64 || body.contentBase64) {
          buffer = Buffer.from(
            body.content_base64 || body.contentBase64,
            "base64",
          );
        } else if (typeof body.content === "string") {
          buffer = Buffer.from(body.content, "utf8");
        } else {
          return send(res, 400, {
            error: "provide content_base64 or content (utf8 string)",
          });
        }
      }

      const written = writeCompanyFile(config.hub, {
        filename,
        subdir,
        buffer,
        overwrite,
      });

      try {
        logEvent(config.hub, {
          event: "company_upload",
          status: "ok",
          path: written.path,
          size: written.size,
          username: (req.session && req.session.username) || "",
        });
      } catch (_err) {
        /* ignore */
      }

      // Optional [Company] journal breadcrumb for weekly KS
      try {
        const journalDir = path.join(config.hub, "journal");
        fs.mkdirSync(journalDir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        const jpath = path.join(journalDir, `${day}.md`);
        const line = `- [Company] Uploaded \`company/${written.path}\` via control plane (${written.size} bytes)\n`;
        if (!fs.existsSync(jpath)) {
          fs.writeFileSync(jpath, `# ${day}\n\n${line}`, "utf8");
        } else {
          fs.appendFileSync(jpath, line, "utf8");
        }
      } catch (_err) {
        /* journal is best-effort */
      }

      return send(res, 200, {
        ok: true,
        path: written.path,
        size: written.size,
        mtime: written.mtime,
      });
    } catch (err) {
      const msg = err.message || "upload failed";
      const status = /too large|not allowed|already exists|invalid|escape|empty/i.test(
        msg,
      )
        ? 400
        : 500;
      return send(res, status, { error: msg });
    }
  }

  // --- Library (operator-facing plans/specs; browser viewer) ---
  if (url.pathname === "/api/library" && req.method === "GET") {
    try {
      ensureLibrary(config.hub);
      return send(res, 200, {
        ...listLibrary(config.hub),
        max_bytes: LIBRARY_MAX_BYTES,
      });
    } catch (err) {
      return send(res, 400, { error: err.message || "list failed" });
    }
  }

  if (url.pathname === "/api/library/file" && req.method === "GET") {
    try {
      const id = (url.searchParams.get("id") || url.searchParams.get("path") || "").trim();
      if (!id) return send(res, 400, { error: "id required" });
      const wantDownload =
        url.searchParams.get("download") === "1" ||
        url.searchParams.get("download") === "true";
      const doc = getLibraryEntry(config.hub, id);
      if (wantDownload) {
        const { abs } = resolveLibraryFile(config.hub, doc.path);
        const raw = fs.readFileSync(abs);
        const filename = path.basename(doc.path || "document.md");
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Length": raw.length,
          "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
          "Cache-Control": "no-store",
        });
        res.end(raw);
        return null;
      }
      return send(res, 200, doc);
    } catch (err) {
      const msg = err.message || "not found";
      const status = /not found|missing/i.test(msg) ? 404 : 400;
      return send(res, status, { error: msg });
    }
  }

  // POST /api/library removed — library is write-via-hub/agents only.

  // --- Chat uploads drop zone (.bizagent/uploads/ or company/) ---
  if (url.pathname === "/api/uploads" && req.method === "POST") {
    try {
      const ct = String(req.headers["content-type"] || "");
      if (!ct.includes("multipart/form-data")) {
        return send(res, 400, { error: "multipart/form-data required" });
      }
      const raw = await readRequestBuffer(req);
      const parsed = parseMultipart(raw, ct);
      if (!parsed.file || !parsed.file.buffer) {
        return send(res, 400, { error: "missing file field (use name=file)" });
      }
      const to = (parsed.fields.to || "hub").trim();
      const conversationId = (parsed.fields.conversation_id || "").trim();
      const subdir = parsed.fields.subdir || "";
      const filename = parsed.fields.filename || parsed.file.filename || "upload.bin";
      const written = writeUpload(config.hub, {
        to,
        conversationId,
        subdir,
        filename,
        buffer: parsed.file.buffer,
        overwrite:
          parsed.fields.overwrite === "1" ||
          parsed.fields.overwrite === "true",
      });
      try {
        logEvent(config.hub, {
          event: "chat_upload",
          status: "ok",
          to: written.to,
          path: written.path,
          size: written.size,
          conversation_id: conversationId || "",
          username: (req.session && req.session.username) || "",
        });
      } catch (_err) {
        /* ignore */
      }
      return send(res, 200, {
        ok: true,
        ...written,
        max_upload_bytes: UPLOAD_MAX_BYTES,
      });
    } catch (err) {
      const msg = err.message || "upload failed";
      const status = /too large|not allowed|invalid|empty|escape|missing/i.test(msg)
        ? 400
        : 500;
      return send(res, status, { error: msg });
    }
  }

  // List available LLM providers from cli.json
  if (url.pathname === "/api/clis" && req.method === "GET") {
    const payload = buildCliModelsPayload(config);
    return send(res, 200, {
      clis: payload.clis,
      providers: payload.providers || payload.clis,
    });
  }

  // Providers + models for the selection dialog (from cli.json)
  if (
    (url.pathname === "/api/cli-models" || url.pathname === "/api/providers") &&
    req.method === "GET"
  ) {
    return send(res, 200, buildCliModelsPayload(config));
  }

  // Update agent provider/model in registry.json
  const agentConfigMatch = url.pathname.match(
    /^\/api\/agent\/([^/]+)\/config$/,
  );
  if (agentConfigMatch && req.method === "PUT") {
    const slug = decodeURIComponent(agentConfigMatch[1]);
    try {
      const body = await parseBody(req);
      const result = updateAgentConfig(config.hub, slug, {
        provider: body.provider || body.cliName,
        cliName: body.cliName || body.provider,
        model: body.model,
      });
      // Force in-process registry reload even if mtime granularity is coarse.
      config._registryMtimeMs = 0;
      refreshRuntimeConfig(config);
      didChangeState();
      return send(res, 200, { ok: true, ...result });
    } catch (err) {
      const msg = err.message || "failed to update agent config";
      const status =
        /not found|invalid|required|provide/i.test(msg) ? 400 : 500;
      return send(res, status, { error: msg });
    }
  }

  const agentDetailMatch = url.pathname.match(/^\/api\/agent-detail\/([^/]+)$/);
  if (agentDetailMatch && req.method === "GET") {
    const slug = decodeURIComponent(agentDetailMatch[1]);
    if (!/^[a-zA-Z0-9._-]+$/.test(slug) || slug === "." || slug === "..") {
      return send(res, 400, { error: "invalid slug" });
    }
    const agentDir = path.resolve(config.hub, "agents", slug);
    if (!agentDir.startsWith(path.resolve(config.hub, "agents") + path.sep)) {
      return send(res, 400, { error: "invalid slug" });
    }
    return send(res, 200, getAgentDetail(config.hub, slug));
  }

  const conversationMatch = url.pathname.match(
    /^\/api\/conversations\/([^/]+)$/,
  );
  if (conversationMatch && req.method === "GET") {
    const id = decodeURIComponent(conversationMatch[1]);
    const conv = getConversation(config.hub, id);
    if (!conv) return send(res, 404, { error: "conversation not found" });
    // Console poll / open: keep this conversation active so hub→user mail
    // missing conversation_id can be stamped on route and relay into chat.
    setActiveConversation(config.hub, id);
    return send(res, 200, conv);
  }

  // SSE per-conversation stream (replaces 2s pollConversation)
  const convStreamMatch = url.pathname.match(
    /^\/api\/conversations\/([^/]+)\/stream$/,
  );
  if (convStreamMatch && req.method === "GET") {
    const id = decodeURIComponent(convStreamMatch[1]);
    const conv = getConversation(config.hub, id);
    if (!conv) return send(res, 404, { error: "conversation not found" });
    setActiveConversation(config.hub, id);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    try { res.write(`data: ${JSON.stringify({ id, conv })}\n\n`); } catch (_) {}
    addConvClient(id, res);
    rememberPushedConv(id, conv);
    req.on("close", () => removeConvClient(id, res));
    return null;
  }

  if (conversationMatch && req.method === "DELETE") {
    const id = decodeURIComponent(conversationMatch[1]);
    if (!getConversation(config.hub, id)) {
      return send(res, 404, { error: "conversation not found" });
    }
    if (!deleteConversation(config.hub, id)) {
      return send(res, 500, { error: "could not delete conversation" });
    }
    didChangeState();
    return send(res, 200, { ok: true, id });
  }

  const messageMatch = url.pathname.match(
    /^\/api\/conversations\/([^/]+)\/messages$/,
  );
  if (messageMatch && req.method === "POST") {
    const start = Date.now();
    const body = await parseBody(req);
    const content = body.content || "";
    const id = shouldStartNewConversation(content)
      ? createConversation(config.hub, conversationNameFromContent(content)).id
      : decodeURIComponent(messageMatch[1]);

    // Optional attachments: paths must already exist under uploads/ or company/.
    let attachments = [];
    if (Array.isArray(body.attachments) && body.attachments.length) {
      try {
        attachments = body.attachments.map((a) => {
          const rel = assertAllowedAttachmentPath(config.hub, a.path || a);
          return {
            name: a.name || path.basename(rel),
            path: rel,
            to: a.to || "",
            size: a.size || undefined,
          };
        });
      } catch (err) {
        return send(res, 400, { error: err.message || "invalid attachments" });
      }
    }

    writeHubInboxMessage(config.hub, content, id, { attachments });
    const conv = appendMessage(config.hub, id, "user", content, { attachments });
    setActiveConversation(config.hub, id);

    logEvent(config.hub, {
      event: 'user_message_received',
      conversation_id: id,
      content_length: content.length,
      attachment_count: attachments.length,
      duration_ms: Math.round((Date.now() - start) * 100) / 100
    });

    didChangeState();
    // Push the specific conversation so the sender sees its own message promptly.
    try { broadcastConv(id, conv); } catch (_) {}
    try { wsBroadcastConv(id, conv); } catch (_) {}
    return send(res, 200, conv);
  }

  return send(res, 404, { error: "not found" });
}

function runTick(config) {
  const start = Date.now();
  refreshRuntimeConfig(config);
  maybeReloadEnterprise(config);
  const routed = routeOutboxes(config.hub);
  const relayed = syncUserInbox(config); // numeric for hadWork (compat)
  // Backup: if hub CLI exited without the shell safety hook, finish the turn.
  // Safety may route+relay or hard-fail AFTER syncUserInbox — push those ids next.
  const safetyResults = drainHubTurnSafety(config) || [];
  const safetyIds = conversationIdsFromSafetyResults(safetyResults);
  for (const id of safetyIds) {
    try { pushConv(config, id); } catch (_) {}
  }
  const dispatched = dispatchPendingAgents(config) || {};
  const launched = Number(dispatched.launched || 0);
  // Launch-ack (and any other same-tick conv mutation) — push by disk stamp.
  // Also covers EXIT-hook child process that mutated conv JSON without broadcast.
  const stampPushed = pushConversationsChangedOnDisk(config);

  const hadWork =
    (routed.delivered || 0) > 0 ||
    (routed.quarantined || 0) > 0 ||
    (routed.warnings || 0) > 0 ||
    relayed > 0 ||
    launched > 0 ||
    safetyIds.length > 0 ||
    stampPushed > 0;

  if (hadWork) {
    logEvent(config.hub, {
      event: 'control_plane_tick',
      duration_ms: Math.round((Date.now() - start) * 100) / 100,
      routed: routed.delivered || 0,
      quarantined: routed.quarantined || 0,
      warnings: routed.warnings || 0,
      launched,
      safety_pushed: safetyIds.length,
      stamp_pushed: stampPushed,
      poll_seconds: config.pollSeconds,
    });
    // Push agent board when lights or agents changed.
    pushState(config);
  }
}

function createServer(config) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      handleApi(config, req, res).catch((err) =>
        send(res, 500, { error: err.message }),
      );
      return;
    }
    if (!serveStatic(req, res)) send(res, 404, "not found");
  });

  // Attach WebSocket feeds (preferred subscribe model) if 'ws' is available.
  // Auth: same bizagent_session cookie as REST. OSS: full visibility for the sole session.
  // Enterprise: per-user scoping on subscribe + publish (see comments below).
  if (WebSocket && WebSocket.WebSocketServer) {
    const wss = new WebSocket.WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      // Only accept the feeds endpoint; other upgrades (if any) are ignored.
      const u = new URL(req.url, `http://${req.headers.host}`);
      if (u.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      // Cookie/session auth identical to requireAuth (no body parsing here).
      if (!hasAuth(config.hub)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const cookies = parseCookies(req.headers.cookie);
      const session = getSession(config.hub, cookies.bizagent_session);
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const username = session.username || 'operator';

      wss.handleUpgrade(req, socket, head, (ws) => {
        const meta = getClientMeta(ws);
        meta.username = username;

        ws.on('message', (data) => {
          let msg;
          try { msg = JSON.parse(String(data)); } catch (_) { return; }
          const { action, feed } = msg || {};
          if (action === 'subscribe' && typeof feed === 'string') {
            if (feed === 'agents') {
              meta.subscribed.add('agents');
              addWsAgentsClient(ws);
              // Immediate snapshot on subscribe (and reconnect)
              try { wsSend(ws, { feed: 'agents', snapshot: currentState(config) }); } catch (_) {}
            } else if (feed.startsWith('conversation:')) {
              const id = feed.slice('conversation:'.length);
              // Conversation visibility gate (OSS = any existing conv; Enterprise = ownership/ACL).
              // We validate the conv exists for this hub; per-user scoping is a documented hook.
              const conv = getConversation(config.hub, id);
              if (!conv) {
                wsSend(ws, { feed, error: 'not found' });
                return;
              }
              meta.subscribed.add(feed);
              addWsConvClient(id, ws);
              try { wsSend(ws, { feed, id, conv }); } catch (_) {}
              // Align stamp so the next tick only pushes on real disk changes.
              rememberPushedConv(id, conv);
            }
          } else if (action === 'unsubscribe' && typeof feed === 'string') {
            meta.subscribed.delete(feed);
            if (feed === 'agents') removeWsAgentsClient(ws);
            else if (feed.startsWith('conversation:')) {
              const id = feed.slice('conversation:'.length);
              removeWsConvClient(id, ws);
            }
          }
        });

        ws.on('close', () => {
          removeWsAgentsClient(ws);
          // Remove from all conv rooms
          for (const [id, set] of wsConvClients.entries()) {
            set.delete(ws);
            if (set.size === 0) wsConvClients.delete(id);
          }
          wsClientMeta.delete(ws);
        });

        // Welcome / ready (client still needs to subscribe)
        wsSend(ws, { feed: 'ready', ok: true });
      });
    });
  }

  return server;
}

function pidFilePath(hub) {
  return path.join(hub, ".bizagent", "control-plane.pid");
}

/** Write our PID so control-plane.sh can manage us even when systemd/nohup started us. */
function writePidFile(hub) {
  try {
    const dir = path.join(hub, ".bizagent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pidFilePath(hub), `${process.pid}\n`, "utf8");
  } catch (_err) {
    // Non-fatal: shell discovery can still find us via /proc.
  }
}

/** Remove the PID file only if it still points at this process. */
function clearPidFile(hub) {
  const file = pidFilePath(hub);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing === String(process.pid)) fs.unlinkSync(file);
  } catch (_err) {
    // absent or unreadable — fine
  }
}

function start(hubInput) {
  const config = loadRuntimeConfig(hubInput);
  attachEnterprisePlugin(config);
  config._enterpriseFp = JSON.stringify(
    (config.registry.settings && config.registry.settings.enterprise) || null,
  );
  const server = createServer(config);
  ensureHubRuntimePrompt(config.hub);
  // Main-process push hook: safety net / spawn exit handler mutations broadcast
  // immediately. EXIT-trap child processes do not register this (empty client sets).
  setOnConversationMutated((_hub, id) => {
    try { pushConv(config, id); } catch (_) {}
  });
  // Own the pidfile for the lifetime of this process (systemd, nohup, or bare node).
  writePidFile(config.hub);
  const clear = () => clearPidFile(config.hub);
  process.once("exit", clear);
  process.once("SIGINT", () => {
    clear();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    clear();
    process.exit(143);
  });
  runTick(config);
  // Honor settings.dispatch.poll_seconds (default 2; was previously hard-coded).
  const pollMs = Math.max(1000, Math.min(30000, Number(config.pollSeconds || 2) * 1000));
  setInterval(() => {
    refreshRuntimeConfig(config);
    runTick(config);
  }, pollMs);
  server.listen(config.port, config.host, () => {
    const bindUrl = `http://${config.host}:${config.port}`;
    const openUrl = config.host === '0.0.0.0' ? `http://localhost:${config.port}` : bindUrl;
    const logLine = openUrl !== bindUrl
      ? `bizagent-control-plane listening on ${config.host}:${config.port} poll=${config.pollSeconds}s (open ${openUrl})`
      : `bizagent-control-plane listening on ${bindUrl} poll=${config.pollSeconds}s`;
    
    logEvent(config.hub, {
      event: 'control_plane_start',
      status: 'ok',
      host: config.host,
      port: config.port,
      poll_seconds: config.pollSeconds,
      bind_url: bindUrl
    });
    console.log(`${new Date().toISOString()} ${logLine}`);
  });
  return server;
}

if (require.main === module) {
  start(process.argv[2]);
}

module.exports = {
  attachEnterprisePlugin,
  conversationIdsFromSafetyResults,
  createServer,
  pushConv,
  pushConversationsChangedOnDisk,
  runTick,
  start,
};
