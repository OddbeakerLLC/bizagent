#!/usr/bin/env node
'use strict';

/**
 * log-rotate.js — nightly rotation/size caps for hub logs.
 *
 * Rotates every top-level logs/*.log / *.stderr / *.jsonl over the size cap
 * (default 512K): the oversized file becomes `<name>.1.gz` (older generations
 * shift down and the excess is dropped), and the fresh active file keeps the
 * last 64K (line-aligned) so recent structured.log events stay readable.
 *
 * Usage:
 *   node scripts/log-rotate.js [--hub <path>] [--max-bytes N]
 *                              [--keep-generations N] [--no-compress] [--json]
 *
 * Env overrides: BIZAGENT_LOG_MAX_BYTES, BIZAGENT_LOG_KEEP_GENERATIONS,
 * BIZAGENT_LOG_COMPRESS=0. CLI flags win over env.
 *
 * Called nightly by scripts/nightly.sh; safe to run manually any time.
 */

const path = require('path');
const { rotateLogs, logsDirBytes } = require('../control-plane/lib/log-caps');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const scriptDir = path.dirname(__filename);
let hub = path.dirname(scriptDir); // default: the hub this checkout belongs to
const hubArg = argValue('--hub');
if (hubArg) hub = path.resolve(hubArg);

const opts = {};
const maxBytes = Number(argValue('--max-bytes'));
if (Number.isFinite(maxBytes) && maxBytes > 0) opts.maxBytes = maxBytes;
const keepGenerations = Number(argValue('--keep-generations'));
if (Number.isFinite(keepGenerations) && keepGenerations >= 0) opts.keepGenerations = Math.floor(keepGenerations);
if (process.argv.includes('--no-compress')) opts.compress = false;

const before = logsDirBytes(hub);
const result = rotateLogs(hub, opts);
const after = logsDirBytes(hub);

const summary = {
  hub,
  rotated: result.rotated,
  files: result.files,
  bytes_removed: result.bytesRemoved,
  logs_dir_bytes_before: before,
  logs_dir_bytes_after: after,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `log-rotate: ${result.rotated} file(s) rotated` +
    (result.files.length ? ` (${result.files.join(', ')})` : '') +
    `, ~${Math.round(result.bytesRemoved / 1024)}K removed; logs/ ${Math.round(before / 1024)}K -> ${Math.round(after / 1024)}K`
  );
}
