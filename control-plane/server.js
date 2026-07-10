const fs = require('fs');
const http = require('http');
const path = require('path');
const { agentsFromRegistry, loadRuntimeConfig } = require('./lib/config');
const { createSession, destroySession, getSession, hasAuth, initAuth, parseCookies, verifyLogin } = require('./lib/auth');
const {
  appendMessage,
  conversationNameFromContent,
  createConversation,
  getConversation,
  listConversations,
  shouldStartNewConversation,
  writeHubInboxMessage,
} = require('./lib/conversations');
const { dispatchPendingAgents, isAgentActive } = require('./lib/dispatcher');
const { ensureHubRuntimePrompt } = require('./lib/hub-memory');
const { agentMailStatus, routeOutboxes } = require('./lib/mail');
const { appendLog } = require('./lib/log');

const PUBLIC_DIR = path.join(__dirname, 'public');

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return false;
  const ext = path.extname(file);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function requireAuth(config, req, res) {
  if (!hasAuth(config.hub)) {
    send(res, 401, { error: 'setup required' });
    return false;
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(config.hub, cookies.bizagent_session);
  if (!session) {
    send(res, 401, { error: 'login required' });
    return false;
  }
  req.session = { id: cookies.bizagent_session, ...session };
  return true;
}

function currentState(config) {
  const agents = agentMailStatus(config.hub, agentsFromRegistry(config.registry)).map((agent) => ({
    ...agent,
    active: isAgentActive(config.hub, agent.slug, config.lockLeaseSecs),
  }));
  return { agents };
}

async function handleApi(config, req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/setup' && req.method === 'POST') {
    if (hasAuth(config.hub)) return send(res, 409, { error: 'auth already initialized' });
    const body = await parseBody(req);
    initAuth(config.hub, body.username, body.password);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!verifyLogin(config.hub, body.username, body.password)) return send(res, 401, { error: 'invalid login' });
    const sessionId = createSession(config.hub, body.username);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `bizagent_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/` });
  }

  if (!requireAuth(config, req, res)) return null;

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    if (req.session && req.session.id) destroySession(config.hub, req.session.id);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'bizagent_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return send(res, 200, currentState(config));
  }

  if (url.pathname === '/api/conversations' && req.method === 'GET') {
    return send(res, 200, listConversations(config.hub));
  }

  if (url.pathname === '/api/conversations' && req.method === 'POST') {
    const body = await parseBody(req);
    return send(res, 200, createConversation(config.hub, body.name));
  }

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch && req.method === 'GET') {
    const conv = getConversation(config.hub, decodeURIComponent(conversationMatch[1]));
    if (!conv) return send(res, 404, { error: 'conversation not found' });
    return send(res, 200, conv);
  }

  const messageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messageMatch && req.method === 'POST') {
    const body = await parseBody(req);
    const content = body.content || '';
    const id = shouldStartNewConversation(content)
      ? createConversation(config.hub, conversationNameFromContent(content)).id
      : decodeURIComponent(messageMatch[1]);
    writeHubInboxMessage(config.hub, content, id);
    const conv = appendMessage(config.hub, id, 'user', content);
    return send(res, 200, conv);
  }

  return send(res, 404, { error: 'not found' });
}

function runTick(config) {
  routeOutboxes(config.hub);
  dispatchPendingAgents(config);
}

function createServer(config) {
  return http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      handleApi(config, req, res).catch((err) => send(res, 500, { error: err.message }));
      return;
    }
    if (!serveStatic(req, res)) send(res, 404, 'not found');
  });
}

function start(hubInput) {
  const config = loadRuntimeConfig(hubInput);
  const server = createServer(config);
  ensureHubRuntimePrompt(config.hub);
  runTick(config);
  setInterval(() => runTick(config), 6000);
  server.listen(config.port, config.host, () => {
    appendLog(config.hub, `bizagent-control-plane listening on http://${config.host}:${config.port}`);
    console.log(`bizagent-control-plane listening on http://${config.host}:${config.port}`);
  });
  return server;
}

if (require.main === module) {
  start(process.argv[2]);
}

module.exports = {
  createServer,
  runTick,
  start,
};
