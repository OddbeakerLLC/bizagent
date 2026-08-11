const fs = require('fs');
const path = require('path');
const { agentsFromRegistry, appDir, ensureDir, loadRegistry } = require('./config');
const {
  getStampConversationId,
  postAgentCompletionNotice,
  recordPendingAgentWork,
  recordUserInboxDelivery,
  stampConversationId,
  userInbox,
} = require('./conversations');
const { logEvent, appendLog } = require('./log');

function frontmatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

function inboxFor(hub, slug) {
  if (slug === 'user') return userInbox(hub);
  return slug === 'hub' ? path.join(hub, 'inbox') : path.join(hub, 'agents', slug, 'inbox');
}

function recipientSlugs(hub) {
  return new Set(['hub', 'user', ...agentsFromRegistry(loadRegistry(hub)).map((agent) => agent.slug)]);
}

function safeInboxFor(hub, slug) {
  if (!recipientSlugs(hub).has(slug)) return null;
  const hubRoot = path.resolve(hub);
  const inbox = path.resolve(inboxFor(hub, slug));
  if (inbox !== path.join(hubRoot, 'inbox') && !inbox.startsWith(`${hubRoot}${path.sep}`)) {
    throw new Error(`invalid inbox path for ${slug}`);
  }
  return inbox;
}

function outboxes(hub) {
  const boxes = [path.join(hub, 'outbox')];
  const agentsDir = path.join(hub, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const slug of fs.readdirSync(agentsDir)) {
      const dir = path.join(agentsDir, slug, 'outbox');
      if (fs.existsSync(dir)) boxes.push(dir);
    }
  }
  return boxes;
}

function canRouteToUser(hub, outbox) {
  return path.resolve(outbox) === path.resolve(path.join(hub, 'outbox'));
}

function markdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(dir, name));
}

function writeFileUnique(dir, basename, source) {
  const ext = path.extname(basename);
  const stem = basename.slice(0, basename.length - ext.length);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${Math.random().toString(16).slice(2, 8)}`;
    const dest = path.join(dir, `${stem}${suffix}${ext}`);
    try {
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(source);
      return dest;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not allocate unique delivery filename for ${basename}`);
}

function normalizeBodyForDedupe(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\s+$/g, '').trim();
}

/**
 * Return true if an identical (from/to + normalized body) message already
 * exists in the target outbox. Used to guarantee one outbox file per
 * logical completion event even under re-dispatch or double-call.
 */
function hasIdenticalMessage(outboxDir, from, to, body) {
  const want = normalizeBodyForDedupe(body);
  for (const f of markdownFiles(outboxDir)) {
    try {
      const txt = fs.readFileSync(f, 'utf8');
      if (frontmatterValue(txt, 'from') !== from) continue;
      if (frontmatterValue(txt, 'to') !== to) continue;
      const existingBody = normalizeBodyForDedupe(
        txt.replace(/^---[\s\S]*?\r?\n---\r?\n?/, '')
      );
      if (existingBody === want) return f;
    } catch (_e) {
      /* ignore unreadable */
    }
  }
  return null;
}

/** Write string content uniquely (used when stamping conversation_id on route). */
function writeContentUnique(dir, basename, content) {
  ensureDir(dir);
  const ext = path.extname(basename);
  const stem = basename.slice(0, basename.length - ext.length);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${Math.random().toString(16).slice(2, 8)}`;
    const dest = path.join(dir, `${stem}${suffix}${ext}`);
    try {
      fs.writeFileSync(dest, content, { flag: 'wx' });
      return dest;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not allocate unique delivery filename for ${basename}`);
}

/**
 * For mail missing conversation_id: stamp via getStampConversationId.
 * agent→hub (fromSlug set): pending hub→agent work for that slug, else last-viewed.
 * hub→user / unscoped: in-flight originating hub turn, else last-viewed.
 * Never overwrites an existing conversation_id.
 * @param {string} [fromSlug] - product agent slug for agent→hub completions
 */
function maybeStampUserConversationId(hub, text, base, fromSlug) {
  const stampId = getStampConversationId(hub, fromSlug);
  if (!stampId) return text;
  const stamped = stampConversationId(text, stampId);
  if (stamped !== text) {
    logEvent(hub, {
      event: 'conversation_id_stamp',
      conversation_id: stampId,
      file: base,
      from: fromSlug || ''
    });
  }
  return stamped;
}

function quarantineDir(hub) {
  return path.join(appDir(hub), 'quarantine');
}

/**
 * Move a stuck/invalid outbox file into .bizagent/quarantine/ so it no longer
 * spams WARN every poll tick. One log line per quarantine action.
 */
function quarantineOutboxFile(hub, file, reason) {
  const destDir = quarantineDir(hub);
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(file);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest)) {
    dest = path.join(destDir, `${Date.now()}-${base}`);
  }
  try {
    fs.renameSync(file, dest);
  } catch (_err) {
    try {
      fs.copyFileSync(file, dest);
      fs.unlinkSync(file);
    } catch (copyErr) {
      logEvent(hub, {
    event: 'quarantine_failed',
    file: base,
    reason: 'copy_error',
    error: copyErr.message
  });
      return null;
    }
  }
  logEvent(hub, {
    event: 'quarantine',
    file: base,
    reason: reason,
    dest: path.relative(hub, dest)
  });
  return dest;
}

function isMultiRecipient(to) {
  if (!to) return false;
  // Single slug only: letters, digits, underscore, hyphen.
  // Comma / semicolon / pipe / whitespace = multi-to (invalid; quarantine).
  return /[,;|\s]/.test(to);
}

/**
 * Single-slug recipients only: [a-zA-Z0-9_-]+. Anything else (path tricks,
 * empty after multi-to strip) is unrouteable.
 */
function isValidSingleRecipient(to) {
  return typeof to === 'string' && /^[A-Za-z0-9_-]+$/.test(to);
}

function routeOutboxes(hub) {
  let delivered = 0;
  let warnings = 0;
  let quarantined = 0;
  const startTime = Date.now();
  const tRoute = new Date().toISOString();
  for (const outbox of outboxes(hub)) {
    for (const file of markdownFiles(outbox)) {
      const text = fs.readFileSync(file, 'utf8');
      const to = frontmatterValue(text, 'to');
      const from = frontmatterValue(text, 'from');
      const base = path.basename(file);

      if (!to) {
        // Unrouteable forever — quarantine once instead of WARN every tick.
        quarantineOutboxFile(hub, file, 'missing-to');
        quarantined += 1;
        warnings += 1;
        continue;
      }

      if (isMultiRecipient(to)) {
        quarantineOutboxFile(hub, file, `multi-to:${to}`);
        quarantined += 1;
        warnings += 1;
        continue;
      }

      if (!isValidSingleRecipient(to)) {
        quarantineOutboxFile(hub, file, `invalid-to:${to}`);
        quarantined += 1;
        warnings += 1;
        continue;
      }

      if (to === 'user' && !canRouteToUser(hub, outbox)) {
        warnings += 1;
        logEvent(hub, {
          event: 'warn',
          type: 'user_recipient_from_non_hub',
          file: base
        });
        continue;
      }
      const dest = safeInboxFor(hub, to);
      if (!dest || !fs.existsSync(dest)) {
        if (to === 'user' && dest) fs.mkdirSync(dest, { recursive: true });
      }
      if (!dest || !fs.existsSync(dest)) {
        // Unknown single recipient: leave in place + WARN (operator may fix `to:`
        // or add the product). Multi-to / missing / invalid already quarantined.
        warnings += 1;
        logEvent(hub, {
          event: 'warn',
          type: 'unknown_recipient',
          to: to,
          file: base
        });
        continue;
      }
      let deliveredFile;
      // Stamp conversation_id for:
      // - hub→user mail (console visibility)
      // - agent→hub mail (completion notifications): associate with originating /
      //   last-viewed / pending hub→agent work so the hub turn emits a user-visible
      //   summary via reserved-body / write-message / safety-net.
      const isAgentToHub = (to === 'hub') && from && from !== 'hub' && from !== 'user';
      const isHubToAgent = (from === 'hub') && to && to !== 'user' && to !== 'hub';
      const shouldStamp = (to === 'user') || isAgentToHub;
      if (shouldStamp) {
        const stamped = maybeStampUserConversationId(hub, text, base, isAgentToHub ? from : undefined);
        if (stamped !== text) {
          deliveredFile = writeContentUnique(dest, base, stamped);
          fs.unlinkSync(file);
        } else {
          deliveredFile = writeFileUnique(dest, base, file);
        }
      } else {
        deliveredFile = writeFileUnique(dest, base, file);
      }
      // Thread conversation_id: hub→agent dispatch remembers which console chat asked.
      // Prefer conversation_id already on the hub→agent mail; else stamp heuristics.
      if (isHubToAgent && deliveredFile) {
        let stampId = '';
        try {
          const deliveredText = fs.existsSync(deliveredFile)
            ? fs.readFileSync(deliveredFile, 'utf8')
            : text;
          stampId = frontmatterValue(deliveredText, 'conversation_id') || '';
        } catch (_e) {
          stampId = '';
        }
        if (!stampId) stampId = getStampConversationId(hub) || '';
        if (stampId) {
          try {
            recordPendingAgentWork(hub, to, stampId);
            logEvent(hub, {
              event: 'pending_agent_work',
              to,
              conversation_id: stampId,
              file: base
            });
          } catch (_e) { /* non-fatal */ }
        }
      }
      if (to === 'user') {
        recordUserInboxDelivery(hub, deliveredFile);
      }
      // CP-owned visible notice for agent→hub completions (does not launch hub;
      // dispatchPendingAgents claims+launches on the same tick).
      if (isAgentToHub && deliveredFile) {
        const stampedCid = frontmatterValue(
          fs.existsSync(deliveredFile) ? fs.readFileSync(deliveredFile, 'utf8') : text,
          'conversation_id'
        );
        if (stampedCid) {
          try { postAgentCompletionNotice(hub, stampedCid, from); } catch (_e) { /* non-fatal */ }
          logEvent(hub, {
            event: 'agent_completion_stamped',
            from,
            conversation_id: stampedCid,
            file: base
          });
        }
      }
      delivered += 1;
      logEvent(hub, {
        event: 'route',
        file: base,
        to: to,
        duration_ms: Math.round((Date.now() - startTime) * 100) / 100
      });
      logEvent(hub, {
        event: 'routed',
        file: base,
        to: to
      });
    }
  }
  return { delivered, warnings, quarantined };
}

function pendingMail(hub, slug) {
  return markdownFiles(inboxFor(hub, slug));
}

function agentMailStatus(hub, agents) {
  return agents.map((agent) => ({
    ...agent,
    hasMail: pendingMail(hub, agent.slug).length > 0,
    pending: pendingMail(hub, agent.slug).length,
  }));
}

const VALID_SLUG = /^[A-Za-z0-9_-]+$/;

function subjectSlug(subject) {
  return String(subject || 'message')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'message';
}

/**
 * Outbox directory for a sender slug. Hub root outbox for `hub`; else agents/<slug>/outbox.
 */
function outboxFor(hub, fromSlug) {
  if (fromSlug === 'hub') return path.join(hub, 'outbox');
  return path.join(hub, 'agents', fromSlug, 'outbox');
}

/**
 * Write a correctly named outbox markdown message with YAML frontmatter.
 * Does not invent conversation_id — only stamps when the caller passes one.
 *
 * @returns {{ file: string, basename: string }}
 */
function writeOutboxMessage(hub, opts = {}) {
  const from = String(opts.from || '').trim();
  const to = String(opts.to || '').trim();
  const subject = String(opts.subject || '').trim();
  const body = String(opts.body != null ? opts.body : '').replace(/^\uFEFF/, '');
  const conversationId = opts.conversationId != null
    ? String(opts.conversationId).trim()
    : '';

  if (!from || !VALID_SLUG.test(from)) {
    throw new Error('writeOutboxMessage: invalid or missing from slug');
  }
  if (!to || !isValidSingleRecipient(to)) {
    throw new Error('writeOutboxMessage: invalid or missing to slug');
  }
  if (isMultiRecipient(to)) {
    throw new Error('writeOutboxMessage: multi-recipient to is not allowed');
  }
  if (!subject) {
    throw new Error('writeOutboxMessage: subject is required');
  }

  const date = opts.date || new Date().toISOString().slice(0, 10);
  const header = [
    '---',
    `from: ${from}`,
    `to: ${to}`,
    `date: ${date}`,
    `subject: ${subject}`,
    conversationId ? `conversation_id: ${conversationId}` : '',
    '---',
  ].filter((line) => line !== '').join('\n');

  const content = `${header}\n\n${body.replace(/\s+$/, '')}\n`;
  const outbox = outboxFor(hub, from);
  ensureDir(outbox);

  // Dedupe identical completion / status bodies: one outbox file per event.
  const existing = hasIdenticalMessage(outbox, from, to, body);
  if (existing) {
    return { file: existing, basename: path.basename(existing), outbox };
  }

  const basename = `${date}-${from}-${subjectSlug(subject)}.md`;
  const file = writeContentUnique(outbox, basename, content);
  return { file, basename: path.basename(file), outbox };
}

module.exports = {
  agentMailStatus,
  canRouteToUser,
  frontmatterValue,
  inboxFor,
  isMultiRecipient,
  isValidSingleRecipient,
  maybeStampUserConversationId,
  outboxFor,
  pendingMail,
  quarantineDir,
  quarantineOutboxFile,
  recipientSlugs,
  routeOutboxes,
  safeInboxFor,
  subjectSlug,
  writeContentUnique,
  writeFileUnique,
  writeOutboxMessage,
};
