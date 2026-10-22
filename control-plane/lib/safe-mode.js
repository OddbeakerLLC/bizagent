'use strict';

/**
 * Boot / runtime safe-mode gate.
 *
 * When the hub volume is in the emergency zone (or an operator flips the
 * switch), the control plane runs in a mode that only serves:
 *   - login (+ setup)
 *   - a blocking health banner
 *   - the health JSON
 * No agent launches, no multi-MB log appends, no session dumps.
 */

const fs = require('fs');
const path = require('path');
const { readJsonState, writeJsonAtomic } = require('./atomic-state');

function flagPath(hub) {
  return path.join(hub, '.bizagent', 'safe-mode.json');
}

function readFlag(hub) {
  // Tolerant read: a torn flag file falls back to the last-good .bak rather
  // than silently dropping the hub out of safe mode.
  const raw = readJsonState(flagPath(hub), null);
  if (raw && typeof raw === 'object') return raw;
  return null;
}

/** True when the hub must run degraded (flag file present and not manually cleared). */
function isSafeMode(hub) {
  return !!readFlag(hub);
}

function enterSafeMode(hub, reason) {
  try {
    return !!writeJsonAtomic(
      flagPath(hub),
      { active: true, reason: String(reason || ''), ts: new Date().toISOString() },
    );
  } catch (_err) {
    return false;
  }
}

function exitSafeMode(hub) {
  try {
    fs.unlinkSync(flagPath(hub));
    return true;
  } catch (_err) {
    return !isSafeMode(hub);
  }
}

// ---------------------------------------------------------------------------
// Auto-exit (health recovery)
//
// Flags entered by the health watchdog (reason "health emergency: <ts>") clear
// themselves once the probe reports ok on N consecutive runs. Operator-set
// flags (any other reason) always require a manual exit.
// ---------------------------------------------------------------------------

const HEALTH_EMERGENCY_REASON_PREFIX = 'health emergency';

/** True when this flag was set by the health watchdog (auto-exit eligible). */
function isHealthEmergencyFlag(flag) {
  return !!(flag
    && typeof flag.reason === 'string'
    && flag.reason.startsWith(HEALTH_EMERGENCY_REASON_PREFIX));
}

/** Consecutive ok runs required before auto-exit (env override, default 2). */
function autoExitRuns() {
  const n = Number(process.env.BIZAGENT_SAFE_MODE_EXIT_RUNS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

/**
 * Pure auto-exit decision (unit-testable, no I/O).
 * - level must be exactly 'ok' ('warn'/'critical'/'emergency' never count);
 * - the flag must be a health-emergency flag;
 * - any non-ok run resets the streak to 0.
 * Returns { exit, okStreak } where okStreak is the streak AFTER this run.
 */
function autoExitDecision({ level, flag, okStreak = 0, requiredRuns } = {}) {
  if (level !== 'ok' || !isHealthEmergencyFlag(flag)) return { exit: false, okStreak: 0 };
  const need = requiredRuns != null ? requiredRuns : autoExitRuns();
  const streak = Number(okStreak || 0) + 1;
  return { exit: streak >= need, okStreak: streak };
}

/**
 * API gate for safe mode. Returns true when `pathname` may still be served.
 * Everything else gets a 503 with the health payload so the UI can banner it.
 */
function routeAllowedInSafeMode(pathname) {
  const allowed = new Set([
    '/api/login',
    '/api/setup',
    '/api/logout',
    '/api/health',
    '/api/safe-mode',
  ]);
  return allowed.has(pathname);
}

module.exports = {
  autoExitDecision,
  autoExitRuns,
  enterSafeMode,
  exitSafeMode,
  flagPath,
  isHealthEmergencyFlag,
  isSafeMode,
  readFlag,
  routeAllowedInSafeMode,
};
