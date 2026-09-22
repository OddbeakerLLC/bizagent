'use strict';

/**
 * In-turn standby helpers (not product agents).
 *
 * Product/hub agents call hire_helper; this module checks the registry pool,
 * spawns a short read-only bizagent-agent, and returns one string.
 * Pool slots live on disk so concurrent parent processes share one cap.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_ALLOW = ['research', 'search', 'summarize', 'test-extract'];
const DEFAULT_POOL_SIZE = 10;
const DEFAULT_WALL_SECS = 120;
const DEFAULT_PER_AGENT = 1;
const MAX_RESULT_CHARS = 80000;
const LOCK_WAIT_MS = 3000;

function resolveHubRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.BIZAGENT_HUB) return path.resolve(process.env.BIZAGENT_HUB);
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, 'registry.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function productCount(registry) {
  const products = (registry && Array.isArray(registry.products)) ? registry.products : [];
  return products.filter((p) => p && String(p.slug || '').trim()).length;
}

/**
 * Floor is pool_size (default 10). If product count is higher, match it.
 */
function effectivePoolSize(poolSize, nProducts) {
  const floor = Math.max(1, Math.min(64, Number(poolSize) || DEFAULT_POOL_SIZE));
  const n = Math.max(0, Number(nProducts) || 0);
  return Math.max(floor, n);
}

function loadHelpersConfig(hubRoot) {
  const hub = resolveHubRoot(hubRoot);
  const file = path.join(hub, 'registry.json');
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return {
      hub,
      enabled: false,
      pool_size: DEFAULT_POOL_SIZE,
      effective_pool: DEFAULT_POOL_SIZE,
      provider: 'venice',
      model: 'qwen3-5-9b',
      max_concurrent_per_agent: DEFAULT_PER_AGENT,
      max_wall_secs: DEFAULT_WALL_SECS,
      max_depth: 1,
      allow: DEFAULT_ALLOW.slice(),
      product_count: 0,
      found: false,
    };
  }
  const raw = (registry.settings && registry.settings.helpers) || {};
  const nProducts = productCount(registry);
  const poolSize = raw.pool_size == null ? DEFAULT_POOL_SIZE : raw.pool_size;
  const allow = Array.isArray(raw.allow) && raw.allow.length
    ? raw.allow.map((k) => String(k).trim()).filter(Boolean)
    : DEFAULT_ALLOW.slice();
  return {
    hub,
    enabled: raw.enabled === true,
    pool_size: poolSize,
    effective_pool: effectivePoolSize(poolSize, nProducts),
    provider: String(raw.provider || 'venice').trim() || 'venice',
    model: String(raw.model || 'qwen3-5-9b').trim() || 'qwen3-5-9b',
    max_concurrent_per_agent: Math.max(
      1,
      Math.min(8, Number(raw.max_concurrent_per_agent) || DEFAULT_PER_AGENT),
    ),
    max_wall_secs: Math.max(
      15,
      Math.min(600, Number(raw.max_wall_secs) || DEFAULT_WALL_SECS),
    ),
    max_depth: Math.max(1, Math.min(1, Number(raw.max_depth) || 1)),
    allow,
    product_count: nProducts,
    found: true,
  };
}

function slotsDir(hub) {
  return path.join(hub, '.bizagent', 'helper-slots');
}

function poolLockDir(hub) {
  return path.join(hub, '.bizagent', 'helper-pool.lock');
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!n || !Number.isFinite(n)) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait; lock hold is milliseconds */
  }
}

function reapSlots(hub) {
  const dir = slotsDir(hub);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_err) {
    return [];
  }
  const live = [];
  for (const name of names) {
    const slotPath = path.join(dir, name);
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(slotPath, 'meta.json'), 'utf8'));
    } catch (_err) {
      try { fs.rmSync(slotPath, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
      continue;
    }
    if (meta.pid && pidAlive(meta.pid)) {
      live.push({ id: name, path: slotPath, ...meta });
      continue;
    }
    try { fs.rmSync(slotPath, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
  return live;
}

function withPoolLock(hub, fn) {
  const lock = poolLockDir(hub);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      let holder = '';
      try {
        holder = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
      } catch (_e) {
        holder = '';
      }
      if (holder && !pidAlive(holder)) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_e) { /* retry */ }
      } else if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error('helper pool lock timeout');
      } else {
        sleepMs(15);
      }
    }
  }
  try {
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    return fn();
  } finally {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
}

function acquireSlot(hub, { parentSlug, kind, pool, perAgent }) {
  return withPoolLock(hub, () => {
    fs.mkdirSync(slotsDir(hub), { recursive: true });
    const live = reapSlots(hub);
    if (live.length >= pool) {
      return {
        ok: false,
        error: `helper pool full (${live.length}/${pool}); do the work yourself`,
        live: live.length,
        pool,
      };
    }
    const mine = live.filter((s) => s.parent === parentSlug).length;
    if (mine >= perAgent) {
      return {
        ok: false,
        error: `this agent already has ${mine} helper(s) (max ${perAgent}); do the work yourself`,
        live: live.length,
        pool,
      };
    }
    const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    const slotPath = path.join(slotsDir(hub), id);
    fs.mkdirSync(slotPath);
    const meta = {
      id,
      parent: parentSlug,
      kind: kind || '',
      pid: process.pid,
      started: Math.floor(Date.now() / 1000),
    };
    fs.writeFileSync(path.join(slotPath, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return { ok: true, id, path: slotPath, live: live.length + 1, pool };
  });
}

function releaseSlot(hub, slotId) {
  if (!slotId) return;
  const slotPath = path.join(slotsDir(hub), slotId);
  try { fs.rmSync(slotPath, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

function logHelper(hub, event) {
  try {
    const dir = path.join(hub, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'structured.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
    );
  } catch (_err) {
    /* ignore */
  }
}

function helperCli(hub) {
  return process.env.BIZAGENT_HELPER_CLI || path.join(hub, 'scripts', 'bizagent-agent');
}

function providerBaseUrl(hub, provider) {
  try {
    const cli = JSON.parse(fs.readFileSync(path.join(hub, 'cli.json'), 'utf8'));
    const def = cli && cli[provider];
    return (def && (def.baseURL || def.baseUrl)) || '';
  } catch (_err) {
    return '';
  }
}

function buildHelperPrompt({ kind, justification, prompt, doneWhen, parentSlug }) {
  return [
    '# Helper task (in-turn, read-only)',
    '',
    `You are an unnamed standby helper hired by **${parentSlug}**. You are not a product agent.`,
    'Return one markdown/text answer. Do not write files, send mail, or hire anyone.',
    '',
    `- Kind: ${kind}`,
    `- Justification: ${justification}`,
    `- Done when: ${doneWhen}`,
    '',
    '## Task',
    '',
    String(prompt || '').trim(),
    '',
    'When finished, stop calling tools and print the answer only.',
  ].join('\n');
}

function killProcessGroup(child) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_e) { /* ignore */ }
  try { child.kill('SIGKILL'); } catch (_e) { /* ignore */ }
}

function spawnHelperProcess({
  hub,
  kind,
  justification,
  prompt,
  doneWhen,
  parentSlug,
  provider,
  model,
  wallMs,
}) {
  const turnsDir = path.join(hub, '.bizagent', 'prompts', 'turns');
  fs.mkdirSync(turnsDir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const promptFile = path.join(turnsDir, `helper-${parentSlug}-${id}.md`);
  const resultFile = path.join(turnsDir, `helper-${parentSlug}-${id}.result.txt`);
  fs.writeFileSync(
    promptFile,
    buildHelperPrompt({ kind, justification, prompt, doneWhen, parentSlug }),
    'utf8',
  );

  const cli = helperCli(hub);
  const args = [
    '-f', promptFile,
    '-y',
    '--helper',
    '--provider', provider,
    '--model', model,
  ];
  const baseURL = providerBaseUrl(hub, provider);
  if (baseURL) args.push('--base-url', baseURL);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.unlinkSync(promptFile); } catch (_e) { /* ignore */ }
      let resultText = '';
      try {
        resultText = fs.readFileSync(resultFile, 'utf8');
      } catch (_e) {
        resultText = '';
      }
      try { fs.unlinkSync(resultFile); } catch (_e) { /* ignore */ }
      const text = String(resultText || stdout || '').trim();
      resolve({ ...payload, text, stdout, stderr });
    };

    let child;
    try {
      child = spawn(cli, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BIZAGENT_HUB: hub,
          BIZAGENT_HELPER: '1',
          BIZAGENT_HELPER_PARENT: parentSlug,
          BIZAGENT_HELPER_KIND: kind || '',
          BIZAGENT_HELPER_RESULT: resultFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      finish({
        ok: false,
        error: `failed to spawn helper: ${err.message || err}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      killProcessGroup(child);
      finish({
        ok: false,
        error: `helper timed out after ${Math.round(wallMs / 1000)}s; do the work yourself`,
        timed_out: true,
      });
    }, wallMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_RESULT_CHARS * 2) {
        stdout = stdout.slice(-MAX_RESULT_CHARS);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (err) => {
      finish({
        ok: false,
        error: `helper spawn error: ${err.message || err}`,
      });
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        finish({ ok: true, exit_code: 0 });
        return;
      }
      const errBit = (stderr || '').trim().split('\n').slice(-8).join('\n');
      finish({
        ok: false,
        exit_code: code,
        signal: signal || '',
        error: `helper exited ${code}${signal ? `/${signal}` : ''}${errBit ? `: ${errBit.slice(0, 500)}` : ''}`,
      });
    });
  });
}

function parentSlugFromEnv() {
  return String(
    process.env.BIZAGENT_AGENT_SLUG
      || process.env.BIZAGENT_HELPER_PARENT
      || 'unknown',
  ).trim() || 'unknown';
}

function isHelperProcess() {
  return process.env.BIZAGENT_HELPER === '1';
}

async function hireHelper(args = {}, hubRoot) {
  const kind = String((args && args.kind) || '').trim();
  const justification = String((args && args.justification) || '').trim();
  const prompt = String((args && args.prompt) || '').trim();
  const doneWhen = String((args && (args.done_when || args.doneWhen)) || '').trim();

  if (isHelperProcess()) {
    return {
      success: false,
      error: 'helpers cannot hire helpers (max_depth=1); do the work yourself',
    };
  }
  if (!kind) {
    return { success: false, error: 'kind is required (research|search|summarize|test-extract)' };
  }
  if (!justification || justification.length < 8) {
    return { success: false, error: 'justification must be one sentence (why this hire)' };
  }
  if (!prompt) {
    return { success: false, error: 'prompt is required' };
  }
  if (!doneWhen) {
    return { success: false, error: 'done_when is required' };
  }

  const cfg = loadHelpersConfig(hubRoot);
  if (!cfg.enabled) {
    return {
      success: false,
      error: 'helpers are disabled in registry settings.helpers.enabled; do the work yourself',
    };
  }
  if (!cfg.allow.includes(kind)) {
    return {
      success: false,
      error: `kind "${kind}" is not allowed; allowed: ${cfg.allow.join(', ')}`,
    };
  }

  const parentSlug = parentSlugFromEnv();
  let slot;
  try {
    slot = acquireSlot(cfg.hub, {
      parentSlug,
      kind,
      pool: cfg.effective_pool,
      perAgent: cfg.max_concurrent_per_agent,
    });
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
  if (!slot.ok) {
    return { success: false, error: slot.error, pool: slot.pool, live: slot.live };
  }

  logHelper(cfg.hub, {
    event: 'helper_hire',
    parent: parentSlug,
    kind,
    slot: slot.id,
    pool: slot.pool,
    live: slot.live,
    provider: cfg.provider,
    model: cfg.model,
  });

  try {
    const result = await spawnHelperProcess({
      hub: cfg.hub,
      kind,
      justification,
      prompt,
      doneWhen,
      parentSlug,
      provider: cfg.provider,
      model: cfg.model,
      wallMs: cfg.max_wall_secs * 1000,
    });
    const text = String(result.text || '').slice(0, MAX_RESULT_CHARS);
    if (!result.ok) {
      logHelper(cfg.hub, {
        event: 'helper_fail',
        parent: parentSlug,
        kind,
        slot: slot.id,
        error: result.error || 'failed',
      });
      return {
        success: false,
        error: result.error || 'helper failed',
        timed_out: !!result.timed_out,
        text: text || undefined,
      };
    }
    logHelper(cfg.hub, {
      event: 'helper_done',
      parent: parentSlug,
      kind,
      slot: slot.id,
      chars: text.length,
    });
    return {
      success: true,
      kind,
      parent: parentSlug,
      text: text || '(helper produced no text)',
    };
  } finally {
    releaseSlot(cfg.hub, slot.id);
  }
}

module.exports = {
  DEFAULT_ALLOW,
  DEFAULT_POOL_SIZE,
  acquireSlot,
  effectivePoolSize,
  hireHelper,
  isHelperProcess,
  loadHelpersConfig,
  parentSlugFromEnv,
  productCount,
  releaseSlot,
  resolveHubRoot,
};
