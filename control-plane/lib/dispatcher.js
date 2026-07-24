const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { agentsFromRegistry, appDir } = require('./config');
const { compileAgentCommand, getCliSettings } = require('./cli-config');
const {
  buildHubTurnPrompt,
  ensureHubRuntimeCwd,
  ensureHubRuntimePrompt,
} = require('./hub-memory');
const { pendingMail } = require('./mail');
const { appendLog } = require('./log');
const { writeFileUnique } = require('./conversations');

function nowIso() {
  return new Date().toISOString();
}

function getRecentHubInboxMessage(hub) {
  const inboxDir = path.join(hub, 'inbox');
  try {
    const files = fs.readdirSync(inboxDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const file = path.join(inboxDir, files[0]);
    const content = fs.readFileSync(file, 'utf8');
    const match = content.match(/^conversation_id:\s*(.+?)$/m);
    return match ? match[1].trim() : null;
  } catch (_err) {
    return null;
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

function liveRunCount(hub, leaseSecs) {
  const agentsDir = path.join(hub, 'agents');
  let count = 0;
  if (isAgentActive(hub, 'hub', leaseSecs)) count += 1;
  if (!fs.existsSync(agentsDir)) return count;
  for (const slug of fs.readdirSync(agentsDir)) {
    const lock = lockDir(hub, slug);
    if (!fs.existsSync(lock)) continue;
    let pid = '';
    try {
      pid = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
    } catch (_err) {
      pid = '';
    }
    if (pidAlive(pid) && lockAgeSecs(lock) < leaseSecs) count += 1;
  }
  return count;
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
  const promptFile = ensureDispatchPrompt(hub, slug);
  appendLog(hub, `dispatch_start slug=${slug} t=${nowIso()}`);

  if (dryRun) {
    fs.rmSync(lock, { recursive: true, force: true });
    appendLog(hub, `DRY_RUN launch ${slug} using agents/${slug}/.dispatch.md`);
    return;
  }

  fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
  const cliSettings = getCliSettings(hub, cliJson, config, cliName, model);
  const cmdPreview = compileAgentCommand(cliSettings, promptFile);
  appendLog(hub, `cli_spawn slug=${slug} t=${nowIso()} cmd=${cmdPreview}`);

  // Timing + exit log live in the shell wrapper: detached+unref children do not
  // reliably deliver Node 'exit' events to a long-running control plane.
  const script = [
    'HUB="$1"; slug="$2"; cli="$3"; pflag="$4"; extra="$5"; pfile="$6"; agentlog="$7"; stderrlog="$8"',
    'lockdir="$HUB/agents/$slug/.lock"',
    'cplog="$HUB/logs/control-plane.log"',
    'printf "%s\\n" "$$" > "$lockdir/pid" 2>/dev/null',
    'date +%s > "$lockdir/start" 2>/dev/null',
    'trap "rm -rf \\"$lockdir\\"" EXIT',
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
  appendLog(hub, `launched ${slug} using agents/${slug}/.dispatch.md`);
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

  if (dryRun) {
    fs.rmSync(lock, { recursive: true, force: true });
    appendLog(hub, 'DRY_RUN launch hub using turn prompt + runtime-cwd');
    return;
  }

  const promptFile = buildHubTurnPrompt(hub);
  fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
  // Prefer settings.hub_agent.cliName (via config.hubCliName); empty falls back to .cli / default.
  const cliSettings = getCliSettings(hub, cliJson, config, hubCliName || '', hubModel || '');
  const cmdPreview = compileAgentCommand(cliSettings, promptFile);
  appendLog(hub, `cli_spawn slug=hub t=${nowIso()} cwd=${path.relative(hub, runtimeCwd) || runtimeCwd} turn=${path.basename(promptFile)} cmd=${cmdPreview}`);

  const script = [
    'HUB="$1"; cli="$2"; pflag="$3"; extra="$4"; pfile="$5"; agentlog="$6"; stderrlog="$7"; cwd="$8"',
    'lockdir="$HUB/.bizagent/hub.lock"',
    'cplog="$HUB/logs/control-plane.log"',
    'mkdir -p "$HUB/.bizagent" "$HUB/logs"',
    'printf "%s\\n" "$$" > "$lockdir/pid" 2>/dev/null',
    'date +%s > "$lockdir/start" 2>/dev/null',
    'trap \'rm -rf "$lockdir"; rm -f "$pfile"\' EXIT',
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

  const conversationId = getRecentHubInboxMessage(hub);
  const child = spawn('bash', [
    '-c', script, '_', hub, cliSettings.cli, cliSettings.promptFlag, cliSettings.extraArgs,
    promptFile, agentLog, agentStderr, runtimeCwd,
  ], {
    detached: true,
    stdio: 'ignore',
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      const stderrTail = readStderrTail(agentStderr);
      recordAgentError(hub, 'hub', code, stderrTail, conversationId);
    }
  });

  child.unref();
  appendLog(hub, `launched hub using turn prompt ${path.basename(promptFile)} cwd=${path.basename(runtimeCwd)}`);
}

function dispatchPendingAgents(config) {
  const agents = agentsFromRegistry(config.registry);
  let running = liveRunCount(config.hub, config.lockLeaseSecs);
  let launched = 0;
  let skippedLocked = 0;
  let skippedCap = 0;
  const retrySecs = dispatchRetrySecs(config);

  const hubNew = pendingUndispatchedMail(config.hub, 'hub', retrySecs);
  if (hubNew.length > 0) {
    if (running >= config.maxConcurrency) {
      skippedCap += 1;
    } else if (tryLock(config.hub, 'hub', config.lockLeaseSecs)) {
      markMailDispatched(config.hub, 'hub', hubNew, retrySecs);
      launchHub(config);
      launched += 1;
      running += 1;
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
    if (running >= config.maxConcurrency) {
      skippedCap += 1;
      continue;
    }
    if (tryLock(config.hub, agent.slug, config.lockLeaseSecs)) {
      markMailDispatched(config.hub, agent.slug, fresh, retrySecs);
      launchAgent(config, agent.slug, agent.model || config.agentDefaultModel || '', agent.cliName || '');
      launched += 1;
      running += 1;
    } else {
      skippedLocked += 1;
    }
  }

  return { launched, skippedLocked, skippedCap, running };
}

module.exports = {
  dispatchPendingAgents,
  dispatchFingerprint,
  dispatchRetrySecs,
  ensureDispatchPrompt,
  getRecentHubInboxMessage,
  isAgentActive,
  launchHub,
  liveRunCount,
  markMailDispatched,
  pendingUndispatchedMail,
  promptFileFor,
  readStderrTail,
  recordAgentError,
  tryLock,
};
