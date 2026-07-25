const fs = require('fs');
const path = require('path');
const { appDir, ensureDir, readJson } = require('./config');
const { compactHubSession, resetHubSession } = require('./hub-memory');
const { logEvent } = require('./log');

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

/** Deterministic CP launch ack — no model. Superseded when a real hub reply arrives. */
const LAUNCH_ACK_TEXT = 'Working. Stand by...';
const LAUNCH_ACK_KIND = 'launch-ack';
const STATUS_ERROR_KIND = 'error';

/** CP-owned notice posted when a product agent exits cleanly and mailed hub (with stamped conv). */
const AGENT_COMPLETION_KIND = 'agent-completion';
const AGENT_COMPLETION_TEXT = (slug) => `Agent ${slug} finished — summarizing…`;

function isLaunchAckMessage(msg) {
  return msg && msg.role === 'status' && msg.kind === LAUNCH_ACK_KIND;
}

function isAgentCompletionMessage(msg) {
  return msg && msg.role === 'status' && msg.kind === AGENT_COMPLETION_KIND;
}

/**
 * Remove transient status lines (launch-ack and agent-completion notices) from a conversation.
 * Called when a real hub reply or hard failure is posted.
 */
function stripTransientStatuses(conv) {
  if (!conv || !Array.isArray(conv.messages)) return 0;
  const before = conv.messages.length;
  conv.messages = conv.messages.filter((msg) => {
    if (msg.role === 'status' && (msg.kind === LAUNCH_ACK_KIND || msg.kind === AGENT_COMPLETION_KIND)) return false;
    return true;
  });
  return before - conv.messages.length;
}

/** Back-compat wrapper — strips launch acks (and now also completion notices). */
function stripLaunchAcks(conv) {
  return stripTransientStatuses(conv);
}

function saveConversation(hub, conv) {
  conv.updated_at = new Date().toISOString();
  compactConversation(conv);
  fs.writeFileSync(safeConversationFile(hub, conv.id), `${JSON.stringify(conv, null, 2)}\n`);
  compactHubSession(hub, conv);
  return conv;
}

/**
 * Append a message. Optional meta: { kind } (e.g. launch-ack, error, agent-completion).
 * Real hub replies and error statuses supersede transient status lines (launch-ack + agent-completion).
 */
function appendMessage(hub, id, role, content, meta = {}) {
  const conv = getConversation(hub, id);
  if (!conv) throw new Error('conversation not found');
  if (role === 'hub' || (role === 'status' && meta.kind === STATUS_ERROR_KIND)) {
    stripTransientStatuses(conv);
  }
  const msg = { role, content, created_at: new Date().toISOString() };
  if (meta.kind) msg.kind = meta.kind;
  conv.messages.push(msg);
  return saveConversation(hub, conv);
}

/**
 * Post one CP-owned launch ack into the conversation (idempotent per open ack).
 * Returns the conversation, or null if id is missing/invalid.
 */
function postLaunchAck(hub, conversationId, text = LAUNCH_ACK_TEXT) {
  if (!conversationId) return null;
  const conv = getConversation(hub, conversationId);
  if (!conv) return null;
  const last = conv.messages[conv.messages.length - 1];
  // One visible ack at a time — do not spam if the previous ack is still showing.
  if (isLaunchAckMessage(last)) return conv;
  conv.messages.push({
    role: 'status',
    kind: LAUNCH_ACK_KIND,
    content: text,
    created_at: new Date().toISOString(),
  });
  return saveConversation(hub, conv);
}

/**
 * Post a CP-owned one-liner when a product agent exits cleanly with hub-bound mail.
 * Idempotent: do not post a second notice if one is already the last visible transient.
 */
function postAgentCompletionNotice(hub, conversationId, slug) {
  if (!conversationId || !slug) return null;
  const conv = getConversation(hub, conversationId);
  if (!conv) return null;
  const last = conv.messages[conv.messages.length - 1];
  if (isLaunchAckMessage(last) || isAgentCompletionMessage(last)) {
    // Replace the transient with the more specific agent completion notice.
    // Strip both kinds then append the new one.
    stripTransientStatuses(conv);
  } else if (isAgentCompletionMessage(last)) {
    return conv;
  }
  const text = AGENT_COMPLETION_TEXT(slug);
  conv.messages.push({
    role: 'status',
    kind: AGENT_COMPLETION_KIND,
    content: text,
    created_at: new Date().toISOString(),
  });
  return saveConversation(hub, conv);
}

/** Drop any launch-ack status lines now that a real reply (or failure) is in. */
function supersedeLaunchAcks(hub, conversationId) {
  if (!conversationId) return null;
  const conv = getConversation(hub, conversationId);
  if (!conv) return null;
  const removed = stripLaunchAcks(conv);
  if (removed === 0) return conv;
  return saveConversation(hub, conv);
}

function writeHubInboxMessage(hub, content, conversationId) {
  const start = Date.now();
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

  const result = writeFileUnique(path.join(hub, 'inbox'), `${date}-operator-console-message-${stamp}`, `${header}\n\n${content}\n`);

  logEvent(hub, {
    event: 'write_hub_inbox',
    conversation_id: conversationId,
    duration_ms: Math.round((Date.now() - start) * 100) / 100
  });

  return result;
}

function frontmatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

/** How long a console conversation stays "open" after last GET/POST touch. */
const ACTIVE_CONVERSATION_MAX_AGE_MS = 30_000;

function activeConversationFile(hub) {
  return path.join(appDir(hub), 'active-conversation.json');
}

/**
 * Mark a conversation as the open console chat. Called when the web UI
 * loads or posts to a conversation (poll every ~2s keeps it fresh).
 */
function setActiveConversation(hub, id) {
  if (!id || !getConversation(hub, id)) return false;
  ensureDir(appDir(hub));
  fs.writeFileSync(
    activeConversationFile(hub),
    `${JSON.stringify({ id, updated_at: new Date().toISOString() }, null, 2)}\n`,
  );
  return true;
}

/**
 * Return the open console conversation id, or null if none / stale / invalid.
 * @param {number} [maxAgeMs] - override staleness window (default 30s)
 */
function getActiveConversationId(hub, maxAgeMs = ACTIVE_CONVERSATION_MAX_AGE_MS) {
  const data = readJson(activeConversationFile(hub), null);
  if (!data || !data.id || !data.updated_at) return null;
  const age = Date.now() - Date.parse(data.updated_at);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  if (!getConversation(hub, data.id)) return null;
  return data.id;
}

/**
 * Insert conversation_id into YAML frontmatter if the key is absent.
 * Never invents an id; never overwrites a present conversation_id key
 * (including empty values).
 */
function stampConversationId(text, conversationId) {
  const raw = String(text || '');
  if (!conversationId) return raw;
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n?)/);
  if (!match) return raw;
  const body = match[2];
  if (/^conversation_id:/m.test(body)) return raw;
  const insert = body === '' || body.endsWith('\n')
    ? `${body}conversation_id: ${conversationId}`
    : `${body}\nconversation_id: ${conversationId}`;
  return `${match[1]}${insert}${match[3]}${match[4]}${raw.slice(match[0].length)}`;
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


function pendingHubTurnsFile(hub) {
  return path.join(appDir(hub), 'pending-hub-turns.json');
}

/**
 * Conversation that initiated an in-flight console hub turn.
 * Prefer this over the currently-viewed chat when stamping hub→user mail
 * so a reply cannot land in a different session after the operator switches tabs.
 */
function getOriginatingConversationId(hub) {
  const data = readJson(pendingHubTurnsFile(hub), null);
  const turns = data && Array.isArray(data.turns) ? data.turns : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const id = turns[i] && turns[i].conversationId;
    if (id && getConversation(hub, id)) return id;
  }
  return null;
}

/**
 * Id to stamp on hub→user mail missing conversation_id.
 * Originating (in-flight) turn wins; else the open console conversation.
 */
function getStampConversationId(hub) {
  return getOriginatingConversationId(hub) || getActiveConversationId(hub);
}

function deleteConversation(hub, id) {
  let file;
  try {
    file = safeConversationFile(hub, id);
  } catch (_err) {
    return false;
  }
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  const active = readJson(activeConversationFile(hub), null);
  if (active && active.id === id) {
    try {
      fs.unlinkSync(activeConversationFile(hub));
    } catch (_err) {
      /* ignore */
    }
  }
  return true;
}

module.exports = {
  ACTIVE_CONVERSATION_MAX_AGE_MS,
  AGENT_COMPLETION_KIND,
  AGENT_COMPLETION_TEXT,
  appendMessage,
  assertValidConversationId,
  conversationNameFromContent,
  createConversation,
  deleteConversation,
  frontmatterValue,
  getActiveConversationId,
  getConversation,
  getOriginatingConversationId,
  getStampConversationId,
  isAgentCompletionMessage,
  isLaunchAckMessage,
  LAUNCH_ACK_KIND,
  LAUNCH_ACK_TEXT,
  listConversations,
  postAgentCompletionNotice,
  postLaunchAck,
  readUserInboxMessages,
  recordUserInboxDelivery,
  setActiveConversation,
  shouldStartNewConversation,
  safeConversationFile,
  stampConversationId,
  STATUS_ERROR_KIND,
  stripLaunchAcks,
  stripTransientStatuses,
  supersedeLaunchAcks,
  userInbox,
  writeFileUnique,
  writeHubInboxMessage,
};
