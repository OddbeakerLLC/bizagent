/**
 * In-flight "thinking" tracking for the web UI.
 *
 * When a hub or product-agent turn launches, we record which dispatch log is
 * producing output for a given conversation. The UI opens an SSE stream that
 * tails that log live (in place of the static "Working. Stand by..." launch
 * ack) and replaces it with the real reply when the turn completes.
 *
 * Entries are keyed by conversation, then by slug, so two slugs bound to the
 * same conversation never overwrite each other's stream.
 *
 * State is a small JSON file under .bizagent/ — never committed, best-effort.
 */
const fs = require('fs');
const path = require('path');
const { appDir } = require('./config');

function thinkingFile(hub) {
  return path.join(appDir(hub), 'thinking.json');
}

function readThinking(hub) {
  try {
    const data = JSON.parse(fs.readFileSync(thinkingFile(hub), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (_err) {
    return {};
  }
}

function writeThinking(hub, data) {
  try {
    fs.mkdirSync(appDir(hub), { recursive: true });
    fs.writeFileSync(thinkingFile(hub), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (_err) {
    /* best-effort — thinking stream is a UX nicety, never critical */
  }
}

/**
 * Normalize a stored conversation entry to the per-slug map shape.
 * Legacy entries were flat { slug, logFile, logByteOffset, startedAt }.
 */
function entryBySlug(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (raw.slug && ('logFile' in raw || 'logByteOffset' in raw || 'startedAt' in raw)) {
    return {
      [raw.slug]: {
        logFile: String(raw.logFile || ''),
        logByteOffset: Number(raw.logByteOffset) || 0,
        startedAt: String(raw.startedAt || ''),
      },
    };
  }
  return raw;
}

function latestSlug(per) {
  const keys = Object.keys(per);
  if (!keys.length) return '';
  // Stable ascending sort: last key = newest startedAt; equal timestamps
  // fall back to insertion order (later record wins).
  keys.sort((a, b) => String(per[a].startedAt || '').localeCompare(String(per[b].startedAt || '')));
  return keys[keys.length - 1];
}

/**
 * Record an in-flight turn's thinking source for a conversation.
 * @param {string} hub
 * @param {string} conversationId
 * @param {string} slug - 'hub' or a product agent slug
 * @param {string} logFile - absolute path to the dispatch stdout log
 * @param {number} [logByteOffset] - byte offset into logFile where this turn
 *   begins, so the UI streams only the current turn's output (not the whole log)
 */
function recordThinking(hub, conversationId, slug, logFile, logByteOffset) {
  if (!conversationId || !slug) return;
  const data = readThinking(hub);
  const per = entryBySlug(data[conversationId]);
  per[slug] = {
    logFile: String(logFile || ''),
    logByteOffset: Number(logByteOffset) || 0,
    startedAt: new Date().toISOString(),
  };
  data[conversationId] = per;
  writeThinking(hub, data);
}

/**
 * Clear a recorded thinking entry.
 * @param {string} [slug] - when given, only that slug's entry is removed;
 *   otherwise the whole conversation entry is dropped.
 */
function clearThinking(hub, conversationId, slug) {
  if (!conversationId) return;
  const data = readThinking(hub);
  if (!data[conversationId]) return;
  if (!slug) {
    delete data[conversationId];
    writeThinking(hub, data);
    return;
  }
  const per = entryBySlug(data[conversationId]);
  if (!per[slug]) return;
  delete per[slug];
  if (Object.keys(per).length) data[conversationId] = per;
  else delete data[conversationId];
  writeThinking(hub, data);
}

/**
 * Look up a recorded thinking entry.
 * @param {string} [slug] - when omitted, the most recently recorded slug wins.
 * @returns {?{ slug: string, logFile: string, logByteOffset: number, startedAt: string }}
 */
function getThinking(hub, conversationId, slug) {
  const data = readThinking(hub);
  const per = entryBySlug(data[conversationId]);
  const key = slug && per[slug] ? slug : latestSlug(per);
  if (!key || !per[key]) return null;
  return {
    slug: key,
    logFile: String(per[key].logFile || ''),
    logByteOffset: Number(per[key].logByteOffset) || 0,
    startedAt: String(per[key].startedAt || ''),
  };
}

module.exports = {
  clearThinking,
  getThinking,
  recordThinking,
  readThinking,
  thinkingFile,
  writeThinking,
};
