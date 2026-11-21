'use strict';

/**
 * Model-availability preflight (2026-11-21 incident review).
 *
 * Before an agent is dispatched on a provider/model, a cached live check
 * confirms the model actually exists on the endpoint. A 404 model-not-found
 * used to burn a full turn (spawn → CLI → provider 404 → failure card) and,
 * worse, re-fired on the failure backoff. The preflight catches it before
 * launch and surfaces a "model broken/missing on endpoint" card with a
 * one-click model switch instead.
 *
 * Design constraints:
 *   - The dispatch tick is synchronous, so the live fetch happens OUT of band
 *     (periodic refresh, every ~10 ticks) into a per-provider cache file; the
 *     dispatch gate only reads the cache.
 *   - Fail open: no cache entry, stale entry (>24 h), or a fallback-source
 *     list never blocks dispatch. Only a fresh LIVE list that demonstrably
 *     lacks the model holds the launch.
 */

const fs = require('fs');
const path = require('path');
const { appDir } = require('./config');
const { writeJsonAtomic } = require('./atomic-state');
const { listProviderModels } = require('./provider-models');

const CACHE_TTL_MS = 60 * 60 * 1000; // refresh a provider's list at most hourly
const BLOCK_TTL_MS = 24 * 60 * 60 * 1000; // a "missing" verdict blocks for 24 h max

function preflightDir(hub) {
  return path.join(appDir(hub), 'model-preflight');
}

function providerCacheFile(hub, provider) {
  const safe = String(provider || 'fleet').replace(/[^a-z0-9_-]/gi, '') || 'fleet';
  return path.join(preflightDir(hub), `${safe}.json`);
}

function readCache(hub, provider) {
  try {
    const s = JSON.parse(fs.readFileSync(providerCacheFile(hub, provider), 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Refresh the cached live model list for one provider. Best-effort; never
 * throws. Returns the cache entry written (or the previous one on failure).
 */
async function refreshProviderCache(hub, cliJson, provider) {
  const key = String(provider || '').trim().toLowerCase();
  if (!key) return null;
  const prev = readCache(hub, key);
  if (prev && Date.now() - Number(prev.checkedAtMs || 0) < CACHE_TTL_MS) return prev;
  let result = null;
  try {
    result = await listProviderModels({ hub, cliJson, provider: key });
  } catch (_err) {
    result = null;
  }
  if (!result || result.source !== 'live' || !Array.isArray(result.models)) {
    // Live fetch failed → keep any previous verdict, else record a fail-open
    // entry so we do not re-fetch on every tick while the provider is down.
    const entry = {
      provider: key,
      source: 'unavailable',
      checkedAtMs: Date.now(),
      ...(prev && prev.source === 'live' ? { models: prev.models } : {}),
    };
    try {
      fs.mkdirSync(preflightDir(hub), { recursive: true });
      writeJsonAtomic(providerCacheFile(hub, key), entry);
    } catch (_err) { /* best-effort */ }
    return entry;
  }
  const entry = {
    provider: key,
    source: 'live',
    checkedAtMs: Date.now(),
    models: result.models.map((m) => String(m && m.id || '').trim()).filter(Boolean),
  };
  try {
    fs.mkdirSync(preflightDir(hub), { recursive: true });
    writeJsonAtomic(providerCacheFile(hub, key), entry);
  } catch (_err) { /* best-effort */ }
  return entry;
}

/**
 * Sync dispatch gate. Returns { block, reason } — block only when a fresh
 * LIVE cached list exists and demonstrably lacks the model.
 */
function preflightGate(hub, provider, model) {
  const key = String(provider || '').trim().toLowerCase();
  const modelId = String(model || '').trim();
  if (!key || !modelId) return { block: false, reason: '' };
  const entry = readCache(hub, key);
  if (!entry || entry.source !== 'live') return { block: false, reason: '' };
  if (Date.now() - Number(entry.checkedAtMs || 0) > BLOCK_TTL_MS) return { block: false, reason: '' };
  if (!Array.isArray(entry.models) || entry.models.length === 0) return { block: false, reason: '' };
  if (entry.models.includes(modelId)) return { block: false, reason: '' };
  return {
    block: true,
    reason: `model "${modelId}" is not in the live model list for provider "${key}"`,
  };
}

/** Clear a provider's cached verdict (e.g. after a model switch). */
function clearPreflight(hub, provider) {
  try {
    fs.rmSync(providerCacheFile(hub, provider), { force: true });
  } catch (_err) { /* ignore */ }
}

/**
 * Refresh cache entries for every provider/model pair actually in use
 * (hub + product agents). Called out of band every ~10 dispatcher ticks.
 */
async function refreshPreflightCache(hub, cliJson, registry) {
  const pairs = new Map(); // provider -> Set(models)
  const add = (provider, model) => {
    const p = String(provider || '').trim().toLowerCase();
    const m = String(model || '').trim();
    if (!p || !m) return;
    if (!pairs.has(p)) pairs.set(p, new Set());
    pairs.get(p).add(m);
  };
  try {
    const hubAgent = (registry && registry.settings && registry.settings.hub_agent) || {};
    add(hubAgent.provider || hubAgent.cliName || '', hubAgent.model || '');
    const { agentsFromRegistry } = require('./config');
    for (const agent of agentsFromRegistry(registry || {})) {
      add(agent.provider || agent.cliName || '', agent.model || '');
    }
  } catch (_err) { /* best-effort */ }
  for (const [provider, models] of pairs) {
    await refreshProviderCache(hub, cliJson, provider);
    // Per-model verdicts are derived from the provider list at gate time;
    // nothing per-model to store beyond the list itself.
  }
}

module.exports = {
  preflightGate,
  refreshPreflightCache,
  refreshProviderCache,
  clearPreflight,
  readCache,
};