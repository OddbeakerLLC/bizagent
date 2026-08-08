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
  // Always advance updated_at so console poll stamps detect ack→reply swaps
  // even when two saves land in the same millisecond (ISO resolution is 1ms).
  const prev = conv.updated_at;
  let next = new Date().toISOString();
  if (prev && next <= prev) {
    const t = Date.parse(prev);
    next = new Date((Number.isFinite(t) ? t : Date.now()) + 1).toISOString();
  }
  conv.updated_at = next;
  compactConversation(conv);
  fs.writeFileSync(safeConversationFile(hub, conv.id), `${JSON.stringify(conv, null, 2)}\n`);
  compactHubSession(hub, conv);
  return conv;
}

/**
 * Append a message. Optional meta: { kind, attachments }.
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
  if (Array.isArray(meta.attachments) && meta.attachments.length) {
    msg.attachments = meta.attachments.map((a) => ({
      name: a.name || '',
      path: a.path || '',
      to: a.to || '',
      size: a.size || undefined,
    }));
  }
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

/** Drop any launch-ack status lines now that a real reply (or failure) is in. */
function supersedeLaunchAcks(hub, conversationId) {
  if (!conversationId) return null;
  const conv = getConversation(hub, conversationId);
  if (!conv) return null;
  const removed = stripLaunchAcks(conv);
  if (removed === 0) return conv;
  return saveConversation(hub, conv);
}

/**
 * Post a CP-owned one-liner when a product agent exits cleanly with hub-bound mail.
 * Strongly idempotent: never append a second notice for the same slug in this
 * conversation, even across re-dispatches while the agent→hub mail remains unarchived.
 */
function postAgentCompletionNotice(hub, conversationId, slug) {
  if (!conversationId || !slug) return null;
  const conv = getConversation(hub, conversationId);
  if (!conv) return null;
  // Scan the whole list — a prior notice for this slug means we already told the operator.
  const already = (conv.messages || []).some(
    (m) => m && m.role === 'status' && m.kind === AGENT_COMPLETION_KIND &&
           typeof m.content === 'string' && m.content.includes(`Agent ${slug} finished`)
  );
  if (already) return conv;
  const last = conv.messages[conv.messages.length - 1];
  if (isLaunchAckMessage(last) || isAgentCompletionMessage(last)) {
    stripTransientStatuses(conv);
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

/**
 * Write operator console message into hub inbox.
 * @param {string} content
 * @param {string} conversationId
 * @param {object} [opts]
 * @param {Array<{name?:string,path:string,to?:string}>} [opts.attachments]
 */
function writeHubInboxMessage(hub, content, conversationId, opts = {}) {
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

  let body = String(content || '');
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
  if (attachments.length) {
    // Lazy require avoids circular load at module init.
    const { formatAttachmentsMarkdown } = require('./uploads');
    body = `${body}${formatAttachmentsMarkdown(attachments)}`;
  }

  const result = writeFileUnique(path.join(hub, 'inbox'), `${date}-operator-console-message-${stamp}`, `${header}\n\n${body}\n`);

  logEvent(hub, {
    event: 'write_hub_inbox',
    conversation_id: conversationId,
    attachment_count: attachments.length,
    duration_ms: Math.round((Date.now() - start) * 100) / 100
  });

  return result;
}

function frontmatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

/** How long the UI "is looking" marker stays fresh (short; for presence). */
const ACTIVE_CONVERSATION_MAX_AGE_MS = 30_000;

/**
 * How long the last-viewed console conversation may still receive stamped
 * hub→user / agent→hub mail. SSE/WS replaced 2s polling, so the short
 * presence window alone drops conversation_id before agents finish work.
 */
const STAMP_ACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Pending hub→agent work retains a conversation_id for this long. */
const PENDING_AGENT_WORK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function activeConversationFile(hub) {
  return path.join(appDir(hub), 'active-conversation.json');
}

function pendingAgentWorkFile(hub) {
  return path.join(appDir(hub), 'pending-agent-work.json');
}

/**
 * Mark a conversation as the open console chat. Called when the web UI
 * loads, posts, or opens a stream/WS subscription for a conversation.
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
 * @param {number} [maxAgeMs] - override staleness window (default 30s presence)
 */
function getActiveConversationId(hub, maxAgeMs = ACTIVE_CONVERSATION_MAX_AGE_MS) {
  const data = readJson(activeConversationFile(hub), null);
  if (!data || !data.id || !data.updated_at) return null;
  const age = Date.now() - Date.parse(data.updated_at);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  if (!getConversation(hub, data.id)) return null;
  return data.id;
}

function readPendingAgentWork(hub) {
  const data = readJson(pendingAgentWorkFile(hub), null);
  const bySlug = data && data.bySlug && typeof data.bySlug === 'object' ? data.bySlug : {};
  return bySlug;
}

function writePendingAgentWork(hub, bySlug) {
  ensureDir(appDir(hub));
  fs.writeFileSync(
    pendingAgentWorkFile(hub),
    `${JSON.stringify({ bySlug }, null, 2)}\n`,
  );
}

/**
 * Remember which console conversation dispatched work to an agent slug.
 * Used to stamp agent→hub completions after the short UI presence window expires.
 */
/**
 * Remember which console conversation dispatched work to an agent slug.
 * Stacks per slug so two chats using the same agent do not overwrite each other.
 * Newest entry is preferred on lookup (LIFO).
 */
function recordPendingAgentWork(hub, slug, conversationId) {
  if (!slug || !conversationId || !getConversation(hub, conversationId)) return false;
  const bySlug = readPendingAgentWork(hub);
  const key = String(slug);
  const now = new Date().toISOString();
  const entry = {
    conversationId: String(conversationId),
    updatedAt: now,
  };
  const prev = bySlug[key];
  let stack = [];
  if (Array.isArray(prev && prev.stack)) {
    stack = prev.stack.filter(
      (e) => e && e.conversationId && e.conversationId !== conversationId,
    );
  } else if (prev && prev.conversationId && prev.conversationId !== conversationId) {
    stack = [{ conversationId: prev.conversationId, updatedAt: prev.updatedAt || now }];
  }
  stack.push(entry);
  // Cap stack depth
  if (stack.length > 12) stack = stack.slice(-12);
  bySlug[key] = {
    conversationId: entry.conversationId,
    updatedAt: entry.updatedAt,
    stack,
  };
  writePendingAgentWork(hub, bySlug);
  return true;
}

function pendingEntryFresh(hub, entry) {
  if (!entry || !entry.conversationId || !entry.updatedAt) return null;
  const age = Date.now() - Date.parse(entry.updatedAt);
  if (!Number.isFinite(age) || age < 0 || age > PENDING_AGENT_WORK_MAX_AGE_MS) return null;
  if (!getConversation(hub, entry.conversationId)) return null;
  return entry.conversationId;
}

/**
 * Lookup conversation_id for a product agent that still has outstanding work.
 * Prefers newest stack entry. Returns null when missing, expired, or deleted.
 */
function getPendingAgentWorkConversationId(hub, slug) {
  if (!slug) return null;
  const data = readPendingAgentWork(hub)[String(slug)];
  if (!data) return null;
  if (Array.isArray(data.stack) && data.stack.length) {
    for (let i = data.stack.length - 1; i >= 0; i -= 1) {
      const id = pendingEntryFresh(hub, data.stack[i]);
      if (id) return id;
    }
  }
  return pendingEntryFresh(hub, data);
}

/** Drop pending-agent-work entries that point at a deleted conversation id. */
function clearPendingAgentWorkForConversation(hub, conversationId) {
  if (!conversationId) return false;
  const bySlug = readPendingAgentWork(hub);
  let changed = false;
  for (const slug of Object.keys(bySlug)) {
    const data = bySlug[slug];
    if (!data) continue;
    let stack = Array.isArray(data.stack) ? data.stack.slice() : null;
    if (stack) {
      const next = stack.filter((e) => e && e.conversationId !== conversationId);
      if (next.length !== stack.length) {
        changed = true;
        stack = next;
      }
    }
    if (data.conversationId === conversationId) {
      changed = true;
      if (stack && stack.length) {
        const top = stack[stack.length - 1];
        bySlug[slug] = {
          conversationId: top.conversationId,
          updatedAt: top.updatedAt,
          stack,
        };
      } else {
        delete bySlug[slug];
      }
    } else if (stack) {
      if (stack.length === 0) delete bySlug[slug];
      else {
        const top = stack[stack.length - 1];
        bySlug[slug] = {
          conversationId: top.conversationId,
          updatedAt: top.updatedAt,
          stack,
        };
      }
    }
  }
  if (changed) writePendingAgentWork(hub, bySlug);
  return changed;
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

function normalizeForSimilarity(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Very cheap near-dupe check: normalized body similarity + short window. */
function isNearDuplicateHubReply(messages, body, windowMs = 5 * 60 * 1000) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const want = normalizeForSimilarity(body);
  const now = Date.now();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'hub') continue;
    const ts = Date.parse(m.created_at || 0);
    if (Number.isFinite(ts) && now - ts > windowMs) break;
    const existing = normalizeForSimilarity(m.content);
    if (!existing) continue;
    // High overlap or exact after normalization
    if (existing === want) return true;
    const len = Math.min(existing.length, want.length);
    if (len > 20) {
      let same = 0;
      for (let j = 0; j < len; j += 1) if (existing[j] === want[j]) same += 1;
      if (same / len >= 0.92) return true;
    }
  }
  return false;
}

/**
 * Relay hub→user inbox mail into conversation JSON.
 * Returns { relayed, ids } so the main CP process can push those convs over WS/SSE.
 * (Numeric-only return was insufficient: callers need the conversation ids.)
 */
function readUserInboxMessages(hub) {
  const inbox = userInbox(hub);
  ensureDir(inbox);
  ensureDir(path.join(inbox, 'archive'));
  let relayed = 0;
  const ids = [];
  for (const name of fs.readdirSync(inbox).filter((entry) => entry.endsWith('.md')).sort()) {
    const file = path.join(inbox, name);
    const text = fs.readFileSync(file, 'utf8');
    const from = frontmatterValue(text, 'from');
    const conversationId = frontmatterValue(text, 'conversation_id');
    if (!wasUserInboxDelivered(hub, file) || from !== 'hub' || !conversationId || !getConversation(hub, conversationId)) {
      archiveUserInboxMessage(hub, file);
      continue;
    }
    const body = markdownBody(text);
    const conv = getConversation(hub, conversationId);
    if (conv && isNearDuplicateHubReply(conv.messages, body)) {
      // Near-duplicate within window — drop instead of appending a second paraphrased reply.
      archiveUserInboxMessage(hub, file);
      continue;
    }
    appendMessage(hub, conversationId, 'hub', body);
    archiveUserInboxMessage(hub, file);
    relayed += 1;
    ids.push(conversationId);
  }
  return { relayed, ids: [...new Set(ids)] };
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
 * Id to stamp on mail missing conversation_id.
 *
 * When fromSlug is set (agent→hub completions):
 *   1. pending hub→agent work for that slug — the chat that dispatched the agent
 *   2. last-viewed console chat (long TTL) — last resort only
 *   Never use the in-flight hub turn: that is whichever chat the operator is
 *   talking to *now*, and must not steal another product's completion mail.
 *
 * When fromSlug is absent (hub→user and other unscoped mail):
 *   1. in-flight originating hub turn (never overridden by active UI chat)
 *   2. last-viewed console chat (long TTL) — last resort only
 *
 * @param {string} [fromSlug] - product agent slug when routing agent→hub mail
 */
function getStampConversationId(hub, fromSlug) {
  if (fromSlug) {
    const pending = getPendingAgentWorkConversationId(hub, fromSlug);
    if (pending) return pending;
    return getActiveConversationId(hub, STAMP_ACTIVE_MAX_AGE_MS);
  }
  const originating = getOriginatingConversationId(hub);
  if (originating) return originating;
  return getActiveConversationId(hub, STAMP_ACTIVE_MAX_AGE_MS);
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
  try {
    clearPendingAgentWorkForConversation(hub, id);
  } catch (_err) {
    /* non-fatal */
  }
  try {
    const { gcConversationUploads } = require('./uploads');
    gcConversationUploads(hub, id);
  } catch (_err) {
    /* non-fatal */
  }
  return true;
}

module.exports = {
  ACTIVE_CONVERSATION_MAX_AGE_MS,
  STAMP_ACTIVE_MAX_AGE_MS,
  PENDING_AGENT_WORK_MAX_AGE_MS,
  AGENT_COMPLETION_KIND,
  AGENT_COMPLETION_TEXT,
  activeConversationFile,
  appendMessage,
  assertValidConversationId,
  conversationNameFromContent,
  clearPendingAgentWorkForConversation,
  createConversation,
  deleteConversation,
  frontmatterValue,
  getActiveConversationId,
  getConversation,
  getOriginatingConversationId,
  getPendingAgentWorkConversationId,
  getStampConversationId,
  isAgentCompletionMessage,
  isLaunchAckMessage,
  isNearDuplicateHubReply: (conv, body) => {
    // Export helper for tests (internal conv.messages expected)
    const msgs = (conv && Array.isArray(conv.messages)) ? conv.messages : [];
    return isNearDuplicateHubReply(msgs, body);
  },
  LAUNCH_ACK_KIND,
  LAUNCH_ACK_TEXT,
  listConversations,
  pendingAgentWorkFile,
  postAgentCompletionNotice,
  postLaunchAck,
  readUserInboxMessages,
  recordPendingAgentWork,
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
