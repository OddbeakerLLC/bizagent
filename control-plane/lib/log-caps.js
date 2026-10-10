'use strict';

/**
 * Reserved free-space buffer + log caps.
 *
 * Survival instinct: the hub volume must never hit 100%. Bulky writes are
 * refused while a reserved buffer (default 1.5 GB) remains, and logs are
 * truncated *before* the disk fills — not after.
 */

const fs = require('fs');
const path = require('path');

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Reserved free space on the hub volume (bytes). Env override: BIZAGENT_RESERVED_FREE_BYTES. */
function reservedFreeBytes() {
  const raw = Number(process.env.BIZAGENT_RESERVED_FREE_BYTES || 0);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return Math.round(1.5 * GB);
}

/** Smallest write we bother guarding (small JSON/status files always pass). */
const BULKY_WRITE_BYTES = 256 * 1024;

function statfsSafe(hub) {
  try {
    if (typeof fs.statfsSync === 'function') return fs.statfsSync(hub);
  } catch (_err) { /* fall through */ }
  return null;
}

/** { freeBytes, totalBytes } for the volume holding `hub`, or null when unknown. */
function volumeSpace(hub) {
  const s = statfsSafe(hub);
  if (!s || !s.bsize) return null;
  return {
    freeBytes: Number(s.bavail) * Number(s.bsize),
    totalBytes: Number(s.blocks) * Number(s.bsize),
  };
}

/**
 * Guard for bulky writes (uploads, exports, session dumps, big logs).
 * @returns {{ ok: boolean, freeBytes?: number, reservedBytes: number, reason?: string }}
 */
function assertBulkyWriteAllowed(hub, bytes) {
  const want = Math.max(0, Number(bytes || 0));
  const reserved = reservedFreeBytes();
  const space = volumeSpace(hub);
  if (!space) return { ok: true, reservedBytes: reserved }; // unknown volume: do not block small writes
  if (want < BULKY_WRITE_BYTES) return { ok: true, freeBytes: space.freeBytes, reservedBytes: reserved };
  if (space.freeBytes - reserved < want) {
    return {
      ok: false,
      freeBytes: space.freeBytes,
      reservedBytes: reserved,
      reason:
        `refusing ${Math.round(want / MB)} MB write: only ${Math.round(space.freeBytes / MB)} MB free ` +
        `and ${Math.round(reserved / MB)} MB is reserved (disk-full protection)`,
    };
  }
  return { ok: true, freeBytes: space.freeBytes, reservedBytes: reserved };
}

/** Keep only the tail of a file (in place). Returns bytes removed (0 when untouched). */
function truncateToTail(file, keepBytes) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size <= keepBytes) return 0;
    const fd = fs.openSync(file, 'r');
    let tail;
    try {
      const buf = Buffer.alloc(Math.min(keepBytes, st.size));
      fs.readSync(fd, buf, 0, buf.length, st.size - buf.length);
      tail = buf;
    } finally {
      fs.closeSync(fd);
    }
    fs.writeFileSync(file, tail);
    return st.size - tail.length;
  } catch (_err) {
    return 0;
  }
}

/**
 * Cap hub logs: every logs/*.log / *.stderr keeps only its tail.
 * Used by the emergency mitigation path and safe-mode boot.
 * @returns {{ files: number, bytesRemoved: number }}
 */
function capLogs(hub, { keepBytes = 512 * 1024 } = {}) {
  const dir = path.join(hub, 'logs');
  let files = 0;
  let bytesRemoved = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_err) {
    return { files, bytesRemoved };
  }
  for (const name of entries) {
    if (!/\.(log|stderr|jsonl)$/.test(name)) continue;
    const removed = truncateToTail(path.join(dir, name), keepBytes);
    if (removed > 0) {
      files += 1;
      bytesRemoved += removed;
    }
  }
  return { files, bytesRemoved };
}

/** Total bytes under hub/logs/ (bounded walk, one level deep). */
function logsDirBytes(hub) {
  const dir = path.join(hub, 'logs');
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isFile()) total += fs.statSync(p).size;
      else if (e.isDirectory()) {
        for (const n of fs.readdirSync(p)) {
          try { total += fs.statSync(path.join(p, n)).size; } catch (_e) { /* ignore */ }
        }
      }
    } catch (_err) { /* ignore */ }
  }
  return total;
}

module.exports = {
  BULKY_WRITE_BYTES,
  assertBulkyWriteAllowed,
  capLogs,
  logsDirBytes,
  reservedFreeBytes,
  statfsSafe,
  truncateToTail,
  volumeSpace,
};
