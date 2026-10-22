'use strict';

/**
 * Startup recovery pass (2026-10-22 crash-resilience task).
 *
 * Runs once at control-plane boot to reconcile state left behind by a crash
 * (short of SIGKILL of the CP itself, which is accepted data loss):
 *   1. Drains stale pending hub turns via the existing safety net.
 *   2. Re-routes any unrouted outbox mail (routeOutboxes).
 *   3. Clears stale locks/pidfiles whose owning processes are gone.
 *   4. Re-queues interrupted dispatches by relaxing dispatch markers whose
 *      inbox mail is still unarchived but whose slug is not running.
 *   5. Emits one `control_plane_recovery` structured-log event summarizing actions.
 *
 * Best-effort throughout: recovery failures must never block CP startup.
 */

const fs = require('fs');
const path = require('path');
const { appDir } = require('./config');
const { cleanTmpFiles, writeJsonAtomic } = require('./atomic-state');
const { logEvent } = require('./log');
const { routeOutboxes } = require('./mail');
const { drainPendingHubTurns } = require('./hub-turn-safety');

const TMP_MAX_AGE_MS = 60 * 60 * 1000;

function pidAlive(pid) {
  if (!pid || !/^[0-9]+$/.test(String(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Remove a lock dir / pidfile when its recorded pid is dead and no live
 * bizagent-agent CLI child exists for the slug. Returns true when cleared.
 */
function clearStaleLock(hub, lockDir, slug, findAgentCliPid) {
  let pid = '';
  try {
    pid = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim();
  } catch (_err) { /* no pid file */ }
  if (pidAlive(pid)) return false;
  if (findAgentCliPid && findAgentCliPid(hub, slug)) return false;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Full startup recovery pass. `config` is the runtime config (needs .hub,
 * .lockLeaseSecs); `dispatcher` is the dispatcher module (passed in to avoid
 * a circular require at module load).
 */
function runStartupRecovery(config, dispatcher) {
  const hub = config.hub;
  const actions = {
    pending_hub_turns_drained: 0,
    outbox_routed: 0,
    locks_cleared: 0,
    dispatches_requeued: 0,
    tmp_files_removed: 0,
  };

  // 1. Drain stale pending hub turns (existing mechanism). A genuinely live
  // hub CLI/daemon keeps its turns pending; only orphaned ones finalize.
  try {
    const results = drainPendingHubTurns(hub, () =>
      dispatcher.isAgentActive(hub, 'hub', config.lockLeaseSecs)) || [];
    actions.pending_hub_turns_drained = results.length;
  } catch (_err) { /* best-effort */ }

  // 2. Re-route any unrouted outbox mail left by a crashed turn.
  try {
    const routed = routeOutboxes(hub) || {};
    actions.outbox_routed = (routed.delivered || 0) + (routed.quarantined || 0);
  } catch (_err) { /* best-effort */ }

  // 3. Clear stale locks/pidfiles whose owners are gone.
  try {
    if (clearStaleLock(hub, path.join(appDir(hub), 'hub.lock'), 'hub', dispatcher.findAgentCliPid)) {
      actions.locks_cleared += 1;
    }
    const agentsDir = path.join(hub, 'agents');
    const slugs = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : [];
    for (const slug of slugs) {
      if (slug === 'hub') continue;
      if (clearStaleLock(hub, path.join(agentsDir, slug, '.lock'), slug, dispatcher.findAgentCliPid)) {
        actions.locks_cleared += 1;
      }
    }
    // Stale CP pidfile: remove only if it points at a dead pid.
    const pidFile = path.join(appDir(hub), 'control-plane.pid');
    try {
      const existing = fs.readFileSync(pidFile, 'utf8').trim();
      if (existing && !pidAlive(existing)) {
        fs.unlinkSync(pidFile);
        actions.locks_cleared += 1;
      }
    } catch (_err) { /* absent — fine */ }
  } catch (_err) { /* best-effort */ }

  // 4. Re-queue interrupted dispatches: for each slug not currently running,
  // relax dispatch markers on mail still sitting unarchived in its inbox so
  // the first tick can re-dispatch instead of waiting out the lease.
  try {
    const agentsDir = path.join(hub, 'agents');
    const slugs = ['hub'].concat(fs.existsSync(agentsDir)
      ? fs.readdirSync(agentsDir).filter((s) => s !== 'hub')
      : []);
    for (const slug of slugs) {
      if (dispatcher.isAgentActive(hub, slug, config.lockLeaseSecs)) continue;
      // Operator stop intentionally holds markers — never re-queue those.
      if (dispatcher.wasOperatorStopped(hub, slug)) continue;
      try {
        const stateFile = path.join(appDir(hub), 'dispatch-state', `${slug}.json`);
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (!state || !Array.isArray(state.handled) || state.handled.length === 0) continue;
        const inboxDir = slug === 'hub' ? path.join(hub, 'inbox') : path.join(agentsDir, slug, 'inbox');
        const now = Math.floor(Date.now() / 1000);
        const shifted = now - Math.max(0, Number(config.lockLeaseSecs || 1800));
        let changed = false;
        const next = state.handled.map((item) => {
          if (item && fs.existsSync(path.join(inboxDir, item.file))) {
            changed = true;
            return { ...item, dispatchedAt: shifted };
          }
          return item;
        });
        if (changed) {
          writeJsonAtomic(stateFile, { handled: next });
          actions.dispatches_requeued += 1;
        }
      } catch (_err) { /* no markers for this slug */ }
    }
  } catch (_err) { /* best-effort */ }

  // 5. Clean leftover tmp staging files from crashed atomic writers.
  try {
    actions.tmp_files_removed = cleanTmpFiles(appDir(hub), TMP_MAX_AGE_MS);
  } catch (_err) { /* best-effort */ }

  try {
    logEvent(hub, {
      event: 'control_plane_recovery',
      status: 'ok',
      ...actions,
    });
  } catch (_err) { /* never block startup on logging */ }

  return actions;
}

/**
 * Crash handlers for the control-plane process. All state writes go through
 * atomic-state (tmp + fsync + rename), so there is no buffered state to flush
 * — the checkpoint is the structured-log event itself, and the next boot's
 * runStartupRecovery() resumes from disk. SIGKILL is accepted data loss.
 */
function registerCrashHandlers(config) {
  const checkpoint = (reason, detail) => {
    try {
      logEvent(config.hub, {
        event: 'control_plane_crash',
        reason,
        message: String(detail || '').slice(0, 500),
        t: new Date().toISOString(),
      });
    } catch (_err) {
      try { process.stderr.write(`control-plane crash (${reason}): ${detail}\n`); } catch (_) {}
    }
  };
  process.on('uncaughtException', (err) => {
    checkpoint('uncaughtException', (err && (err.stack || err.message)) || String(err));
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    // Log and keep serving — a rejected promise must not take the hub down.
    checkpoint('unhandledRejection', reason instanceof Error ? (reason.stack || reason.message) : String(reason));
  });
}

module.exports = {
  clearStaleLock,
  pidAlive,
  registerCrashHandlers,
  runStartupRecovery,
};