/**
 * Fleet thinking viewer — tails agent stdout only.
 *
 * Same idea as the operator log follower, but only logs/dispatch-<slug>.log
 * (agent thinking / stdout). Never error streams or any other non-thinking log.
 *
 * Node-side stat/read only. Callers must not shell out.
 */
const fs = require("fs");
const path = require("path");

const DISPATCH_LOG_RE = /^dispatch-([A-Za-z0-9._-]+)\.log$/;
const MAX_CHUNK_BYTES = 64 * 1024;
const TAIL_BYTES = 48 * 1024;

function logsDir(hub) {
  return path.join(hub, "logs");
}

function isSafeSlug(slug) {
  return typeof slug === "string" && /^[A-Za-z0-9._-]+$/.test(slug) && slug !== "." && slug !== "..";
}

/**
 * Resolve logs/dispatch-<slug>.log and refuse anything outside logs/.
 * @returns {?{ slug: string, name: string, file: string }}
 */
function resolveDispatchLog(hub, name) {
  if (!hub || typeof name !== "string") return null;
  const base = path.basename(name);
  if (base !== name) return null;
  const m = DISPATCH_LOG_RE.exec(base);
  if (!m || !isSafeSlug(m[1])) return null;
  const dir = logsDir(hub);
  const file = path.resolve(dir, base);
  const root = path.resolve(dir) + path.sep;
  if (file !== path.resolve(dir, base) || !file.startsWith(root)) return null;
  return { slug: m[1], name: base, file };
}

/**
 * Non-empty dispatch-*.log files under logs/ (maxdepth 1).
 * Skips empty files and anything that is not a regular dispatch stdout file in logs/.
 * @returns {{ slug: string, name: string, file: string, size: number }[]}
 */
function listDispatchLogs(hub) {
  const dir = logsDir(hub);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_err) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const resolved = resolveDispatchLog(hub, name);
    if (!resolved) continue;
    let stat;
    try {
      stat = fs.statSync(resolved.file);
    } catch (_err) {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    out.push({ ...resolved, size: stat.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Read new bytes since offset. Rotation (size shrinks) resets offset to 0
 * and reads from the start of the new file. Bursts are capped.
 * @returns {{ text: string, offset: number, rotated: boolean }}
 */
function readSince(file, offset, maxBytes = MAX_CHUNK_BYTES) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_CHUNK_BYTES;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_err) {
    return { text: "", offset: Number(offset) || 0, rotated: false };
  }
  if (!stat.isFile()) return { text: "", offset: Number(offset) || 0, rotated: false };
  let from = Number(offset);
  if (!Number.isFinite(from) || from < 0) from = stat.size;
  let rotated = false;
  if (stat.size < from) {
    rotated = true;
    from = 0;
  }
  if (stat.size <= from) return { text: "", offset: from, rotated };
  const length = Math.min(stat.size - from, cap);
  const buffer = Buffer.alloc(length);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buffer, 0, length, from);
  } catch (_err) {
    return { text: "", offset: from, rotated };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_err) { /* ignore */ }
    }
  }
  return { text: buffer.toString("utf8"), offset: from + length, rotated };
}

/**
 * Initial tail window so a newly opened viewer is not blank.
 * @returns {number}
 */
function tailOffset(size, tailBytes = TAIL_BYTES) {
  const n = Number(size) || 0;
  const tail = Number.isFinite(tailBytes) && tailBytes > 0 ? tailBytes : TAIL_BYTES;
  return Math.max(0, n - tail);
}

module.exports = {
  DISPATCH_LOG_RE,
  MAX_CHUNK_BYTES,
  TAIL_BYTES,
  isSafeSlug,
  listDispatchLogs,
  logsDir,
  readSince,
  resolveDispatchLog,
  tailOffset,
};
