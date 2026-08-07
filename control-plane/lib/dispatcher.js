const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { agentsFromRegistry, appDir, loadHubEnv } = require('./config');
const { compileAgentCommand, getCliSettings } = require('./cli-config');
const {
  buildAgentTurnPrompt,
  buildHubTurnPrompt,
  ensureHubRuntimeCwd,
  ensureHubRuntimePrompt,
} = require('./hub-memory');
const { pendingMail } = require('./mail');
const { logEvent, logLatency, logError, appendLog } = require('./log');
const { postLaunchAck, postAgentCompletionNotice, writeFileUnique } = require('./conversations');
const {
  drainPendingHubTurns,
  notifyConversationMutated,
  onHubCliExit,
  prepareReservedReplyBody,
  readPendingHubTurns,
  recordPendingHubTurn,
  reservedReplyBodyPath,
} = require('./hub-turn-safety');

function hubDaemonSock(hub) {
  return path.join(hub, '.bizagent', 'hub.sock');
}

/**
 * Ask the warm hub-daemon to process pending hub mail.
 * Resolves { ok, via:'warm', ... } or { ok:false, error } on connect/timeout/busy.
 */
function requestWarmHubTurn(hub, opts = {}) {
  const sockPath = hubDaemonSock(hub);
  const connectMs = Math.max(100, Number(opts.connectTimeoutMs || 500));
  const turnMs = Math.max(5000, Number(opts.turnTimeoutMs || 600000));
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
      const req = {
        type: 'turn',
        requestId: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      };
      socket.write(`${JSON.stringify(req)}\n`);
    });
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      clearTimeout(turnTimer);
      try {
        const msg = JSON.parse(line);
        done({
          ...msg,
          via: 'warm',
          ok: !!msg.ok || msg.action === 'reserved-body' || msg.action === 'ok-existing',
        });
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

function nowIso() {
  return new Date().toISOString();
}

/**
 * Get conversation_id for hub dispatch.
 * ALWAYS returns a valid conversation_id — never null.
 * Falls back to active conversation or creates a "System" conversation.
 */
function getHubConversationId(hub) {
  // First: check pending hub inbox mail for explicit conversation_id
  const inboxDir = path.join(hub, 'inbox');
  try {
    const files = fs.readdirSync(inboxDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .sort()
      .reverse();
    for (const name of files) {
      const content = fs.readFileSync(path.join(inboxDir, name), 'utf8');
      const match = content.match(/^conversation_id:\s*(.+?)$/m);
      if (match) return match[1].trim();
    }
  } catch (_err) {
    /* ignore */
  }

  // Second: use active conversation (longer TTL for stamping)
  const { getActiveConversationId, createConversation } = require('./conversations');
  const activeId = getActiveConversationId(hub, 24 * 60 * 60 * 1000); // 24h TTL
  if (activeId) return activeId;

  // Third: create a System conversation (always-warm guarantee)
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

function recordAgentError(hub, slug, exitCode, stderrTail, conversationId) {
  const errorMsg = `Agent \`${slug}\` failed with exit code ${exitCode}.\n\nStderr:\n\`\`\`\n${stderrTail}\n\`\`\``;

  if (conversationId) {
    const inboxDir = path.join(hub, 'user', 'inbox');
    writeFileUnique(inboxDir, `${new Date().toISOString().slice(0, 10)}-cp-agent-error`, [
      '---',
      'from: hub',
      'to: user',
      `date: ${new Date().toISOString().slice(0, 10)}`,
      'subject: agent error',
      `conversation_id: ${conversationId}`,
      '---',
      '',
      errorMsg,
    ].join('\n'));
  } else {
    const journalDir = path.join(appDir(hub), 'incidents');
    fs.mkdirSync(journalDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const journalFile = path.join(journalDir, `${dateStr}.md`);
    const incident = `\n## [Incident] ${slug} exit code ${exitCode}\n${stderrTail.slice(0, 200)}\n`;
    try {
      fs.appendFileSync(journalFile, incident);
    } catch (_err) {
      fs.writeFileSync(journalFile, `# Incidents\n${incident}`);
    }
  }
}

function readStderrTail(stderrFile, maxBytes = 500) {
  try {
    if (!fs.existsSync(stderrFile)) return '';
    const stat = fs.statSync(stderrFile);
    const size = stat.size;
    if (size === 0) return '';
    const buffer = Buffer.alloc(Math.min(maxBytes, size));
    const fd = fs.openSync(stderrFile, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - maxBytes));
    fs.closeSync(fd);
    return buffer.toString('utf8').trim();
  } catch (_err) {
    return '';
  }
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

function dispatchRetrySecs(config) {
  return Math.max(1, Math.min(60, Number(config.lockLeaseSecs || 60)));
}

function activeDispatchMarker(item, fingerprint, now, retrySecs) {
  const dispatchedAt = Number(item.dispatchedAt || 0);
  return sameFingerprint(item, fingerprint) && dispatchedAt > 0 && now - dispatchedAt < retrySecs;
}

function pendingUndispatchedMail(hub, slug, retrySecs = 0) {
  const handled = readDispatchState(hub, slug);
  const now = Math.floor(Date.now() / 1000);
  return pendingMail(hub, slug).filter((file) => {
    const fingerprint = dispatchFingerprint(file);
    return !handled.some((item) => activeDispatchMarker(item, fingerprint, now, retrySecs));
  });
}

function markMailDispatched(hub, slug, files, retrySecs = 0) {
  const target = dispatchStateFile(hub, slug);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const handled = readDispatchState(hub, slug);
  const now = Math.floor(Date.now() / 1000);
  const mailDir = path.dirname(files[0] || '');
  const next = handled.filter((item) => (
    fs.existsSync(path.join(mailDir, item.file)) && Number(item.dispatchedAt || 0) > now - retrySecs
  ));
  for (const file of files) {
    const fingerprint = dispatchFingerprint(file);
    if (!next.some((item) => sameFingerprint(item, fingerprint))) next.push({ ...fingerprint, dispatchedAt: now });
  }
  fs.writeFileSync(target, JSON.stringify({ handled: next.slice(-200) }, null, 2));
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
    const age = lockAgeSecs(lock);
    if (pidAlive(pid) && age < leaseSecs) return false;
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

function isAgentActive(hub, slug, leaseSecs) {
  const lock = lockDir(hub, slug);
  if (!fs.existsSync(lock)) return false;
  let pid = '';
  try {
    pid = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
  } catch (_err) {
    pid = '';
  }
  return pidAlive(pid) && lockAgeSecs(lock) < leaseSecs;
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
    'exit "$code"',
  ].join('\n');

  const child = spawn('bash', ['-c', script, '_', hub, slug, cliSettings.cli, cliSettings.promptFlag, cliSettings.extraArgs, promptFile, agentLog, agentStderr], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      const stderrTail = readStderrTail(agentStderr);
      recordAgentError(hub, slug, code, stderrTail, null);
    }
  });

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
    try { buildHubTurnPrompt(hub); } catch (_err) { /* optional in dry-run */ }
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
        // Daemon owns CLI lifecycle; drop CP lock when turn finishes.
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

  // Build turn prompt first (creates reserved body file when conversation_id present).
  const promptFile = buildHubTurnPrompt(hub);
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
    cliSettings = getCliSettings(hub, cliJson, config, hubCliName || '', hubModel || '');
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
    model: hubModel || 'default',
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
    'exit "$code"',
  ].join('\n');

  const child = spawn('bash', [
    '-c', script, '_', hub, cliSettings.cli, cliSettings.promptFlag, cliSettings.extraArgs,
    promptFile, agentLog, agentStderr, runtimeCwd, safetyModule, turnJsonBase,
  ], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      const stderrTail = readStderrTail(agentStderr);
      recordAgentError(hub, 'hub', code, stderrTail, conversationId);
    }
    // Backup if shell EXIT hook did not clear the pending turn (tick also drains).
    let action = '';
    if (conversationId) {
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
  // Phase 2 tiers: hub and product agents use separate slot pools.
  const hubSlots = Math.max(1, Number(config.hubSlots || 1));
  const agentSlots = Math.max(1, Number(config.agentSlots || config.maxConcurrency || 8));
  let hubRunning = liveHubCount(config.hub, config.lockLeaseSecs);
  let agentRunning = liveAgentCount(config.hub, config.lockLeaseSecs);
  let launched = 0;
  let skippedLocked = 0;
  let skippedCap = 0;
  const retrySecs = dispatchRetrySecs(config);

  const hubNew = pendingUndispatchedMail(config.hub, 'hub', retrySecs);
  if (hubNew.length > 0) {
    if (hubRunning >= hubSlots) {
      skippedCap += 1;
    } else if (tryLock(config.hub, 'hub', config.lockLeaseSecs)) {
      markMailDispatched(config.hub, 'hub', hubNew, retrySecs);
      launchHub(config);
      launched += 1;
      hubRunning += 1;
    } else {
      skippedLocked += 1;
    }
  }

  for (const agent of agents) {
    const pending = pendingMail(config.hub, agent.slug);
    if (pending.length === 0) continue;
    const fresh = pendingUndispatchedMail(config.hub, agent.slug, retrySecs);
    if (fresh.length === 0) {
      continue;
    }
    if (agentRunning >= agentSlots) {
      skippedCap += 1;
      continue;
    }
    if (tryLock(config.hub, agent.slug, config.lockLeaseSecs)) {
      markMailDispatched(config.hub, agent.slug, fresh, retrySecs);
      launchAgent(config, agent.slug, agent.model || config.agentDefaultModel || '', agent.cliName || '');
      launched += 1;
      agentRunning += 1;
    } else {
      skippedLocked += 1;
    }
  }

  return {
    launched,
    skippedLocked,
    skippedCap,
    running: hubRunning + agentRunning,
    hubRunning,
    agentRunning,
    hubSlots,
    agentSlots,
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
  ensureDispatchPrompt,
  getHubConversationId,
  getRecentHubInboxMessage,
  hubDaemonSock,
  isAgentActive,
  launchAgent,
  launchHub,
  launchHubCold,
  liveAgentCount,
  liveHubCount,
  liveRunCount,
  markMailDispatched,
  pendingUndispatchedMail,
  preferWarmDaemon,
  promptFileFor,
  readStderrTail,
  recordAgentError,
  requestWarmHubTurn,
  tryLock,
};
