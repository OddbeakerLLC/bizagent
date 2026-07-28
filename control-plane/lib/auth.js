const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { appDir, ensureDir, readJson } = require('./config');
const { logEvent } = require('./log');

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
  fs.writeFileSync(authPath(hub), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(sessionPath(hub), '{}\n', { mode: 0o600 });
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
  ensureDir(appDir(hub));
  fs.writeFileSync(sessionPath(hub), `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
}

function createSession(hub, username) {
  const sessions = loadSessions(hub);
  const id = crypto.randomBytes(32).toString('hex');
  sessions[id] = { username, created_at: new Date().toISOString() };
  saveSessions(hub, sessions);
  logEvent(hub, {
    event: 'login',
    username: username,
    session_id: id
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
    session_id: sessionId
  });
}

function getSession(hub, sessionId) {
  if (!sessionId) return null;
  return loadSessions(hub)[sessionId] || null;
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
