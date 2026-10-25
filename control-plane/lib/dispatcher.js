const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { agentsFromRegistry, appDir, loadHubEnv, loadRegistry } = require('./config');
const { writeJsonAtomic } = require('./atomic-state');
const { compileAgentCommand, getCliSettings } = require('./cli-config');
const {
  buildAgentTurnPrompt,
  buildHubTurnPrompt,
  ensureHubRuntimeCwd,
  ensureHubRuntimePrompt,
  pickPendingConversationId,
} = require('./hub-memory');
const { pendingMail, writeOutboxMessage } = require('./mail');
const { logEvent, logLatency, logError, appendLog } = require('./log');
const {
  appendMessage,
  createConversation,
  getActiveConversationId,
  getConversation,
  getPendingAgentWorkConversationId,
  listConversations,
  postLaunchAck,
  postAgentCompletionNotice,
  recordCrossChatAlert,
  STATUS_ERROR_KIND,
  writeFileUnique,
} = require('./conversations');
const {
  drainPendingHubTurns,
  notifyConversationMutated,
  onHubCliExit,
  prepareReservedReplyBody,
  readPendingHubTurns,
  recordPendingHubTurn,
  reservedReplyBodyPath,
} = require('./hub-turn-safety');
const {
  classifyProviderError,
  formatProviderFailureMessage,
  nameProviderInClassification,
} = require('./provider-errors');
const ollamaFallback = require('./ollama-fallback');
const {
  clearThinking,
  recordThinking,
} = require('./thinking');

function hubDaemonSock(hub) {
  return path.join(hub, '.bizagent', 'hub.sock');
}

/**
 * Low-level NDJSON request to the warm hub-daemon socket.
 * Resolves parsed response or { ok:false, error }.
 */
function requestHubDaemon(hub, payload, opts = {}) {
  const sockPath = hubDaemonSock(hub);
  const connectMs = Math.max(100, Number(opts.connectTimeoutMs || 500));
  const turnMs = Math.max(1000, Number(opts.turnTimeoutMs || 5000));
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) {
      resolve({ ok: false, error: 'no_socket' });
      return;
    }
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_e) { /* ignore */ }
      resolve(result);
    };
    const socket = net.createConnection(sockPath);
    let buf = '';
    const connectTimer = setTimeout(() => done({ ok: false, error: 'connect_timeout' }), connectMs);
    const turnTimer = setTimeout(() => done({ ok: false, error: 'turn_timeout' }), turnMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      clearTimeout(connectTimer);
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      clearTimeout(turnTimer);
      try {
        done(JSON.parse(line));
      } catch (err) {
        done({ ok: false, error: `bad_response:${err.message}` });
      }
    });
    socket.on('error', (err) => {
      clearTimeout(connectTimer);
      clearTimeout(turnTimer);
      done({ ok: false, error: err.message || 'socket_error' });
    });
  });
}

/**
 * Ask the warm hub-daemon to process pending hub mail.
 * Resolves { ok, via:'warm', ... } or { ok:false, error } on connect/timeout/busy.
 */
function requestWarmHubTurn(hub, opts = {}) {
  const connectMs = Math.max(100, Number(opts.connectTimeoutMs || 500));
  const turnMs = Math.max(5000, Number(opts.turnTimeoutMs || 600000));
  return requestHubDaemon(
    hub,
    {
      type: 'turn',
      requestId: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    },
    { connectTimeoutMs: connectMs, turnTimeoutMs: turnMs },
  ).then((msg) => {
    if (msg.error && !msg.type && msg.ok === false) {
      return { ...msg, via: undefined };
    }
    return {
      ...msg,
      via: 'warm',
      ok: !!msg.ok || msg.action === 'reserved-body' || msg.action === 'ok-existing',
    };
  });
}

/**
 * Ask the warm hub-daemon to abort its in-flight CLI turn (if any).
 * Does not shut down the daemon process.
 */
function requestWarmHubCancel(hub, opts = {}) {
  const connectMs = Math.max(100, Number(opts.connectTimeoutMs || 500));
  const turnMs = Math.max(500, Number(opts.turnTimeoutMs || 3000));
  return requestHubDaemon(
    hub,
    {
      type: 'cancel',
      requestId: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    },
    { connectTimeoutMs: connectMs, turnTimeoutMs: turnMs },
  ).then((msg) => ({
    ...msg,
    via: 'warm',
    ok: !!msg.ok,
  }));
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Get conversation_id for hub dispatch.
 * ALWAYS returns a valid conversation_id — never null.
 * Newest operator/user console mail wins (the chat they are waiting in);
 * else oldest pending mail with a conversation_id (FIFO agent reports).
 */
function getHubConversationId(hub) {
  try {
    const picked = pickPendingConversationId(hub);
    if (picked) return picked;
  } catch (_err) {
    /* ignore */
  }

  // Second: in-flight originating turn (if any)
  try {
    const { getOriginatingConversationId } = require('./conversations');
    const originating = getOriginatingConversationId(hub);
    if (originating) return originating;
  } catch (_err) {
    /* ignore */
  }

  // Third: active conversation (longer TTL)
  const activeId = getActiveConversationId(hub, 24 * 60 * 60 * 1000); // 24h TTL
  if (activeId) return activeId;

  // Fourth: System conversation (always-warm guarantee)
  const sysConv = createConversation(hub, 'System');
  return sysConv.id;
}

/** @deprecated Use getHubConversationId() which always returns a valid id */
function getRecentHubInboxMessage(hub) {
  return getHubConversationId(hub);
}

function logByteOffset(file) {
  try {
    if (!fs.existsSync(file)) return 0;
    return fs.statSync(file).size;
  } catch (_err) {
    return 0;
  }
}

function readLogTail(file, maxBytes = 2500) {
  try {
    if (!fs.existsSync(file)) return '';
    const stat = fs.statSync(file);
    const size = stat.size;
    if (size === 0) return '';
    const buffer = Buffer.alloc(Math.min(maxBytes, size));
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - maxBytes));
    fs.closeSync(fd);
    return buffer.toString('utf8').trim();
  } catch (_err) {
    return '';
  }
}

function readStderrTail(stderrFile, maxBytes = 2500) {
  return readLogTail(stderrFile, maxBytes);
}

/**
 * Resolve a conversation to show operator-facing agent failures.
 * Prefer explicit id → originating conversation for this slug's outstanding
 * work (pending-agent-work) → active chat → most recently updated conversation.
 */
function resolveAlertConversationId(hub, conversationId, slug) {
  if (conversationId && getConversation(hub, conversationId)) return conversationId;
  // The conversation that dispatched this agent's work owns its errors —
  // never broadcast into whatever chat the operator happens to have open.
  try {
    const origin = slug ? getPendingAgentWorkConversationId(hub, slug) : null;
    if (origin && getConversation(hub, origin)) return origin;
  } catch (_err) {
    /* ignore */
  }
  try {
    const active = getActiveConversationId(hub, 24 * 60 * 60 * 1000);
    if (active && getConversation(hub, active)) return active;
  } catch (_err) {
    /* ignore */
  }
  try {
    const list = listConversations(hub) || [];
    if (list.length) {
      const sorted = [...list].sort((a, b) =>
        String(b.updated_at || b.created_at || '').localeCompare(
          String(a.updated_at || a.created_at || ''),
        ),
      );
      if (sorted[0] && sorted[0].id) return sorted[0].id;
    }
  } catch (_err) {
    /* ignore */
  }
  return null;
}

/** Shell EXIT + Node child.exit can both fire — suppress duplicate alerts. */
function shouldSkipDuplicateAgentError(hub, slug, exitCode, kind) {
  const stampPath = path.join(hub, '.bizagent', 'last-agent-error.json');
  const now = Date.now();
  try {
    if (fs.existsSync(stampPath)) {
      const prev = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
      if (
        prev &&
        prev.slug === slug &&
        Number(prev.exitCode) === Number(exitCode) &&
        prev.kind === kind &&
        now - Number(prev.ts || 0) < 45000
      ) {
        return true;
      }
    }
  } catch (_err) {
    /* ignore */
  }
  try {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    writeJsonAtomic(stampPath, { slug, exitCode, kind, ts: now });
  } catch (_err) {
    /* ignore */
  }
  return false;
}

// --- Iteration-cap notify (2026-10-25) -------------------------------------
// When an agent burns its whole tool-iteration budget (often a degenerate
// identical-tool-call loop), tell the hub once per slug per hour. Cap exits
// are code 0, so this is detected from log tails regardless of exit code.

const ITERATION_CAP_NOTIFY_WINDOW_MS = 60 * 60 * 1000;
const ITERATION_CAP_MARKER = /stopped after (\d+) tool iterations/;

function iterationCapNotifyStatePath(hub, slug) {
  return path.join(appDir(hub), `iteration-cap-notify-${slug}.json`);
}

/** Debounce: at most one iteration-cap mail per slug per hour. */
function shouldNotifyIterationCap(hub, slug, now = Date.now()) {
  const statePath = iterationCapNotifyStatePath(hub, slug);
  try {
    const prev = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (
      prev &&
      prev.slug === slug &&
      now - Number(prev.ts || 0) < ITERATION_CAP_NOTIFY_WINDOW_MS
    ) {
      return false;
    }
  } catch (_err) {
    /* no state yet */
  }
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    writeJsonAtomic(statePath, { slug, ts: now });
  } catch (_err) {
    /* ignore */
  }
  return true;
}

/** Last N distinct `→ tool …` progress lines from a dispatch log tail. */
function lastDistinctToolCalls(logTail, limit = 3) {
  const seen = [];
  const lines = String(logTail || '').split('\n');
  for (let i = lines.length - 1; i >= 0 && seen.length < limit; i -= 1) {
    const idx = lines[i].indexOf('→ ');
    if (idx === -1) continue;
    const call = lines[i].slice(idx).trim();
    if (!call || seen.includes(call)) continue;
    seen.push(call);
  }
  return seen.reverse();
}

/** Best-effort task hint: subject of the slug's newest pending inbox mail. */
function iterationCapTaskHint(hub, slug) {
  try {
    const files = pendingMail(hub, slug) || [];
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const body = fs.readFileSync(files[i], 'utf8');
      const subj = String(body).match(/^subject:\s*(.+?)\s*$/m);
      if (subj) return subj[1].trim();
    }
  } catch (_err) {
    /* ignore */
  }
  return '(turn prompt already cleaned up — see dispatch-<slug>.log)';
}

/**
 * Detect the iteration-cap marker in a dispatch's log tails and write one
 * debounced mail to the hub inbox (from the agent slug). Best-effort — never
 * blocks dispatch. Returns true when a mail was written.
 */
function notifyIterationCap(hub, slug) {
  try {
    const stdoutTail = readLogTail(
      path.join(hub, 'logs', `dispatch-${slug}.log`),
      20000,
    );
    const stderrTail = readStderrTail(
      path.join(hub, 'logs', `dispatch-${slug}.stderr`),
      20000,
    );
    const match = `${stdoutTail}\n${stderrTail}`.match(ITERATION_CAP_MARKER);
    if (!match) return false;
    if (!shouldNotifyIterationCap(hub, slug)) return false;
    const calls = lastDistinctToolCalls(stdoutTail, 3);
    const body = [
      `Agent \`${slug}\` hit the tool iteration cap (${match[1]} iterations) without finishing its turn.`,
      `Task: ${iterationCapTaskHint(hub, slug)}`,
      calls.length
        ? `Last distinct tool calls:\n${calls.map((c) => `- ${c}`).join('\n')}`
        : 'Last distinct tool calls: (none found in log tail)',
    ].join('\n');
    writeOutboxMessage(hub, {
      from: slug,
      to: 'hub',
      subject: `iteration-cap hit: ${slug}`,
      body,
    });
    try {
      logEvent(hub, {
        event: 'iteration_cap_notify',
        slug,
        iterations: Number(match[1]),
      });
    } catch (_err) {
      /* ignore */
    }
    return true;
  } catch (_err) {
    return false;
  }
}

const RECENT_ERRORS_LIMIT = 20;

function recentErrorsFile(hub) {
  return path.join(appDir(hub), 'recent-errors.json');
}

/**
 * Ring buffer of recent classified agent/hub errors, surfaced by the console
 * health banner (operator request 2026-10-21: connection / rate-limit /
 * provider errors should be visible at the top of the page, not only as
 * in-chat status messages). Best-effort — never blocks dispatch.
 */
function recordRecentError(hub, entry) {
  try {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(recentErrorsFile(hub), 'utf8')); } catch (_err) { /* first */ }
    if (!Array.isArray(list)) list = [];
    list.push(entry);
    fs.mkdirSync(path.dirname(recentErrorsFile(hub)), { recursive: true });
    writeJsonAtomic(recentErrorsFile(hub), list.slice(-RECENT_ERRORS_LIMIT));
  } catch (_err) { /* ignore */ }
}

/** Recent errors, newest first, within the last `maxAgeMs` (default 24h). */
function readRecentErrors(hub, maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const list = JSON.parse(fs.readFileSync(recentErrorsFile(hub), 'utf8'));
    const cutoff = Date.now() - maxAgeMs;
    return (Array.isArray(list) ? list : [])
      .filter((e) => e && Number(e.ts || 0) >= cutoff)
      .slice(-RECENT_ERRORS_LIMIT)
      .reverse();
  } catch (_err) {
    return [];
  }
}

/**
 * Notify the operator in the web console when an agent (or hub cold path) fails.
 * Posts a status error into the active chat so credit/quota failures are never log-only.
 */
function recordAgentError(hub, slug, exitCode, stderrTail, conversationId) {
  const stdoutTail = readLogTail(
    path.join(hub, 'logs', `dispatch-${slug}.log`),
    2500,
  );
  // Iteration-cap notify (2026-10-25): cap exits are code 0, so this also
  // runs from notifyAgentExitFromLogs on every exit regardless of code.
  try { notifyIterationCap(hub, slug); } catch (_err) { /* ignore */ }
  const combined = [stderrTail, stdoutTail].filter(Boolean).join('\n');
  // Classify the real error output (stderr) first. The stdout log is the
  // agent's own transcript — thinking/tool output can mention "rate limit",
  // "429", or API keys without any provider error, which misclassified real
  // failures as provider errors (2026-10-19 operator report). Only fall back
  // to the transcript when stderr contributed nothing at all.
  let classified = classifyProviderError(stderrTail) ||
    (stderrTail ? null : classifyProviderError(combined));
  const kind = classified ? classified.kind : 'error';
  if (shouldSkipDuplicateAgentError(hub, slug, exitCode, kind)) return;

  // Provider queue (2026-10-23): every failed turn also feeds the
  // per-provider consecutive-failure counter (exponential backoff, then a
  // hold + one-time operator notice instead of retry-looping forever).
  let provider = '';
  let queueHold = null;
  try {
    const registry = loadRegistry(hub);
    provider = agentProvider(registry, slug);
    if (classified && classified.kind === 'rate_limit') {
      markRateLimitCooldown(hub, rateLimitCooldownSecs(registry), provider);
      classified = nameProviderInClassification(classified, provider);
    }
    const q = recordProviderFailure(hub, registry, provider, kind);
    if (q.justHeld) queueHold = q;
  } catch (_err) { /* best-effort */ }

  // Hub-only Ollama fallback: paid provider reachable but refused (credits /
  // auth / model). Background — classifies, checks Ollama, activates the
  // launch-time override, and tells the operator what to fix. Never for
  // product agents, never a network outage.
  try {
    ollamaFallback.maybeTriggerFallback(hub, { slug, text: stderrTail || combined });
  } catch (_err) { /* ignore */ }

  const errorMsg = formatProviderFailureMessage({
    slug,
    exitCode,
    text: combined,
    classified,
  });

  const cid = resolveAlertConversationId(hub, conversationId, slug);

  // One-time notice when a provider's queue transitions into the held state
  // (operator request 2026-10-23: hold the mail and say so, never loop).
  if (queueHold && cid) {
    try {
      const holdMsg = [
        `**Provider queue: pending mail held for \`${provider || 'fleet'}\`**`,
        '',
        `${queueHold.consecutive} consecutive failed turns (last kind: ${queueHold.lastKind || 'error'}). Pending mail for agents on this provider is held — no more automatic retries until it is resumed.`,
        '',
        '**Fix:** Resolve the provider issue, then tell the hub to resume the queue — it clears the hold and re-dispatches the held mail.',
      ].join('\n');
      appendMessage(hub, cid, 'status', holdMsg, { kind: STATUS_ERROR_KIND });
      notifyConversationMutated(hub, cid);
    } catch (_err) { /* ignore */ }
    try {
      recordRecentError(hub, {
        ts: Date.now(),
        slug,
        exitCode,
        kind: 'dispatch_held',
        title: `Provider queue held (${provider || 'fleet'})`,
        summary: `${queueHold.consecutive} consecutive failures — pending mail held, no more auto-retries.`,
        fix: 'Fix the provider, then have the hub resume the queue.',
        conversationId: cid || '',
      });
    } catch (_err) { /* ignore */ }
  }

  // Operator request (2026-10-21): feed the console health banner so recent
  // connection / rate-limit / provider errors are visible at the top of the
  // page even when the operator is in another conversation.
  try {
    recordRecentError(hub, {
      ts: Date.now(),
      slug,
      exitCode,
      kind,
      title: classified ? classified.title : 'Agent failure',
      summary: classified ? classified.summary : 'The run ended without a clean success.',
      fix: classified ? classified.fix : `See logs/dispatch-${slug}.log`,
      conversationId: cid || '',
    });
  } catch (_err) { /* ignore */ }

  const dateStr = new Date().toISOString().slice(0, 10);
  const subject = classified
    ? classified.kind === 'credits'
      ? 'LLM credits exhausted'
      : classified.title.slice(0, 60)
    : 'agent error';

  // Primary: status error in the console conversation (visible immediately on poll).
  let postedToChat = false;
  if (cid) {
    try {
      appendMessage(hub, cid, 'status', errorMsg, { kind: STATUS_ERROR_KIND });
      postedToChat = true;
      try {
        notifyConversationMutated(hub, cid);
      } catch (_err) {
        /* detached shell has no WS push — poll still picks it up */
      }
    } catch (_err) {
      postedToChat = false;
    }
    // Operator is in a different conversation: leave a lightweight one-line
    // "error waiting in <conversation>" indicator there (never the full dump).
    try {
      const activeNow = getActiveConversationId(hub);
      if (activeNow && activeNow !== cid) {
        recordCrossChatAlert(hub, cid, slug, subject);
      }
    } catch (_err) {
      /* ignore */
    }
  }

  // Backup path: user inbox (relayed on next CP tick) if direct append failed.
  if (cid && !postedToChat) {
    try {
      writeFileUnique(path.join(hub, 'user', 'inbox'), `${dateStr}-cp-agent-error`, [
        '---',
        'from: hub',
        'to: user',
        `date: ${dateStr}`,
        `subject: ${subject}`,
        `conversation_id: ${cid}`,
        '---',
        '',
        errorMsg,
      ].join('\n'));
    } catch (_err) {
      /* ignore */
    }
  }

  // No chat at all: queue for hub so PTL can relay once operator is back.
  if (!cid) {
    try {
      writeFileUnique(path.join(hub, 'inbox'), `${dateStr}-cp-agent-error-${slug}`, [
        '---',
        'from: control-plane',
        'to: hub',
        `date: ${dateStr}`,
        `subject: ${subject}`,
        '---',
        '',
        errorMsg,
        '',
        'Relay a short notice to the operator if appropriate.',
      ].join('\n'));
    } catch (_err) {
      /* ignore */
    }
  }

  // Always journal for ops trail
  try {
    const journalDir = path.join(hub, 'journal');
    fs.mkdirSync(journalDir, { recursive: true });
    const journalFile = path.join(journalDir, `${dateStr}.md`);
    const incident = `- [Incident] agent \`${slug}\` exit ${exitCode} (${kind}): ${
      classified ? classified.title : 'see dispatch logs'
    }\n`;
    if (!fs.existsSync(journalFile)) {
      fs.writeFileSync(journalFile, `# ${dateStr}\n\n${incident}`, 'utf8');
    } else {
      fs.appendFileSync(journalFile, incident, 'utf8');
    }
  } catch (_err) {
    /* ignore */
  }

  try {
    logEvent(hub, {
      event: 'agent_error',
      status: 'error',
      slug,
      exit_code: exitCode,
      kind,
      conversation_id: cid || '',
      message: classified ? classified.title : `exit ${exitCode}`,
    });
  } catch (_err) {
    /* ignore */
  }
}

/**
 * CLI helper for shell wrappers after non-zero agent exit (detached children
 * do not always deliver Node 'exit' to the long-lived control plane).
 */
function notifyAgentExitFromLogs(hub, slug, exitCode) {
  // Successful turn: clear the provider queue's backoff/hold for this
  // agent's provider (2026-10-23 provider queue).
  if (Number(exitCode) === 0) {
    try {
      recordProviderSuccess(hub, agentProvider(loadRegistry(hub), slug));
    } catch (_err) { /* best-effort */ }
    return;
  }
  // Operator hard-stop: suppress failure chatter + hard-fail re-dispatch.
  if (wasOperatorStopped(hub, slug)) {
    try {
      logEvent(hub, {
        event: 'operator_stop_exit',
        slug,
        exit_code: exitCode,
        t: nowIso(),
      });
    } catch (_err) { /* ignore */ }
    return;
  }
  const stderrTail = readStderrTail(
    path.join(hub, 'logs', `dispatch-${slug}.stderr`),
  );
  recordAgentError(hub, slug, exitCode, stderrTail, null);
  // Failed turn: do not let its fresh dispatch markers pin the inbox for the
  // whole lease — shorten them to the failure backoff so the dispatcher
  // retries automatically (operator report 2026-10-21, "green light" bug).
  try {
    backoffFailedDispatch(hub, slug, agentRetrySecs(hub));
  } catch (_err) { /* ignore */ }
}

function rateLimitCooldownFile(hub, provider = '') {
  // Per-provider cooldowns (2026-10-22): one file per provider so a Venice 429
  // no longer idles agents on other providers. The unnamed file is the
  // fleet-wide fallback for providers we cannot identify from the model string.
  const name = provider
    ? `rate-limit-cooldown-${provider}.json`
    : 'rate-limit-cooldown.json';
  return path.join(appDir(hub), name);
}

/**
 * Registry settings.dispatch.rate_limit_cooldown_secs (default 120, clamp 30–3600).
 * On the first rate-limit error every dispatch (hub + product agents) pauses
 * for this long before any turn may launch again.
 */
function rateLimitCooldownSecs(registry) {
  const dispatch = (registry && registry.settings && registry.settings.dispatch) || {};
  const n = Number(dispatch.rate_limit_cooldown_secs);
  if (!Number.isFinite(n)) return 120;
  return Math.max(30, Math.min(3600, Math.floor(n)));
}

/**
 * Registry settings.dispatch.recent_error_ttl_secs (default 300, clamp 30–86400).
 * How long a recent-error entry stays visible in the console health banner
 * (operator request 2026-10-23: 5 minutes by default, not 24h).
 */
function recentErrorTtlSecs(registry) {
  const dispatch = (registry && registry.settings && registry.settings.dispatch) || {};
  const n = Number(dispatch.recent_error_ttl_secs);
  if (!Number.isFinite(n)) return 300;
  return Math.max(30, Math.min(24 * 3600, Math.floor(n)));
}

/**
 * Record/extend a per-provider rate-limit cooldown. Each new rate-limit error
 * pushes the pause out (max of existing until vs now+secs) so repeated 429s
 * keep that provider stopped instead of retry-storming it. An empty provider
 * marks the fleet-wide fallback file, which gates every launch.
 */
function markRateLimitCooldown(hub, secs = 120, provider = '') {
  const target = rateLimitCooldownFile(hub, provider);
  const now = Math.floor(Date.now() / 1000);
  let until = now + secs;
  try {
    const prev = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (prev && Number(prev.until || 0) > until) until = Number(prev.until);
  } catch (_err) { /* first cooldown */ }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeJsonAtomic(target, { provider: provider || 'fleet', until, secs, at: now, t: nowIso() });
  } catch (_err) { /* best-effort */ }
  try {
    logEvent(hub, {
      event: 'rate_limit_cooldown',
      provider: provider || 'fleet',
      until_epoch: until,
      secs: until - now,
      t: nowIso(),
    });
  } catch (_err) { /* ignore */ }
  return until - now;
}

/** Seconds remaining in a provider's rate-limit cooldown (0 = clear). */
function rateLimitCooldownRemaining(hub, provider = '') {
  try {
    const data = JSON.parse(fs.readFileSync(rateLimitCooldownFile(hub, provider), 'utf8'));
    const until = Number(data.until || 0);
    if (!until) return 0;
    return Math.max(0, until - Math.floor(Date.now() / 1000));
  } catch (_err) {
    return 0;
  }
}

/**
 * Max remaining cooldown across all per-provider files (0 = all clear).
 * Used by /api/health so the banner still shows while any bucket is paused.
 */
function maxRateLimitCooldownRemaining(hub) {
  let max = 0;
  let entries;
  try {
    entries = fs.readdirSync(appDir(hub));
  } catch (_err) {
    return 0;
  }
  for (const entry of entries) {
    const match = /^rate-limit-cooldown(?:-(.+))?\.json$/.exec(entry);
    if (!match) continue;
    const secs = rateLimitCooldownRemaining(hub, match[1] || '');
    if (secs > max) max = secs;
  }
  return max;
}

// --- Provider dispatch queue (2026-10-23 operator request) -------------------
// Per-provider serialized dispatch with exponential backoff on consecutive
// failures (default ladder 60s → 120s → 300s → 900s cap) and a max-retry
// limit that HOLDS the provider's pending mail and notifies the operator
// once, instead of retry-looping forever. State lives in
// .bizagent/provider-queue/<provider>.json; a successful turn on the
// provider clears backoff + hold; the operator (via the hub) can resume a
// held queue explicitly.
function failureBackoffLadder(registry) {
  const dispatch = (registry && registry.settings && registry.settings.dispatch) || {};
  const raw = Array.isArray(dispatch.failure_backoff_secs) ? dispatch.failure_backoff_secs : null;
  const list = (raw && raw.length ? raw : [60, 120, 300, 900])
    .map((n) => Math.max(10, Math.min(24 * 3600, Math.floor(Number(n) || 0))))
    .filter((n) => n > 0);
  return list.length ? list : [60, 120, 300, 900];
}

function maxProviderFailures(registry) {
  const dispatch = (registry && registry.settings && registry.settings.dispatch) || {};
  const n = Number(dispatch.max_provider_failures);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

/**
 * Minimum spacing between two launches on the same provider — the "API queue"
 * (operator clarification 2026-10-23: a 0.5 second delay between API calls).
 * settings.dispatch.api_min_interval_ms, default 500, clamp 0–60000.
 */
function apiMinIntervalMs(registry) {
  const dispatch = (registry && registry.settings && registry.settings.dispatch) || {};
  const n = Number(dispatch.api_min_interval_ms);
  if (!Number.isFinite(n)) return 500;
  return Math.max(0, Math.min(60000, Math.floor(n)));
}

function providerQueueFile(hub, provider) {
  return path.join(appDir(hub), 'provider-queue', `${provider || 'fleet'}.json`);
}

function readProviderQueueState(hub, provider) {
  try {
    const s = JSON.parse(fs.readFileSync(providerQueueFile(hub, provider), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (_err) {
    return {};
  }
}

function writeProviderQueueState(hub, provider, state) {
  try {
    fs.mkdirSync(path.dirname(providerQueueFile(hub, provider)), { recursive: true });
    writeJsonAtomic(providerQueueFile(hub, provider), state);
  } catch (_err) { /* best-effort */ }
}

/** Dispatch gate for a provider: { held, backoffRemaining, consecutive }. */
function providerQueueGate(hub, provider) {
  const s = readProviderQueueState(hub, provider);
  const now = Math.floor(Date.now() / 1000);
  return {
    held: !!s.held,
    backoffRemaining: Math.max(0, Number(s.backoffUntil || 0) - now),
    consecutive: Number(s.consecutive || 0),
  };
}

/**
 * Record one failed turn for `provider`. Returns the new state including
 * justHeld (true only on the transition into the held state, so the
 * operator is notified once, not on every further failure).
 */
function recordProviderFailure(hub, registry, provider, kind) {
  const now = Math.floor(Date.now() / 1000);
  const prev = readProviderQueueState(hub, provider);
  const consecutive = Number(prev.consecutive || 0) + 1;
  const ladder = failureBackoffLadder(registry);
  const backoff = ladder[Math.min(consecutive - 1, ladder.length - 1)] || ladder[ladder.length - 1];
  const held = consecutive >= maxProviderFailures(registry) ? true : !!prev.held;
  const next = {
    provider: provider || 'fleet',
    consecutive,
    backoffUntil: now + backoff,
    held,
    heldAt: held ? Number(prev.heldAt || 0) || now : 0,
    lastKind: kind || '',
    lastT: nowIso(),
  };
  writeProviderQueueState(hub, provider, next);
  try {
    logEvent(hub, {
      event: 'provider_failure',
      provider: provider || 'fleet',
      consecutive,
      backoff_secs: backoff,
      held,
      kind: kind || '',
      t: nowIso(),
    });
  } catch (_err) { /* ignore */ }
  return { ...next, justHeld: held && !prev.held };
}

/** A successful turn on this provider clears backoff + hold. */
function recordProviderSuccess(hub, provider) {
  const prev = readProviderQueueState(hub, provider);
  if (!prev.consecutive && !prev.held && !prev.backoffUntil) return;
  writeProviderQueueState(hub, provider, {
    provider: provider || 'fleet',
    consecutive: 0,
    backoffUntil: 0,
    held: false,
    heldAt: 0,
    lastT: nowIso(),
  });
  try {
    logEvent(hub, { event: 'provider_recovered', provider: provider || 'fleet', t: nowIso() });
  } catch (_err) { /* ignore */ }
}

/** Operator/hub-initiated resume of a held or backing-off provider queue. */
function resumeProviderQueue(hub, provider) {
  writeProviderQueueState(hub, provider, {
    provider: provider || 'fleet',
    consecutive: 0,
    backoffUntil: 0,
    held: false,
    heldAt: 0,
    resumedAt: Math.floor(Date.now() / 1000),
    lastT: nowIso(),
  });
  try {
    logEvent(hub, { event: 'provider_queue_resumed', provider: provider || 'fleet', t: nowIso() });
  } catch (_err) { /* ignore */ }
}

/**
 * Provider key for a slug from registry.json ('' = unknown / fleet fallback).
 * Hub resolves from settings.hub_agent; product agents from their
 * provider/cliName fields. Lowercased for file-name-safe bucket keys.
 */
function agentProvider(registry, slug) {
  if (slug === 'hub') {
    const hubAgent = (registry && registry.settings && registry.settings.hub_agent) || {};
    return String(hubAgent.provider || hubAgent.cliName || '').trim().toLowerCase();
  }
  const agents = agentsFromRegistry(registry || {});
  const agent = agents.find((a) => a && a.slug === slug);
  return agent ? String(agent.provider || '').trim().toLowerCase() : '';
}

function promptFileFor(hub, slug) {
  return path.join(hub, 'agents', slug, '.dispatch.md');
}

function ensureDispatchPrompt(hub, slug) {
  const target = promptFileFor(hub, slug);
  const template = path.join(hub, 'templates', 'dispatch.md.template');
  if (!fs.existsSync(template)) throw new Error(`missing dispatch prompt template: ${template}`);
  const text = fs.readFileSync(template, 'utf8')
    .replace(/\{\{slug\}\}/g, slug)
    .replace(/\{\{agent_md\}\}/g, `agents/${slug}/agent.md`)
    .replace(/\{\{inbox\}\}/g, `agents/${slug}/inbox`)
    .replace(/\{\{outbox\}\}/g, `agents/${slug}/outbox`);
  // Always refresh from template so ops blurb updates (e.g. defer-wake) reach agents.
  fs.writeFileSync(target, text);
  return target;
}

function pidAlive(pid) {
  if (!pid || !/^[0-9]+$/.test(String(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Scan /proc for a live bizagent-agent CLI process for this slug
 * (node <hub>/agent-runtime/src/index.js -f …/turns/agent-<slug>-<turn>.md …).
 * Returns the pid (string) or '' when none is running.
 */
function findAgentCliPid(hub, slug) {
  const marker = slug === 'hub' ? 'hub-' : `agent-${slug}-`;
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch (_err) {
    return '';
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch (_err) {
      continue;
    }
    if (!cmd.includes('src/index.js')) continue;
    if (!cmd.includes(marker)) continue;
    return entry;
  }
  return '';
}

function lockDir(hub, slug) {
  if (slug === 'hub') return path.join(appDir(hub), 'hub.lock');
  return path.join(hub, 'agents', slug, '.lock');
}

function dispatchStateFile(hub, slug) {
  return path.join(appDir(hub), 'dispatch-state', `${slug}.json`);
}

function dispatchFingerprint(file) {
  const stat = fs.statSync(file);
  return {
    file: path.basename(file),
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
  };
}

function readDispatchState(hub, slug) {
  try {
    const state = JSON.parse(fs.readFileSync(dispatchStateFile(hub, slug), 'utf8'));
    return Array.isArray(state.handled) ? state.handled : [];
  } catch (_err) {
    return [];
  }
}

function sameFingerprint(left, right) {
  return left.file === right.file && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/**
 * How long a dispatch marker suppresses re-launch while the inbox file still exists.
 * Capped low (60s) caused duplicate hub turns: hub often finishes + leaves mail
 * unarchived briefly, then the next tick re-dispatches the same file.
 * Keep markers for the lock lease (default 30m), bounded 60s–6h.
 * Failed turns clear markers explicitly so retry is not blocked.
 */
function dispatchRetrySecs(config) {
  return Math.max(60, Math.min(6 * 3600, Number(config.lockLeaseSecs || 1800)));
}

function activeDispatchMarker(item, fingerprint, now, retrySecs, running = false) {
  const dispatchedAt = Number(item.dispatchedAt || 0);
  if (!sameFingerprint(item, fingerprint) || dispatchedAt <= 0) return false;
  // A slug that is actually running holds its markers regardless of age —
  // the same inbox fingerprint must not launch a second copy.
  if (running) return true;
  return now - dispatchedAt < retrySecs;
}

function pendingUndispatchedMail(hub, slug, retrySecs = 0, leaseSecs = 0) {
  const handled = readDispatchState(hub, slug);
  const now = Math.floor(Date.now() / 1000);
  const running = leaseSecs ? isAgentActive(hub, slug, leaseSecs) : false;
  return pendingMail(hub, slug).filter((file) => {
    const fingerprint = dispatchFingerprint(file);
    return !handled.some((item) => activeDispatchMarker(item, fingerprint, now, retrySecs, running));
  });
}

function markMailDispatched(hub, slug, files, retrySecs = 0, leaseSecs = 0) {
  const target = dispatchStateFile(hub, slug);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const handled = readDispatchState(hub, slug);
  const now = Math.floor(Date.now() / 1000);
  const mailDir = path.dirname(files[0] || '');
  const running = leaseSecs ? isAgentActive(hub, slug, leaseSecs) : false;
  // Drop markers only when the inbox file is gone (archived) or past retry
  // window — never while the slug is actually running.
  const next = handled.filter((item) => (
    fs.existsSync(path.join(mailDir, item.file)) &&
    (running || Number(item.dispatchedAt || 0) > now - retrySecs)
  ));
  for (const file of files) {
    const fingerprint = dispatchFingerprint(file);
    if (!next.some((item) => sameFingerprint(item, fingerprint))) next.push({ ...fingerprint, dispatchedAt: now });
  }
  writeJsonAtomic(target, { handled: next.slice(-200) });
}

/** Clear hub/agent dispatch markers so unarchived mail may launch again (e.g. hard-fail). */
function clearDispatchState(hub, slug) {
  const target = dispatchStateFile(hub, slug);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (_err) {
    /* ignore */
  }
}

/**
 * After a failed agent turn, shrink the dispatch markers' remaining
 * suppression window to a short backoff instead of the full lock lease.
 * Operator report (2026-10-21): a run that died early (connection/auth error)
 * left its markers active for up to `dispatchRetrySecs` (default 30m), so the
 * dispatcher ignored that inbox — green light, nobody home — with no signal
 * for when it should stop ignoring. Failed turns now re-dispatch after
 * AGENT_FAILURE_BACKOFF_SECS automatically (rate-limit failures additionally
 * gate the whole fleet via markRateLimitCooldown, so this does not 429-storm).
 */
const AGENT_FAILURE_BACKOFF_SECS = 60;

function backoffFailedDispatch(hub, slug, retrySecs, backoffSecs = AGENT_FAILURE_BACKOFF_SECS) {
  const target = dispatchStateFile(hub, slug);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_err) {
    return; // no markers to relax — next tick decides fresh
  }
  if (!state || !Array.isArray(state.handled) || state.handled.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const inboxDir = path.join(hub, 'agents', slug, 'inbox');
  const shifted = now - Math.max(0, Number(retrySecs || 0) - Math.max(1, Number(backoffSecs || 0)));
  state.handled = state.handled.map((item) => (
    fs.existsSync(path.join(inboxDir, item.file)) ? { ...item, dispatchedAt: shifted } : item
  ));
  try {
    writeJsonAtomic(target, state);
  } catch (_err) {
    /* ignore */
  }
  try {
    logEvent(hub, {
      event: 'dispatch_failure_backoff',
      slug,
      backoff_secs: backoffSecs,
      t: nowIso(),
    });
  } catch (_err) { /* ignore */ }
}

/** dispatchRetrySecs without a full config object (registry/env lookup). */
function agentRetrySecs(hub) {
  let leaseSecs = 1800;
  try {
    const dispatch = (loadRegistry(hub).settings || {}).dispatch || {};
    leaseSecs = Number(process.env.BIZAGENT_LOCK_LEASE_SECS || dispatch.lock_lease_secs || 1800);
  } catch (_err) { /* default lease */ }
  return dispatchRetrySecs({ lockLeaseSecs: leaseSecs });
}

function lockAgeSecs(lock) {
  const startFile = path.join(lock, 'start');
  const now = Math.floor(Date.now() / 1000);
  let start = 0;
  try {
    start = Number(fs.readFileSync(startFile, 'utf8').trim());
  } catch (_err) {
    try {
      start = Math.floor(fs.statSync(lock).mtimeMs / 1000);
    } catch (_statErr) {
      start = now;
    }
  }
  return now - start;
}

function tryLock(hub, slug, leaseSecs) {
  const lock = lockDir(hub, slug);
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    fs.writeFileSync(path.join(lock, 'start'), String(Math.floor(Date.now() / 1000)));
    return true;
  } catch (_err) {
    let pid = '';
    try {
      pid = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
    } catch (_readErr) {
      pid = '';
    }
    // A still-running lock owner keeps exclusive ownership past the lease —
    // long turns (>30m) must never be stolen / double-dispatched.
    if (pidAlive(pid)) return false;
    // Lock pid gone but a leftover bizagent-agent child for this slug may
    // still be running (orphaned wrapper) — do not steal.
    if (findAgentCliPid(hub, slug)) return false;
    // Dead/stale lock: reclaim.
    fs.rmSync(lock, { recursive: true, force: true });
    return tryLock(hub, slug, leaseSecs);
  }
}

function liveHubCount(hub, leaseSecs) {
  return isAgentActive(hub, 'hub', leaseSecs) ? 1 : 0;
}

function liveAgentCount(hub, leaseSecs) {
  const agentsDir = path.join(hub, 'agents');
  let count = 0;
  if (!fs.existsSync(agentsDir)) return 0;
  for (const slug of fs.readdirSync(agentsDir)) {
    if (slug === 'hub') continue;
    if (isAgentActive(hub, slug, leaseSecs)) count += 1;
  }
  return count;
}

/** Total live runs (hub + product agents). Kept for status/back-compat. */
function liveRunCount(hub, leaseSecs) {
  return liveHubCount(hub, leaseSecs) + liveAgentCount(hub, leaseSecs);
}

/**
 * True iff a live process exists for this slug — independent of lease age.
 * False as soon as the process is gone (lights/thinking follow reality).
 */
function isAgentActive(hub, slug, leaseSecs) {
  const lock = lockDir(hub, slug);
  if (!fs.existsSync(lock)) return false;
  let pid = '';
  try {
    pid = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
  } catch (_err) {
    pid = '';
  }
  if (pidAlive(pid)) return true;
  // Lock pid gone but a leftover bizagent-agent child may still run.
  return !!findAgentCliPid(hub, slug);
}

/**
 * Never SIGKILL the control-plane or hub-daemon themselves.
 * Warm hub locks often still hold the CP pid (tryLock writes process.pid before
 * the daemon owns the turn); killing that group would take down the whole hub.
 */
function isProtectedStopPid(hub, pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true;
  if (n === process.pid) return true;
  try {
    const daemonPid = fs.readFileSync(path.join(hub, '.bizagent', 'hub-daemon.pid'), 'utf8').trim();
    if (daemonPid && Number(daemonPid) === n) return true;
  } catch (_err) { /* no daemon pid file */ }
  return false;
}

/**
 * Kill a detached bash+CLI process group from a lock pid file.
 * Returns true if a kill signal was sent.
 */
function killLockProcessGroup(hub, lock) {
  let pid = '';
  try {
    pid = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
  } catch (_err) {
    pid = '';
  }
  if (!pid || !/^[0-9]+$/.test(pid)) return false;
  if (isProtectedStopPid(hub, pid)) return false;
  const n = Number(pid);
  let killed = false;
  try {
    // Negative pid targets the whole process group (spawn used detached:true).
    process.kill(-n, 'SIGKILL');
    killed = true;
  } catch (_err) {
    try { process.kill(n, 'SIGKILL'); killed = true; } catch (_err2) { /* gone */ }
  }
  return killed;
}

/**
 * Kill a leftover bizagent-agent CLI process for this slug (whole process
 * group when possible, else the pid). Used when the lock pid is missing or
 * protected (CP/daemon) so an orphaned turn is still stopped.
 * Returns true when a kill signal was sent.
 */
function killLeftoverAgentCli(hub, slug) {
  const pid = findAgentCliPid(hub, slug);
  if (!pid) return false;
  const n = Number(pid);
  if (isProtectedStopPid(hub, n)) return false;
  // Prefer the process group (wrapper bash + CLI + stderr-tee children).
  let pgrp = 0;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.indexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    pgrp = Number(fields[2]) || 0; // field 5 = pgrp
  } catch (_err) { /* fall back to pid */ }
  if (pgrp > 0 && pgrp !== n) {
    try { process.kill(-pgrp, 'SIGKILL'); return true; } catch (_err) { /* fall through */ }
  }
  try { process.kill(-n, 'SIGKILL'); return true; } catch (_err) { /* fall through */ }
  try { process.kill(n, 'SIGKILL'); return true; } catch (_err2) { return false; }
}

function operatorStopStampPath(hub, slug) {
  return path.join(appDir(hub), 'operator-stop', `${slug}.json`);
}

/**
 * Stamp an operator stop so cold-path exit hooks do not clearDispatchState
 * (hard-fail retry) and re-fire the same mail within seconds.
 */
function markOperatorStop(hub, slug) {
  try {
    const target = operatorStopStampPath(hub, slug);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeJsonAtomic(target, { slug, at: Math.floor(Date.now() / 1000), t: nowIso() });
  } catch (_err) { /* best-effort */ }
}

/**
 * True when an operator stop landed recently (default 2 minutes).
 * Consumed by hub cold exit / hard-fail paths that would otherwise clear markers.
 */
function wasOperatorStopped(hub, slug, withinSecs = 120) {
  try {
    const raw = fs.readFileSync(operatorStopStampPath(hub, slug), 'utf8');
    const data = JSON.parse(raw);
    const at = Number(data.at || 0);
    if (!at) return false;
    return Math.floor(Date.now() / 1000) - at < withinSecs;
  } catch (_err) {
    return false;
  }
}

/**
 * Keep dispatch markers after an intentional operator stop so the same
 * unarchived inbox mail is not re-launched on the next poll tick.
 * Operator stop ≠ hard-fail retry (which still calls clearDispatchState).
 * Markers expire with the normal lock-lease window once mail is archived
 * or the operator resends a new file.
 */
function suppressRedispatchAfterStop(hub, slug) {
  markOperatorStop(hub, slug);
  try {
    const files = pendingMail(hub, slug);
    if (!files.length) return;
    markMailDispatched(hub, slug, files, dispatchRetrySecs({ lockLeaseSecs: 1800 }));
  } catch (_err) { /* best-effort */ }
  try {
    logEvent(hub, {
      event: 'operator_stop_hold_dispatch',
      slug,
      t: nowIso(),
    });
  } catch (_err) { /* ignore */ }
}

/** clearDispatchState unless this slug was just operator-stopped. */
function clearDispatchStateUnlessOperatorStop(hub, slug) {
  if (wasOperatorStopped(hub, slug)) {
    try {
      logEvent(hub, {
        event: 'dispatch_clear_skipped_operator_stop',
        slug,
        t: nowIso(),
      });
    } catch (_err) { /* ignore */ }
    return false;
  }
  clearDispatchState(hub, slug);
  return true;
}

/**
 * Hard-stop an in-flight turn (operator Escape or running status light).
 * - Product agents / cold hub: SIGKILL detached process group from lock pid.
 * - Warm hub: cancel the daemon's in-flight CLI (do not kill CP or daemon).
 * Always drops the lock and holds dispatch markers so mail is not re-fired.
 * Async: await from API handlers. Returns true if a live process was targeted
 * or warm cancel reported an in-flight kill.
 */
async function stopAgentTurn(hub, slug) {
  const lock = lockDir(hub, slug);
  let killed = false;

  if (slug === 'hub') {
    // Warm path: lock pid is often the CP itself — never kill that.
    // Ask the daemon to abort its current CLI child instead.
    try {
      const result = await requestWarmHubCancel(hub, {
        connectTimeoutMs: 500,
        turnTimeoutMs: 3000,
      });
      if (result && result.ok && result.cancelled) killed = true;
      else if (result && result.ok && result.busy === false) {
        /* daemon idle — fall through to cold lock kill if any */
      } else if (result && result.cancelled) {
        killed = true;
      }
    } catch (_err) { /* fall through to cold lock kill */ }
  }

  // Cold spawn (product agents, or hub cold fallback): kill lock process group.
  // Skip if pid is protected (CP / daemon).
  if (killLockProcessGroup(hub, lock)) killed = true;
  // Lock missing/stolen or pid protected (CP/daemon): scan for leftover
  // bizagent-agent CLI children for this slug and kill their process groups.
  if (!killed && killLeftoverAgentCli(hub, slug)) killed = true;

  // SIGKILL cannot be trapped, so the shell EXIT trap won't clean the lock.
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_err) { /* ignore */ }

  // Hold markers so the same inbox mail is not immediately re-dispatched.
  suppressRedispatchAfterStop(hub, slug);

  try {
    logEvent(hub, {
      event: 'operator_stop',
      slug,
      killed: !!killed,
      t: nowIso(),
    });
  } catch (_err) { /* ignore */ }

  return killed;
}

function buildArgs(extraArgs, modelOverride) {
  if (!modelOverride) return extraArgs;
  if (!/^[A-Za-z0-9._:/-]+$/.test(modelOverride)) {
    throw new Error(`Invalid model name: ${modelOverride}`);
  }
  const stripped = extraArgs
    .replace(/--model[= ]\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return stripped ? `${stripped} --model ${modelOverride}` : `--model ${modelOverride}`;
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_err) {
    /* ignore */
  }
}

function launchAgent(config, slug, model = '', cliName = '') {
  const { hub, dryRun, _cliJson } = config;
  const cliJson = _cliJson || {};
  const lock = lockDir(hub, slug);
  const agentLog = path.join(hub, 'logs', `dispatch-${slug}.log`);
  const agentStderr = path.join(hub, 'logs', `dispatch-${slug}.stderr`);
  // Ensure standing .dispatch.md exists; launch uses ephemeral turn with mail inject.
  ensureDispatchPrompt(hub, slug);
  logEvent(hub, {
    event: 'dispatch_start',
    slug: slug,
    t: nowIso()
  });

  if (dryRun) {
    fs.rmSync(lock, { recursive: true, force: true });
    logEvent(hub, {
      event: 'dispatch_dry_run',
      slug: slug,
      type: 'agent'
    });
    return;
  }

  const promptFile = buildAgentTurnPrompt(hub, slug);
  fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
  let cliSettings;
  try {
    cliSettings = getCliSettings(hub, cliJson, config, cliName, model);
  } catch (err) {
    fs.rmSync(lock, { recursive: true, force: true });
    try { fs.unlinkSync(promptFile); } catch (_e) { /* ignore */ }
    logEvent(hub, {
      event: 'cli_config_error',
      slug: slug,
      cliName: cliName || config.cli || '',
      error: err.message,
      status: 'error',
    });
    recordAgentError(hub, slug, 1, err.message, null);
    return;
  }
  const cmdPreview = compileAgentCommand(cliSettings, promptFile);
  logEvent(hub, {
    event: 'cli_spawn',
    slug: slug,
    turn: path.basename(promptFile),
    cmd: cmdPreview,
    model: model || 'default'
  });

  // Timing + exit log live in the shell wrapper: detached+unref children do not
  // reliably deliver Node 'exit' events to a long-running control plane.
  // Delete ephemeral turn prompt on exit (same pattern as hub).
  // Ensure API keys from .bizagent/env are in this process (and thus children).
  loadHubEnv(hub);

  const script = [
    'HUB="$1"; slug="$2"; cli="$3"; pflag="$4"; extra="$5"; pfile="$6"; agentlog="$7"; stderrlog="$8"',
    'lockdir="$HUB/agents/$slug/.lock"',
    'cplog="$HUB/logs/control-plane.log"',
    'ts() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }',
    // Source hub env so CLI always sees XAI_API_KEY even if parent missed it.
    'if [ -f "$HUB/.bizagent/env" ]; then set -a; . "$HUB/.bizagent/env" 2>/dev/null || true; set +a; fi',
    'printf "%s\\n" "$$" > "$lockdir/pid" 2>/dev/null',
    'date +%s > "$lockdir/start" 2>/dev/null',
    'trap \'rm -rf "$lockdir"; rm -f "$pfile"\' EXIT',
    'cd "$HUB" || exit 1',
    'mkdir -p "$(dirname "$agentlog")" "$(dirname "$stderrlog")" 2>/dev/null || true',
    // Turn banners (not every stdout line — model chatter stays readable).
    'printf "%s === dispatch start slug=%s cli=%s ===\\n" "$(ts)" "$slug" "$cli" >> "$agentlog"',
    'printf "%s === dispatch start slug=%s cli=%s ===\\n" "$(ts)" "$slug" "$cli" >> "$stderrlog"',
    'start_ms=$(date +%s%3N 2>/dev/null || python3 -c "import time;print(int(time.time()*1000))")',
    'set +e',
    // stdout: raw agent output after banner; stderr: timestamp each line
    '"$cli" $pflag "$pfile" $extra >> "$agentlog" 2> >(while IFS= read -r line || [ -n "$line" ]; do printf "%s %s\\n" "$(ts)" "$line"; done >> "$stderrlog")',
    'code=$?',
    'end_ms=$(date +%s%3N 2>/dev/null || python3 -c "import time;print(int(time.time()*1000))")',
    'dur=$((end_ms - start_ms))',
    'printf "%s === dispatch end slug=%s code=%s duration_ms=%s ===\\n" "$(ts)" "$slug" "$code" "$dur" >> "$agentlog"',
    'printf "%s === dispatch end slug=%s code=%s duration_ms=%s ===\\n" "$(ts)" "$slug" "$code" "$dur" >> "$stderrlog"',
    'printf "%s control-plane: cli_exit slug=%s code=%s duration_ms=%s t=%s\\n" "$(ts)" "$slug" "$code" "$dur" "$(ts)" >> "$cplog"',
    // Detached CP may miss Node 'exit'; notify operator (credits/auth/etc.)
    // from logs on failure, clear the provider queue on success.
    'if command -v node >/dev/null 2>&1; then',
    '  node -e "try{require(process.argv[1]).notifyAgentExitFromLogs(process.argv[2],process.argv[3],Number(process.argv[4]))}catch(e){}" "$HUB/control-plane/lib/dispatcher.js" "$HUB" "$slug" "$code" >>"$cplog" 2>&1 || true',
    'fi',
    'exit "$code"',
  ].join('\n');

  const child = spawn('bash', ['-c', script, '_', hub, slug, cliSettings.cli, cliSettings.promptFlag, cliSettings.extraArgs, promptFile, agentLog, agentStderr], {
    detached: true,
    stdio: 'ignore',
    // BIZAGENT_HUB / BIZAGENT_AGENT_SLUG so hire_helper can attribute pool slots
    // (and agent-runtime can load settings.mcp from registry.json).
    env: { ...process.env, BIZAGENT_HUB: hub, BIZAGENT_AGENT_SLUG: slug },
  });

  child.on('exit', (code) => {
    if (code === 0 || code === null) {
      // Success: clear this provider's queue backoff/hold (best-effort; the
      // shell wrapper's cold-path notify also covers detached exits).
      try {
        recordProviderSuccess(hub, agentProvider(loadRegistry(hub), slug));
      } catch (_err) { /* ignore */ }
    }
    if (code !== 0 && code !== null && !wasOperatorStopped(hub, slug)) {
      const stderrTail = readStderrTail(agentStderr);
      recordAgentError(hub, slug, code, stderrTail, null);
      // Mirror the cold-path recovery: shorten dispatch markers to the
      // failure backoff so a crashed run retries instead of idling out
      // the full lease (operator report 2026-10-21).
      try {
        backoffFailedDispatch(config.hub, slug, dispatchRetrySecs(config));
      } catch (_err) { /* ignore */ }
    }
  });

  // Agent turns never attach to the operator chat (2026-10-12 operator report):
  // no launch-ack, no thinking record, no conversation mutation. Only the hub
  // may own a thinking bubble in the conversation view; agent logs remain in
  // the fleet thinking viewer (/api/logs/stream), never in the chat pane.
  // (Previously this posted a launch-ack + recordThinking for the agent slug,
  // which rendered the agent's dispatch log as a chat thinking bubble that no
  // hub reply would ever strip.)

  child.unref();
  logEvent(hub, {
    event: 'cli_launched',
    slug: slug,
    turn: path.basename(promptFile)
  });
}

function preferWarmDaemon(config) {
  const tuning = (config.registry && config.registry.settings && config.registry.settings.tuning) || {};
  const hubTune = tuning.hub || {};
  if (hubTune.prefer_warm_daemon === false) return false;
  return true;
}

function launchHub(config) {
  const { hub, dryRun, hubModel, hubCliName, _cliJson } = config;
  const cliJson = _cliJson || {};
  const lock = lockDir(hub, 'hub');
  const agentLog = path.join(hub, 'logs', 'dispatch-hub.log');
  const agentStderr = path.join(hub, 'logs', 'dispatch-hub.stderr');
  logEvent(hub, { event: 'dispatch_start', slug: 'hub', t: nowIso() });

  // Always refresh base hub.md for tools that still open it; launch uses turn file.
  ensureHubRuntimePrompt(hub);
  const runtimeCwd = ensureHubRuntimeCwd(hub);

  // ALWAYS-WARM: conversation_id is guaranteed — never null
  const conversationId = getHubConversationId(hub);
  const startedAt = nowIso();
  const logOffset = logByteOffset(agentLog);
  const stderrOffset = logByteOffset(agentStderr);

  if (conversationId) {
    // CP-owned first byte: deterministic status line before CLI boot.
    // One ack per spawn (postLaunchAck is idempotent if ack still visible).
    try {
      postLaunchAck(hub, conversationId);
      logEvent(hub, { event: 'launch_ack', conversation_id: conversationId, t: startedAt });
      // Track the in-flight turn so the UI can stream its thinking live.
      recordThinking(hub, conversationId, 'hub', agentLog, logOffset);
      // Push "Working. Stand by..." over WS/SSE (hook no-ops outside main CP process).
      notifyConversationMutated(hub, conversationId);
    } catch (err) {
      logEvent(hub, { event: 'warn', type: 'launch_ack_failed', message: err.message });
    }
  }

  if (dryRun) {
    fs.rmSync(lock, { recursive: true, force: true });
    logEvent(hub, { event: 'dispatch_dry_run', slug: 'hub', type: 'hub' });
    // No CLI → no safety-net pending (would false-fail with empty log).
    // Still build turn prompt so reserved path + delivery instructions are exercised.
    try { buildHubTurnPrompt(hub, { conversationId }); } catch (_err) { /* optional in dry-run */ }
    return;
  }

  // Prefer warm hub-daemon when available (Makeover Phase 1). Cold spawn is fallback.
  if (preferWarmDaemon(config)) {
    const tuning = (config.registry && config.registry.settings && config.registry.settings.tuning) || {};
    const hubTune = tuning.hub || {};
    // Fire-and-forget async: lock is held by tryLock; daemon or we release.
    requestWarmHubTurn(hub, {
      connectTimeoutMs: hubTune.warm_connect_timeout_ms || 500,
      turnTimeoutMs: hubTune.warm_turn_timeout_ms || 600000,
    }).then((result) => {
      // Only fall back to cold spawn when the daemon is unreachable / timed out.
      // If the daemon ran the turn (success or failure), do not double-launch.
      const unreachable = !result.via || [
        'no_socket',
        'connect_timeout',
        'socket_error',
        'turn_timeout',
        'busy',
      ].includes(result.error);
      if (!unreachable) {
        logEvent(hub, {
          event: 'hub_turn_completed',
          via: 'warm_daemon',
          ok: !!result.ok,
          action: result.action || '',
          exit_code: result.exitCode,
          duration_ms: result.duration_ms,
          conversation_id: conversationId || result.conversationId || '',
          error: result.error || undefined,
        });
        // Hard-fail: allow the same unarchived inbox mail to re-dispatch.
        // Skip after operator stop (markers must keep holding the mail).
        if (
          !result.ok
          && !result.operator_stop
          && result.action !== 'operator_stop'
          && (result.action === 'failed' || result.action === 'cli_config_error')
        ) {
          try { clearDispatchStateUnlessOperatorStop(hub, 'hub'); } catch (_e) { /* ignore */ }
        }
        // Daemon owns CLI lifecycle; drop CP lock when turn finishes.
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
        return;
      }
      // Daemon is mid-turn for another request — do NOT cold-spawn a second hub CLI
      // (that double-delivered operator replies). Release lock; tick will retry.
      if (result.error === 'busy') {
        logEvent(hub, {
          event: 'hub_warm_busy',
          conversation_id: conversationId || '',
        });
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
        return;
      }
      logEvent(hub, {
        event: 'hub_warm_fallback',
        reason: result.error || 'warm_failed',
        conversation_id: conversationId || '',
      });
      launchHubCold(config, {
        conversationId,
        startedAt,
        logOffset,
        stderrOffset,
        agentLog,
        agentStderr,
        runtimeCwd,
        lock,
        hubModel,
        hubCliName,
        cliJson,
      });
    }).catch((err) => {
      logEvent(hub, {
        event: 'hub_warm_fallback',
        reason: err.message || 'warm_exception',
        conversation_id: conversationId || '',
      });
      launchHubCold(config, {
        conversationId,
        startedAt,
        logOffset,
        stderrOffset,
        agentLog,
        agentStderr,
        runtimeCwd,
        lock,
        hubModel,
        hubCliName,
        cliJson,
      });
    });
    return;
  }

  launchHubCold(config, {
    conversationId,
    startedAt,
    logOffset,
    stderrOffset,
    agentLog,
    agentStderr,
    runtimeCwd,
    lock,
    hubModel,
    hubCliName,
    cliJson,
  });
}

function launchHubCold(config, ctx) {
  const {
    conversationId,
    startedAt,
    logOffset,
    stderrOffset,
    agentLog,
    agentStderr,
    runtimeCwd,
    lock,
    hubModel,
    hubCliName,
    cliJson,
  } = ctx;
  const { hub } = config;

  // Ollama fallback (hub-only): while the flag is active, retry this hub turn
  // against local Ollama. Launch-time override only — registry.json / cli.json
  // are never rewritten as the new default.
  let effectiveModel = hubModel || '';
  let effectiveCliName = hubCliName || '';
  const fbOverride = ollamaFallback.hubLaunchOverride(hub);
  if (fbOverride) {
    effectiveCliName = fbOverride.provider;
    effectiveModel = fbOverride.model;
    try {
      logEvent(hub, {
        event: 'hub_ollama_fallback_launch',
        provider: fbOverride.provider,
        model: fbOverride.model,
        conversation_id: conversationId || '',
      });
    } catch (_e) { /* ignore */ }
  }

  // Build turn prompt first (creates reserved body file when conversation_id present).
  let promptFile;
  try {
    promptFile = buildHubTurnPrompt(hub, { conversationId });
  } catch (err) {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    logEvent(hub, {
      event: 'hub_turn_prompt_error',
      message: err.message,
      conversation_id: conversationId || '',
      status: 'error',
    });
    return;
  }
  const replyBodyFile = conversationId
    ? (reservedReplyBodyPath(hub, conversationId) || prepareReservedReplyBody(hub, conversationId))
    : '';

  if (conversationId) {
    recordPendingHubTurn(hub, {
      conversationId,
      logByteOffset: logOffset,
      stderrByteOffset: stderrOffset,
      startedAt,
      agentLog,
      agentStderr,
      replyBodyFile,
    });
  }

  fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
  // Ensure API keys from .bizagent/env are in this process (and thus children).
  const envLoad = loadHubEnv(hub);
  // Prefer settings.hub_agent.cliName (via config.hubCliName); empty falls back to .cli / default.
  let cliSettings;
  try {
    cliSettings = getCliSettings(hub, cliJson, config, effectiveCliName, effectiveModel);
  } catch (err) {
    fs.rmSync(lock, { recursive: true, force: true });
    try { fs.unlinkSync(promptFile); } catch (_e) { /* ignore */ }
    logEvent(hub, {
      event: 'cli_config_error',
      slug: 'hub',
      cliName: hubCliName || config.cli || '',
      error: err.message,
      status: 'error',
    });
    if (conversationId) {
      try {
        onHubCliExit(hub, {
          conversationId,
          logByteOffset: logOffset,
          stderrByteOffset: stderrOffset,
          startedAt,
          agentLog,
          agentStderr,
          replyBodyFile,
          exitCode: 1,
        });
      } catch (_e) { /* ignore */ }
    }
    return;
  }
  const cmdPreview = compileAgentCommand(cliSettings, promptFile);
  logEvent(hub, {
    event: 'cli_spawn',
    slug: 'hub',
    turn: path.basename(promptFile),
    cmd: cmdPreview,
    model: effectiveModel || 'default',
    cwd: path.relative(hub, runtimeCwd) || runtimeCwd,
    env_file_found: !!envLoad.found,
    env_keys_applied: envLoad.applied || 0,
    has_xai_key: !!(process.env.XAI_API_KEY && process.env.XAI_API_KEY.length > 0),
  });

  // Safety module path for EXIT trap (absolute so cwd isolation does not matter).
  const safetyModule = path.join(__dirname, 'hub-turn-safety.js');
  // turnjson is a template; shell substitutes exit code before node runs.
  const turnJsonBase = JSON.stringify({
    conversationId: conversationId || '',
    logByteOffset: logOffset,
    stderrByteOffset: stderrOffset,
    startedAt,
    agentLog,
    agentStderr,
    replyBodyFile,
  });

  const script = [
    'HUB="$1"; cli="$2"; pflag="$3"; extra="$4"; pfile="$5"; agentlog="$6"; stderrlog="$7"; cwd="$8"; safemod="$9"; turnjson="${10}"',
    'lockdir="$HUB/.bizagent/hub.lock"',
    'cplog="$HUB/logs/control-plane.log"',
    'ts() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }',
    'mkdir -p "$HUB/.bizagent" "$HUB/logs"',
    // Source hub env so CLI always sees XAI_API_KEY even if parent missed it.
    'if [ -f "$HUB/.bizagent/env" ]; then set -a; . "$HUB/.bizagent/env" 2>/dev/null || true; set +a; fi',
    'printf "%s\\n" "$$" > "$lockdir/pid" 2>/dev/null',
    'date +%s > "$lockdir/start" 2>/dev/null',
    'code=0',
    // On exit: drop lock + ephemeral prompt, then outbox safety net (if console turn).
    'cleanup() {',
    '  rm -rf "$lockdir"',
    '  rm -f "$pfile"',
    '  if [ -n "$turnjson" ] && [ "$turnjson" != "{}" ] && command -v node >/dev/null 2>&1; then',
    // Merge exit code in Node (safer than sed on JSON).
    '    node -e "const m=require(process.argv[1]); const t=JSON.parse(process.argv[3]||\\"{}\\"); t.exitCode=Number(process.argv[4]); if(t.conversationId) m.onHubCliExit(process.argv[2], t);" "$safemod" "$HUB" "$turnjson" "$code" >>"$cplog" 2>&1 || true',
    '  fi',
    '}',
    'trap cleanup EXIT',
    'cd "$cwd" || exit 1',
    'printf "%s === dispatch start slug=hub cli=%s ===\\n" "$(ts)" "$cli" >> "$agentlog"',
    'printf "%s === dispatch start slug=hub cli=%s ===\\n" "$(ts)" "$cli" >> "$stderrlog"',
    'start_ms=$(date +%s%3N 2>/dev/null || python3 -c "import time;print(int(time.time()*1000))")',
    'set +e',
    '"$cli" $pflag "$pfile" $extra >> "$agentlog" 2> >(while IFS= read -r line || [ -n "$line" ]; do printf "%s %s\\n" "$(ts)" "$line"; done >> "$stderrlog")',
    'code=$?',
    'end_ms=$(date +%s%3N 2>/dev/null || python3 -c "import time;print(int(time.time()*1000))")',
    'dur=$((end_ms - start_ms))',
    'printf "%s === dispatch end slug=hub code=%s duration_ms=%s ===\\n" "$(ts)" "$code" "$dur" >> "$agentlog"',
    'printf "%s === dispatch end slug=hub code=%s duration_ms=%s ===\\n" "$(ts)" "$code" "$dur" >> "$stderrlog"',
    'printf "%s control-plane: cli_exit slug=hub code=%s duration_ms=%s t=%s\\n" "$(ts)" "$code" "$dur" "$(ts)" >> "$cplog"',
    'if [ "$code" -ne 0 ] && command -v node >/dev/null 2>&1; then',
    '  node -e "try{require(process.argv[1]).notifyAgentExitFromLogs(process.argv[2],process.argv[3],Number(process.argv[4]))}catch(e){}" "$HUB/control-plane/lib/dispatcher.js" "$HUB" hub "$code" >>"$cplog" 2>&1 || true',
    'fi',
    'exit "$code"',
  ].join('\n');

  const child = spawn('bash', [
    '-c', script, '_', hub, cliSettings.cli, cliSettings.promptFlag, cliSettings.extraArgs,
    promptFile, agentLog, agentStderr, runtimeCwd, safetyModule, turnJsonBase,
  ], {
    detached: true,
    stdio: 'ignore',
    // BIZAGENT_HUB / BIZAGENT_AGENT_SLUG so hire_helper can attribute pool slots
    // (and agent-runtime can load settings.mcp from registry.json).
    env: { ...process.env, BIZAGENT_HUB: hub, BIZAGENT_AGENT_SLUG: 'hub' },
  });

  child.on('exit', (code) => {
    const opStop = wasOperatorStopped(hub, 'hub');
    if (code === 0 || code === null) {
      try {
        recordProviderSuccess(hub, agentProvider(loadRegistry(hub), 'hub'));
      } catch (_err) { /* ignore */ }
    }
    if (code !== 0 && code !== null && !opStop) {
      const stderrTail = readStderrTail(agentStderr);
      recordAgentError(hub, 'hub', code, stderrTail, conversationId);
    }
    // Backup if shell EXIT hook did not clear the pending turn (tick also drains).
    let action = opStop ? 'operator_stop' : '';
    if (!opStop && conversationId) {
      const stillPending = readPendingHubTurns(hub).some(
        (t) => t.conversationId === conversationId && t.startedAt === startedAt,
      );
      if (stillPending) {
        try {
          const result = onHubCliExit(hub, {
            conversationId,
            logByteOffset: logOffset,
            stderrByteOffset: stderrOffset,
            startedAt,
            agentLog,
            agentStderr,
            replyBodyFile,
            exitCode: code,
          });
          action = (result && result.action) || '';
        } catch (_err) {
          /* tick drain will retry */
        }
      }
    }
    logEvent(hub, {
      event: 'hub_turn_completed',
      via: 'cold',
      ok: code === 0,
      exit_code: code,
      action,
      conversation_id: conversationId || '',
    });
    if (
      action !== 'operator_stop'
      && (action === 'failed'
        || (code !== 0 && code !== null && action !== 'reserved-body' && action !== 'ok-existing'))
    ) {
      try { clearDispatchStateUnlessOperatorStop(hub, 'hub'); } catch (_e) { /* ignore */ }
    }
  });

  child.unref();
  logEvent(hub, {
    event: 'cli_launched',
    slug: 'hub',
    via: 'cold',
    turn: path.basename(promptFile),
    cwd: path.basename(runtimeCwd),
  });
}

function dispatchPendingAgents(config) {
  const agents = agentsFromRegistry(config.registry);
  // Per-provider buckets (2026-10-22): pending agents are grouped by the
  // provider resolved from their registry model/provider fields instead of
  // one global agent pool, and each provider has its own slot cap and
  // rate-limit cooldown. A Venice 429 no longer idles agents on other
  // providers. The hub keeps its own bucket (hub_slots, default 1); its
  // cooldown is keyed by the hub's provider so a hub 429 freezes that
  // provider's product-agent bucket too. Agents whose provider cannot be
  // identified share the '' bucket, gated by the fleet-wide cooldown file.
  // If a turn retries/falls back onto a different provider (registry change),
  // it simply re-queues into that provider's bucket on the next tick — the
  // failed provider's cooldown does not follow it.
  const allowConcurrency = config.allowConcurrency !== false;
  // allow_concurrency=false (or BIZAGENT_ALLOW_CONCURRENCY=0): at most one
  // live turn at a time across hub + product agents (serial; local CPU).
  const hubSlots = allowConcurrency ? Math.max(1, Number(config.hubSlots || 1)) : 1;
  const agentSlots = allowConcurrency ? Math.max(1, Number(config.agentSlots || config.maxConcurrency || 8)) : 1;
  // Default cap for providers not listed in the agent_slots map (or when
  // agent_slots is still a plain number — legacy config stays valid).
  const slotsByProvider = allowConcurrency ? (config.agentSlotsByProvider || {}) : {};
  const slotCapFor = (provider) => {
    if (!allowConcurrency) return 1;
    const mapped = slotsByProvider[provider];
    return Math.max(1, Number(mapped || agentSlots));
  };
  let hubRunning = liveHubCount(config.hub, config.lockLeaseSecs);
  // Per-provider live counts for product agents (buckets come from the registry).
  const runningByProvider = {};
  let agentRunning = 0;
  for (const agent of agents) {
    if (!isAgentActive(config.hub, agent.slug, config.lockLeaseSecs)) continue;
    const provider = agentProvider(config.registry, agent.slug);
    runningByProvider[provider] = (runningByProvider[provider] || 0) + 1;
    agentRunning += 1;
  }
  let launched = 0;
  let skippedLocked = 0;
  let skippedCap = 0;
  let skippedCooldown = 0;
  let skippedQueue = 0;
  let skippedSpacing = 0;
  const retrySecs = dispatchRetrySecs(config);
  const serialBusy = () => !allowConcurrency && (hubRunning + agentRunning) >= 1;
  // Fleet-wide fallback cooldown (unnamed file): gates every launch, for
  // providers we cannot identify from the model string and as a hard stop.
  const fleetCooldownSecs = rateLimitCooldownRemaining(config.hub);
  // API queue (2026-10-23): minimum spacing between two launches on the same
  // provider (default 500ms) so calls to one provider are serialized. Tick
  // granularity is coarser than 500ms, so the first launch in a tick always
  // goes and the next same-provider launch waits for a later tick.
  const minIntervalMs = apiMinIntervalMs(config.registry);
  const lastLaunchAtByProvider = new Map();
  const apiQueueOpen = (provider) => {
    if (minIntervalMs <= 0) return true;
    const last = lastLaunchAtByProvider.get(provider) || 0;
    return Date.now() - last >= minIntervalMs;
  };
  const noteLaunch = (provider) => lastLaunchAtByProvider.set(provider, Date.now());
  // Provider queue (2026-10-23): a provider with consecutive failures backs
  // off exponentially; past the max-retry limit its pending mail is HELD
  // (no automatic retries until the operator/hub resumes the queue).
  const queueOpen = (provider) => {
    const gate = providerQueueGate(config.hub, provider);
    return !gate.held && gate.backoffRemaining <= 0;
  };

  const hubNew = pendingUndispatchedMail(config.hub, 'hub', retrySecs, config.lockLeaseSecs);
  if (hubNew.length > 0) {
    const hubProvider = agentProvider(config.registry, 'hub');
    if (fleetCooldownSecs > 0 || rateLimitCooldownRemaining(config.hub, hubProvider) > 0) {
      skippedCooldown += 1;
    } else if (!queueOpen(hubProvider)) {
      skippedQueue += 1;
    } else if (serialBusy() || hubRunning >= hubSlots) {
      skippedCap += 1;
    } else if (!apiQueueOpen(hubProvider)) {
      skippedSpacing += 1;
    } else if (tryLock(config.hub, 'hub', config.lockLeaseSecs)) {
      markMailDispatched(config.hub, 'hub', hubNew, retrySecs, config.lockLeaseSecs);
      try {
        launchHub(config);
        launched += 1;
        hubRunning += 1;
        noteLaunch(hubProvider);
      } catch (err) {
        try { fs.rmSync(lockDir(config.hub, 'hub'), { recursive: true, force: true }); } catch (_e) { /* ignore */ }
        logEvent(config.hub, {
          event: 'hub_launch_error',
          message: err.message,
          status: 'error',
        });
      }
    } else {
      skippedLocked += 1;
    }
  }

  for (const agent of agents) {
    const pending = pendingMail(config.hub, agent.slug);
    if (pending.length === 0) continue;
    const fresh = pendingUndispatchedMail(config.hub, agent.slug, retrySecs, config.lockLeaseSecs);
    if (fresh.length === 0) {
      continue;
    }
    const provider = agentProvider(config.registry, agent.slug);
    if (fleetCooldownSecs > 0 || rateLimitCooldownRemaining(config.hub, provider) > 0) {
      skippedCooldown += 1;
      continue;
    }
    if (!queueOpen(provider)) {
      skippedQueue += 1;
      continue;
    }
    const running = runningByProvider[provider] || 0;
    if (serialBusy() || running >= slotCapFor(provider)) {
      skippedCap += 1;
      continue;
    }
    if (!apiQueueOpen(provider)) {
      skippedSpacing += 1;
      continue;
    }
    if (tryLock(config.hub, agent.slug, config.lockLeaseSecs)) {
      markMailDispatched(config.hub, agent.slug, fresh, retrySecs, config.lockLeaseSecs);
      launchAgent(config, agent.slug, agent.model || config.agentDefaultModel || '', agent.cliName || '');
      launched += 1;
      runningByProvider[provider] = running + 1;
      agentRunning += 1;
      noteLaunch(provider);
    } else {
      skippedLocked += 1;
    }
  }

  return {
    launched,
    skippedLocked,
    skippedCap,
    skippedCooldown,
    skippedQueue,
    skippedSpacing,
    running: hubRunning + agentRunning,
    hubRunning,
    agentRunning,
    hubSlots,
    agentSlots,
    agentSlotsByProvider: slotsByProvider,
    runningByProvider,
    allowConcurrency,
    rateLimitCooldownSecs: maxRateLimitCooldownRemaining(config.hub),
  };
}

/** Tick backup: finish safety net for hub turns whose CLI has exited. */
function drainHubTurnSafety(config) {
  return drainPendingHubTurns(config.hub, () =>
    isAgentActive(config.hub, 'hub', config.lockLeaseSecs),
  );
}

module.exports = {
  dispatchPendingAgents,
  dispatchFingerprint,
  dispatchRetrySecs,
  drainHubTurnSafety,
  agentProvider,
  apiMinIntervalMs,
  ensureDispatchPrompt,
  failureBackoffLadder,
  maxProviderFailures,
  providerQueueGate,
  recordProviderFailure,
  recordProviderSuccess,
  resumeProviderQueue,
  findAgentCliPid,
  getHubConversationId,
  getRecentHubInboxMessage,
  hubDaemonSock,
  isAgentActive,
  killLeftoverAgentCli,
  launchAgent,
  launchHub,
  launchHubCold,
  liveAgentCount,
  liveHubCount,
  liveRunCount,
  clearDispatchState,
  clearDispatchStateUnlessOperatorStop,
  backoffFailedDispatch,
  agentRetrySecs,
  isProtectedStopPid,
  iterationCapTaskHint,
  markMailDispatched,
  markOperatorStop,
  markRateLimitCooldown,
  maxRateLimitCooldownRemaining,
  lastDistinctToolCalls,
  notifyAgentExitFromLogs,
  notifyIterationCap,
  pendingUndispatchedMail,
  preferWarmDaemon,
  promptFileFor,
  rateLimitCooldownRemaining,
  rateLimitCooldownSecs,
  recentErrorTtlSecs,
  readRecentErrors,
  readStderrTail,
  recordAgentError,
  requestHubDaemon,
  requestWarmHubCancel,
  requestWarmHubTurn,
  shouldNotifyIterationCap,
  stopAgentTurn,
  suppressRedispatchAfterStop,
  tryLock,
  wasOperatorStopped,
};
