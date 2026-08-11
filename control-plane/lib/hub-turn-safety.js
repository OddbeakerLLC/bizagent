/**
 * Hub-turn UX safety net (control-plane owned).
 *
 * Operator-visible replies must land as outbox mail (or CP status). Paths:
 * 1. Reserved reply body file — CP pre-creates path; hub writes body only.
 * 2. write-message / normal hub→user outbox with conversation_id.
 * 3. Last-resort promote of a final assistant blob from dispatch log/stderr.
 * 4. Hard in-UI failure if nothing recoverable.
 *
 * Stdout is debug only — never the delivery channel.
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
const { logEvent, logError, appendLog } = require('./log');
const { routeOutboxes, writeOutboxMessage } = require('./mail');

const DEFAULT_MAX_BLOB_CHARS = 4000;
const MIN_BLOB_CHARS = 12;
const MIN_RESERVED_BODY_CHARS = 1;
const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h — drop abandoned markers

function pendingHubTurnsFile(hub) {
  return path.join(appDir(hub), 'pending-hub-turns.json');
}

function pendingRepliesDir(hub) {
  return path.join(appDir(hub), 'pending-replies');
}

/** Safe filename stem from conversation id (ids are already constrained). */
function safeConversationFileStem(conversationId) {
  return String(conversationId || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'unknown';
}

/**
 * Absolute path for the CP-reserved operator reply body (no frontmatter).
 * Hub CLI must write the final operator-visible markdown body here (or use write-message).
 */
function reservedReplyBodyPath(hub, conversationId) {
  if (!conversationId) return '';
  return path.join(pendingRepliesDir(hub), `${safeConversationFileStem(conversationId)}.body.md`);
}

/**
 * Create/truncate the reserved body file for a console turn.
 * Returns absolute path, or '' if no conversationId.
 */
function prepareReservedReplyBody(hub, conversationId) {
  if (!conversationId) return '';
  ensureDir(pendingRepliesDir(hub));
  const file = reservedReplyBodyPath(hub, conversationId);
  fs.writeFileSync(file, '');
  return file;
}

function readReservedReplyBody(hub, conversationId) {
  const file = reservedReplyBodyPath(hub, conversationId);
  if (!file || !fs.existsSync(file)) return '';
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch (_err) {
    return '';
  }
}

function clearReservedReplyBody(hub, conversationId) {
  const file = reservedReplyBodyPath(hub, conversationId);
  if (!file) return;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_err) {
    /* ignore */
  }
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
    stderrByteOffset: Number(turn.stderrByteOffset || 0),
    startedAt: turn.startedAt || new Date().toISOString(),
    agentLog: turn.agentLog || path.join(hub, 'logs', 'dispatch-hub.log'),
    agentStderr: turn.agentStderr || path.join(hub, 'logs', 'dispatch-hub.stderr'),
    replyBodyFile: turn.replyBodyFile || reservedReplyBodyPath(hub, turn.conversationId),
    exitCode: turn.exitCode != null ? turn.exitCode : null,
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

/** Whole-line noise from CLI wrappers / auth failures. */
function isNoiseLine(t) {
  if (!t) return true;
  if (/^control-plane:/.test(t)) return true;
  if (/^Error:\s*Internal error:/i.test(t)) return true;
  if (/^Internal error:\s*\{/i.test(t)) return true;
  if (/^API error \(status \d+/i.test(t)) return true;
  if (/"message"\s*:\s*"API error/i.test(t)) return true;
  if (/"http_status"\s*:/i.test(t)) return true;
  if (/^\{[\s\S]*"message"\s*:\s*"API error/i.test(t)) return true;
  if (/^\{[\s\S]*"http_status"\s*:/i.test(t) && t.length < 400) return true;
  if (/^Not signed in\./i.test(t)) return true;
  if (/^To authenticate without a browser/i.test(t)) return true;
  if (/^Alternatively, set the XAI_API_KEY/i.test(t)) return true;
  if (/^Error:\s*Not signed in/i.test(t)) return true;
  if (/^\s*grok login/i.test(t)) return true;
  if (/^Warning:\s*The 'NO_COLOR'/i.test(t)) return true;
  if (/^\(node:\d+\)/i.test(t)) return true;
  return false;
}

/**
 * First-person / tool-loop narration that is not an operator-facing answer.
 * Single short lines only — multi-line blocks or marked-up answers are kept.
 */
function isProcessNarrationBlock(block) {
  const t = String(block || '').trim();
  if (!t) return true;
  if (t.includes('\n')) return false; // multi-line → likely real content
  // Substance markers → treat as answer even if it starts with "On it"
  if (/\*\*[^*]+\*\*/.test(t) || /^#+\s/m.test(t) || /`[^`]+`/.test(t)) return false;
  if (t.length >= 200) return false;
  // Imperative / progress lines models dump to stdout while working
  if (/^(I('ll| will| need| am|'m)|Let me|Checking|Reading|Loading|Writing|Dispatching|Waiting|Acknowledging|Processing|Looking|Opening|Searching|Confirming|Acting|Found|System is|There's |There is |Continuing|Reporting|Archiving|Journaling|Detecting|I'll |I'm the |Acting as )/i.test(t)) {
    return true;
  }
  // Bare ack without substance
  if (/^(Stand by\.?|On it\.?)$/i.test(t)) return true;
  if (/^(Stand by|On it)\b/i.test(t) && t.length < 40) return true;
  return false;
}

/**
 * Score a candidate block: higher = more likely the operator-facing final answer.
 */
function scoreAnswerBlock(block) {
  const t = String(block || '').trim();
  if (!t || t.length < MIN_BLOB_CHARS) return -1;
  if (isProcessNarrationBlock(t)) return -1;
  let score = Math.min(t.length, 800);
  // Prefer markdown that looks like a finished reply
  if (/\*\*[^*]+\*\*/.test(t)) score += 80;
  if (/^#+\s/m.test(t)) score += 40;
  if (/^- /m.test(t) || /^\| /m.test(t)) score += 40;
  if (/\b(Agent [A-Z]{1,3}|fixed|shipped|done|yes|no)\b/i.test(t)) score += 30;
  // Penalize pure meta
  if (/outbox|inbox\/archive|conversation_id/i.test(t) && t.length < 120) score -= 40;
  return score;
}

/**
 * Heuristic: best trailing assistant blob from hub stdout/stderr delta.
 * Filters CLI/API noise and short process-narration. Truncates from the front if over maxChars.
 */
function extractFinalAssistantBlob(logChunk, maxChars = DEFAULT_MAX_BLOB_CHARS) {
  let text = String(logChunk || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return '';

  const cleaned = text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      return !isNoiseLine(t);
    })
    .join('\n')
    .trim();
  if (!cleaned) return '';

  const blocks = cleaned
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return '';

  // Walk from the end: pick the best-scoring trailing window (1–3 blocks).
  let best = { score: -1, blob: '' };
  for (let end = blocks.length - 1; end >= 0; end -= 1) {
    for (let span = 1; span <= 3 && end - span + 1 >= 0; span += 1) {
      const from = end - span + 1;
      const slice = blocks.slice(from, end + 1);
      // Drop leading narration within the window
      while (slice.length && isProcessNarrationBlock(slice[0])) slice.shift();
      if (slice.length === 0) continue;
      const blob = slice.join('\n\n').trim();
      const score = scoreAnswerBlock(blob) + (end === blocks.length - 1 ? 20 : 0) + span;
      if (score > best.score) best = { score, blob };
    }
    // Only consider the last ~8 blocks as "final answer" candidates
    if (blocks.length - 1 - end >= 8) break;
  }

  let blob = best.score >= 0 ? best.blob : '';
  // Fallback: last non-narration block even if score was weak
  if (!blob) {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (!isProcessNarrationBlock(blocks[i]) && blocks[i].length >= MIN_BLOB_CHARS) {
        blob = blocks[i];
        break;
      }
    }
  }
  if (!blob) return '';

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

function promoteBlobToOutbox(hub, conversationId, body, subject = 'recovered hub reply') {
  let userId = '';
  try {
    const conv = getConversation(hub, conversationId);
    if (conv && conv.user_id) userId = String(conv.user_id);
  } catch (_e) { /* ignore */ }
  if (!userId) {
    try {
      const { getActiveEnterpriseHooks, isActiveEnterprise } = require('./enterprise-plugin');
      if (isActiveEnterprise()) {
        const hooks = getActiveEnterpriseHooks();
        if (typeof hooks.resolveActingUserId === 'function') {
          userId = hooks.resolveActingUserId(hub, { conversationId }) || '';
        }
      }
    } catch (_e) { /* ignore */ }
  }
  return writeOutboxMessage(hub, {
    from: 'hub',
    to: 'user',
    subject,
    body,
    conversationId,
    userId,
  });
}

function finalizeViaOutbox(hub, conversationId, body, subject, actionTag) {
  promoteBlobToOutbox(hub, conversationId, body, subject);
  routeOutboxes(hub);
  readUserInboxMessages(hub);
  logEvent(hub, {
    event: 'hub_safety',
    action: actionTag,
    conversation_id: conversationId,
    chars: body.length
  });
  // Notify main CP process (no-op in EXIT-hook child — that process has empty WS sets).
  notifyConversationMutated(hub, conversationId);
  return { action: actionTag, chars: body.length, conversationId, mutated: true };
}

/**
 * Optional hook the main control-plane process registers so conversation
 * mutations (reserved-body, promote, hard-fail, relay) can push WS/SSE.
 * EXIT-hook child processes never register this — their client sets are empty.
 */
let onConversationMutated = null;
function setOnConversationMutated(fn) {
  onConversationMutated = typeof fn === 'function' ? fn : null;
}
function notifyConversationMutated(hub, conversationId) {
  if (!conversationId || typeof onConversationMutated !== 'function') return;
  try { onConversationMutated(hub, conversationId); } catch (_) { /* push must not break safety */ }
}

/** Actions from ensureHubUserReply / drain that mean the console may need a push. */
function isPushWorthySafetyAction(action) {
  if (!action) return false;
  return action !== 'skip'
    && action !== 'skip-no-conversation'
    && action !== 'expired';
}

/**
 * Collect conversation ids that should be pushed after a safety drain.
 * Includes ok-existing: ensureHubUserReply may have just relayed outbox mail.
 */
function conversationIdsFromSafetyResults(results) {
  const ids = [];
  if (!Array.isArray(results)) return ids;
  for (const r of results) {
    if (!r || !isPushWorthySafetyAction(r.action)) continue;
    const id = r.conversationId
      || (r.turn && r.turn.conversationId)
      || '';
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

function stderrSnippet(turn, maxChars = 400) {
  const delta = readLogDelta(turn.agentStderr, turn.stderrByteOffset || 0);
  const auth = /Not signed in|XAI_API_KEY|grok login|authentication/i.test(delta || '');
  if (auth) {
    return 'CLI auth failure (not signed in / missing API key). Check `logs/dispatch-hub.stderr`.';
  }
  const cleaned = String(delta || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Warning:\s*The 'NO_COLOR'/i.test(l) && !/^\(node:\d+\)/i.test(l))
    .join('\n')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxChars ? cleaned.slice(-maxChars) : cleaned;
}

function hardFailMessage(turn) {
  // Prefer the real underlying failure; avoid opaque meta-errors when we know the cause.
  const err = turn ? stderrSnippet(turn) : '';
  const exitCode = turn && turn.exitCode != null && turn.exitCode !== ''
    ? Number(turn.exitCode)
    : null;

  const exitBit = (exitCode != null && exitCode !== 0) ? `CLI exit code: ${exitCode}.` : '';

  if (err && /CLI auth failure|Not signed in|XAI_API_KEY|grok login/i.test(err)) {
    return [
      'Hub CLI authentication failed.',
      exitBit,
      err,
      'Fix: put XAI_API_KEY (or the relevant CLI key) in `.bizagent/env`, then `scripts/control-plane.sh restart` and `scripts/hub-daemon.sh restart`.',
      'See `logs/dispatch-hub.stderr`.',
    ].filter(Boolean).join(' ');
  }
  if (err && /unknown model id|Couldn't set model/i.test(err)) {
    return [
      'Hub CLI rejected the configured model.',
      exitBit,
      err,
      'Fix: set `settings.hub_agent.model` in registry.json to a model from `grok models` (or your CLI), then restart the control plane.',
    ].filter(Boolean).join(' ');
  }
  if (
    err &&
    /usage balance exhausted|402 Payment Required|used all available credits|spending limit|purchase more credits|insufficient.?credit/i.test(
      err,
    )
  ) {
    return [
      'LLM API credits / spending limit exhausted.',
      exitBit,
      err,
      'Fix: top up or raise the limit at the provider console, or switch provider/model in the agent rail, then retry.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (err && /403/.test(err) && /credit|spending limit|quota/i.test(err)) {
    return [
      'LLM API credits / spending limit exhausted (HTTP 403).',
      exitBit,
      err,
      'Fix: top up or raise the limit at the provider console, or switch provider/model in the agent rail, then retry.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  const parts = [
    'Hub produced no user-visible reply (no reserved body file and no outbox mail to user).',
  ];
  if (exitCode != null && exitCode !== 0) {
    parts.push(`CLI exit code: ${exitCode}.`);
  }
  if (err) parts.push(err);
  else parts.push('No actionable stderr captured.');
  parts.push('Check `logs/dispatch-hub.stderr` and `logs/structured.log` (event hub_turn_completed / hub_daemon_turn_end).');
  return parts.join(' ');
}

/**
 * After hub CLI exit (or tick drain): ensure the operator sees a reply or a hard failure.
 * Idempotent — safe if real outbox mail already routed.
 *
 * ALWAYS-WARM: conversation_id is guaranteed. No blob promotion from stdout —
 * if hub didn't write to reserved body file, that's a clear failure mode.
 */
function ensureHubUserReply(hub, turn) {
  const conversationId = turn && turn.conversationId;
  // ALWAYS-WARM: conversation_id is required — fail fast if missing
  if (!conversationId) {
    return { action: 'skip-no-conversation', error: 'conversation_id required (warm-launch guarantee violated)' };
  }
  if (!getConversation(hub, conversationId)) {
    clearPendingHubTurn(hub, turn);
    clearReservedReplyBody(hub, conversationId);
    return { action: 'skip-no-conversation', conversationId };
  }

  // Prefer normal path: route any outbox the hub did write, then relay.
  routeOutboxes(hub);
  readUserInboxMessages(hub);

  if (hubReplySince(hub, conversationId, turn.startedAt)) {
    clearPendingHubTurn(hub, turn);
    clearReservedReplyBody(hub, conversationId);
    // Relay (here or prior EXIT hook) may have just written the hub message — push.
    notifyConversationMutated(hub, conversationId);
    return { action: 'ok-existing', conversationId, mutated: true };
  }
  // Idempotent: shell EXIT + Node exit + tick drain may all fire.
  if (hubFailureSince(hub, conversationId, turn.startedAt)) {
    clearPendingHubTurn(hub, turn);
    clearReservedReplyBody(hub, conversationId);
    notifyConversationMutated(hub, conversationId);
    return { action: 'ok-failed-already', conversationId, mutated: true };
  }
  if (pendingUserOutboxFor(hub, conversationId)) {
    routeOutboxes(hub);
    readUserInboxMessages(hub);
    if (hubReplySince(hub, conversationId, turn.startedAt)) {
      clearPendingHubTurn(hub, turn);
      clearReservedReplyBody(hub, conversationId);
      notifyConversationMutated(hub, conversationId);
      return { action: 'ok-existing', conversationId, mutated: true };
    }
  }

  // Reserved body path: model wrote markdown body only; CP owns frontmatter + route.
  const reservedBody = readReservedReplyBody(hub, conversationId);
  if (reservedBody && reservedBody.length >= MIN_RESERVED_BODY_CHARS) {
    if (hubReplySince(hub, conversationId, turn.startedAt)) {
      clearPendingHubTurn(hub, turn);
      clearReservedReplyBody(hub, conversationId);
      notifyConversationMutated(hub, conversationId);
      return { action: 'ok-existing', conversationId, mutated: true };
    }
    const result = finalizeViaOutbox(
      hub,
      conversationId,
      reservedBody,
      'console reply',
      'reserved-body',
    );
    clearPendingHubTurn(hub, turn);
    clearReservedReplyBody(hub, conversationId);
    return result;
  }

  // ALWAYS-WARM: No blob promotion fallback. If reserved body is empty, that's a failure.
  if (hubReplySince(hub, conversationId, turn.startedAt)
    || hubFailureSince(hub, conversationId, turn.startedAt)) {
    clearPendingHubTurn(hub, turn);
    clearReservedReplyBody(hub, conversationId);
    notifyConversationMutated(hub, conversationId);
    return { action: 'ok-existing', conversationId, mutated: true };
  }

  // Hard fail: hub didn't write to reserved body file
  supersedeLaunchAcks(hub, conversationId);
  appendMessage(
    hub,
    conversationId,
    'status',
    hardFailMessage(turn),
    { kind: STATUS_ERROR_KIND },
  );
  clearPendingHubTurn(hub, turn);
  clearReservedReplyBody(hub, conversationId);
  logEvent(hub, {
    event: 'hub_safety_fail',
    conversation_id: conversationId,
    reason: 'no_reserved_body'
  });
  notifyConversationMutated(hub, conversationId);
  return { action: 'failed', conversationId, mutated: true };
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
      clearReservedReplyBody(hub, turn.conversationId);
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
 * CLI / shell EXIT entry:
 * node -e 'require(m).onHubCliExit(hub, JSON.parse(process.argv[2]))' mod hub '{...}'
 * Optional exitCode on the turn object improves hard-fail text.
 */
function onHubCliExit(hub, turn) {
  const start = Date.now();
  const result = ensureHubUserReply(hub, turn || {});

  logEvent(hub, {
    event: 'hub_safety_on_exit',
    duration_ms: Math.round((Date.now() - start) * 100) / 100,
    conversation_id: turn?.conversationId,
    action: result.action || 'unknown'
  });

  return result;
}

module.exports = {
  DEFAULT_MAX_BLOB_CHARS,
  clearPendingHubTurn,
  clearReservedReplyBody,
  conversationIdsFromSafetyResults,
  drainPendingHubTurns,
  ensureHubUserReply,
  extractFinalAssistantBlob,
  hubFailureSince,
  hubReplySince,
  isNoiseLine,
  isProcessNarrationBlock,
  isPushWorthySafetyAction,
  LAUNCH_ACK_KIND,
  MIN_BLOB_CHARS,
  MIN_RESERVED_BODY_CHARS,
  notifyConversationMutated,
  onHubCliExit,
  pendingHubTurnsFile,
  pendingRepliesDir,
  prepareReservedReplyBody,
  promoteBlobToOutbox,
  readLogDelta,
  readPendingHubTurns,
  readReservedReplyBody,
  recordPendingHubTurn,
  reservedReplyBodyPath,
  setOnConversationMutated,
  writePendingHubTurns,
};
