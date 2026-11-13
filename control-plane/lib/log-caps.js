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
const zlib = require('zlib');

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

/**
 * Nightly log rotation with size caps.
 *
 * Every top-level logs/*.log / *.stderr / *.jsonl over `maxBytes` is rotated:
 * the oversized file becomes generation 1 (`<name>.1`, gzip-compressed by
 * default), older generations shift down and the excess is dropped, and the
 * fresh active file keeps only the last `keepTailBytes` (line-aligned) so
 * recent context (e.g. structured.log events read by observability and
 * startup recovery) survives the rotation. Small files are untouched.
 *
 * Env overrides: BIZAGENT_LOG_MAX_BYTES, BIZAGENT_LOG_KEEP_GENERATIONS,
 * BIZAGENT_LOG_COMPRESS=0 (disable gzip).
 *
 * @returns {{ rotated: number, files: string[], bytesRemoved: number }}
 */
function rotateLogs(hub, {
  maxBytes = 512 * 1024,
  keepGenerations = 1,
  keepTailBytes = 64 * 1024,
  compress = true,
} = {}) {
  const envMax = Number(process.env.BIZAGENT_LOG_MAX_BYTES || 0);
  if (Number.isFinite(envMax) && envMax > 0) maxBytes = envMax;
  if (process.env.BIZAGENT_LOG_KEEP_GENERATIONS != null && process.env.BIZAGENT_LOG_KEEP_GENERATIONS !== '') {
    const envGens = Number(process.env.BIZAGENT_LOG_KEEP_GENERATIONS);
    if (Number.isFinite(envGens) && envGens >= 0) keepGenerations = Math.floor(envGens);
  }
  if (String(process.env.BIZAGENT_LOG_COMPRESS || '') === '0') compress = false;

  const dir = path.join(hub, 'logs');
  const result = { rotated: 0, files: [], bytesRemoved: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_err) {
    return result;
  }

  const isArchive = (name) => /\.gz$/.test(name) || /\.\d+(\.gz)?$/.test(name);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const name of entries) {
    if (!/\.(log|stderr|jsonl)$/.test(name)) continue;
    if (isArchive(name)) continue;
    const active = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(active);
    } catch (_err) { continue; }
    if (!st.isFile() || st.size <= maxBytes) continue;

    const size = st.size;

    // Shift existing archives down: (keepGenerations-1) -> keepGenerations,
    // ... 1 -> 2. The oldest slot is dropped.
    for (let gen = keepGenerations; gen >= 1; gen--) {
      for (const suffix of ['.gz', '']) {
        const from = path.join(dir, `${name}.${gen}${suffix}`);
        if (gen >= keepGenerations) {
          try { fs.unlinkSync(from); } catch (_err) { /* not present */ }
          continue;
        }
        const to = path.join(dir, `${name}.${gen + 1}${suffix}`);
        try { fs.renameSync(from, to); } catch (_err) { /* not present */ }
      }
    }

    // Drop any archive generations beyond the retention window.
    for (const entry of entries) {
      const m = entry.match(new RegExp(`^${escapeRe(name)}\\.(\\d+)(\\.gz)?$`));
      if (!m) continue;
      if (Number(m[1]) > keepGenerations) {
        try { fs.unlinkSync(path.join(dir, entry)); } catch (_err) { /* ignore */ }
      }
    }

    // Read the tail (line-aligned) BEFORE archiving, so the fresh active
    // file keeps recent context readable without unpacking the archive.
    let tail = Buffer.alloc(0);
    try {
      const keep = Math.min(keepTailBytes, size);
      const fd = fs.openSync(active, 'r');
      try {
        tail = Buffer.alloc(keep);
        fs.readSync(fd, tail, 0, keep, size - keep);
      } finally {
        fs.closeSync(fd);
      }
      if (keep < size) {
        const nl = tail.indexOf('\n');
        if (nl >= 0 && nl + 1 < tail.length) tail = tail.slice(nl + 1);
        else tail = Buffer.alloc(0); // tail is one partial line — drop it
      }
    } catch (_err) { tail = Buffer.alloc(0); }

    // Active file -> generation 1 (compressed when enabled).
    let archiveBytes = 0;
    if (compress) {
      try {
        const content = fs.readFileSync(active);
        const gz = zlib.gzipSync(content);
        fs.writeFileSync(path.join(dir, `${name}.1.gz`), gz);
        archiveBytes = gz.length;
        fs.unlinkSync(active);
      } catch (_err) {
        // Fall back to an uncompressed rename if gzipping failed.
        try { fs.renameSync(active, path.join(dir, `${name}.1`)); archiveBytes = size; } catch (_e2) { /* keep going */ }
      }
    } else {
      try { fs.renameSync(active, path.join(dir, `${name}.1`)); archiveBytes = size; } catch (_err) { /* keep going */ }
    }

    try { fs.writeFileSync(active, tail); } catch (_err) { /* best effort */ }

    result.rotated += 1;
    result.files.push(name);
    result.bytesRemoved += Math.max(0, size - archiveBytes - tail.length);
  }
  return result;
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
  rotateLogs,
  statfsSafe,
  truncateToTail,
  volumeSpace,
};