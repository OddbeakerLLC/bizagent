/**
 * Hub-turn UX safety net (control-plane owned).
 *
 * 1. Launch ack is posted by dispatcher via conversations.postLaunchAck.
 * 2. When a hub CLI run ends with no user-visible reply for the turn's
 *    conversation_id, promote a truncated final assistant blob from the
 *    dispatch log into hub outbox → user, or surface a hard in-UI failure.
 */
const fs = require('fs');
const path = require('path');
const { appDir, ensureDir } = require('./config');
const {
  appendMessage,
  frontmatterValue,
  getConversation,
  LAUNCH_ACK_KIND,
  readUserInboxMessages,
  STATUS_ERROR_KIND,
  supersedeLaunchAcks,
} = require('./conversations');
const { appendLog } = require('./log');
const { routeOutboxes, writeContentUnique } = require('./mail');

const DEFAULT_MAX_BLOB_CHARS = 4000;
const MIN_BLOB_CHARS = 12;
const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h — drop abandoned markers

function pendingHubTurnsFile(hub) {
  return path.join(appDir(hub), 'pending-hub-turns.json');
}

function readPendingHubTurns(hub) {
  try {
    const data = JSON.parse(fs.readFileSync(pendingHubTurnsFile(hub), 'utf8'));
    return Array.isArray(data.turns) ? data.turns : [];
  } catch (_err) {
    return [];
  }
}

function writePendingHubTurns(hub, turns) {
  ensureDir(appDir(hub));
  fs.writeFileSync(
    pendingHubTurnsFile(hub),
    `${JSON.stringify({ turns: turns.slice(-20) }, null, 2)}\n`,
  );
}

/**
 * Record a console hub turn so the safety net can run after CLI exit.
 * One entry per launch; conversationId may be empty (agent→hub only) — those skip ack/safety.
 */
function recordPendingHubTurn(hub, turn) {
  if (!turn || !turn.conversationId) return;
  const turns = readPendingHubTurns(hub).filter(
    (item) => item.conversationId !== turn.conversationId || item.startedAt !== turn.startedAt,
  );
  turns.push({
    conversationId: turn.conversationId,
    logByteOffset: Number(turn.logByteOffset || 0),
    startedAt: turn.startedAt || new Date().toISOString(),
    agentLog: turn.agentLog || path.join(hub, 'logs', 'dispatch-hub.log'),
  });
  writePendingHubTurns(hub, turns);
}

function clearPendingHubTurn(hub, turn) {
  if (!turn || !turn.conversationId) return;
  const next = readPendingHubTurns(hub).filter(
    (item) => !(item.conversationId === turn.conversationId && item.startedAt === turn.startedAt),
  );
  writePendingHubTurns(hub, next);
}

function readLogDelta(logPath, byteOffset) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return '';
    const stat = fs.statSync(logPath);
    const start = Math.max(0, Math.min(Number(byteOffset) || 0, stat.size));
    if (stat.size <= start) return '';
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch (_err) {
    return '';
  }
}

/**
 * Heuristic: last substantial blank-line block(s) from hub stdout delta.
 * Filters obvious CLI/API noise. Truncates from the front if over maxChars.
 */
function extractFinalAssistantBlob(logChunk, maxChars = DEFAULT_MAX_BLOB_CHARS) {
  let text = String(logChunk || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return '';

  const cleaned = text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^control-plane:/.test(t)) return false;
      if (/^Error:\s*Internal error:/i.test(t)) return false;
      if (/^Internal error:\s*\{/i.test(t)) return false;
      if (/^API error \(status \d+/i.test(t)) return false;
      if (/"message"\s*:\s*"API error/i.test(t)) return false;
      if (/"http_status"\s*:/i.test(t)) return false;
      // Whole-line JSON error blobs from CLI wrappers
      if (/^\{[\s\S]*"message"\s*:\s*"API error/i.test(t)) return false;
      if (/^\{[\s\S]*"http_status"\s*:/i.test(t) && t.length < 400) return false;
      return true;
    })
    .join('\n')
    .trim();
  if (!cleaned) return '';

  const blocks = cleaned
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return '';

  // Prefer the last block that looks like operator-facing prose (≥ MIN chars).
  // If the last few blocks are short tool-narration, still take the last one.
  let start = blocks.length - 1;
  while (start > 0 && blocks[start].length < MIN_BLOB_CHARS) start -= 1;
  // Include up to 3 trailing blocks so multi-paragraph finals stay intact.
  start = Math.max(0, Math.min(start, blocks.length - 1));
  const from = Math.max(0, start - 2);
  let blob = blocks.slice(from).join('\n\n').trim();

  if (blob.length > maxChars) {
    blob = blob.slice(blob.length - maxChars);
    const nl = blob.indexOf('\n');
    if (nl > 0 && nl < 240) blob = blob.slice(nl + 1);
    blob = `…\n${blob.trim()}`;
  }
  return blob.trim().length >= MIN_BLOB_CHARS ? blob.trim() : '';
}

function messageSince(hub, conversationId, startedAt, predicate) {
  const conv = getConversation(hub, conversationId);
  if (!conv || !Array.isArray(conv.messages)) return false;
  const t0 = Date.parse(startedAt || 0);
  const floor = Number.isFinite(t0) ? t0 - 2000 : 0;
  return conv.messages.some((msg) => {
    if (!predicate(msg)) return false;
    const ts = Date.parse(msg.created_at || 0);
    return Number.isFinite(ts) ? ts >= floor : true;
  });
}

function hubReplySince(hub, conversationId, startedAt) {
  return messageSince(hub, conversationId, startedAt, (msg) => msg.role === 'hub');
}

function hubFailureSince(hub, conversationId, startedAt) {
  return messageSince(
    hub,
    conversationId,
    startedAt,
    (msg) => msg.role === 'status' && msg.kind === STATUS_ERROR_KIND,
  );
}

function pendingUserOutboxFor(hub, conversationId) {
  const outbox = path.join(hub, 'outbox');
  if (!fs.existsSync(outbox)) return false;
  for (const name of fs.readdirSync(outbox).filter((n) => n.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(outbox, name), 'utf8');
    if (frontmatterValue(text, 'to') !== 'user') continue;
    const cid = frontmatterValue(text, 'conversation_id');
    if (!cid || cid === conversationId) return true;
  }
  return false;
}

function promoteBlobToOutbox(hub, conversationId, body) {
  const date = new Date().toISOString().slice(0, 10);
  const content = [
    '---',
    'from: hub',
    'to: user',
    `date: ${date}`,
    'subject: recovered hub reply',
    `conversation_id: ${conversationId}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
  return writeContentUnique(
    path.join(hub, 'outbox'),
    `${date}-hub-recovered-reply.md`,
    content,
  );
}

/**
 * After hub CLI exit (or tick drain): ensure the operator sees a reply or a hard failure.
 * Idempotent — safe if real outbox mail already routed.
 */
function ensureHubUserReply(hub, turn) {
  const conversationId = turn && turn.conversationId;
  if (!conversationId) return { action: 'skip' };
  if (!getConversation(hub, conversationId)) {
    clearPendingHubTurn(hub, turn);
    return { action: 'skip-no-conversation' };
  }

  // Prefer normal path: route any outbox the hub did write, then relay.
  routeOutboxes(hub);
  readUserInboxMessages(hub);

  if (hubReplySince(hub, conversationId, turn.startedAt)) {
    clearPendingHubTurn(hub, turn);
    return { action: 'ok-existing' };
  }
  // Idempotent: shell EXIT + Node exit + tick drain may all fire.
  if (hubFailureSince(hub, conversationId, turn.startedAt)) {
    clearPendingHubTurn(hub, turn);
    return { action: 'ok-failed-already' };
  }
  if (pendingUserOutboxFor(hub, conversationId)) {
    routeOutboxes(hub);
    readUserInboxMessages(hub);
    if (hubReplySince(hub, conversationId, turn.startedAt)) {
      clearPendingHubTurn(hub, turn);
      return { action: 'ok-existing' };
    }
  }

  const delta = readLogDelta(turn.agentLog, turn.logByteOffset);
  const blob = extractFinalAssistantBlob(delta);
  if (blob) {
    // Re-check after reading log — a concurrent handler may have finished.
    if (hubReplySince(hub, conversationId, turn.startedAt)) {
      clearPendingHubTurn(hub, turn);
      return { action: 'ok-existing' };
    }
    promoteBlobToOutbox(hub, conversationId, blob);
    routeOutboxes(hub);
    readUserInboxMessages(hub);
    clearPendingHubTurn(hub, turn);
    appendLog(
      hub,
      `hub_safety promote conversation_id=${conversationId} chars=${blob.length}`,
    );
    return { action: 'promoted', chars: blob.length };
  }

  if (hubReplySince(hub, conversationId, turn.startedAt)
    || hubFailureSince(hub, conversationId, turn.startedAt)) {
    clearPendingHubTurn(hub, turn);
    return { action: 'ok-existing' };
  }

  supersedeLaunchAcks(hub, conversationId);
  appendMessage(
    hub,
    conversationId,
    'status',
    'Hub produced no user-visible reply (no outbox mail and no recoverable dispatch output). Check `logs/dispatch-hub.log`.',
    { kind: STATUS_ERROR_KIND },
  );
  clearPendingHubTurn(hub, turn);
  appendLog(hub, `hub_safety fail conversation_id=${conversationId}`);
  return { action: 'failed' };
}

/**
 * Process pending hub turns whose CLI is no longer holding the hub lock.
 * Called each CP tick as a backup when the shell EXIT hook did not run.
 */
function drainPendingHubTurns(hub, isHubActive) {
  const turns = readPendingHubTurns(hub);
  if (turns.length === 0) return [];
  const active = typeof isHubActive === 'function' ? isHubActive() : false;
  const now = Date.now();
  const results = [];
  const keep = [];
  for (const turn of turns) {
    const age = now - Date.parse(turn.startedAt || 0);
    if (Number.isFinite(age) && age > PENDING_MAX_AGE_MS) {
      clearPendingHubTurn(hub, turn);
      results.push({ turn, action: 'expired' });
      continue;
    }
    // While hub is still running, leave the turn pending (one hub slot).
    if (active) {
      keep.push(turn);
      continue;
    }
    results.push({ turn, ...ensureHubUserReply(hub, turn) });
  }
  // ensureHubUserReply clears itself; re-write only still-active keeps.
  // Re-read in case ensure cleared some while we also had keeps.
  const remaining = readPendingHubTurns(hub).filter((t) =>
    keep.some((k) => k.conversationId === t.conversationId && k.startedAt === t.startedAt),
  );
  // If active, keep those; if we filtered expired via clear, file already updated.
  if (active) writePendingHubTurns(hub, remaining.length ? remaining : keep);
  return results;
}

/**
 * CLI / shell EXIT entry: `node -e 'require(m).onHubCliExit(hub, JSON.parse(process.argv[2]))' mod '{...}'`
 */
function onHubCliExit(hub, turn) {
  return ensureHubUserReply(hub, turn || {});
}

module.exports = {
  DEFAULT_MAX_BLOB_CHARS,
  drainPendingHubTurns,
  ensureHubUserReply,
  extractFinalAssistantBlob,
  hubFailureSince,
  hubReplySince,
  LAUNCH_ACK_KIND,
  MIN_BLOB_CHARS,
  onHubCliExit,
  pendingHubTurnsFile,
  promoteBlobToOutbox,
  readLogDelta,
  readPendingHubTurns,
  recordPendingHubTurn,
  clearPendingHubTurn,
  writePendingHubTurns,
};
