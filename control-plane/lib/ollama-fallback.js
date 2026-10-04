'use strict';

/**
 * Hub-only Ollama fallback — when the paid provider is *reachable but refuses*
 * the request: spend/credit cap, invalid or missing API key (401/403/402),
 * or a rejected model. NOT a general network outage, NOT a bad prompt.
 *
 * Flow (background, no click):
 *   1. Classify the hub LLM error (control-plane/lib/provider-errors.js).
 *   2. If Ollama is installed and 127.0.0.1:11434 is up, pull a small model if
 *      needed (qwen3:4b unless already present). Skip the pull when disk is
 *      already in the emergency zone.
 *   3. The next hub dispatch retries THIS hub turn against local Ollama via a
 *      launch-time override. registry.json / cli.json are never rewritten.
 *   4. The hub tells the operator the paid provider failed and what to fix.
 *   5. Health flag + console banner `provider_fallback_active` until a
 *      paid-provider probe succeeds again.
 *
 * Product agents never fall back to a 4B local model — hub turns only.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { classifyProviderError } = require('./provider-errors');

const FALLBACK_MODEL = process.env.BIZAGENT_OLLAMA_FALLBACK_MODEL || 'qwen3:4b';
const OLLAMA_BASE = process.env.BIZAGENT_OLLAMA_URL || 'http://127.0.0.1:11434';

function flagPath(hub) {
  return path.join(hub, '.bizagent', 'ollama-fallback.json');
}

function readFlag(hub) {
  try {
    const raw = JSON.parse(fs.readFileSync(flagPath(hub), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch (_err) { /* ignore */ }
  return null;
}

function isFallbackActive(hub) {
  const f = readFlag(hub);
  return !!(f && f.active);
}

function writeFlag(hub, flag) {
  try {
    fs.mkdirSync(path.dirname(flagPath(hub)), { recursive: true });
    fs.writeFileSync(flagPath(hub), `${JSON.stringify(flag, null, 2)}\n`, 'utf8');
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Should this classified provider error trigger the Ollama fallback?
 * credits / auth / model → yes. rate_limit / network / unknown → no.
 */
function shouldFallback(classified) {
  return !!classified && ['credits', 'auth', 'model'].includes(classified.kind);
}

async function ollamaStatus(baseUrl = OLLAMA_BASE) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { up: false };
    const body = await res.json();
    const models = (body && body.models) || [];
    return { up: true, models: models.map((m) => m && m.name).filter(Boolean) };
  } catch (_err) {
    return { up: false };
  }
}

function ollamaInstalled() {
  try {
    execFileSync('bash', ['-c', 'command -v ollama >/dev/null 2>&1'], { timeout: 5000 });
    return true;
  } catch (_err) {
    return false;
  }
}

function pullModel(model, baseUrl = OLLAMA_BASE) {
  try {
    execFileSync('ollama', ['pull', model], {
      timeout: 10 * 60 * 1000,
      stdio: 'ignore',
      env: { ...process.env, OLLAMA_HOST: baseUrl },
    });
    return true;
  } catch (_err) {
    return false;
  }
}

function diskEmergency(hub) {
  try {
    const health = JSON.parse(fs.readFileSync(path.join(hub, 'logs', 'health.json'), 'utf8'));
    return health && health.level === 'emergency';
  } catch (_err) {
    return false;
  }
}

/**
 * Activate the fallback for subsequent hub turns. Returns a result object;
 * never throws. `reason` is the classified provider error.
 */
async function activateFallback(hub, { classified, text } = {}) {
  const status = await ollamaStatus();
  if (!status.up) {
    return { ok: false, reason: 'ollama_not_running' };
  }
  const hasModel = (status.models || []).some((m) => m === FALLBACK_MODEL || m.split(':')[0] === FALLBACK_MODEL.split(':')[0]);
  let pulled = false;
  if (!hasModel) {
    if (diskEmergency(hub)) {
      // Disk already in the emergency zone: do NOT pull a multi-GB model.
      return { ok: false, reason: 'disk_emergency_skip_pull' };
    }
    if (!ollamaInstalled()) return { ok: false, reason: 'ollama_not_installed' };
    pulled = pullModel(FALLBACK_MODEL);
    if (!pulled) return { ok: false, reason: 'ollama_pull_failed' };
  }
  const flag = {
    active: true,
    provider: 'ollama',
    model: FALLBACK_MODEL,
    reason: (classified && classified.kind) || 'provider_refused',
    detail: (classified && classified.title) || '',
    ts: new Date().toISOString(),
  };
  writeFlag(hub, flag);
  try {
    const { logEvent } = require('./log');
    logEvent(hub, {
      event: 'provider_fallback_activated',
      status: 'warn',
      provider: 'ollama',
      model: FALLBACK_MODEL,
      kind: flag.reason,
      pulled,
    });
  } catch (_err) { /* ignore */ }
  return { ok: true, flag, pulled };
}

function clearFallback(hub, reason) {
  const wasActive = isFallbackActive(hub);
  try { fs.unlinkSync(flagPath(hub)); } catch (_err) { /* ignore */ }
  if (wasActive) {
    try {
      const { logEvent } = require('./log');
      logEvent(hub, { event: 'provider_fallback_cleared', reason: reason || 'paid_provider_ok' });
    } catch (_err) { /* ignore */ }
  }
  return wasActive;
}

/**
 * Launch-time override for hub turns while the fallback is active.
 * Returns { provider, model } or null. Never mutates registry.json/cli.json.
 */
function hubLaunchOverride(hub) {
  const flag = readFlag(hub);
  if (!flag || !flag.active) return null;
  return { provider: flag.provider || 'ollama', model: flag.model || FALLBACK_MODEL };
}

/**
 * Probe the paid provider with a cheap authenticated GET (model list).
 * 2xx → the paid provider works again → clear the fallback flag.
 */
async function probePaidProvider(hub) {
  let providerName = '';
  let def = null;
  try {
    const { loadRegistry } = require('./config');
    const { loadCliJson, providerEntries, resolveProviderName } = require('./cli-config');
    const registry = loadRegistry(hub);
    const hubAgent = (registry.settings && registry.settings.hub_agent) || {};
    providerName = String(hubAgent.provider || hubAgent.cliName || '').trim();
    if (!providerName) return { probed: false };
    const cliJson = loadCliJson(hub);
    const key = resolveProviderName(providerName, cliJson);
    def = providerEntries(cliJson)[key];
  } catch (_err) {
    return { probed: false };
  }
  if (!def || !def.baseURL) return { probed: false };
  const keyEnv = def.keyEnv || '';
  const apiKey = (keyEnv && process.env[keyEnv]) || '';
  if (!apiKey) return { probed: true, ok: false, reason: `missing ${keyEnv}` };
  try {
    const url = `${String(def.baseURL).replace(/\/$/, '')}/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      clearFallback(hub, 'paid_provider_probe_ok');
      return { probed: true, ok: true };
    }
    return { probed: true, ok: false, status: res.status };
  } catch (err) {
    return { probed: true, ok: false, error: err.message };
  }
}

/**
 * Hook from dispatcher.recordAgentError: on a hub-turn provider refusal,
 * classify and (background) activate the Ollama fallback + operator notice.
 * Fire-and-forget; never throws.
 */
function maybeTriggerFallback(hub, { slug, text } = {}) {
  try {
    if (slug && slug !== 'hub') return; // hub-only: product agents never run on a 4B local model
    const classified = classifyProviderError(text);
    if (!shouldFallback(classified)) return;
    const prev = readFlag(hub);
    if (prev && prev.active && prev.kind === classified.kind &&
        Date.now() - Date.parse(prev.ts || 0) < 30 * 60 * 1000) {
      return; // already handled this incident
    }
    activateFallback(hub, { classified, text }).then((result) => {
      notifyOperator(hub, classified, result);
    }).catch(() => { /* ignore */ });
  } catch (_err) { /* ignore */ }
}

/**
 * Tell the operator (console chat) that the paid provider failed, what the fix
 * is, and that hub turns are temporarily on local Ollama. Never silent-death:
 * when Ollama is missing/unavailable the existing provider-failure message and
 * the health alert still stand.
 */
function notifyOperator(hub, classified, result) {
  try {
    const { listConversations, appendMessage } = require('./conversations');
    const lines = [`**${classified ? classified.title : 'LLM provider refused the request'}**`];
    if (classified) lines.push('', classified.summary, '', `**Fix:** ${classified.fix}`);
    if (result && result.ok) {
      lines.push(
        '',
        `Meanwhile, hub turns are running on local Ollama (\`${result.flag ? result.flag.model : FALLBACK_MODEL}\`). ` +
        'Product agents are NOT falling back — they stay paused until the paid provider works again.',
      );
    } else if (result && !result.ok) {
      lines.push(
        '',
        `Local Ollama fallback unavailable (${result.reason || 'unavailable'}) — hub turns will keep failing ` +
        'until the provider issue is fixed. See HEALTH-ALERT.md / logs/health.json.',
      );
    }
    const convs = (listConversations(hub) || [])
      .slice()
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    const cid = convs[0] && convs[0].id;
    if (!cid) return;
    appendMessage(hub, cid, 'status', lines.join('\n'), { kind: 'provider_fallback' });
  } catch (_err) { /* ignore */ }
}

module.exports = {
  FALLBACK_MODEL,
  OLLAMA_BASE,
  activateFallback,
  clearFallback,
  hubLaunchOverride,
  isFallbackActive,
  maybeTriggerFallback,
  notifyOperator,
  ollamaInstalled,
  ollamaStatus,
  probePaidProvider,
  pullModel,
  shouldFallback,
};
