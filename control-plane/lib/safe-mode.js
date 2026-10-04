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

function flagPath(hub) {
  return path.join(hub, '.bizagent', 'safe-mode.json');
}

function readFlag(hub) {
  try {
    const raw = JSON.parse(fs.readFileSync(flagPath(hub), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch (_err) { /* absent or corrupt */ }
  return null;
}

/** True when the hub must run degraded (flag file present and not manually cleared). */
function isSafeMode(hub) {
  return !!readFlag(hub);
}

function enterSafeMode(hub, reason) {
  const dir = path.dirname(flagPath(hub));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      flagPath(hub),
      `${JSON.stringify({ active: true, reason: String(reason || ''), ts: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    return true;
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
  enterSafeMode,
  exitSafeMode,
  flagPath,
  isSafeMode,
  readFlag,
  routeAllowedInSafeMode,
};
