'use strict';

/**
 * Hub health watchdog — survival instinct.
 *
 * Two layers share this module:
 *   1. In-process: control-plane server ticks every ~45s (cheap, but dies with the CP).
 *   2. Out-of-process: scripts/health-probe.sh via systemd user timer / cron
 *      (works when the control plane cannot start; OnFailure= still fires).
 *
 * Both write logs/health.json (overwrite) + a single-line logs/health.status.
 * Levels: ok < warn < critical < emergency.
 *
 * Emergency auto-mitigation (no LLM): rotate/truncate logs, prune archives,
 * pause product-agent launches (safe mode), stop helpers. NEVER touches git,
 * registry.json, or company/. Never auto-deletes product artifacts (VCDs,
 * checkpoints) — warn only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const logCaps = require('./log-caps');
const safeMode = require('./safe-mode');

const MB = 1024 * 1024;
const GB = 1024 * MB;

const LEVELS = ['ok', 'warn', 'critical', 'emergency'];

const THRESHOLDS = {
  // Disk free on the hub volume: trip when EITHER the % or the absolute GB line is crossed.
  disk: { warnPct: 15, warnGb: 10, critPct: 10, critGb: 3, emergPct: 5, emergGb: 1 },
  inodes: { warn: 80, crit: 90, emerg: 95 }, // % used
  logs: { warn: 200 * MB, crit: 1 * GB, emergGrowthPerHour: 50 * MB },
  // Volume growth rate (used bytes / hour, from previous health sample).
  growth: { warnBytesPerHour: 2 * GB, critBytesPerHour: 5 * GB, emergBytesPerHour: 10 * GB },
  // Hours until the volume is full at the current growth rate.
  fill: { warnHours: 48, critHours: 12, emergHours: 3 },
  ram: { warnPct: 15, critPct: 8 }, // % MemAvailable
  fds: { warnPct: 70, critPct: 90 }, // % of fd limit
  load: { warnPerCpu: 2, critPerCpu: 4 },
  heartbeat: { warnMs: 60 * 1000, critMs: 3 * 60 * 1000, emergMs: 10 * 60 * 1000 },
  clockSkewMs: 90 * 1000,
};

function maxLevel(a, b) {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

function worst(levels) {
  return levels.reduce((acc, l) => (l ? maxLevel(acc, l) : acc), 'ok');
}

function fmtGb(bytes) {
  return `${(Number(bytes || 0) / GB).toFixed(2)}GB`;
}

/**
 * Pure evaluator: map a samples object to per-check levels + overall level.
 * Kept side-effect-free so tests can inject synthetic samples.
 *
 * Samples (all optional; missing → check skipped):
 *   disk: { freeBytes, totalBytes }
 *   inodes: { free, total }
 *   logsBytes, logsGrowthBytesPerHour
 *   growthBytesPerHour (volume used-bytes growth)
 *   ram: { availableBytes, totalBytes }, oomLastHour
 *   load1, cpus, openFds, fdLimit
 *   heartbeatAgeMs
 *   lockStale (hub.lock pid dead), cpPidDead (control-plane.pid dead)
 *   files: { registry, cli, env, auth } = 'ok' | 'corrupt' | 'unreadable' | 'missing'
 *   providerKeyPresent
 *   fsReadOnly, hubDirsWritable
 *   clockSkewMs
 *   providerFallbackActive
 */
function evaluateChecks(s) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });

  // --- Disk free on hub volume ---
  if (s.disk && s.disk.totalBytes > 0) {
    const freePct = (s.disk.freeBytes / s.disk.totalBytes) * 100;
    const freeGb = s.disk.freeBytes / GB;
    const t = THRESHOLDS.disk;
    let level = 'ok';
    if (freePct < t.emergPct || freeGb < t.emergGb) level = 'emergency';
    else if (freePct < t.critPct || freeGb < t.critGb) level = 'critical';
    else if (freePct < t.warnPct || freeGb < t.warnGb) level = 'warn';
    add('disk_free', level, `${freePct.toFixed(1)}% free (${fmtGb(s.disk.freeBytes)})`);
  }

  // --- Inodes ---
  if (s.inodes && s.inodes.total > 0) {
    const usedPct = ((s.inodes.total - s.inodes.free) / s.inodes.total) * 100;
    const t = THRESHOLDS.inodes;
    let level = 'ok';
    if (usedPct > t.emerg) level = 'emergency';
    else if (usedPct > t.crit) level = 'critical';
    else if (usedPct > t.warn) level = 'warn';
    add('inodes', level, `${usedPct.toFixed(1)}% used`);
  }

  // --- Hub logs/ size (+ growth) ---
  if (s.logsBytes != null) {
    const t = THRESHOLDS.logs;
    let level = 'ok';
    if (s.logsGrowthBytesPerHour != null && s.logsGrowthBytesPerHour > t.emergGrowthPerHour) {
      level = 'emergency';
    } else if (s.logsBytes > t.crit) level = 'critical';
    else if (s.logsBytes > t.warn) level = 'warn';
    const growth = s.logsGrowthBytesPerHour != null
      ? ` (+${Math.round(s.logsGrowthBytesPerHour / MB)}MB/h)` : '';
    add('logs_size', level, `${fmtGb(s.logsBytes)}${growth}`);
  }

  // --- Volume growth rate / time-to-full ---
  if (s.growthBytesPerHour != null && s.disk && s.disk.freeBytes != null) {
    const t = THRESHOLDS.growth;
    const tf = THRESHOLDS.fill;
    let level = 'ok';
    let detail = `${Math.round(s.growthBytesPerHour / MB)}MB/h`;
    if (s.growthBytesPerHour > 0) {
      const hoursToFull = s.disk.freeBytes / s.growthBytesPerHour;
      detail += `, full in ~${hoursToFull.toFixed(1)}h`;
      if (hoursToFull < tf.emergHours || s.growthBytesPerHour > t.emergBytesPerHour) level = 'emergency';
      else if (hoursToFull < tf.critHours || s.growthBytesPerHour > t.critBytesPerHour) level = 'critical';
      else if (hoursToFull < tf.warnHours || s.growthBytesPerHour > t.warnBytesPerHour) level = 'warn';
    }
    add('volume_growth', level, detail);
  }

  // --- RAM available ---
  if (s.ram && s.ram.totalBytes > 0) {
    const availPct = (s.ram.availableBytes / s.ram.totalBytes) * 100;
    const t = THRESHOLDS.ram;
    let level = 'ok';
    if (s.oomLastHour) level = 'emergency';
    else if (availPct < t.critPct) level = 'critical';
    else if (availPct < t.warnPct) level = 'warn';
    add('ram_available', level, `${availPct.toFixed(1)}% available${s.oomLastHour ? ' (OOM in last hour)' : ''}`);
  }

  // --- Load / FD count ---
  if (s.load1 != null && s.cpus > 0) {
    const perCpu = s.load1 / s.cpus;
    const t = THRESHOLDS.load;
    let level = 'ok';
    if (perCpu > t.critPerCpu) level = 'critical';
    else if (perCpu > t.warnPerCpu) level = 'warn';
    add('load', level, `load1=${s.load1.toFixed(2)} over ${s.cpus} cpus`);
  }
  if (s.openFds != null && s.fdLimit > 0) {
    const usedPct = (s.openFds / s.fdLimit) * 100;
    const t = THRESHOLDS.fds;
    let level = 'ok';
    if (s.openFds >= s.fdLimit) level = 'emergency'; // fork/EMFILE territory
    else if (usedPct > t.critPct) level = 'critical';
    else if (usedPct > t.warnPct) level = 'warn';
    add('fd_count', level, `${s.openFds}/${s.fdLimit} (${usedPct.toFixed(0)}%)`);
  }

  // --- Control-plane heartbeat ---
  if (s.heartbeatAgeMs != null) {
    const t = THRESHOLDS.heartbeat;
    let level = 'ok';
    if (s.heartbeatAgeMs > t.emergMs) level = 'emergency';
    else if (s.heartbeatAgeMs > t.critMs) level = 'critical';
    else if (s.heartbeatAgeMs > t.warnMs) level = 'warn';
    add('heartbeat', level, `control plane last seen ${Math.round(s.heartbeatAgeMs / 1000)}s ago`);
  }

  // --- Hub daemon / lock / pid ---
  if (s.lockStale || s.cpPidDead) {
    let level = 'warn';
    if (s.cpPidDead) level = 'critical';
    if (s.cpPidDead && s.heartbeatAgeMs != null && s.heartbeatAgeMs > THRESHOLDS.heartbeat.critMs) {
      level = 'emergency'; // cannot start
    }
    add('hub_daemon', level, [s.lockStale ? 'stale hub.lock' : '', s.cpPidDead ? 'control-plane pid dead' : '']
      .filter(Boolean).join('; '));
  }

  // --- Registry / env / auth readable + not corrupt ---
  if (s.files) {
    const bad = Object.entries(s.files).filter(([, v]) => v && v !== 'ok' && v !== 'missing');
    if (bad.length > 0) {
      add('config_files', 'critical', bad.map(([k, v]) => `${k}: ${v}`).join(', '));
    }
  }

  // --- Provider key present ---
  if (s.providerKeyPresent === false) {
    add('provider_key', 'critical', 'no API key for the configured provider');
  }

  // --- Filesystem writable ---
  if (s.fsReadOnly) add('fs_writable', 'emergency', 'filesystem remounted read-only');
  else if (s.hubDirsWritable === false) add('fs_writable', 'emergency', 'hub dirs not writable');

  // --- Clock skew (wall vs monotonic drift between probes) ---
  if (s.clockSkewMs != null && Math.abs(s.clockSkewMs) > THRESHOLDS.clockSkewMs) {
    add('clock_skew', 'warn', `wall clock jumped ~${Math.round(s.clockSkewMs / 1000)}s between probes`);
  }

  // --- Provider fallback flag (informational; banner surfaces it) ---
  if (s.providerFallbackActive) {
    add('provider_fallback', 'warn', 'paid provider refused; hub turns running on local Ollama');
  }

  const level = worst(checks.map((c) => c.level));
  return { level, checks, ts: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Samplers (real system data)
// ---------------------------------------------------------------------------

function readJson5(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return undefined;
  }
}

function heartbeatAgeMs(hub) {
  const file = path.join(hub, '.bizagent', 'control-plane.heartbeat');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return Math.max(0, Date.now() - ms);
    return Math.max(0, Date.now() - fs.statSync(file).mtimeMs);
  } catch (_err) {
    return null; // no heartbeat yet — do not alarm a fresh install
  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!n || !Number.isFinite(n)) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function lockStale(hub) {
  const pidFile = path.join(hub, '.bizagent', 'hub.lock', 'pid');
  try {
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    return !pidAlive(pid);
  } catch (_err) {
    return false;
  }
}

function cpPidDead(hub) {
  try {
    const pid = fs.readFileSync(path.join(hub, '.bizagent', 'control-plane.pid'), 'utf8').trim();
    return !!pid && !pidAlive(pid);
  } catch (_err) {
    return false;
  }
}

function memAvailable() {
  // Prefer MemAvailable (includes reclaimable cache) on Linux.
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = text.match(/^MemAvailable:\s+(\d+)\s kB/m);
    if (m) return { availableBytes: Number(m[1]) * 1024, totalBytes: os.totalmem() };
  } catch (_err) { /* non-Linux */ }
  return { availableBytes: os.freemem(), totalBytes: os.totalmem() };
}

function systemFdCount() {
  try {
    const nr = fs.readFileSync('/proc/sys/fs/file-nr', 'utf8').trim().split(/\s+/);
    const open = Number(nr[0]);
    const limit = Number(nr[2]);
    if (Number.isFinite(open) && Number.isFinite(limit) && limit > 0) return { openFds: open, fdLimit: limit };
  } catch (_err) { /* non-Linux */ }
  return null;
}

function fdLimitFromShell() {
  try {
    const out = execFileSync('bash', ['-c', 'ulimit -n'], { encoding: 'utf8' });
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : 0;
  } catch (_err) {
    return 0;
  }
}

/** Resolve the hub's configured provider (registry settings.hub_agent) → { name, def } via cli.json. */
function resolveHubProviderDef(hub) {
  const registry = readJson5(path.join(hub, 'registry.json'));
  if (!registry) return null;
  const settings = registry.settings || {};
  const hubAgent = settings.hub_agent || {};
  let name = String(hubAgent.provider || hubAgent.cliName || settings.provider || '').trim();
  if (!name) return null;
  try {
    const { resolveProviderName, providerEntries, loadCliJson } = require('./cli-config');
    const cliJson = loadCliJson(hub);
    name = resolveProviderName(name, cliJson);
    return { name, def: providerEntries(cliJson)[name] || null };
  } catch (_err) {
    return null;
  }
}

/** Map provider name (registry settings.hub_agent.provider) → its key env var. */
function providerKeyEnv(hub) {
  const resolved = resolveHubProviderDef(hub);
  return (resolved && resolved.def && resolved.def.keyEnv) || '';
}

/** Keyless providers (e.g. local Ollama) need no API key — health must not demand one. */
function providerKeyOptional(hub) {
  const resolved = resolveHubProviderDef(hub);
  if (!resolved || !resolved.def) return false;
  return resolved.def.optionalKey === true || resolved.name === 'ollama';
}

function providerKeyPresent(hub) {
  const keyEnv = providerKeyEnv(hub);
  if (!keyEnv) return null; // unknown provider → skip check
  if (providerKeyOptional(hub)) return null; // keyless provider (local Ollama) → skip check
  if (process.env[keyEnv] && String(process.env[keyEnv]).trim()) return true;
  try {
    const envText = fs.readFileSync(path.join(hub, '.bizagent', 'env'), 'utf8');
    const m = envText.match(new RegExp(`^${keyEnv}=(.+)$`, 'm'));
    return !!(m && m[1] && m[1].trim().replace(/^["']|["']$/g, ''));
  } catch (_err) {
    return false;
  }
}

function checkConfigFiles(hub) {
  const files = {};
  const jsonCheck = (rel, required) => {
    const p = path.join(hub, rel);
    if (!fs.existsSync(p)) return required ? 'missing' : 'missing';
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'));
      return 'ok';
    } catch (_err) {
      return 'corrupt';
    }
  };
  files.registry = jsonCheck('registry.json', true);
  try {
    files.cli = fs.existsSync(path.join(hub, 'cli.json')) ? jsonCheck('cli.json', false) : 'missing';
  } catch (_err) {
    files.cli = 'unreadable';
  }
  const envFile = path.join(hub, '.bizagent', 'env');
  if (!fs.existsSync(envFile)) files.env = 'missing';
  else {
    try {
      fs.accessSync(envFile, fs.constants.R_OK);
      files.env = 'ok';
    } catch (_err) {
      files.env = 'unreadable';
    }
  }
  const authFile = path.join(hub, '.bizagent', 'auth.json');
  if (!fs.existsSync(authFile)) files.auth = 'missing';
  else {
    try {
      JSON.parse(fs.readFileSync(authFile, 'utf8'));
      files.auth = 'ok';
    } catch (_err) {
      files.auth = 'corrupt';
    }
  }
  return files;
}

function writableProbe(hub) {
  const probe = path.join(hub, '.bizagent', `.health-write-${process.pid}`);
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { fsReadOnly: false, hubDirsWritable: true };
  } catch (err) {
    const readOnly = err && (err.code === 'EROFS' || /read-only/i.test(String(err.message)));
    return { fsReadOnly: readOnly, hubDirsWritable: !readOnly ? false : true };
  }
}

function clockSkewMs(hub) {
  // Compare wall-clock delta vs monotonic delta since the previous probe.
  const stateFile = path.join(hub, '.bizagent', 'health-state.json');
  const prev = readJson5(stateFile);
  const mono = Number(process.hrtime.bigint() / 1000000n);
  const wall = Date.now();
  let skew = null;
  if (prev && Number.isFinite(prev.wallMs) && Number.isFinite(prev.monoMs)) {
    const wallDelta = wall - prev.wallMs;
    const monoDelta = mono - prev.monoMs;
    if (monoDelta >= 0) skew = wallDelta - monoDelta;
  }
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ wallMs: wall, monoMs: mono })}\n`, 'utf8');
  } catch (_err) { /* ignore */ }
  return skew;
}

function providerFallbackActive(hub) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(hub, '.bizagent', 'ollama-fallback.json'), 'utf8'));
    return !!(raw && raw.active);
  } catch (_err) {
    return false;
  }
}

/** Gather real samples for the hub. Cheap: statfs + a bounded logs walk. */
function sample(hub, { now } = {}) {
  const at = now || new Date().toISOString();
  const space = logCaps.volumeSpace(hub);
  const logsBytes = logCaps.logsDirBytes(hub);

  // Growth rate: compare volume used bytes against the previous health.json.
  let growthBytesPerHour = null;
  let logsGrowthBytesPerHour = null;
  const prevRaw = readJson5(path.join(hub, 'logs', 'health.json'));
  const prev = (prevRaw && prevRaw.samples) || prevRaw; // reports nest samples
  const prevTs = prevRaw && prevRaw.ts;
  if (prev && prevTs && space) {
    const dtH = (Date.now() - Date.parse(prevTs)) / 3600000;
    if (dtH > 0.02 && dtH < 6 && prev.disk && prev.disk.totalBytes > 0) {
      const usedNow = space.totalBytes - space.freeBytes;
      const usedPrev = prev.disk.totalBytes - prev.disk.freeBytes;
      growthBytesPerHour = (usedNow - usedPrev) / dtH;
    }
    if (dtH > 0.02 && dtH < 6 && prev.logsBytes != null) {
      logsGrowthBytesPerHour = (logsBytes - prev.logsBytes) / dtH;
    }
  }

  const fds = systemFdCount() || (() => {
    const limit = fdLimitFromShell();
    return limit > 0 ? { openFds: null, fdLimit: limit } : null;
  })();

  const write = writableProbe(hub);

  return {
    at,
    disk: space,
    inodes: (() => {
      try {
        const s = fs.statfsSync(hub);
        return { free: Number(s.ffree), total: Number(s.files) };
      } catch (_err) {
        return null;
      }
    })(),
    logsBytes,
    logsGrowthBytesPerHour,
    growthBytesPerHour,
    ram: { availableBytes: memAvailable().availableBytes, totalBytes: os.totalmem() },
    oomLastHour: false, // detection is opt-in via BIZAGENT_HEALTH_OOM_CMD (see probe)
    load1: os.loadavg()[0],
    cpus: os.cpus().length,
    openFds: fds ? fds.openFds : null,
    fdLimit: fds ? fds.fdLimit : 0,
    heartbeatAgeMs: heartbeatAgeMs(hub),
    lockStale: lockStale(hub),
    cpPidDead: cpPidDead(hub),
    files: checkConfigFiles(hub),
    providerKeyPresent: providerKeyPresent(hub),
    fsReadOnly: write.fsReadOnly,
    hubDirsWritable: write.hubDirsWritable,
    clockSkewMs: clockSkewMs(hub),
    providerFallbackActive: providerFallbackActive(hub),
  };
}

// ---------------------------------------------------------------------------
// Writers + alerts
// ---------------------------------------------------------------------------

function writeHealthFiles(hub, report) {
  const logsDir = path.join(hub, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  // Overwrite (never append) — health.json must not grow.
  fs.writeFileSync(path.join(logsDir, 'health.json'), body, 'utf8');
  const top = (report.checks || [])
    .filter((c) => c.level !== 'ok')
    .map((c) => `${c.name}=${c.detail}`)
    .join(' ');
  fs.writeFileSync(
    path.join(logsDir, 'health.status'),
    `${report.level}${top ? ` ${top}` : ''}\n`,
    'utf8',
  );
}

/**
 * Local last-resort alert: HEALTH-ALERT.md in the hub root (Library can show it).
 * Persisted until the check is green again.
 */
function updateHealthAlertFile(hub, report) {
  const file = path.join(hub, 'HEALTH-ALERT.md');
  if (report.level === 'ok' || report.level === 'warn') {
    try { fs.unlinkSync(file); } catch (_err) { /* absent */ }
    return false;
  }
  const bad = (report.checks || []).filter((c) => c.level !== 'ok');
  const lines = [
    `# HEALTH-ALERT — ${report.level.toUpperCase()}`,
    '',
    `\`${report.ts}\` — the BizAgent health watchdog tripped on this hub.`,
    '',
    ...bad.map((c) => `- **${c.name}** (${c.level}): ${c.detail}`),
    '',
    'The control plane may be unable to start or run turns. Check `logs/health.json`,',
    'free disk space, and `journalctl --user -u bizagent-health.service`.',
    '',
    'This file is removed automatically when the next health check is green.',
    '',
  ];
  try {
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return true;
  } catch (_err) {
    return false; // disk may already be unwritable — the probe exit code still fires OnFailure
  }
}

/**
 * Console chat line, once per incident (dedupe ~30 min) so it lands in history.
 */
function postHealthChatLine(hub, report) {
  if (report.level === 'ok') return false;
  const stampFile = path.join(hub, '.bizagent', 'health-chat-stamp.json');
  const key = `${report.level}`;
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
  } catch (_err) { /* ignore */ }
  const now = Date.now();
  if (prev && prev.key === key && now - Number(prev.ts || 0) < 30 * 60 * 1000) return false;
  try {
    fs.mkdirSync(path.dirname(stampFile), { recursive: true });
    fs.writeFileSync(stampFile, `${JSON.stringify({ key, ts: now })}\n`, 'utf8');
  } catch (_err) { /* ignore */ }

  const bad = (report.checks || []).filter((c) => c.level !== 'ok');
  const body = [
    `**Hub health: ${report.level}**`,
    '',
    ...bad.map((c) => `- ${c.name}: ${c.detail}`),
    '',
    report.level === 'emergency'
      ? 'Auto-mitigation ran (logs capped, archives pruned, agent launches paused). Product artifacts were not touched.'
      : 'Watch this space — details in `logs/health.json`.',
  ].join('\n');
  try {
    const { listConversations, appendMessage } = require('./conversations');
    const convs = (listConversations(hub) || [])
      .slice()
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    const cid = convs[0] && convs[0].id;
    if (!cid) return false;
    appendMessage(hub, cid, 'status', body, { kind: 'health' });
    return true;
  } catch (_err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Emergency auto-mitigation (no LLM involved)
// ---------------------------------------------------------------------------

function stopHelpers(hub) {
  try {
    execFileSync('bash', ['-c', 'pkill -f -- "--helper" || true'], { timeout: 5000 });
    return true;
  } catch (_err) {
    return false;
  }
}

function pruneArchives(hub) {
  const script = path.join(hub, 'scripts', 'prune-archives.sh');
  try {
    execFileSync('bash', [script, '--days', '3', String(hub)], { timeout: 60000 });
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Emergency mitigation. Returns a summary of what was done.
 * Never deletes git, registry.json, or company/. Never deletes product
 * artifacts (VCDs, checkpoints) — those only ever produce warnings.
 */
function mitigate(hub, report) {
  const done = [];
  if (report.level !== 'emergency') return done;
  if (!safeMode.isSafeMode(hub)) {
    if (safeMode.enterSafeMode(hub, `health emergency: ${report.ts}`)) done.push('safe_mode_entered');
  }
  const capped = logCaps.capLogs(hub, { keepBytes: 512 * 1024 });
  if (capped.files > 0) done.push(`logs_capped(${capped.files} files, -${Math.round(capped.bytesRemoved / MB)}MB)`);
  if (pruneArchives(hub)) done.push('archives_pruned');
  if (stopHelpers(hub)) done.push('helpers_stopped');
  try {
    const { logEvent } = require('./log');
    logEvent(hub, { event: 'health_emergency_mitigation', actions: done, level: report.level });
  } catch (_err) { /* ignore */ }
  return done;
}

/**
 * One watchdog pass: sample → evaluate → write files → alert → mitigate.
 * Used by both the in-process timer and the out-of-process probe.
 */
function runHealthCheck(hub, { mitigate: doMitigate = true } = {}) {
  const samples = sample(hub);
  const report = evaluateChecks(samples);
  report.samples = samples;
  try {
    writeHealthFiles(hub, report);
  } catch (_err) { /* disk may be full; probe exit code still signals */ }
  try {
    updateHealthAlertFile(hub, report);
  } catch (_err) { /* ignore */ }
  try {
    postHealthChatLine(hub, report);
  } catch (_err) { /* ignore */ }
  let actions = [];
  if (doMitigate) {
    try {
      actions = mitigate(hub, report);
    } catch (_err) { /* ignore */ }
  }
  report.mitigation = actions;
  return report;
}

module.exports = {
  LEVELS,
  THRESHOLDS,
  evaluateChecks,
  heartbeatAgeMs,
  mitigate,
  postHealthChatLine,
  providerKeyPresent,
  runHealthCheck,
  sample,
  updateHealthAlertFile,
  writeHealthFiles,
};
