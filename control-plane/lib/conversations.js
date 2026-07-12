const fs = require('fs');
const path = require('path');
const { appDir, ensureDir, readJson } = require('./config');
const { compactHubSession, resetHubSession } = require('./hub-memory');

const MAX_STORED_MESSAGES = 48;
const KEEP_RECENT_MESSAGES = 24;
const MAX_SUMMARY_CHARS = 6000;
const VALID_CONVERSATION_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[a-f0-9]{6}$/;
const userInboxDeliveries = new Map();

function conversationsDir(hub) {
  return path.join(appDir(hub), 'conversations');
}

function userInbox(hub) {
  return path.join(hub, 'user', 'inbox');
}

function slugify(value) {
  return String(value || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'conversation';
}

function assertValidConversationId(id) {
  if (!VALID_CONVERSATION_ID.test(String(id || ''))) {
    throw new Error('invalid conversation id');
  }
}

function safeConversationFile(hub, id) {
  assertValidConversationId(id);
  const dir = path.resolve(conversationsDir(hub));
  const file = path.resolve(dir, `${id}.json`);
  if (!file.startsWith(`${dir}${path.sep}`)) {
    throw new Error('invalid conversation path');
  }
  return file;
}

function excerpt(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function compactConversation(conv) {
  if (!Array.isArray(conv.messages) || conv.messages.length <= MAX_STORED_MESSAGES) return conv;
  const older = conv.messages.slice(0, conv.messages.length - KEEP_RECENT_MESSAGES);
  const recent = conv.messages.slice(-KEEP_RECENT_MESSAGES);
  const additions = older.map((msg) => `- ${msg.role || 'message'}: ${excerpt(msg.content)}`).join('\n');
  const existing = conv.summary ? `${conv.summary.trim()}\n` : '';
  conv.summary = `${existing}${additions}`.trim().slice(-MAX_SUMMARY_CHARS);
  conv.messages = recent;
  return conv;
}

function shouldStartNewConversation(content) {
  return /^(new conversation|start new conversation|new topic|change topic)\b/i.test(String(content || '').trim());
}

function conversationNameFromContent(content) {
  return String(content || '')
    .trim()
    .replace(/^(new conversation|start new conversation|new topic|change topic)[:\s-]*/i, '')
    .split(/\r?\n/)[0]
    .trim()
    .slice(0, 80) || 'New conversation';
}

function writeFileUnique(dir, basename, content) {
  ensureDir(dir);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = Math.random().toString(16).slice(2, 8);
    const file = path.join(dir, `${basename}-${suffix}.md`);
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
      return file;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('could not allocate unique hub inbox filename');
}

function listConversations(hub) {
  ensureDir(conversationsDir(hub));
  return fs.readdirSync(conversationsDir(hub))
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(conversationsDir(hub), name), null))
    .filter(Boolean)
    .map((conv) => ({ id: conv.id, name: conv.name, updated_at: conv.updated_at }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function createConversation(hub, name) {
  ensureDir(conversationsDir(hub));
  const now = new Date().toISOString();
  const id = `${now.slice(0, 10)}-${slugify(name)}-${Math.random().toString(16).slice(2, 8)}`;
  const conv = { id, name: name || 'Conversation', created_at: now, updated_at: now, summary: '', messages: [] };
  fs.writeFileSync(safeConversationFile(hub, id), `${JSON.stringify(conv, null, 2)}\n`);
  resetHubSession(hub, conv);
  return conv;
}

function getConversation(hub, id) {
  let file;
  try {
    file = safeConversationFile(hub, id);
  } catch (_err) {
    return null;
  }
  const conv = readJson(file, null);
  if (conv) compactHubSession(hub, conv);
  return conv;
}

function appendMessage(hub, id, role, content) {
  const conv = getConversation(hub, id);
  if (!conv) throw new Error('conversation not found');
  conv.messages.push({ role, content, created_at: new Date().toISOString() });
  conv.updated_at = new Date().toISOString();
  compactConversation(conv);
  fs.writeFileSync(safeConversationFile(hub, id), `${JSON.stringify(conv, null, 2)}\n`);
  compactHubSession(hub, conv);
  return conv;
}

function writeHubInboxMessage(hub, content, conversationId) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const header = [
    '---',
    'from: operator',
    'to: hub',
    `date: ${date}`,
    'subject: console message',
    conversationId ? `conversation_id: ${conversationId}` : '',
    '---',
  ].filter((line) => line !== '').join('\n');
  return writeFileUnique(path.join(hub, 'inbox'), `${date}-operator-console-message-${stamp}`, `${header}\n\n${content}\n`);
}

function frontmatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

function userInboxFingerprint(file) {
  const stat = fs.statSync(file);
  return {
    file: path.basename(file),
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
  };
}

function sameUserInboxFingerprint(left, right) {
  return left.file === right.file && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function userInboxDeliveryKey(hub) {
  return path.resolve(hub);
}

function recordUserInboxDelivery(hub, file) {
  const key = userInboxDeliveryKey(hub);
  const delivered = (userInboxDeliveries.get(key) || [])
    .filter((item) => fs.existsSync(path.join(userInbox(hub), item.file)));
  const fingerprint = userInboxFingerprint(file);
  if (!delivered.some((item) => sameUserInboxFingerprint(item, fingerprint))) {
    delivered.push(fingerprint);
  }
  userInboxDeliveries.set(key, delivered.slice(-200));
}

function wasUserInboxDelivered(hub, file) {
  const fingerprint = userInboxFingerprint(file);
  return (userInboxDeliveries.get(userInboxDeliveryKey(hub)) || [])
    .some((item) => sameUserInboxFingerprint(item, fingerprint));
}

function markdownBody(text) {
  const match = String(text || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (match ? match[1] : text).trim();
}

function archiveUserInboxMessage(hub, file) {
  const archive = path.join(userInbox(hub), 'archive');
  ensureDir(archive);
  fs.renameSync(file, path.join(archive, path.basename(file)));
}

function readUserInboxMessages(hub) {
  const inbox = userInbox(hub);
  ensureDir(inbox);
  ensureDir(path.join(inbox, 'archive'));
  let relayed = 0;
  for (const name of fs.readdirSync(inbox).filter((entry) => entry.endsWith('.md')).sort()) {
    const file = path.join(inbox, name);
    const text = fs.readFileSync(file, 'utf8');
    const from = frontmatterValue(text, 'from');
    const conversationId = frontmatterValue(text, 'conversation_id');
    if (!wasUserInboxDelivered(hub, file) || from !== 'hub' || !conversationId || !getConversation(hub, conversationId)) {
      archiveUserInboxMessage(hub, file);
      continue;
    }
    appendMessage(hub, conversationId, 'hub', markdownBody(text));
    archiveUserInboxMessage(hub, file);
    relayed += 1;
  }
  return relayed;
}

module.exports = {
  appendMessage,
  assertValidConversationId,
  conversationNameFromContent,
  createConversation,
  getConversation,
  listConversations,
  readUserInboxMessages,
  recordUserInboxDelivery,
  shouldStartNewConversation,
  safeConversationFile,
  userInbox,
  writeFileUnique,
  writeHubInboxMessage,
};
