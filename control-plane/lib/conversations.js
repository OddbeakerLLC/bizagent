const fs = require('fs');
const path = require('path');
const { appDir, ensureDir, readJson, loadRegistry } = require('./config');
const { writeJsonAtomic } = require('./atomic-state');
const { assertBulkyWriteAllowed } = require('./log-caps');
const { compactHubSession, resetHubSession } = require('./hub-memory');
const { logEvent } = require('./log');

const MAX_STORED_MESSAGES = 48;
const KEEP_RECENT_MESSAGES = 24;
const MAX_SUMMARY_CHARS = 6000;
const VALID_CONVERSATION_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[a-f0-9]{6}$/;
/** Chat-product binding (2026-11-08): a chat may be bound to at most 3 products. */
const MAX_BOUND_PRODUCTS = 3;
/** Pinned landing chat for configured hubs: hub topics + products with no chat of their own. */
const GENERAL_CONVERSATION_NAME = 'General';
const VALID_SLUG = /^[A-Za-z0-9._-]+$/;
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

// --- Chat-product binding (2026-11-08) -------------------------------------
// A conversation is bound to the registry products it pertains to. Routing for
// agent→hub mail is deterministic: the chat the operator asked in owns answers;
// unsolicited reports go to the chat bound to the sender product.

/** Clean a product list: registry slugs only, deduped, capped at MAX_BOUND_PRODUCTS. */
function normalizeProducts(value) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const item of raw) {
    const slug = String(item || '').trim().toLowerCase();
    if (!slug || !VALID_SLUG.test(slug)) continue;
    if (!out.includes(slug)) out.push(slug);
    if (out.length >= MAX_BOUND_PRODUCTS) break;
  }
  return out;
}

function conversationKind(conv) {
  if (!conv) return 'general';
  if (conv.kind === 'product') return 'product';
  return normalizeProducts(conv.products).length ? 'product' : 'general';
}

/**
 * Explicitly unassigned chat (2026-11-08): the operator chose "no product", so
 * the absence of an association is a stored state, not a gap the UI has to
 * guess at. Chats created before this feature have no `unassigned` field and
 * keep their existing routing behaviour.
 *
 * An unassigned chat is chat-only: the hub answers directly there, no product
 * agent work is attributed to it, and product reports are never routed into it
 * (the resolver sends them to the bound chat or pinned General).
 */
function isUnassignedConversation(hub, idOrConv) {
  const conv = typeof idOrConv === 'string' ? getConversation(hub, idOrConv) : idOrConv;
  if (!conv) return false;
  return conv.unassigned === true && normalizeProducts(conv.products).length === 0;
}

function registrySlugs(hub) {
  try {
    const registry = loadRegistry(hub);
    return (Array.isArray(registry.products) ? registry.products : [])
      .map((p) => String((p && p.slug) || '').trim().toLowerCase())
      .filter(Boolean);
  } catch (_err) {
    return [];
  }
}

function isProductSlug(hub, slug) {
  return registrySlugs(hub).includes(String(slug || '').trim().toLowerCase());
}

/** All conversations bound to a slug, newest activity first. */
function boundConversationsForProduct(hub, slug) {
  const want = String(slug || '').trim().toLowerCase();
  if (!want) return [];
  return listConversations(hub)
    .filter((conv) => normalizeProducts(conv.products).includes(want))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

/** The pinned General chat, or null (never created on the read path). */
function getGeneralConversation(hub) {
  const list = listConversations(hub);
  const general = list.find((conv) => conv.pinned && conversationKind(conv) === 'general');
  return general || null;
}

/**
 * Pinned General landing chat — created only for configured hubs (first-run
 * keeps the installer Welcome chat). Idempotent.
 */
function ensureGeneralConversation(hub) {
  const existing = getGeneralConversation(hub);
  if (existing) return existing;
  if (!registrySlugs(hub).length) return null;
  ensureDir(conversationsDir(hub));
  return createConversation(hub, GENERAL_CONVERSATION_NAME, {
    kind: 'general',
    pinned: true,
    unassigned: true,
  });
}

/**
 * Bind/unbind products on a conversation. Manual change = operator override,
 * so the inferred flag clears. Cap MAX_BOUND_PRODUCTS enforced here.
 */
function updateConversationProducts(hub, id, products, opts = {}) {
  const conv = getConversation(hub, id);
  if (!conv) return null;
  const next = normalizeProducts(products);
  conv.products = next;
  conv.kind = next.length ? 'product' : 'general';
  // An operator-set empty list is an explicit "no product" state, not a gap.
  conv.unassigned = next.length === 0;
  if (opts.inferred === true) conv.products_inferred = true;
  else conv.products_inferred = false;   // manual override / confirmation
  const known = new Set(registrySlugs(hub));
  conv.products_stale = normalizeProducts(conv.products_stale || []).filter((s) => known.has(s));
  return saveConversation(hub, conv);
}

/**
 * Product deleted from the registry: mark the binding stale on every chat that
 * still references it. Never prune silently — the operator may re-add the slug.
 */
function markStaleBindings(hub, slug) {
  const want = String(slug || '').trim().toLowerCase();
  if (!want) return 0;
  let changed = 0;
  for (const entry of listConversations(hub)) {
    const conv = getConversation(hub, entry.id);
    if (!conv) continue;
    const stale = normalizeProducts(conv.products_stale || []);
    if (normalizeProducts(conv.products).includes(want) && !stale.includes(want)) {
      stale.push(want);
      conv.products_stale = stale;
      conv.binding_stale = true;
      saveConversation(hub, conv);
      changed += 1;
    }
  }
  return changed;
}

/** Compare every binding against the registry and mark dangling slugs stale. */
function syncStaleBindings(hub) {
  const known = new Set(registrySlugs(hub));
  let changed = 0;
  for (const entry of listConversations(hub)) {
    const conv = getConversation(hub, entry.id);
    if (!conv) continue;
    const dangling = normalizeProducts(conv.products).filter((s) => !known.has(s));
    const stale = normalizeProducts(conv.products_stale || []);
    const additions = dangling.filter((s) => !stale.includes(s));
    if (!additions.length) continue;
    conv.products_stale = normalizeProducts(stale.concat(additions));
    conv.binding_stale = true;
    saveConversation(hub, conv);
    changed += 1;
  }
  return changed;
}

/**
 * Chat that owns a work item — the chat the operator asked in.
 * agent→hub: the chat that dispatched this slug's work (pending-agent-work).
 * hub→user / hub→agent: the conversation that started the in-flight hub turn.
 */
function workItemOriginConversationId(hub, mail = {}) {
  const from = String(mail.from || '').trim().toLowerCase();
  const to = String(mail.to || '').trim().toLowerCase();
  if (to === 'hub' && from && from !== 'hub' && from !== 'user') {
    return getPendingAgentWorkConversationId(hub, from);
  }
  return getOriginatingConversationId(hub);
}

/**
 * The one resolver used by BOTH route-time stamping (mail.js) and turn-time
 * conversation choice (dispatcher/hub-memory) — they must never disagree.
 *
 * Priority (operator rule, 2026-11-08):
 *   1. explicit conversation_id — always wins.
 *   2. the chat the operator asked the question in (work-item origin).
 *   3. unsolicited report (no operator input pending): the chat bound to the
 *      sender product; multiple → most recently active bound chat.
 *   4. pinned General.
 *   5. the chat the operator is currently viewing.
 * Returns { conversationId, pointerConversationId, reason, proactive }.
 * The pointer (status role, never spoken by TTS) goes to the viewing chat when
 * a proactive report lands somewhere else.
 */
function resolveConversationForMail(hub, mail = {}) {
  const from = String(mail.from || '').trim().toLowerCase();
  const to = String(mail.to || '').trim().toLowerCase();
  const explicit = String(mail.conversationId || '').trim();
  if (explicit && VALID_CONVERSATION_ID.test(explicit)) {
    // A mail that already carries a conversation_id always wins — including ids
    // recovered from inbox-archive by same sender (hub-memory), where the chat
    // file may be gone. Callers that need a live chat check existence.
    return { conversationId: explicit, pointerConversationId: null, reason: 'explicit', proactive: false };
  }

  const origin = workItemOriginConversationId(hub, { from, to });
  const proactive = !origin;
  let destination = origin;
  let reason = origin ? 'origin' : '';

  if (!destination && proactive && isProductSlug(hub, from)) {
    const bound = boundConversationsForProduct(hub, from);
    if (bound.length) {
      destination = bound[0].id;
      reason = 'bound';
    }
  }
  if (!destination) {
    const general = getGeneralConversation(hub);
    if (general) {
      destination = general.id;
      reason = 'general';
    }
  }
  if (!destination) {
    const active = getActiveConversationId(hub, STAMP_ACTIVE_MAX_AGE_MS);
    // Chat-only guard: an explicitly unassigned chat never receives a proactive
    // product report (the hub answers directly there). Answers to a question
    // asked in that chat still land in it via the origin branch above.
    if (active && !(proactive && isUnassignedConversation(hub, active))) {
      destination = active;
      reason = 'active';
    }
  }

  let pointerConversationId = null;
  if (proactive && destination) {
    const viewing = getActiveConversationId(hub, STAMP_ACTIVE_MAX_AGE_MS);
    if (viewing && viewing !== destination) pointerConversationId = viewing;
  }
  return {
    conversationId: destination || null,
    pointerConversationId,
    reason: reason || 'none',
    proactive,
  };
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
    .map((conv) => ({
      id: conv.id,
      name: conv.name,
      updated_at: conv.updated_at,
      products: normalizeProducts(conv.products),
      kind: conversationKind(conv),
      pinned: conv.pinned === true,
      products_inferred: conv.products_inferred === true,
      products_stale: normalizeProducts(conv.products_stale || []),
      unassigned: conv.unassigned === true && normalizeProducts(conv.products).length === 0,
    }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function createConversation(hub, name, opts = {}) {
  ensureDir(conversationsDir(hub));
  const now = new Date().toISOString();
  const id = `${now.slice(0, 10)}-${slugify(name)}-${Math.random().toString(16).slice(2, 8)}`;
  const products = normalizeProducts(opts.products);
  const conv = {
    id,
    name: name || 'Conversation',
    created_at: now,
    updated_at: now,
    summary: '',
    messages: [],
    products,
    kind: opts.kind || (products.length ? 'product' : 'general'),
    pinned: opts.pinned === true,
    products_inferred: opts.products_inferred === true,
    unassigned: opts.unassigned === true && products.length === 0,
  };
  const stale = normalizeProducts(opts.products_stale || []);
  if (stale.length) conv.products_stale = stale;
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
  // Session compaction is mutation-scoped only (saveConversation / createConversation).
  // getConversation runs on every WS/SSE poll, so compaction here would rewrite
  // the per-chat session file on each poll.
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
  const json = `${JSON.stringify(conv, null, 2)}\n`;
  // Bulky-write guard (disk-full protection): a long conversation must not eat
  // the reserved free-space buffer during emergencies. Writes >=256 KB are
  // refused when free space is inside the 1.5 GB reserve; the save is skipped
  // (chat keeps working, nothing crashes) and a breadcrumb explains why.
  let guard = { ok: true };
  try {
    guard = assertBulkyWriteAllowed(hub, Buffer.byteLength(json));
  } catch (_err) { /* guard failure must never break saving */ }
  if (guard.ok) {
    fs.writeFileSync(safeConversationFile(hub, conv.id), json);
  } else {
    process.stderr.write(`log-caps: ${guard.reason}; skipped conversation save ${conv.id}\n`);
  }
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
  // DGen form-request / form-submitted metadata (no secrets — specs and ids only),
  // plus the health-banner error key so the console can dedupe banner vs chat.
  for (const key of ['form_id', 'agent', 'form', 'error_key']) {
    if (meta[key] !== undefined) msg[key] = meta[key];
  }
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
  // Operator-visible filename + frontmatter date use host-local time (the
  // console displays these); message created_at fields stay ISO-UTC.
  const { localDateString, localCompactStamp } = require('./local-time');
  const date = localDateString(now);
  const stamp = localCompactStamp(now);
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
  writeJsonAtomic(
    activeConversationFile(hub),
    { id, updated_at: new Date().toISOString() },
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
  writeJsonAtomic(pendingAgentWorkFile(hub), { bySlug });
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
  // Chat-only guard (2026-11-08): an explicitly unassigned chat must not own
  // product-agent work — the hub answers directly there, so agent replies are
  // never attributed back into a scratch chat (they go to the bound chat or
  // pinned General). Chats with no `unassigned` flag keep old behaviour.
  if (isUnassignedConversation(hub, conversationId)) return false;
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

// --- Cross-conversation waiting indicator -------------------------------------
// When an agent error lands in a conversation the operator is NOT currently
// viewing, other conversations get a lightweight one-line indicator (never the
// full error dump). Entries clear when the operator opens the originating
// conversation, or age out after a day.

const CROSS_CHAT_ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CROSS_CHAT_ALERT_MAX_ENTRIES = 20;

function crossChatAlertsFile(hub) {
  return path.join(appDir(hub), 'cross-chat-alerts.json');
}

function readCrossChatAlerts(hub) {
  const data = readJson(crossChatAlertsFile(hub), null);
  return Array.isArray(data && data.alerts) ? data.alerts : [];
}

function writeCrossChatAlerts(hub, alerts) {
  writeJsonAtomic(crossChatAlertsFile(hub), { alerts });
}

/**
 * Remember that conversationId has an unread agent error waiting.
 * One entry per (conversation, slug); newest wins; bounded list.
 */
function recordCrossChatAlert(hub, conversationId, slug, title, opts = {}) {
  if (!conversationId || !getConversation(hub, conversationId)) return false;
  const kind = String(opts.kind || 'error');
  const destination = String(opts.destination_conversation_id || conversationId);
  if (destination !== conversationId && !getConversation(hub, destination)) return false;
  const alerts = readCrossChatAlerts(hub);
  const next = alerts.filter(
    (a) => !(a && a.conversationId === conversationId && a.slug === slug && (a.kind || 'error') === kind),
  );
  next.push({
    conversationId: String(conversationId),
    slug: String(slug || ''),
    title: String(title || 'agent error').slice(0, 120),
    kind,
    destination_conversation_id: destination,
    ts: new Date().toISOString(),
  });
  writeCrossChatAlerts(hub, next.slice(-CROSS_CHAT_ALERT_MAX_ENTRIES));
  return true;
}

/** Live alerts only: drops expired entries and entries whose conversation was deleted. */
function listCrossChatAlerts(hub) {
  const alerts = readCrossChatAlerts(hub);
  const now = Date.now();
  const live = alerts.filter((a) => {
    if (!a || !a.conversationId) return false;
    const ts = Date.parse(a.ts) || 0;
    if (now - ts > CROSS_CHAT_ALERT_MAX_AGE_MS) return false;
    return !!getConversation(hub, a.conversationId);
  });
  if (live.length !== alerts.length) writeCrossChatAlerts(hub, live);
  return live;
}

/** Clear the waiting indicator once the operator opens the originating conversation. */
function clearCrossChatAlerts(hub, conversationId) {
  if (!conversationId) return false;
  const alerts = readCrossChatAlerts(hub);
  const next = alerts.filter((a) => a && a.conversationId !== conversationId);
  if (next.length === alerts.length) return false;
  writeCrossChatAlerts(hub, next);
  return true;
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
 * Id to stamp on mail missing conversation_id — thin wrapper over the single
 * shared resolver (resolveConversationForMail) so route-time stamping and
 * turn-time conversation choice can never disagree.
 *
 * @param {string} [fromSlug] - product agent slug when routing agent→hub mail
 */
function getStampConversationId(hub, fromSlug) {
  const mail = fromSlug
    ? { from: fromSlug, to: 'hub' }
    : { from: 'hub', to: 'user' };
  return resolveConversationForMail(hub, mail).conversationId;
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
  GENERAL_CONVERSATION_NAME,
  MAX_BOUND_PRODUCTS,
  activeConversationFile,
  appendMessage,
  assertValidConversationId,
  boundConversationsForProduct,
  conversationKind,
  conversationNameFromContent,
  clearPendingAgentWorkForConversation,
  clearCrossChatAlerts,
  createConversation,
  deleteConversation,
  ensureGeneralConversation,
  frontmatterValue,
  getActiveConversationId,
  getConversation,
  getGeneralConversation,
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
  isProductSlug,
  isUnassignedConversation,
  LAUNCH_ACK_KIND,
  LAUNCH_ACK_TEXT,
  listConversations,
  listCrossChatAlerts,
  markStaleBindings,
  normalizeProducts,
  pendingAgentWorkFile,
  postAgentCompletionNotice,
  postLaunchAck,
  readUserInboxMessages,
  recordPendingAgentWork,
  recordCrossChatAlert,
  recordUserInboxDelivery,
  registrySlugs,
  resolveConversationForMail,
  setActiveConversation,
  saveConversation,
  shouldStartNewConversation,
  safeConversationFile,
  stampConversationId,
  STATUS_ERROR_KIND,
  stripLaunchAcks,
  stripTransientStatuses,
  supersedeLaunchAcks,
  syncStaleBindings,
  updateConversationProducts,
  userInbox,
  workItemOriginConversationId,
  writeFileUnique,
  writeHubInboxMessage,
};
