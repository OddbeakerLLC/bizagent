const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { agentsFromRegistry, appDir } = require('./config');
const { ensureHubRuntimePrompt } = require('./hub-memory');
const { pendingMail } = require('./mail');
const { appendLog } = require('./log');

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

function modelArgs(model) {
  return model ? `--model ${model}` : '';
}

function effectiveExtra(extraArgs, model) {
  const parts = [extraArgs, modelArgs(model)].filter(Boolean);
  return parts.join(' ');
}

function launchAgent(config, slug, model = '') {
  const { hub, cli, promptFlag, extraArgs, dryRun } = config;
  const extra = effectiveExtra(extraArgs, model);
  const lock = lockDir(hub, slug);
  const agentLog = path.join(hub, 'logs', `dispatch-${slug}.log`);
  const promptFile = ensureDispatchPrompt(hub, slug);

  if (dryRun) {
    fs.rmSync(lock, { recursive: true, force: true });
    appendLog(hub, `DRY_RUN launch ${slug} using agents/${slug}/.dispatch.md`);
    return;
  }

  fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
  const script = [
    'HUB="$1"; slug="$2"; cli="$3"; pflag="$4"; extra="$5"; pfile="$6"; agentlog="$7"',
    'lockdir="$HUB/agents/$slug/.lock"',
    'printf "%s\\n" "$$" > "$lockdir/pid" 2>/dev/null',
    'date +%s > "$lockdir/start" 2>/dev/null',
    'trap "rm -rf \\"$lockdir\\"" EXIT',
    'cd "$HUB" || exit 1',
    'prompt="$(cat "$pfile")"',
    '"$cli" $pflag $extra "$prompt" >> "$agentlog" 2>&1',
  ].join('\n');

  const child = spawn('bash', ['-c', script, '_', hub, slug, cli, promptFlag, extra, promptFile, agentLog], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  appendLog(hub, `launched ${slug} using agents/${slug}/.dispatch.md`);
}

function launchHub(config) {
  const { hub, cli, promptFlag, extraArgs, dryRun, hubModel } = config;
  const extra = effectiveExtra(extraArgs, hubModel || '');
  const lock = lockDir(hub, 'hub');
  const agentLog = path.join(hub, 'logs', 'dispatch-hub.log');
  const promptFile = ensureHubRuntimePrompt(hub);

  if (dryRun) {
    fs.rmSync(lock, { recursive: true, force: true });
    appendLog(hub, 'DRY_RUN launch hub using .bizagent/prompts/hub.md');
    return;
  }

  fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
  const script = [
    'HUB="$1"; cli="$2"; pflag="$3"; extra="$4"; pfile="$5"; agentlog="$6"',
    'lockdir="$HUB/.bizagent/hub.lock"',
    'mkdir -p "$HUB/.bizagent"',
    'printf "%s\\n" "$$" > "$lockdir/pid" 2>/dev/null',
    'date +%s > "$lockdir/start" 2>/dev/null',
    'trap "rm -rf \\"$lockdir\\"" EXIT',
    'cd "$HUB" || exit 1',
    'prompt="$(cat "$pfile")"',
    '"$cli" $pflag $extra "$prompt" >> "$agentlog" 2>&1',
  ].join('\n');

  const child = spawn('bash', ['-c', script, '_', hub, cli, promptFlag, extra, promptFile, agentLog], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  appendLog(hub, 'launched hub using .bizagent/prompts/hub.md');
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
      launchAgent(config, agent.slug, agent.model || config.agentDefaultModel || '');
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
  isAgentActive,
  launchHub,
  liveRunCount,
  markMailDispatched,
  pendingUndispatchedMail,
  promptFileFor,
  tryLock,
};
