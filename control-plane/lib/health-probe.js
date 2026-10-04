#!/usr/bin/env node
/**
 * health-probe.js — out-of-process health probe (survival instinct layer 2).
 *
 * Runs from a systemd user timer or cron every 1–5 min. Only needs to write
 * one small status file (logs/health.json + logs/health.status), so it works
 * even when the control plane cannot start. Exit codes drive systemd
 * OnFailure= alerts:
 *
 *   0 = ok / warn
 *   1 = critical
 *   2 = emergency
 *   3 = probe itself failed (also triggers OnFailure)
 *
 * Usage: node control-plane/lib/health-probe.js [hub-path]
 */

'use strict';

const path = require('path');

const hub = path.resolve(
  process.argv[2] ||
  process.env.BIZAGENT_HUB ||
  path.join(__dirname, '..', '..'),
);

let health;
try {
  health = require(path.join(__dirname, 'health.js'));
} catch (err) {
  // The watchdog itself is broken — say so and fail loudly.
  process.stderr.write(`health-probe: cannot load health module: ${err.message}\n`);
  process.exit(3);
}

// Optional OOM detection (needs privileges): BIZAGENT_HEALTH_OOM_CMD, e.g.
//   "journalctl -k --since -1h | grep -c 'Out of memory'"
if (process.env.BIZAGENT_HEALTH_OOM_CMD) {
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('bash', ['-c', process.env.BIZAGENT_HEALTH_OOM_CMD], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const n = Number(String(out).trim());
    const origSample = health.sample;
    health.sample = function (h, opts) {
      const s = origSample.call(this, h, opts);
      s.oomLastHour = Number.isFinite(n) && n > 0;
      return s;
    };
  } catch (_err) { /* no privileges — skip OOM detection */ }
}

let report;
try {
  report = health.runHealthCheck(hub, { mitigate: true });
} catch (err) {
  process.stderr.write(`health-probe: check failed: ${err.message}\n`);
  process.exit(3);
}

const bad = (report.checks || []).filter((c) => c.level !== 'ok');
process.stdout.write(`${report.level}${bad.length ? `: ${bad.map((c) => `${c.name}=${c.detail}`).join('; ')}` : ''}\n`);
if (report.mitigation && report.mitigation.length) {
  process.stdout.write(`mitigation: ${report.mitigation.join(', ')}\n`);
}

process.exit(report.level === 'emergency' ? 2 : report.level === 'critical' ? 1 : 0);
