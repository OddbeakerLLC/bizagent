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

function launchAgent(config, slug) {
  const { hub, cli, promptFlag, extraArgs, dryRun } = config;
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

  const child = spawn('bash', ['-c', script, '_', hub, slug, cli, promptFlag, extraArgs, promptFile, agentLog], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  appendLog(hub, `launched ${slug} using agents/${slug}/.dispatch.md`);
}

function launchHub(config) {
  const { hub, cli, promptFlag, extraArgs, dryRun } = config;
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

  const child = spawn('bash', ['-c', script, '_', hub, cli, promptFlag, extraArgs, promptFile, agentLog], {
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

  if (pendingMail(config.hub, 'hub').length > 0) {
    if (running >= config.maxConcurrency) {
      skippedCap += 1;
    } else if (tryLock(config.hub, 'hub', config.lockLeaseSecs)) {
      launchHub(config);
      launched += 1;
      running += 1;
    } else {
      skippedLocked += 1;
    }
  }

  for (const agent of agents) {
    const pending = pendingMail(config.hub, agent.slug).length;
    if (pending === 0) continue;
    if (running >= config.maxConcurrency) {
      skippedCap += 1;
      continue;
    }
    if (tryLock(config.hub, agent.slug, config.lockLeaseSecs)) {
      launchAgent(config, agent.slug);
      launched += 1;
      running += 1;
    } else {
      skippedLocked += 1;
    }
  }

  if (launched || skippedLocked || skippedCap) {
    appendLog(config.hub, `dispatch tick launched=${launched} skipped_locked=${skippedLocked} skipped_cap=${skippedCap}`);
  }
  return { launched, skippedLocked, skippedCap, running };
}

module.exports = {
  dispatchPendingAgents,
  ensureDispatchPrompt,
  isAgentActive,
  launchHub,
  liveRunCount,
  promptFileFor,
  tryLock,
};
