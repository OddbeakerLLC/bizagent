const fs = require('fs');
const path = require('path');

/**
 * Structured logging for BizAgent Makeover Plan (Phase 0)
 * 
 * Goal: Replace noisy, hard-to-parse logs with consistent, meaningful events
 * that are easy to query, alert on, and display in a dashboard.
 */

function timestamp() {
  return new Date().toISOString();
}

function ensureLogDir(hub) {
  const dir = path.join(hub, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Main structured log function
 * @param {string} hub - Hub root path
 * @param {object} event - Event data (will be serialized as JSON)
 */
function logEvent(hub, event) {
  const dir = ensureLogDir(hub);
  const logLine = {
    ts: timestamp(),
    ...event
  };

  const line = JSON.stringify(logLine);
  
  // Always write to structured log
  fs.appendFileSync(
    path.join(dir, 'structured.log'),
    line + '\n'
  );

  // Also write human-readable version to control-plane.log for easy tailing
  const human = `${logLine.ts} ${logLine.event || 'event'} ` +
                `duration=${logLine.duration_ms || '—'}ms ` +
                `status=${logLine.status || 'ok'} ` +
                (logLine.conversation_id ? `conv=${logLine.conversation_id} ` : '') +
                (logLine.model ? `model=${logLine.model} ` : '');

  fs.appendFileSync(
    path.join(dir, 'control-plane.log'),
    human + '\n'
  );
}

/**
 * Convenience wrappers for common events
 */
function logHubTurn(hub, data) {
  logEvent(hub, {
    event: 'hub_turn',
    ...data
  });
}

function logError(hub, error, context = {}) {
  logEvent(hub, {
    event: 'error',
    status: 'error',
    message: error.message || String(error),
    stack: error.stack ? error.stack.split('\n')[0] : undefined,
    ...context
  });
}

function logLatency(hub, eventName, durationMs, context = {}) {
  logEvent(hub, {
    event: eventName,
    duration_ms: Math.round(durationMs * 100) / 100,
    ...context
  });
}

module.exports = {
  logEvent,
  logHubTurn,
  logError,
  logLatency,
  // Legacy compatibility during transition
  appendLog: (hub, message) => {
    logEvent(hub, { event: 'legacy_log', message });
  }
};
