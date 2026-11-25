#!/usr/bin/env node
/**
 * install-approval.js — allowlist check + audit log for agent software installs.
 *
 * Framework rule: agents never install packages or make machine-level changes on
 * their own. They mail the hub an install request; the hub (PTL) either performs
 * the install itself or relays an approval request to the operator. Operator
 * pre-approvals live in `<hub>/.bizagent/install-allowlist.json` so routine,
 * documented items skip the ask. Every request/approval/denial/install is
 * appended to `<hub>/logs/install-audit.jsonl`.
 *
 * See docs/SOFTWARE-INSTALL-APPROVAL.md for the full flow.
 *
 * Subcommands:
 *   check --hub <hub> --command "<cmd>" [--slug <slug>]
 *       Exit 0 (ALLOWED) when the command matches an allowlist entry, else
 *       exit 1 (DENIED) with a reason. A missing/unreadable allowlist is DENIED
 *       (default-deny).
 *   log  --hub <hub> --status <requested|approved|denied|deferred|installed>
 *        --command "<cmd>" [--slug <slug>] [--note "..."] [--by <who>]
 *       Append one JSON line to logs/install-audit.jsonl. Always exit 0 unless
 *       the write itself fails.
 *   init --hub <hub>
 *       Create .bizagent/install-allowlist.json from the built-in example if
 *       missing (never clobbers an existing file).
 *   show --hub <hub>
 *       Print the effective allowlist (or a note that none exists).
 *
 * Allowlist schema (.bizagent/install-allowlist.json):
 *   {
 *     "comment": "Operator pre-approvals for routine agent installs.",
 *     "updated": "2026-11-25",
 *     "entries": [
 *       { "match": "python3 -m pip install --user", "note": "user-scope pip only" },
 *       { "match": "npm install", "note": "project-local npm installs inside product repos" }
 *     ]
 *   }
 * Matching is a case-sensitive prefix match on the trimmed command line: a
 * command is allowed when some entry's `match` equals the whole command, or
 * equals the command's first token, or is a prefix followed by whitespace.
 * Entries are exact prefixes — write them precisely ("npm install" allows
 * "npm install -g x" too; prefer "npm install --no-global" style entries when
 * scope matters). Anything not matched is denied.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATUSES = ['requested', 'approved', 'denied', 'deferred', 'installed'];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hub' || a === '--command' || a === '--slug' || a === '--status' || a === '--note' || a === '--by') {
      const val = argv[++i];
      if (val === undefined) {
        console.error(`install-approval: ${a} requires a value`);
        process.exit(2);
      }
      args[a.slice(2)] = val;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function allowlistPath(hub) {
  return path.join(hub, '.bizagent', 'install-allowlist.json');
}

function auditLogPath(hub) {
  return path.join(hub, 'logs', 'install-audit.jsonl');
}

function loadAllowlist(hub) {
  let raw;
  try {
    raw = fs.readFileSync(allowlistPath(hub), 'utf8');
  } catch (_err) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch (_err) {
    return null;
  }
}

function commandAllowed(command, entries) {
  const cmd = String(command || '').trim();
  if (!cmd) return { allowed: false, reason: 'empty command' };
  const firstToken = cmd.split(/\s+/)[0];
  for (const entry of entries) {
    const match = String((entry && entry.match) || '').trim();
    if (!match) continue;
    if (cmd === match || firstToken === match || cmd.startsWith(match + ' ')) {
      return { allowed: true, matched: match, note: entry.note || '' };
    }
  }
  return { allowed: false, reason: 'no allowlist entry matches this command' };
}

function cmdCheck(args) {
  const hub = args.hub;
  if (!hub) { console.error('check: --hub is required'); process.exit(2); }
  const command = args.command || '';
  const list = loadAllowlist(hub);
  let result;
  if (!list) {
    result = { allowed: false, reason: 'no allowlist file at .bizagent/install-allowlist.json — default deny; mail hub an install request' };
  } else {
    result = commandAllowed(command, list.entries);
    if (!result.allowed && !result.reason) result.reason = 'no allowlist entry matches this command';
  }
  const verdict = result.allowed ? 'ALLOWED' : 'DENIED';
  console.log(`${verdict}: ${command}`);
  if (result.matched) console.log(`matched entry: ${result.matched}${result.note ? ` (${result.note})` : ''}`);
  if (result.reason) console.log(`reason: ${result.reason}`);
  if (!result.allowed) {
    console.log('action: mail hub an install request (what, why, product/task, exact commands) — do not install on your own');
  }
  // Audit the check itself so denied attempts are reviewable even if no mail follows.
  try {
    appendAudit(hub, {
      status: result.allowed ? 'allowlist-pass' : 'allowlist-deny',
      command,
      slug: args.slug || '',
      note: result.matched || result.reason || '',
      by: args.slug || 'agent',
    });
  } catch (_err) { /* audit best-effort on check */ }
  process.exit(result.allowed ? 0 : 1);
}

function appendAudit(hub, entry) {
  const logPath = auditLogPath(hub);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n';
  fs.appendFileSync(logPath, line);
}

function cmdLog(args) {
  const hub = args.hub;
  if (!hub) { console.error('log: --hub is required'); process.exit(2); }
  const status = args.status;
  if (!STATUSES.includes(status)) {
    console.error(`log: --status must be one of ${STATUSES.join('|')}`);
    process.exit(2);
  }
  appendAudit(hub, {
    status,
    command: args.command || '',
    slug: args.slug || '',
    note: args.note || '',
    by: args.by || '',
  });
  console.log(`logged ${status} -> ${auditLogPath(hub)}`);
}

const EXAMPLE_ALLOWLIST = {
  comment: 'Operator pre-approvals for routine agent software installs. Prefix match on the exact command line; anything not listed is denied. Edit by hand, keep entries precise.',
  updated: '',
  entries: [],
};

function cmdInit(args) {
  const hub = args.hub;
  if (!hub) { console.error('init: --hub is required'); process.exit(2); }
  const file = allowlistPath(hub);
  if (fs.existsSync(file)) {
    console.log(`already exists: ${file} (left untouched)`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  EXAMPLE_ALLOWLIST.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify(EXAMPLE_ALLOWLIST, null, 2) + '\n');
  console.log(`created ${file} — add operator pre-approvals to entries[]`);
}

function cmdShow(args) {
  const hub = args.hub;
  if (!hub) { console.error('show: --hub is required'); process.exit(2); }
  const list = loadAllowlist(hub);
  if (!list) {
    console.log('no readable allowlist at .bizagent/install-allowlist.json — everything is denied by default');
    process.exit(1);
  }
  console.log(JSON.stringify(list, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'check') return cmdCheck(args);
  if (cmd === 'log') return cmdLog(args);
  if (cmd === 'init') return cmdInit(args);
  if (cmd === 'show') return cmdShow(args);
  console.error('usage: install-approval.js <check|log|init|show> --hub <hub> [options]');
  console.error('  check --command "<cmd>" [--slug s]   exit 0 = allowlisted, 1 = denied');
  console.error('  log --status requested|approved|denied|deferred|installed --command "<cmd>" [--slug s] [--note n] [--by w]');
  console.error('  init                                  create the example allowlist if missing');
  console.error('  show                                  print the effective allowlist');
  process.exit(2);
}

main();
