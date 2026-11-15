const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { appDir, ensureDir, readJson } = require('./config');
const { writeJsonAtomic } = require('./atomic-state');
const { logEvent } = require('./log');

// H3 (2026-11-15 review): sessions expire after 30 days without use (sliding —
// each authenticated use extends the window). Expired sessions are pruned
// whenever the session file is saved, so it cannot grow unboundedly.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Sliding refresh write granularity: only rewrite the session file when the
// stored last_seen is staler than this, so per-request getSession calls do not
// cause an atomic write on every authenticated request.
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

function sessionHash(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || '')).digest('hex').slice(0, 12);
}

function sessionLastSeen(session) {
  return Date.parse((session && (session.last_seen_at || session.created_at)) || '') || 0;
}

function pruneSessions(sessions) {
  const now = Date.now();
  const out = {};
  for (const [id, session] of Object.entries(sessions || {})) {
    if (now - sessionLastSeen(session) < SESSION_TTL_MS) out[id] = session;
  }
  return out;
}

function authPath(hub) {
  return path.join(appDir(hub), 'auth.json');
}

function sessionPath(hub) {
  return path.join(appDir(hub), 'sessions.json');
}

function createSalt() {
  return crypto.randomBytes(24).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
}

function initAuth(hub, username, password) {
  if (!username || !password) throw new Error('username and password are required');
  ensureDir(appDir(hub));
  const salt = createSalt();
  const data = {
    username,
    salt,
    password_hash: hashPassword(password, salt),
    created_at: new Date().toISOString(),
  };
  writeJsonAtomic(authPath(hub), data, { mode: 0o600 });
  writeJsonAtomic(sessionPath(hub), {}, { mode: 0o600 });
  logEvent(hub, {
    event: 'auth_init',
    username: username
  });
}

function hasAuth(hub) {
  return fs.existsSync(authPath(hub));
}

function verifyLogin(hub, username, password) {
  const data = readJson(authPath(hub), null);
  if (!data) return false;
  const expected = Buffer.from(data.password_hash || '', 'hex');
  const actual = Buffer.from(hashPassword(password || '', data.salt || ''), 'hex');
  return username === data.username && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function loadSessions(hub) {
  return readJson(sessionPath(hub), {});
}

function saveSessions(hub, sessions) {
  writeJsonAtomic(sessionPath(hub), sessions, { mode: 0o600 });
}

function createSession(hub, username) {
  const sessions = pruneSessions(loadSessions(hub));
  const id = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  sessions[id] = { username, created_at: now, last_seen_at: now };
  saveSessions(hub, sessions);
  // H3: never log the raw session ID — it is a live credential. Log a
  // truncated hash so login events stay correlatable without leaking it.
  logEvent(hub, {
    event: 'login',
    username: username,
    session_hash: sessionHash(id)
  });
  return id;
}

function destroySession(hub, sessionId) {
  const sessions = loadSessions(hub);
  const username = sessions[sessionId] && sessions[sessionId].username;
  delete sessions[sessionId];
  saveSessions(hub, sessions);
  logEvent(hub, {
    event: 'logout',
    username: username || 'unknown',
    session_hash: sessionHash(sessionId)
  });
}

function getSession(hub, sessionId) {
  if (!sessionId) return null;
  const sessions = loadSessions(hub);
  const session = sessions[sessionId] || null;
  if (!session) return null;
  // Enforce the sliding TTL: an expired session is pruned on sight.
  if (Date.now() - sessionLastSeen(session) >= SESSION_TTL_MS) {
    delete sessions[sessionId];
    saveSessions(hub, sessions);
    return null;
  }
  // Sliding window: touch last_seen (bounded write frequency).
  const last = sessionLastSeen(session);
  if (Date.now() - last >= SESSION_TOUCH_INTERVAL_MS) {
    session.last_seen_at = new Date().toISOString();
    sessions[sessionId] = session;
    saveSessions(hub, sessions);
  }
  return session;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

module.exports = {
  createSession,
  destroySession,
  getSession,
  hasAuth,
  hashPassword,
  initAuth,
  parseCookies,
  verifyLogin,
};
