'use strict';

/**
 * Atomic state writes + tolerant loads for `.bizagent/*.json` state files.
 *
 * Crash resilience (2026-10-22): every control-plane state file is written
 * through writeJsonAtomic — tmp file + fsync + rename — so a crash (short of
 * SIGKILL mid-rename, which POSIX makes atomic) can never leave a torn or
 * half-written JSON file behind. The previous parseable copy is kept as
 * `<file>.bak` on each write, and readJsonState falls back to it when the
 * main file is missing or corrupt (legacy files written before this module
 * may still be torn on disk; the .bak only exists once a write has landed).
 */

const fs = require('fs');
const path = require('path');

function bakPath(file) {
  return `${file}.bak`;
}

/** Write text to a tmp file in the same dir, fsync it, rename over target. */
function writeFileAtomic(file, text, mode) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode != null ? mode : 0o644);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch (_err) { /* fsync unsupported — rename still atomic */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Atomically write a JSON state file (tmp + fsync + rename).
 * Before replacing, snapshot the current file to `<file>.bak` — but only when
 * it still parses as JSON, so a corrupt main file never clobbers a good bak.
 * Returns `data` (mirrors writeRegistry's contract).
 */
function writeJsonAtomic(file, data, opts = {}) {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  try {
    const prev = fs.readFileSync(file, 'utf8');
    JSON.parse(prev); // throws on corrupt → keep the existing .bak instead
    fs.writeFileSync(bakPath(file), prev, 'utf8');
  } catch (_err) { /* absent or corrupt — best-effort backup only */ }
  writeFileAtomic(file, body, opts.mode);
  return data;
}

function tryParseJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (_err) {
    return { ok: false };
  }
}

/**
 * Tolerant state read: main file → `<file>.bak` → fallback.
 * When the main file is corrupt but the bak is good, best-effort repair the
 * main file from the bak so subsequent plain readers (older processes, shell
 * scripts) also see valid JSON.
 */
function readJsonState(file, fallback) {
  const primary = tryParseJsonFile(file);
  if (primary.ok) return primary.value;
  const bak = tryParseJsonFile(bakPath(file));
  if (!bak.ok) return fallback;
  try {
    writeFileAtomic(file, `${JSON.stringify(bak.value, null, 2)}\n`);
  } catch (_err) { /* read-only disk — caller still gets the bak value */ }
  return bak.value;
}

/**
 * Startup hygiene: remove leftover `*.tmp` / `*.tmp` rename staging files from
 * crashed writers. Only files older than `maxAgeMs` are removed so a live
 * concurrent writer is never hit. Returns the number removed.
 */
function cleanTmpFiles(dir, maxAgeMs = 60 * 60 * 1000) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_err) {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.endsWith('.tmp')) continue;
    const file = path.join(dir, entry);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch (_err) { /* gone or busy — fine */ }
  }
  return removed;
}

module.exports = {
  bakPath,
  cleanTmpFiles,
  readJsonState,
  writeFileAtomic,
  writeJsonAtomic,
};