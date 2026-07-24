const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { agentsFromRegistry, appDir } = require('./config');
const { compileAgentCommand, getCliSettings } = require('./cli-config');
const {
  buildAgentTurnPrompt,
  buildHubTurnPrompt,
  ensureHubRuntimeCwd,
  ensureHubRuntimePrompt,
} = require('./hub-memory');
const { pendingMail } = require('./mail');
const { appendLog } = require('./log');
const { postLaunchAck, writeFileUnique } = require('./conversations');
const {
  drainPendingHubTurns,
  onHubCliExit,
  prepareReservedReplyBody,
  readPendingHubTurns,
  recordPendingHubTurn,
  reservedReplyBodyPath,
} = require('./hub-turn-safety');

function nowIso() {
  return new Date().toISOString();
}

/**
 * Newest hub-inbox conversation_id (console turns). Scans all pending .md,
 * newest filename first. Product-agent mail never carries conversation_id.
 */
function getRecentHubInboxMessage(hub) {
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
    return null;
  } catch (_err) {
    return null;
  }
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
  if (fs.existsSync(target)) return target;
  const template = path.join(hub, 'templates', 'dispatch.md.template');
  if (!fs.existsSync(template)) throw new Error(`missing dispatch prompt template: ${template}`);
  const agentDir = path.join(hub, 'agents', slug);
  const text = fs.readFileSync(template, 'utf8')
    .replace(/\{\{slug\}\}/g, slug)
    .replace(/\{\{agent_md\}\}/g, `agents/${slug}/agent.md`)
    .replace(/\{\{inbox\}\}/g, `agents/${slug}/inbox`)
    .replace(/\{\{outbox\}\}/g, `agents/${slug}/outbox`);
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
  if (!/^[A-Za-z0-9._:-]+$/.test(modelOverride)) {
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
  appendLog(hub, `dispatch_start slug=${slug} t=${nowIso()}`);

  if (dryRun) {
    fs.rmSync(lock, { recursive: true, force: true });
    appendLog(hub, `DRY_RUN launch ${slug} using agent turn prompt + pending mail inject`);
    return;
  }

  const promptFile = buildAgentTurnPrompt(hub, slug);
  fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
  const cliSettings = getCliSettings(hub, cliJson, config, cliName, model);
  const cmdPreview = compileAgentCommand(cliSettings, promptFile);
  appendLog(hub, `cli_spawn slug=${slug} t=${nowIso()} turn=${path.basename(promptFile)} cmd=${cmdPreview}`);

  // Timing + exit log live in the shell wrapper: detached+unref children do not
  // reliably deliver Node 'exit' events to a long-running control plane.
  // Delete ephemeral turn prompt on exit (same pattern as hub).
  const script = [
    'HUB="$1"; slug="$2"; cli="$3"; pflag="$4"; extra="$5"; pfile="$6"; agentlog="$7"; stderrlog="$8"',
    'lockdir="$HUB/agents/$slug/.lock"',
    'cplog="$HUB/logs/control-plane.log"',
    'printf "%s\\n" "$$" > "$lockdir/pid" 2>/dev/null',
    'date +%s > "$lockdir/start" 2>/dev/null',
    'trap \'rm -rf "$lockdir"; rm -f "$pfile"\' EXIT',
    'cd "$HUB" || exit 1',
    'start_ms=$(date +%s%3N 2>/dev/null || python3 -c "import time;print(int(time.time()*1000))")',
    'set +e',
    '"$cli" $pflag "$pfile" $extra >> "$agentlog" 2>> "$stderrlog"',
    'code=$?',
    'end_ms=$(date +%s%3N 2>/dev/null || python3 -c "import time;print(int(time.time()*1000))")',
    'dur=$((end_ms - start_ms))',
    'ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)',
    'printf "%s control-plane: cli_exit slug=%s code=%s duration_ms=%s t=%s\\n" "$ts" "$slug" "$code" "$dur" "$ts" >> "$cplog"',
    'exit "$code"',
  ].join('\n');

  const child = spawn('bash', ['-c', script, '_', hub, slug, cliSettings.cli, cliSettings.promptFlag, cliSettings.extraArgs, promptFile, agentLog, agentStderr], {
    detached: true,
    stdio: 'ignore',
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      const stderrTail = readStderrTail(agentStderr);
      recordAgentError(hub, slug, code, stderrTail, null);
    }
  });

  child.unref();
  appendLog(hub, `launched ${slug} using turn prompt ${path.basename(promptFile)}`);
}

function launchHub(config) {
  const { hub, dryRun, hubModel, hubCliName, _cliJson } = config;
  const cliJson = _cliJson || {};
  const lock = lockDir(hub, 'hub');
  const agentLog = path.join(hub, 'logs', 'dispatch-hub.log');
  const agentStderr = path.join(hub, 'logs', 'dispatch-hub.stderr');
  appendLog(hub, `dispatch_start slug=hub t=${nowIso()}`);

  // Always refresh base hub.md for tools that still open it; launch uses turn file.
  ensureHubRuntimePrompt(hub);
  const runtimeCwd = ensureHubRuntimeCwd(hub);

  // Console turn id (if any) — used for launch ack + reserved reply + outbox safety net.
  const conversationId = getRecentHubInboxMessage(hub);
  const startedAt = nowIso();
  const logOffset = logByteOffset(agentLog);
  const stderrOffset = logByteOffset(agentStderr);

  if (conversationId) {
    // CP-owned first byte: deterministic status line before CLI boot.
    // One ack per spawn (postLaunchAck is idempotent if ack still visible).
    try {
      postLaunchAck(hub, conversationId);
      appendLog(hub, `launch_ack conversation_id=${conversationId} t=${startedAt}`);
    } catch (err) {
      appendLog(hub, `WARN launch_ack failed: ${err.message}`);
    }
  }

  if (dryRun) {
    fs.rmSync(lock, { recursive: true, force: true });
    appendLog(hub, 'DRY_RUN launch hub using turn prompt + runtime-cwd');
    // No CLI → no safety-net pending (would false-fail with empty log).
    // Still build turn prompt so reserved path + delivery instructions are exercised.
    try { buildHubTurnPrompt(hub); } catch (_err) { /* optional in dry-run */ }
    return;
  }

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
  // Prefer settings.hub_agent.cliName (via config.hubCliName); empty falls back to .cli / default.
  const cliSettings = getCliSettings(hub, cliJson, config, hubCliName || '', hubModel || '');
  const cmdPreview = compileAgentCommand(cliSettings, promptFile);
  appendLog(hub, `cli_spawn slug=hub t=${nowIso()} cwd=${path.relative(hub, runtimeCwd) || runtimeCwd} turn=${path.basename(promptFile)} cmd=${cmdPreview}`);

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
    'mkdir -p "$HUB/.bizagent" "$HUB/logs"',
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
    'start_ms=$(date +%s%3N 2>/dev/null || python3 -c "import time;print(int(time.time()*1000))")',
    'set +e',
    '"$cli" $pflag "$pfile" $extra >> "$agentlog" 2>> "$stderrlog"',
    'code=$?',
    'end_ms=$(date +%s%3N 2>/dev/null || python3 -c "import time;print(int(time.time()*1000))")',
    'dur=$((end_ms - start_ms))',
    'ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)',
    'printf "%s control-plane: cli_exit slug=hub code=%s duration_ms=%s t=%s\\n" "$ts" "$code" "$dur" "$ts" >> "$cplog"',
    'exit "$code"',
  ].join('\n');

  const child = spawn('bash', [
    '-c', script, '_', hub, cliSettings.cli, cliSettings.promptFlag, cliSettings.extraArgs,
    promptFile, agentLog, agentStderr, runtimeCwd, safetyModule, turnJsonBase,
  ], {
    detached: true,
    stdio: 'ignore',
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      const stderrTail = readStderrTail(agentStderr);
      recordAgentError(hub, 'hub', code, stderrTail, conversationId);
    }
    // Backup if shell EXIT hook did not clear the pending turn (tick also drains).
    if (conversationId) {
      const stillPending = readPendingHubTurns(hub).some(
        (t) => t.conversationId === conversationId && t.startedAt === startedAt,
      );
      if (stillPending) {
        try {
          onHubCliExit(hub, {
            conversationId,
            logByteOffset: logOffset,
            stderrByteOffset: stderrOffset,
            startedAt,
            agentLog,
            agentStderr,
            replyBodyFile,
            exitCode: code,
          });
        } catch (_err) {
          /* tick drain will retry */
        }
      }
    }
  });

  child.unref();
  appendLog(hub, `launched hub using turn prompt ${path.basename(promptFile)} cwd=${path.basename(runtimeCwd)}`);
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
  getRecentHubInboxMessage,
  isAgentActive,
  launchAgent,
  launchHub,
  liveAgentCount,
  liveHubCount,
  liveRunCount,
  markMailDispatched,
  pendingUndispatchedMail,
  promptFileFor,
  readStderrTail,
  recordAgentError,
  tryLock,
};
