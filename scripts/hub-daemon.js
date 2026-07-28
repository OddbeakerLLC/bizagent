#!/usr/bin/env node
/**
 * hub-daemon.js — long-lived hub turn worker (Makeover Phase 1).
 *
 * Stays running with .bizagent/env loaded, listens on a Unix socket, and
 * processes hub turns on request. Control plane prefers this path; cold
 * spawn remains the fallback when the daemon is down.
 *
 * Protocol (newline-delimited JSON over Unix socket .bizagent/hub.sock):
 *   → { "type": "ping" }
 *   ← { "ok": true, "type": "pong", "pid": N }
 *
 *   → { "type": "turn", "requestId": "..." }
 *   ← { "ok": true|false, "type": "turn_result", ... }
 *
 *   → { "type": "shutdown" }
 *   ← { "ok": true, "type": "bye" }
 *
 * Usage:
 *   node scripts/hub-daemon.js [--hub PATH]
 *   scripts/hub-daemon.sh {start|stop|status|restart|ping}
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const hubArgIdx = process.argv.indexOf('--hub');
const HUB = path.resolve(
  hubArgIdx >= 0 && process.argv[hubArgIdx + 1]
    ? process.argv[hubArgIdx + 1]
    : path.join(__dirname, '..'),
);

const libRoot = path.join(HUB, 'control-plane', 'lib');
const { loadHubEnv, loadRuntimeConfig } = require(path.join(libRoot, 'config'));
const { compileAgentCommand, getCliSettings } = require(path.join(libRoot, 'cli-config'));
const {
  buildHubTurnPrompt,
  ensureHubRuntimeCwd,
  ensureHubRuntimePrompt,
} = require(path.join(libRoot, 'hub-memory'));
const { logEvent } = require(path.join(libRoot, 'log'));
const { postLaunchAck } = require(path.join(libRoot, 'conversations'));
const {
  onHubCliExit,
  prepareReservedReplyBody,
  recordPendingHubTurn,
  reservedReplyBodyPath,
} = require(path.join(libRoot, 'hub-turn-safety'));

// Inline (avoid requiring dispatcher.js which is heavy / circular-risk)
function getRecentHubInboxMessage(hub) {
  const dir = path.join(hub, 'inbox');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().reverse();
  } catch (_e) {
    return '';
  }
  for (const name of names) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      const m = text.match(/^conversation_id:\s*(.+?)\s*$/m);
      if (m) return m[1].trim();
    } catch (_e) { /* skip */ }
  }
  return '';
}

const SOCK = path.join(HUB, '.bizagent', 'hub.sock');
const PID_FILE = path.join(HUB, '.bizagent', 'hub-daemon.pid');

let busy = false;
let server = null;

function ensureDirs() {
  fs.mkdirSync(path.join(HUB, '.bizagent'), { recursive: true });
  fs.mkdirSync(path.join(HUB, 'logs'), { recursive: true });
}

function writePid() {
  fs.writeFileSync(PID_FILE, `${process.pid}\n`, { mode: 0o600 });
}

function clearPid() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const cur = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (cur === String(process.pid)) fs.unlinkSync(PID_FILE);
    }
  } catch (_e) { /* ignore */ }
}

function clearSock() {
  try {
    if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
  } catch (_e) { /* ignore */ }
}

function nowIso() {
  return new Date().toISOString();
}

function logByteOffset(file) {
  try {
    return fs.statSync(file).size;
  } catch (_e) {
    return 0;
  }
}

function runTurn() {
  return new Promise((resolve) => {
    const start = Date.now();
    const envInfo = loadHubEnv(HUB);
    const config = loadRuntimeConfig(HUB);
    const { hubModel, hubCliName, _cliJson } = config;
    const cliJson = _cliJson || {};

    ensureHubRuntimePrompt(HUB);
    const runtimeCwd = ensureHubRuntimeCwd(HUB);
    const conversationId = getRecentHubInboxMessage(HUB);
    const startedAt = nowIso();
    const agentLog = path.join(HUB, 'logs', 'dispatch-hub.log');
    const agentStderr = path.join(HUB, 'logs', 'dispatch-hub.stderr');
    const logOffset = logByteOffset(agentLog);
    const stderrOffset = logByteOffset(agentStderr);

    if (conversationId) {
      try { postLaunchAck(HUB, conversationId); } catch (_e) { /* non-fatal */ }
    }

    let promptFile;
    try {
      promptFile = buildHubTurnPrompt(HUB);
    } catch (err) {
      logEvent(HUB, { event: 'hub_daemon_turn_error', status: 'error', message: err.message });
      resolve({
        ok: false,
        exitCode: 1,
        duration_ms: Date.now() - start,
        action: 'prompt_build_failed',
        error: err.message,
      });
      return;
    }

    const replyBodyFile = conversationId
      ? (reservedReplyBodyPath(HUB, conversationId) || prepareReservedReplyBody(HUB, conversationId))
      : '';

    if (conversationId) {
      recordPendingHubTurn(HUB, {
        conversationId,
        logByteOffset: logOffset,
        stderrByteOffset: stderrOffset,
        startedAt,
        agentLog,
        agentStderr,
        replyBodyFile,
      });
    }

    let cliSettings;
    try {
      cliSettings = getCliSettings(HUB, cliJson, config, hubCliName || '', hubModel || '');
    } catch (err) {
      try { fs.unlinkSync(promptFile); } catch (_e) { /* ignore */ }
      logEvent(HUB, {
        event: 'cli_config_error',
        slug: 'hub',
        error: err.message,
        status: 'error',
        via: 'warm_daemon',
      });
      resolve({
        ok: false,
        exitCode: 1,
        duration_ms: Date.now() - start,
        action: 'cli_config_error',
        error: err.message,
        conversationId: conversationId || '',
      });
      return;
    }
    const cmdPreview = compileAgentCommand(cliSettings, promptFile);

    logEvent(HUB, {
      event: 'hub_daemon_turn_start',
      conversation_id: conversationId || '',
      turn: path.basename(promptFile),
      cmd: cmdPreview,
      model: hubModel || 'default',
      has_xai_key: !!(process.env.XAI_API_KEY && process.env.XAI_API_KEY.length > 0),
      env_file_found: !!envInfo.found,
      via: 'warm_daemon',
    });

    const childEnv = { ...process.env };
    const script = [
      'set +e',
      `HUB=${JSON.stringify(HUB)}`,
      'if [ -f "$HUB/.bizagent/env" ]; then set -a; . "$HUB/.bizagent/env"; set +a; fi',
      `cd ${JSON.stringify(runtimeCwd)} || exit 1`,
      `${JSON.stringify(cliSettings.cli)} ${cliSettings.promptFlag} ${JSON.stringify(promptFile)} ${cliSettings.extraArgs || ''} >> ${JSON.stringify(agentLog)} 2>> ${JSON.stringify(agentStderr)}`,
      'exit $?',
    ].join('\n');

    const child = spawn('bash', ['-c', script], {
      env: childEnv,
      stdio: 'ignore',
    });

    child.on('error', (err) => {
      try { fs.unlinkSync(promptFile); } catch (_e) { /* ignore */ }
      const duration_ms = Date.now() - start;
      logEvent(HUB, {
        event: 'hub_daemon_turn_end',
        status: 'error',
        error: err.message,
        duration_ms,
      });
      resolve({
        ok: false,
        exitCode: 1,
        duration_ms,
        action: 'spawn_error',
        error: err.message,
      });
    });

    child.on('exit', (code) => {
      const exitCode = code == null ? 1 : code;
      let action = 'ok';
      try {
        if (conversationId) {
          const result = onHubCliExit(HUB, {
            conversationId,
            logByteOffset: logOffset,
            stderrByteOffset: stderrOffset,
            startedAt,
            agentLog,
            agentStderr,
            replyBodyFile,
            exitCode,
          });
          action = (result && result.action) || 'ok';
        }
      } catch (err) {
        action = `safety_error:${err.message}`;
      }
      try { fs.unlinkSync(promptFile); } catch (_e) { /* ignore */ }

      const duration_ms = Date.now() - start;
      logEvent(HUB, {
        event: 'hub_daemon_turn_end',
        status: exitCode === 0 ? 'ok' : 'error',
        exit_code: exitCode,
        duration_ms,
        action,
        conversation_id: conversationId || '',
        via: 'warm_daemon',
      });
      resolve({
        ok: exitCode === 0 || action === 'reserved-body' || action === 'ok-existing',
        exitCode,
        duration_ms,
        action,
        conversationId: conversationId || '',
      });
    });
  });
}

function handleLine(line, socket) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_e) {
    socket.write(`${JSON.stringify({ ok: false, error: 'invalid_json' })}\n`);
    return;
  }

  if (msg.type === 'ping') {
    socket.write(`${JSON.stringify({ ok: true, type: 'pong', pid: process.pid })}\n`);
    return;
  }

  if (msg.type === 'shutdown') {
    socket.write(`${JSON.stringify({ ok: true, type: 'bye' })}\n`);
    shutdown(0);
    return;
  }

  if (msg.type === 'turn') {
    if (busy) {
      socket.write(`${JSON.stringify({
        ok: false,
        type: 'turn_result',
        requestId: msg.requestId || null,
        error: 'busy',
      })}\n`);
      return;
    }
    busy = true;
    runTurn()
      .then((result) => {
        socket.write(`${JSON.stringify({
          type: 'turn_result',
          requestId: msg.requestId || null,
          ...result,
        })}\n`);
      })
      .catch((err) => {
        socket.write(`${JSON.stringify({
          ok: false,
          type: 'turn_result',
          requestId: msg.requestId || null,
          error: err.message,
        })}\n`);
      })
      .finally(() => {
        busy = false;
      });
    return;
  }

  socket.write(`${JSON.stringify({ ok: false, error: 'unknown_type', type: msg.type })}\n`);
}

function shutdown(code) {
  try {
    logEvent(HUB, { event: 'hub_daemon_stop', pid: process.pid });
  } catch (_e) { /* ignore */ }
  if (server) {
    try { server.close(); } catch (_e) { /* ignore */ }
  }
  clearSock();
  clearPid();
  process.exit(code);
}

function main() {
  ensureDirs();
  const envInfo = loadHubEnv(HUB);
  try {
    ensureHubRuntimePrompt(HUB);
    ensureHubRuntimeCwd(HUB);
  } catch (_e) { /* ignore */ }

  clearSock();
  writePid();

  server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handleLine(line, socket);
      }
    });
    socket.on('error', () => { /* client gone */ });
  });

  server.listen(SOCK, () => {
    try { fs.chmodSync(SOCK, 0o600); } catch (_e) { /* ignore */ }
    logEvent(HUB, {
      event: 'hub_daemon_start',
      pid: process.pid,
      sock: SOCK,
      has_xai_key: !!(process.env.XAI_API_KEY && process.env.XAI_API_KEY.length > 0),
      env_file_found: !!envInfo.found,
      env_keys_applied: envInfo.applied || 0,
    });
    // eslint-disable-next-line no-console
    console.log(`hub-daemon listening on ${SOCK} pid=${process.pid}`);
  });

  server.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('hub-daemon server error:', err.message);
    shutdown(1);
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

if (require.main === module) {
  main();
}

module.exports = { getRecentHubInboxMessage, hubDaemonSockPath: SOCK };
