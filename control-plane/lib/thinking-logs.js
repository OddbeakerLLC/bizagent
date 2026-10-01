/**
 * Live fleet thinking logs — dispatch-*.log only (agent stdout).
 *
 * Same file set the operator asked for in the web viewer: what agents are
 * thinking, not stderr, not control-plane/nightly/structured logs.
 * Node-side stat/read; never shells out to viewlog.sh.
 */
const fs = require("fs");
const path = require("path");

const THINKING_LOG_RE = /^dispatch-([A-Za-z0-9._-]+)\.log$/;
const INITIAL_BYTES = 32 * 1024;
const MAX_BURST_BYTES = 64 * 1024;
const CATCHUP_BYTES = 8 * 1024 * 1024;
const ALL_TAIL_LINES = 20;
const TAIL_WINDOW_BYTES = 64 * 1024;
const POLL_MS = 500;
const RESCAN_MS = 3000;

function logsDir(hub) {
  return path.join(path.resolve(hub), "logs");
}

function normalizeFilter(raw) {
  const f = String(raw == null ? "all" : raw).trim();
  if (!f || f === "all") return "all";
  if (!/^[A-Za-z0-9._-]+$/.test(f)) return null;
  return f;
}

function parseThinkingLogName(name) {
  const m = THINKING_LOG_RE.exec(String(name || ""));
  if (!m) return null;
  return { name: m[0], slug: m[1] };
}

function listThinkingLogFiles(hub) {
  const dir = logsDir(hub);
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_err) {
    return out;
  }
  const resolvedDir = path.resolve(dir);
  for (const name of names) {
    const parsed = parseThinkingLogName(name);
    if (!parsed) continue;
    const full = path.resolve(dir, name);
    if (path.dirname(full) !== resolvedDir) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch (_err) {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      name: parsed.name,
      slug: parsed.slug,
      size: st.size,
      path: full,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function publicFileList(files) {
  return (files || []).map((f) => ({
    name: f.name,
    slug: f.slug,
    size: f.size,
  }));
}

function filesMatchingFilter(files, filter) {
  if (filter === "all") return files;
  return files.filter((f) => f.slug === filter);
}

function readChunk(filePath, offset, maxBytes) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (_err) {
    return { missing: true, offset: 0, text: "", rotated: false };
  }
  if (!st.isFile()) return { missing: true, offset: 0, text: "", rotated: false };
  let nextOffset = offset;
  let rotated = false;
  if (!Number.isFinite(nextOffset) || nextOffset < 0 || st.size < nextOffset) {
    nextOffset = 0;
    rotated = Number.isFinite(offset) && offset > 0 && st.size < offset;
  }
  if (st.size <= nextOffset) {
    return { missing: false, offset: st.size, text: "", rotated };
  }
  const length = Math.min(st.size - nextOffset, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, nextOffset);
  } finally {
    fs.closeSync(fd);
  }
  return {
    missing: false,
    offset: nextOffset + length,
    text: buffer.toString("utf8"),
    rotated,
  };
}

function initialOffset(size) {
  const n = Number(size) || 0;
  return n > INITIAL_BYTES ? n - INITIAL_BYTES : 0;
}

/** Byte offset of the last `maxLines` lines, or 0 if the file is smaller. */
function tailLineOffset(filePath, maxLines) {
  const n = Math.max(1, Number(maxLines) || ALL_TAIL_LINES);
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (_err) {
    return 0;
  }
  if (!st.isFile() || st.size <= 0) return 0;
  const window = Math.min(st.size, TAIL_WINDOW_BYTES);
  const buf = Buffer.alloc(window);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buf, 0, window, st.size - window);
  } finally {
    fs.closeSync(fd);
  }
  let end = buf.length;
  if (end > 0 && buf[end - 1] === 0x0a) end -= 1;
  let lines = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) {
      lines += 1;
      if (lines === n) return st.size - window + i + 1;
    }
  }
  return st.size - window;
}

function startOffsetForFilter(filter, filePath, _size) {
  if (filter === "all") return tailLineOffset(filePath, ALL_TAIL_LINES);
  return 0;
}

/**
 * SSE live-tail of dispatch-*.log. Auth is the caller's job.
 * @returns {null} keep the HTTP response open
 */
function streamThinkingLogs(hub, req, res, filterRaw) {
  const filter = normalizeFilter(filterRaw);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const sendEvent = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (_err) {
      /* client gone */
    }
  };
  if (!filter) {
    sendEvent({ error: "invalid filter" });
    try {
      res.end();
    } catch (_err) {
      /* ignore */
    }
    return null;
  }

  const offsets = new Map(); // name -> byte offset
  let lastFilesKey = "";
  let lastRescan = 0;
  let files = [];

  const rescan = (force) => {
    const now = Date.now();
    if (!force && now - lastRescan < RESCAN_MS) return;
    lastRescan = now;
    files = listThinkingLogFiles(hub);
    const key = files.map((f) => f.name).join("\n");
    if (key !== lastFilesKey) {
      lastFilesKey = key;
      sendEvent({ files: publicFileList(files) });
    }
  };

  const tick = () => {
    rescan(false);
    const matched = filesMatchingFilter(files, filter);
    const burst = filter === "all" ? MAX_BURST_BYTES : CATCHUP_BYTES;
    for (const file of matched) {
      if (!offsets.has(file.name)) {
        offsets.set(file.name, startOffsetForFilter(filter, file.path, file.size));
      }
      let before = offsets.get(file.name);
      let remaining = burst;
      while (remaining > 0) {
        let chunk;
        try {
          chunk = readChunk(file.path, before, Math.min(MAX_BURST_BYTES, remaining));
        } catch (_err) {
          break;
        }
        if (chunk.missing) {
          offsets.delete(file.name);
          break;
        }
        if (chunk.rotated) {
          before = startOffsetForFilter(filter, file.path, 0);
          offsets.set(file.name, before);
          remaining -= 1;
          continue;
        }
        offsets.set(file.name, chunk.offset);
        before = chunk.offset;
        if (!chunk.text) break;
        sendEvent({ file: file.name, slug: file.slug, text: chunk.text });
        remaining -= Buffer.byteLength(chunk.text);
      }
    }
  };

  rescan(true);
  tick();
  const iv = setInterval(tick, POLL_MS);
  req.on("close", () => clearInterval(iv));
  return null;
}

module.exports = {
  ALL_TAIL_LINES,
  CATCHUP_BYTES,
  INITIAL_BYTES,
  MAX_BURST_BYTES,
  THINKING_LOG_RE,
  filesMatchingFilter,
  initialOffset,
  listThinkingLogFiles,
  normalizeFilter,
  parseThinkingLogName,
  publicFileList,
  readChunk,
  startOffsetForFilter,
  streamThinkingLogs,
  tailLineOffset,
};
